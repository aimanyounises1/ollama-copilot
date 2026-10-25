/** A bounded, checkpointed browser task. Models advise; the driver owns execution policy. */
import { LIMITS, validateSettings } from "./config.mjs";
import { validateAction } from "./model-client.mjs";
import { safePublicUrl } from "./policy.mjs";

export const CAPTURE_LIMITS = Object.freeze({ maxChars: 8000, maxSources: 20, quoteChars: 1600, maxActivity: 80, activityChars: 400 });
export const RUN_STATUSES = Object.freeze(["idle", "running", "stopping", "stopped", "completed", "paused", "failed", "limit_reached", "interrupted"]);
const ACTIVE = new Set(["running", "stopping"]);
const ACTION_FIELDS = Object.freeze(["kind", "snapshot_id", "target_id", "url", "text", "key", "query", "reason"]);
const ACTION_STATUSES = new Set(["pending", "executed", "unconfirmed", "cancelled", "paused"]);
const TOOL_STRATEGIES = new Set(["read", "interact", "search"]);
const SAFE_ERROR_NAMES = new Set(["ModelClientError", "BrowserDriverError", "AgentRunError"]);

export class AgentRunError extends Error {
  constructor(code, message) { super(message); this.name = "AgentRunError"; this.code = code; }
}
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, maximum, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || !allowEmpty && !value.trim()) throw new AgentRunError("invalid_state", "The task contains invalid or oversized data.");
  return value;
}
function finite(value, maximum = Number.MAX_VALUE) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum; }
function pageTitle(value) {
  if (typeof value !== "string") throw new AgentRunError("invalid_observation", "The browser returned an invalid page title.");
  return value.slice(0, LIMITS.maxTitleChars);
}

/** Safe source links never carry credentials or point to local/browser resources. */
export function sourceUrl(value) {
  try { return safePublicUrl(value); }
  catch { throw new AgentRunError("invalid_source", "Captured source links must use public HTTP(S) websites."); }
}

export function escapeMarkdown(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}\[\]()#+|])/g, "\\$1");
}

/** Report prose is fixed; every finding is an exact captured excerpt with its source. */
export function createReport(state) {
  const lines = [`# ${escapeMarkdown(state.goal || "Ollama Copilot research")}`, "", `Task status: ${escapeMarkdown(state.status.replaceAll("_", " "))}.`, ""];
  if (!state.sources.length) return [...lines, "No source evidence has been captured."].join("\n");
  lines.push("## Captured excerpts", "");
  for (const source of state.sources) {
    const excerpt = source.text.slice(0, CAPTURE_LIMITS.quoteChars);
    lines.push(`### Source ${source.number}: ${escapeMarkdown(source.title || source.url)}`, "");
    lines.push(...excerpt.split("\n").map(line => `> ${escapeMarkdown(line)}`));
    lines.push("", `[${source.number}] [${escapeMarkdown(source.title || "Captured page")}](${`<${sourceUrl(source.url)}>`})`, "");
  }
  lines.push("## Source captures", "");
  for (const source of state.sources) {
    lines.push(`- [${source.number}] [${escapeMarkdown(source.title || "Captured page")}](${`<${sourceUrl(source.url)}>`})`, `  Captured: ${escapeMarkdown(source.capturedAt)}. SHA-256: ${source.contentHash}.`);
  }
  return lines.join("\n");
}

