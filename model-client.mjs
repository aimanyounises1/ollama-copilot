/** Local inference boundary: typed decisions route; chat models propose; code validates. */
import { DEFAULT_SETTINGS, ENDPOINTS, LIMITS, validModelName, validateSettings } from "./config.mjs";
import { JUDGE_INSTRUCTIONS, MODEL_CRITERIA, PLANNER_INSTRUCTIONS, PROMPT_VERSIONS, ROUTE_INSTRUCTIONS, TOOL_ACTIONS, TOOL_CRITERIA, TOOL_INSTRUCTIONS } from "./prompts.mjs";

export class ModelClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelClientError";
    this.code = code;
  }
}

const ACTION_KINDS = Object.freeze(["navigate", "click", "type", "press", "back", "search", "open_tab", "switch_tab", "extract", "done"]);
const ACTION_FIELDS = Object.freeze(["kind", "snapshot_id", "target_id", "tab_ref", "url", "text", "key", "reason", "query"]);
const SUPPORTED_KEYS = Object.freeze(["Enter", "Tab", "Escape"]);
const ACTION_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ACTION_KINDS },
    snapshot_id: { type: "string", minLength: 1, maxLength: LIMITS.maxSnapshotChars },
    target_id: { type: ["string", "null"], minLength: 1, maxLength: LIMITS.maxTargetChars },
    tab_ref: { type: ["string", "null"], minLength: 1, maxLength: LIMITS.maxTargetChars },
    url: { type: ["string", "null"], maxLength: LIMITS.maxUrlChars },
    text: { type: ["string", "null"], maxLength: LIMITS.maxActionText },
    query: { type: ["string", "null"], minLength: 1, maxLength: LIMITS.maxSearchQuery },
    key: { type: ["string", "null"], enum: [...SUPPORTED_KEYS, null] },
    reason: { type: "string", maxLength: LIMITS.maxReasonChars },
  },
  required: ["kind", "snapshot_id", "reason"],
});

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function probability(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function stop(signal) {
  if (signal?.aborted) throw new DOMException("The model request was stopped.", "AbortError");
}
function failure(code, message) { throw new ModelClientError(code, message); }
function boundedString(value, maximum, label, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || !empty && !value.trim()) {
    failure("invalid_input", `${label} must contain bounded text.`);
  }
  return value;
}
function publicUrl(value) {
  boundedString(value, LIMITS.maxUrlChars, "A browser URL");
  let parsed;
  try { parsed = new URL(value); } catch { failure("invalid_action", "A browser URL is invalid."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    failure("invalid_action", "A browser URL must use HTTP(S) without credentials.");
  }
  return parsed.href;
}

/** Structural validation is separate from the driver's observed-control policy. */
export function validateAction(value) {
  if (!object(value) || Object.keys(value).some(key => !ACTION_FIELDS.includes(key)) || !ACTION_KINDS.includes(value.kind)) {
    failure("invalid_action", "The planner returned an unsupported browser action.");
  }
  const result = {
    kind: value.kind,
    snapshot_id: boundedString(value.snapshot_id, LIMITS.maxSnapshotChars, "Snapshot identity"),
    reason: boundedString(value.reason, LIMITS.maxReasonChars, "Action reason", { empty: true }),
  };
  const requirements = { navigate: ["url"], click: ["target_id"], type: ["target_id", "text"], press: ["target_id", "key"], search: ["query"], open_tab: ["target_id"], switch_tab: ["tab_ref"], back: [], extract: [], done: [] };
  const required = requirements[value.kind];
  for (const key of ["target_id", "tab_ref", "url", "text", "key", "query"]) {
    if (!required.includes(key) && value[key] !== undefined && value[key] !== null) {
      failure("invalid_action", "The browser action contains an unused argument.");
    }
  }
  if (required.includes("target_id")) result.target_id = boundedString(value.target_id, LIMITS.maxTargetChars, "Observed target");
  if (required.includes("tab_ref")) result.tab_ref = boundedString(value.tab_ref, LIMITS.maxTargetChars, "Observed task tab");
  if (required.includes("url")) result.url = publicUrl(value.url);
  if (required.includes("text")) result.text = boundedString(value.text, LIMITS.maxActionText, "Typed text", { empty: true });
  if (required.includes("query")) result.query = boundedString(value.query, LIMITS.maxSearchQuery, "Search query").trim();
  if (required.includes("key")) {
    if (!SUPPORTED_KEYS.includes(value.key)) failure("invalid_action", "The browser key is unsupported.");
    result.key = value.key;
  }
  return result;
}

/** Only the driver's explicitly task-owned tab catalog is exposed to models or checkpoints. */
export function validateTaskTabs(value, maximum = LIMITS.maxSteps + 1) {
  if (value.tabs === undefined && value.tab_ref === undefined) return null;
  if (!Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > maximum) {
    failure("invalid_input", "The task tab catalog is invalid or oversized.");
  }
  const currentRef = boundedString(value.tab_ref, LIMITS.maxTargetChars, "Current task tab");
  const refs = new Set();
  const tabs = value.tabs.map(tab => {
    if (!object(tab) || typeof tab.active !== "boolean") failure("invalid_input", "A task tab is invalid.");
    const ref = boundedString(tab.ref, LIMITS.maxTargetChars, "Task tab reference");
    if (!/^[A-Za-z0-9_-]+$/.test(ref) || refs.has(ref)) failure("invalid_input", "Task tab references must be unique opaque labels.");
    refs.add(ref);
    return { ref, title: boundedString(tab.title, LIMITS.maxSourceChars, "Task tab title", { empty: true }).slice(0, LIMITS.maxTitleChars), url: publicUrl(tab.url), active: tab.active };
  });
  const active = tabs.filter(tab => tab.active);
  if (active.length !== 1 || active[0].ref !== currentRef || active[0].url !== publicUrl(value.url)) {
    failure("invalid_input", "The active task tab does not match the current page.");
  }
  return { tab_ref: currentRef, tabs };
}

export function validateObservedAction(action, current) {
  if (action.snapshot_id !== current.snapshot_id) failure("stale_action", "The action belongs to a different browser observation.");
  const target = action.target_id ? current.elements.find(item => item.id === action.target_id) : null;
  if (action.target_id && !target) failure("unobserved_target", "The action target was not observed.");
  if (action.kind === "open_tab" && (target?.tag !== "a" || !target.href)) failure("unobserved_target", "Open only an observed public reading link in a new tab.");
  if (action.kind === "open_tab") publicUrl(target.href);
  const tabTarget = action.tab_ref ? current.tabs?.find(tab => tab.ref === action.tab_ref) : null;
  if (action.kind === "switch_tab" && (!tabTarget || tabTarget.active)) failure("unobserved_tab", "Switch only to another observed task-owned tab.");
  return { target, tabTarget };
}

function observationState(value, decision = false, maximumTabs = LIMITS.maxSteps + 1) {
  if (!object(value) || !Array.isArray(value.elements) || value.elements.length > LIMITS.maxControls) {
    failure("invalid_input", "The browser observation is invalid.");
  }
  const seen = new Set();
  const elements = value.elements.map(element => {
    if (!object(element)) failure("invalid_input", "An observed control is invalid.");
    const id = boundedString(element.id, LIMITS.maxTargetChars, "Observed control identity");
    if (seen.has(id)) failure("invalid_input", "Observed control identities must be unique.");
    seen.add(id);
    const control = { id };
    for (const key of ["tag", "type", "label", "href", "form_method", "role"]) {
      if (typeof element[key] === "string") control[key] = element[key].slice(0, key === "href" ? LIMITS.maxUrlChars : LIMITS.maxLabelChars);
    }
    return control;
  });
  return {
    snapshot_id: boundedString(value.snapshot_id, LIMITS.maxSnapshotChars, "Snapshot identity"),
    url: publicUrl(value.url),
    title: boundedString(value.title, LIMITS.maxSourceChars, "Page title", { empty: true }).slice(0, LIMITS.maxTitleChars),
    text: boundedString(value.text, LIMITS.maxSourceChars, "Page text", { empty: true }).slice(0, decision ? LIMITS.decisionObservationChars : LIMITS.maxObservationChars),
    elements: decision ? [] : elements,
    ...validateTaskTabs(value, maximumTabs),
  };
}

function goalText(value, decision = false) {
  return boundedString(value, LIMITS.maxGoalChars, "The user goal").slice(0, decision ? LIMITS.decisionGoalChars : LIMITS.maxGoalChars);
}

function modelResult(value, expected) {
  if (value.model !== expected || value.remote_host || value.remote_model) failure("invalid_response", "The provider did not confirm the configured local model identity.");
}

function choiceAnswer(value, labels) {
  if (!object(value) || value.type !== "choice" || !labels.includes(value.choice)
      || !probability(value.confidence) || !object(value.probabilities)
      || Object.keys(value.probabilities).length !== labels.length
      || Object.keys(value.probabilities).some(key => !labels.includes(key))
      || labels.some(key => !probability(value.probabilities[key]))) {
    failure("invalid_decision", "The decision model returned an invalid routing choice.");
  }
  const sum = labels.reduce((total, key) => total + value.probabilities[key], 0);
  const highest = Math.max(...labels.map(key => value.probabilities[key]));
  if (Math.abs(sum - 1) > LIMITS.probabilityTolerance || value.probabilities[value.choice] < highest) {
    failure("invalid_decision", "The routing probability distribution is inconsistent.");
  }
  return value;
}

export class ModelClient {
  constructor(settings = DEFAULT_SETTINGS, { fetchImpl = fetch } = {}) {
    this.settings = validateSettings(settings);
    if (typeof fetchImpl !== "function") throw new TypeError("The model transport must be a function.");
    this.fetch = (url, init) => fetchImpl(url, init);
    this.capabilities = new Map();
    this.remoteAliases = new Set();
  }

  async request(path, payload, signal) {
    stop(signal);
    if (!Object.values(ENDPOINTS).includes(path)) failure("invalid_endpoint", "Only registered local model endpoints are supported.");
    const encoded = payload === undefined ? undefined : JSON.stringify(payload);
    if (encoded && new TextEncoder().encode(encoded).byteLength > LIMITS.maxRequestBytes) {
      failure("request_too_large", "The bounded model request is too large.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Model request timed out.", "TimeoutError"));
    }, this.settings.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.fetch(new URL(path, this.settings.ollamaUrl).href, {
        method: payload === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
        body: encoded, signal: combined, credentials: "omit", redirect: "error", cache: "no-store",
      });
      stop(signal);
      if (!response.ok) failure("provider_http", "Ollama refused the request. Check the selected models and extension origin access.");
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        failure("invalid_response", "Ollama returned an unexpected response format.");
      }
      if (Number(response.headers.get("content-length")) > LIMITS.maxResponseBytes || !response.body) {
        failure("response_too_large", "The model response is missing or exceeds its byte allowance.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      let text = "";
      try {
        while (true) {
          stop(signal);
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > LIMITS.maxResponseBytes) failure("response_too_large", "The model response exceeds its byte allowance.");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      stop(signal);
      let result;
      try { result = JSON.parse(text); } catch { failure("invalid_response", "Ollama returned invalid JSON."); }
      if (!object(result) || Object.hasOwn(result, "error")) failure("invalid_response", "Ollama did not return a valid model result.");
      return result;
    } catch (error) {
      stop(signal);
      if (timedOut) failure("timeout", "The model request timed out. Increase the configured timeout or choose a faster model.");
      if (error instanceof ModelClientError) throw error;
      failure("network", "Ollama could not be reached. Start it and allow this exact extension origin.");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async listModels(signal) {
    const result = await this.request(ENDPOINTS.models, undefined, signal);
    if (!Array.isArray(result.models) || result.models.length > LIMITS.maxModels) failure("invalid_models", "Ollama returned an invalid model catalog.");
    const names = new Set();
    this.remoteAliases = new Set();
    for (const item of result.models) {
      if (!object(item) || !validModelName(item.name)) failure("invalid_models", "Ollama returned an invalid model name.");
      if (item.remote_model || item.remote_host || item.name.endsWith(":cloud")) this.remoteAliases.add(item.name);
      else names.add(item.name);
    }
    return [...names].map(name => ({ name, ...(this.capabilities.has(name) ? { capabilities: [...this.capabilities.get(name)] } : {}) }));
  }

  async prepareModels(signal) {
    const catalog = await this.listModels(signal);
    const available = new Set(catalog.map(item => item.name));
    const models = [...new Set([this.settings.decisionModel, this.settings.fastModel, this.settings.strongModel])];
    for (const model of models) {
      if (this.remoteAliases.has(model)) failure("model_capability", "Hosted Ollama aliases cannot receive page content in local-only mode.");
      if (!available.has(model)) failure("model_missing", "A configured model is not installed in Ollama. Select an installed model.");
      if (this.capabilities.has(model)) continue;
      const details = await this.request(ENDPOINTS.show, { model }, signal);
      if (!Array.isArray(details.capabilities) || !details.capabilities.length
          || details.capabilities.some(item => typeof item !== "string") || details.remote_model || details.remote_host) {
        failure("model_capability", "The selected model does not expose supported local capabilities.");
      }
      this.capabilities.set(model, new Set(details.capabilities));
    }
    if (!this.capabilities.get(this.settings.decisionModel).has("decision")) failure("model_capability", "The decision model must support System One decisions.");
    for (const model of [this.settings.fastModel, this.settings.strongModel]) {
      const capabilities = this.capabilities.get(model);
      if (!capabilities.has("completion") || capabilities.has("decision")) {
        failure("model_capability", "Planner models must support chat completion and cannot be decision-only or embedding-only models.");
      }
    }
  }

  async route(goal, observation, signal) {
    await this.prepareModels(signal);
    const state = { goal: goalText(goal, true), page: observationState(observation, true, this.settings.maxSteps + 1), prompt_version: PROMPT_VERSIONS.route };
    const started = performance.now();
    const result = await this.request(ENDPOINTS.decisions, {
      model: this.settings.decisionModel, state,
      questions: {
        model: { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria: MODEL_CRITERIA },
        tool: { type: "choice", instructions: TOOL_INSTRUCTIONS, criteria: TOOL_CRITERIA },
      },
    }, signal);
    modelResult(result, this.settings.decisionModel);
    const model = choiceAnswer(result.answers?.model, Object.keys(MODEL_CRITERIA));
    const tool = choiceAnswer(result.answers?.tool, Object.keys(TOOL_CRITERIA));
    const modelUncertain = model.confidence < this.settings.routeConfidence;
    const toolUncertain = tool.confidence < this.settings.routeConfidence;
    const modelRole = modelUncertain ? "strong" : model.choice;
    const toolStrategy = toolUncertain ? "interact" : tool.choice;
    // Model-tier uncertainty must not erase an independently accepted tool choice.
    const reasons = [];
    if (modelUncertain) reasons.push("Model selection was uncertain; use the configured stronger model.");
    if (toolUncertain) reasons.push("Tool selection was uncertain; use the interact strategy with observed controls.");
    else if (modelUncertain) reasons.push(`Retain the selected ${toolStrategy} strategy.`);
    return {
      model: modelRole === "fast" ? this.settings.fastModel : this.settings.strongModel,
      modelRole, tool: toolStrategy, confidence: Math.min(model.confidence, tool.confidence),
      durationMs: performance.now() - started,
      fallbackReason: reasons.length ? reasons.join(" ") : null,
    };
  }

  async propose(goal, observation, history, route, signal) {
    stop(signal);
    if (!object(route) || ![this.settings.fastModel, this.settings.strongModel].includes(route.model)
        || !Object.hasOwn(TOOL_CRITERIA, route.tool)) failure("invalid_route", "Only a configured model and registered tool may plan an action.");
    if (!Array.isArray(history)) failure("invalid_input", "The browser action history is invalid.");
    await this.prepareModels(signal);
    const current = observationState(observation, false, this.settings.maxSteps + 1);
    const schema = { ...ACTION_SCHEMA, properties: {
      ...ACTION_SCHEMA.properties,
      kind: { type: "string", enum: TOOL_ACTIONS[route.tool] },
      target_id: { ...ACTION_SCHEMA.properties.target_id, enum: [...current.elements.map(element => element.id), null] },
      tab_ref: { ...ACTION_SCHEMA.properties.tab_ref, enum: [...(current.tabs || []).filter(tab => !tab.active).map(tab => tab.ref), null] },
    } };
    const past = history.slice(-LIMITS.maxHistory).map(item => {
      if (!object(item)) failure("invalid_input", "A browser history item is invalid.");
      const historical = item.action || item;
      const metadata = ["status", "step", "score", "model"];
      if (!object(historical) || Object.keys(historical).some(key => !ACTION_FIELDS.includes(key) && !metadata.includes(key))) failure("invalid_input", "Browser history contains an unsupported field.");
      const action = validateAction(Object.fromEntries(ACTION_FIELDS.filter(key => Object.hasOwn(historical, key)).map(key => [key, historical[key]])));
      return { ...action, ...(typeof item.status === "string" ? { status: item.status.slice(0, LIMITS.maxReasonChars) } : {}) };
    });
    const result = await this.request(ENDPOINTS.chat, {
      model: route.model, stream: false, format: schema,
      ...(this.capabilities.get(route.model).has("thinking") ? { think: false } : {}),
      options: { num_predict: LIMITS.plannerOutputTokens, num_ctx: LIMITS.plannerContextTokens },
      messages: [
        { role: "system", content: PLANNER_INSTRUCTIONS },
        { role: "user", content: JSON.stringify({ goal: goalText(goal), observation: current, history: past, route: { tool: route.tool, modelRole: route.modelRole }, prompt_version: PROMPT_VERSIONS.planner }) },
      ],
    }, signal);
    modelResult(result, route.model);
    if (!object(result.message) || typeof result.message.content !== "string" || result.message.content.length > LIMITS.maxResponseBytes || result.done !== true) {
      failure("invalid_response", "The planner did not return one completed structured action.");
    }
    let candidate;
    try { candidate = JSON.parse(result.message.content); } catch { failure("invalid_action", "The planner returned invalid action JSON."); }
    const action = validateAction(candidate);
    if (!TOOL_ACTIONS[route.tool].includes(action.kind)) failure("invalid_action", "The planner action does not match the routed tool.");
    validateObservedAction(action, current);
    return action;
  }

  async judge(goal, observation, action, signal) {
    const observed = observationState(observation, false, this.settings.maxSteps + 1);
    const current = observationState(observation, true, this.settings.maxSteps + 1);
    const proposed = validateAction(action);
    const { target, tabTarget } = validateObservedAction(proposed, observed);
    await this.prepareModels(signal);
    const started = performance.now();
    const result = await this.request(ENDPOINTS.decisions, {
      model: this.settings.decisionModel,
      state: { goal: goalText(goal, true), page: current, target, tab_target: tabTarget, action: proposed, prompt_version: PROMPT_VERSIONS.judge },
      questions: { useful: { type: "noul", instructions: JUDGE_INSTRUCTIONS } },
    }, signal);
    modelResult(result, this.settings.decisionModel);
    const answer = result.answers?.useful;
    if (!object(answer) || answer.type !== "noul" || !probability(answer.noul)) failure("invalid_decision", "The decision model returned an invalid relevance score.");
    return { score: answer.noul, durationMs: performance.now() - started };
  }
}