function safeRoute(value, settings = null) {
  if (!plain(value) || !TOOL_STRATEGIES.has(value.tool) || !finite(value.confidence, 1) || !finite(value.durationMs) || !["fast", "strong"].includes(value.modelRole)) throw new AgentRunError("invalid_route", "The decision model returned an invalid route.");
  const route = { model: text(value.model, LIMITS.maxModelNameChars), modelRole: value.modelRole, tool: value.tool, confidence: value.confidence, durationMs: value.durationMs, fallbackReason: value.fallbackReason == null ? null : text(value.fallbackReason, CAPTURE_LIMITS.activityChars) };
  if (settings && ![settings.fastModel, settings.strongModel].includes(route.model)) throw new AgentRunError("invalid_route", "The decision model selected an unconfigured LLM.");
  return route;
}
function safeObservation(value) {
  if (!plain(value) || !Array.isArray(value.elements) || value.elements.length > LIMITS.maxControls) throw new AgentRunError("invalid_observation", "The browser returned an invalid observation.");
  return { ...value, snapshot_id: text(value.snapshot_id, LIMITS.maxSnapshotChars), url: sourceUrl(value.url), title: pageTitle(value.title), text: text(value.text, LIMITS.maxSourceChars, true) };
}
function publicError(error) {
  return SAFE_ERROR_NAMES.has(error?.name) && typeof error?.code === "string" && typeof error?.message === "string" && error.message.length <= CAPTURE_LIMITS.activityChars ? error.message : "Ollama Copilot could not confirm a browser or model operation. Check the model connection and website access, then start again.";
}
function initialState(id, goal, maximum, now) {
  return { id, goal, status: "idle", step: 0, maxSteps: maximum, tab: null, sources: [], actions: [], activity: [], route: null, report: "", error: null, startedAt: now, updatedAt: now };
}

/** Validate session data as data; a restored task is never an instruction to resume. */
export function restoreCheckpoint(value) {
  try {
    if (!plain(value) || !RUN_STATUSES.includes(value.status) || !Number.isInteger(value.step) || !Number.isInteger(value.maxSteps) || value.step < 0 || value.step > value.maxSteps || value.maxSteps < 1 || value.maxSteps > LIMITS.maxSteps || !Array.isArray(value.sources) || value.sources.length > CAPTURE_LIMITS.maxSources || !Array.isArray(value.actions) || value.actions.length > LIMITS.maxSteps || !Array.isArray(value.activity) || value.activity.length > CAPTURE_LIMITS.maxActivity) return null;
    const id = text(value.id, LIMITS.maxSnapshotChars);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const state = initialState(id, text(value.goal, LIMITS.maxGoalChars, true), value.maxSteps, text(value.startedAt, LIMITS.maxTargetChars));
    state.updatedAt = text(value.updatedAt, LIMITS.maxTargetChars);
    state.decisionModel = value.decisionModel == null ? null : text(value.decisionModel, LIMITS.maxModelNameChars);
    state.status = ACTIVE.has(value.status) ? "interrupted" : value.status;
    state.step = value.step;
    state.error = state.status === "interrupted" ? "The previous panel session ended. Its evidence is retained; start a new task to continue." : value.error == null ? null : text(value.error, CAPTURE_LIMITS.activityChars);
    if (value.tab !== null) {
      if (!plain(value.tab) || !Number.isInteger(value.tab.tabId) || value.tab.tabId < 0) return null;
      state.tab = { tabId: value.tab.tabId, url: sourceUrl(value.tab.url), title: text(value.tab.title, LIMITS.maxTitleChars, true) };
    }
    const seen = new Set();
    state.sources = value.sources.map((source, index) => {
      if (!plain(source) || source.number !== index + 1 || !/^[a-f0-9]{64}$/.test(source.contentHash)) throw new AgentRunError("invalid_source", "The saved source capture is invalid.");
      const result = { number: index + 1, url: sourceUrl(source.url), title: text(source.title, LIMITS.maxTitleChars, true), text: text(source.text, CAPTURE_LIMITS.maxChars), contentHash: source.contentHash, capturedAt: text(source.capturedAt, LIMITS.maxTargetChars) };
      const key = `${result.url}\n${result.contentHash}`;
      if (seen.has(key)) throw new AgentRunError("invalid_source", "The saved source capture is duplicated.");
      seen.add(key); return result;
    });
    state.actions = value.actions.map(entry => {
      if (!plain(entry) || !ACTION_STATUSES.has(entry.status) || !finite(entry.score, 1) || !Number.isInteger(entry.step) || entry.step < 1 || entry.step > value.maxSteps) throw new AgentRunError("invalid_state", "The saved action history is invalid.");
      const action = {};
      for (const key of ACTION_FIELDS) if (entry[key] !== undefined) action[key] = entry[key];
      return { ...validateAction(action), status: entry.status === "pending" ? "unconfirmed" : entry.status, step: entry.step, score: entry.score, model: text(entry.model, LIMITS.maxTitleChars) };
    });
    state.activity = value.activity.map(entry => ({ message: text(entry.message, CAPTURE_LIMITS.activityChars), at: text(entry.at, LIMITS.maxTargetChars) }));
    if (value.route !== null) state.route = safeRoute(value.route);
    state.report = createReport(state);
    return state;
  } catch { return null; }
}

export class AgentRun {
  constructor(settings, { client, driver, onUpdate = async () => {}, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID() } = {}) {
    this.settings = validateSettings(settings);
    if (!client || !driver || typeof onUpdate !== "function") throw new TypeError("A model client, browser driver and update callback are required.");
    this.client = client; this.driver = driver; this.onUpdate = onUpdate; this.now = now; this.idFactory = idFactory;
    this._state = initialState(this.idFactory(), "", this.settings.maxSteps, this.now());
    this._state.decisionModel = this.settings.decisionModel;
    this._abort = null; this._running = false; this._updates = Promise.resolve(); this._pending = null; this._dispatched = false;
  }
  get state() { return clone(this._state); }
  get isRunning() { return this._running; }
  _guard() { this._abort.signal.throwIfAborted(); }
  _note(message) {
    this._state.activity.push({ message: message.slice(0, CAPTURE_LIMITS.activityChars), at: this.now() });
    this._state.activity = this._state.activity.slice(-CAPTURE_LIMITS.maxActivity);
  }
  _publish() {
    this._state.updatedAt = this.now(); this._state.report = createReport(this._state);
    const snapshot = this.state;
    const update = async () => {
      try { await this.onUpdate(snapshot); }
      catch (cause) {
        const error = new AgentRunError("checkpoint_failed", "The task checkpoint could not be saved. Further actions are blocked.");
        error.cause = cause;
        throw error;
      }
    };
    // The original caller receives its failed write. A later terminal checkpoint
    // gets a fresh attempt; recovering the write queue never resumes execution.
    this._updates = this._updates.then(update, update);
    return this._updates;
  }
  async _capture(observation, capturedAt) {
    const raw = observation.text.slice(0, CAPTURE_LIMITS.maxChars);
    if (!raw.trim()) throw new AgentRunError("empty_capture", "This page has no readable evidence to capture.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    this._guard();
    const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (this._state.sources.some(source => source.url === observation.url && source.contentHash === contentHash)) return;
    if (this._state.sources.length >= CAPTURE_LIMITS.maxSources) throw new AgentRunError("source_limit", "The source capture limit was reached. Collected evidence is retained.");
    this._state.sources.push({ number: this._state.sources.length + 1, url: observation.url, title: observation.title, text: raw, contentHash, capturedAt });
    this._note(`Captured source ${this._state.sources.length}: ${observation.title || observation.url}`);
  }
  async start(goal) {
    if (this._running) throw new AgentRunError("already_running", "Stop the current task before starting another.");
    goal = text(goal, LIMITS.maxGoalChars).trim();
    this._abort = new AbortController(); this._running = true; this._pending = null; this._dispatched = false;
    this._state = initialState(this.idFactory(), goal, this.settings.maxSteps, this.now());
    this._state.decisionModel = this.settings.decisionModel;
    this._state.status = "running";
    this._note("Starting on the explicitly selected tab.");
    try {
      await this._publish(); this._guard();
      const tab = await this.driver.bindCurrentTab(); this._guard();
      if (!plain(tab) || !Number.isInteger(tab.tabId)) throw new AgentRunError("invalid_tab", "The browser did not confirm the selected tab.");
      this._state.tab = { tabId: tab.tabId, url: sourceUrl(tab.url), title: pageTitle(tab.title) };
      await this._publish();
      for (let index = 0; index < this.settings.maxSteps; index += 1) {
        this._guard(); this._state.step = index + 1;
        const observation = safeObservation(await this.driver.observe()); this._guard();
        const capturedAt = this.now();
        this._note(`Observed ${observation.title || observation.url}`);
        this._state.route = safeRoute(await this.client.route(goal, observation, this._abort.signal), this.settings); this._guard();
        this._note(`Decision route: ${this._state.route.model}; ${this._state.route.tool} strategy.`);
        await this._publish(); this._guard();
        const action = validateAction(await this.client.propose(goal, observation, this._state.actions, this._state.route, this._abort.signal)); this._guard();
        if (action.snapshot_id !== observation.snapshot_id) throw new AgentRunError("stale_action", "The proposed action does not match the observed page.");
        const judgment = await this.client.judge(goal, observation, action, this._abort.signal); this._guard();
        if (!plain(judgment) || !finite(judgment.score, 1) || !finite(judgment.durationMs)) throw new AgentRunError("invalid_judgment", "The decision model returned an invalid action judgment.");
        this._note(`Action judgment: ${judgment.score.toFixed(2)}; minimum ${this.settings.minimumRelevance.toFixed(2)}.`);
        const entry = { ...action, step: index + 1, model: this._state.route.model, score: judgment.score, status: judgment.score >= this.settings.minimumRelevance ? "pending" : "paused" };
        this._state.actions.push(entry);
        if (entry.status === "paused") {
          this._state.status = "paused"; this._state.error = "The proposed action did not meet the decision threshold. Review the task and start again.";
          this._note(this._state.error); break;
        }
        this._pending = entry; this._dispatched = false;
        await this._publish(); this._guard();
        this._dispatched = true;
        const result = await this.driver.execute(action); this._guard();
        if (!plain(result) || result.status !== "executed") throw new AgentRunError("unconfirmed_action", "The browser did not confirm the action outcome.");
        entry.status = "executed"; this._pending = null; this._dispatched = false;
        if (["extract", "done"].includes(action.kind)) {
          if (sourceUrl(result.url) !== observation.url) throw new AgentRunError("changed_capture", "The page changed before evidence capture could be confirmed.");
          await this._capture(observation, capturedAt); this._guard();
        }
        this._note(`${action.kind}: ${action.reason || "Browser action confirmed."}`);
        await this._publish(); this._guard();
        if (action.kind === "done") { this._state.status = "completed"; this._note("The task finished with its captured evidence."); break; }
      }
      if (this._state.status === "running") { this._state.status = "limit_reached"; this._state.error = "The step limit was reached. Collected evidence is retained."; this._note(this._state.error); }
    } catch (error) {
      if (this._pending) this._pending.status = this._dispatched ? "unconfirmed" : "cancelled";
      if (this._abort.signal.aborted || error?.name === "AbortError") { this._state.status = "stopped"; this._state.error = null; this._note("Stopped. No further actions will run."); }
      else { this._state.status = error?.code === "source_limit" ? "limit_reached" : "failed"; this._state.error = publicError(error); this._note(this._state.error); }
    } finally {
      try { await this.driver.cancel(); }
      catch { this._state.status = "failed"; this._state.error = "Browser control could not be released cleanly. Close this panel and review the tab."; this._note(this._state.error); }
      this._running = false;
    }
    await this._publish();
    return this.state;
  }
  async stop() {
    if (!this._running || this._abort.signal.aborted) return;
    this._abort.abort(); this._state.status = "stopping";
    this._note("Stopping the task and disconnecting browser control.");
    await Promise.all([this.driver.cancel(), this._publish()]);
  }
}
