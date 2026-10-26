/** A bounded, checkpointed browser task. Models advise; the driver owns execution policy. */
import { LIMITS, validateSettings } from "./config.mjs";
import { validateAction, validateObservedAction, validateTaskTabs } from "./model-client.mjs";
import { BrowserDriverError, safePublicUrl } from "./policy.mjs";
import { INTERRUPT, isInterrupted } from "@langchain/langgraph/web";
import { createBrowserTaskGraph, browserGraphRecursionLimit } from "./agent-graph.mjs";
import { createBrowserActionTool, createModelRunnables } from "./agent-tools.mjs";

export const CAPTURE_LIMITS = Object.freeze({ maxChars: 8000, maxSources: 20, maxActivity: 80, activityChars: 400 });
export const RUN_STATUSES = Object.freeze(["idle", "running", "stopping", "stopped", "completed", "paused", "awaiting_permission", "failed", "limit_reached", "interrupted"]);
const ACTIVE = new Set(["running", "stopping"]);
const ACTION_FIELDS = Object.freeze(["kind", "snapshot_id", "target_id", "tab_ref", "url", "text", "key", "query", "reason"]);
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
    const excerpt = source.text.slice(0, CAPTURE_LIMITS.maxChars);
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
function safeObservation(value, maximumTabs) {
  if (!plain(value) || !Array.isArray(value.elements) || value.elements.length > LIMITS.maxControls) throw new AgentRunError("invalid_observation", "The browser returned an invalid observation.");
  return { snapshot_id: text(value.snapshot_id, LIMITS.maxSnapshotChars), url: sourceUrl(value.url), title: pageTitle(value.title), text: text(value.text, LIMITS.maxSourceChars, true), elements: value.elements, ...validateTaskTabs(value, maximumTabs) };
}
function publicError(error) {
  return SAFE_ERROR_NAMES.has(error?.name) && typeof error?.code === "string" && typeof error?.message === "string" && error.message.length <= CAPTURE_LIMITS.activityChars ? error.message : "Ollama Copilot could not confirm a browser or model operation. Check the model connection and website access, then start again.";
}
/** Abort a wait without allowing a late permission result to resume the task. */
function permissionWait(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new DOMException("The browser task was stopped.", "AbortError")); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}
function initialState(id, goal, maximum, now) {
  return { id, goal, status: "idle", step: 0, maxSteps: maximum, tab: null, tabs: [], sources: [], actions: [], activity: [], route: null, report: "", error: null, startedAt: now, updatedAt: now };
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
    state.status = ACTIVE.has(value.status) || value.status === "awaiting_permission" ? "interrupted" : value.status;
    state.step = value.step;
    state.error = state.status === "interrupted" ? "The previous panel session ended. Its evidence is retained; start a new task to continue." : value.error == null ? null : text(value.error, CAPTURE_LIMITS.activityChars);
    if (value.tab !== null) {
      if (!plain(value.tab) || !Number.isInteger(value.tab.tabId) || value.tab.tabId < 0) return null;
      state.tab = { tabId: value.tab.tabId, url: sourceUrl(value.tab.url), title: text(value.tab.title, LIMITS.maxTitleChars, true) };
      if (value.tabs?.length || value.tab.tab_ref !== undefined) {
        const metadata = validateTaskTabs({ tabs: value.tabs, tab_ref: value.tab.tab_ref, url: state.tab.url }, value.maxSteps + 1);
        state.tab.tab_ref = metadata.tab_ref; state.tabs = metadata.tabs;
      } else if (value.tabs !== undefined && (!Array.isArray(value.tabs) || value.tabs.length)) return null;
    } else if (value.tabs !== undefined && (!Array.isArray(value.tabs) || value.tabs.length)) return null;
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
    this._abort = null; this._running = false; this._updates = Promise.resolve(); this._pending = null; this._dispatched = false; this.graph = null;
    this._permissionWait = false; this._permissionApproved = false;
    this._permissionReviewRequired = false; this._permissionTarget = null; this._reviewing = null;
  }
  get state() { return clone(this._state); }
  get isRunning() { return this._running; }
  get canContinue() {
    return this._permissionWait && !this._running && this._state.status === "awaiting_permission" &&
      !this._abort?.signal.aborted && this._safePermissionBoundary();
  }
  get permissionReviewRequired() { return this._permissionReviewRequired; }
  get reviewedPermissionOrigin() { return this.canContinue ? this._permissionTarget?.origin || null : null; }
  /** Review is a separate human gesture; it cannot grant access or invoke the graph. */
  async reviewPermissionTarget() {
    if (this._running || this._reviewing) throw new AgentRunError("already_running", "The task is already running or reviewing a website.");
    if (!this.canContinue) throw new AgentRunError("not_resumable", "This task cannot review website access.");
    const signal = this._abort.signal, id = this._state.id, review = Symbol();
    this._reviewing = review; this._permissionTarget = null;
    try {
      const target = await permissionWait(this.driver.reviewPermissionTarget(signal), signal);
      this._guard(signal);
      if (this._state.id !== id || !this.canContinue) throw new DOMException("The browser task was stopped.", "AbortError");
      if (!plain(target) || Object.keys(target).some(key => !["url", "origin"].includes(key)) ||
          typeof target.origin !== "string" || new URL(safePublicUrl(target.url)).origin !== target.origin) {
        throw new AgentRunError("invalid_tab", "Chrome did not confirm a public current website for review.");
      }
      this._permissionTarget = { url: safePublicUrl(target.url), origin: target.origin };
      this._permissionReviewRequired = false;
      return { ...this._permissionTarget };
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") throw error;
      this._permissionTarget = null;
      if (error instanceof BrowserDriverError && error.code === "permission_review_required") {
        this._permissionReviewRequired = true;
        throw error;
      }
      this._permissionWait = false; this._permissionReviewRequired = false;
      this._state.status = "failed"; this._state.error = publicError(error); this._note(this._state.error);
      try { await this.driver.cancel(); }
      catch { this._state.error = "Browser control could not be released cleanly. Close this panel and review the tab."; }
      await this._publish();
      throw error;
    } finally { if (this._reviewing === review) this._reviewing = null; }
  }
  _safePermissionBoundary() {
    return this._state.tab !== null && this.driver.canContinuePermission === true &&
      this._pending === null && !this._dispatched && this._state.step < this._state.maxSteps &&
      this._state.actions.every(action => action.status === "executed");
  }
  _guard(signal = this._abort.signal) { signal.throwIfAborted(); }
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
  _updateTab(value) {
    const metadata = validateTaskTabs(value, this.settings.maxSteps + 1);
    this._state.tab = { ...this._state.tab, url: sourceUrl(value.url), title: pageTitle(value.title), ...(metadata ? { tab_ref: metadata.tab_ref } : {}) };
    if (metadata) this._state.tabs = metadata.tabs;
  }
  async _capture(observation, capturedAt, signal) {
    const raw = observation.text.slice(0, CAPTURE_LIMITS.maxChars);
    if (!raw.trim()) throw new AgentRunError("empty_capture", "This page has no readable evidence to capture.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    this._guard(signal);
    const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (this._state.sources.some(source => source.url === observation.url && source.contentHash === contentHash)) return;
    if (this._state.sources.length >= CAPTURE_LIMITS.maxSources) throw new AgentRunError("source_limit", "The source capture limit was reached. Collected evidence is retained.");
    this._state.sources.push({ number: this._state.sources.length + 1, url: observation.url, title: observation.title, text: raw, contentHash, capturedAt });
    this._note(`Captured source ${this._state.sources.length}: ${observation.title || observation.url}`);
  }
  _workflow(signal) {
    // The signal belongs to this invocation, even if this AgentRun is used again.
    const guard = () => this._guard(signal);
    const options = { signal, callbacks: [] };
    const models = createModelRunnables(this.client, signal, guard);
    const browserTool = createBrowserActionTool({ driver: this.driver, guard, onDispatch: () => { this._dispatched = true; } });
    return createBrowserTaskGraph({
      bind: async () => {
        guard();
        const tab = await this.driver.bindCurrentTab(); guard();
        if (!plain(tab) || !Number.isInteger(tab.tabId)) throw new AgentRunError("invalid_tab", "The browser did not confirm the selected tab.");
        this._state.tab = { tabId: tab.tabId }; this._updateTab(tab);
        await this._publish(); guard();
        return { step: 0, approved: false, finished: false };
      },
      observe: async state => {
        guard();
        let raw;
        try { raw = await this.driver.observe(); }
        catch (error) {
          guard();
          if (!(error instanceof BrowserDriverError) || error.code !== "site_access_required" || !this._safePermissionBoundary()) throw error;
          this._state.status = "awaiting_permission";
          this._state.error = "This website needs access. Allow and continue to keep researching in this task.";
          this._note("Waiting for explicit website access before a fresh observation. No browser action is pending.");
          await this._publish(); guard();
          return { needsPermission: true, observation: null, modelRoute: null, action: null, judgment: null, result: null, approved: false };
        }
        const observation = safeObservation(raw, this.settings.maxSteps + 1); guard();
        const step = state.step + 1;
        this._state.step = step; this._updateTab(observation);
        this._note(`Observed ${observation.title || observation.url}`);
        return { step, observation, capturedAt: this.now(), action: null, judgment: null, result: null, approved: false, needsPermission: false };
      },
      permission_gate: () => {
        // A native checkpoint breakpoint stops before this side-effect-free gate.
        guard();
        if (!this._permissionApproved) throw new AgentRunError("not_resumable", "Website access must be approved from this open panel.");
        this._permissionApproved = false;
        return { needsPermission: false, observation: null, modelRoute: null, action: null, judgment: null, result: null, approved: false };
      },
      route: async state => {
        guard();
        const route = safeRoute(await models.route.invoke({ goal: state.goal, observation: state.observation }, options), this.settings); guard();
        this._state.route = route;
        this._note(`Decision route: ${route.model}; ${route.tool} strategy.`);
        await this._publish(); guard();
        return { modelRoute: route };
      },
      propose: async state => {
        guard();
        const action = validateAction(await models.propose.invoke({ goal: state.goal, observation: state.observation, history: clone(this._state.actions), route: state.modelRoute }, options)); guard();
        validateObservedAction(action, state.observation);
        this._note(`Planner proposal: ${action.kind}; reason: ${action.reason || "No reason supplied."}`);
        return { action };
      },
      judge: async state => {
        guard();
        const judgment = await models.judge.invoke({ goal: state.goal, observation: state.observation, action: state.action }, options); guard();
        if (!plain(judgment) || !finite(judgment.score, 1) || !finite(judgment.durationMs)) throw new AgentRunError("invalid_judgment", "The decision model returned an invalid action judgment.");
        const approved = judgment.score >= this.settings.minimumRelevance;
        this._note(`Action judgment: ${judgment.score.toFixed(2)}; minimum ${this.settings.minimumRelevance.toFixed(2)}.`);
        const entry = { ...state.action, step: state.step, model: state.modelRoute.model, score: judgment.score, status: approved ? "pending" : "paused" };
        this._state.actions.push(entry);
        if (approved) { this._pending = entry; this._dispatched = false; }
        else {
          this._note(`Rejected ${state.action.kind}; not executed.`);
          this._state.status = "paused";
          this._state.error = "The proposed action did not meet the decision threshold. Review the task and start again.";
          this._note(this._state.error);
        }
        return { judgment: { score: judgment.score, durationMs: judgment.durationMs }, approved };
      },
      prepare_action: async () => {
        guard();
        // The saved checkpoint is a dispatch barrier, not an eventual graph stream.
        await this._publish(); guard();
        return {};
      },
      execute: async state => {
        guard();
        validateObservedAction(state.action, state.observation);
        const result = await browserTool.invoke({ action: state.action }, options); guard();
        if (!plain(result) || result.status !== "executed") throw new AgentRunError("unconfirmed_action", "The browser did not confirm the action outcome.");
        this._pending.status = "executed"; this._pending = null; this._dispatched = false;
        if (result.tabs !== undefined || ["open_tab", "switch_tab"].includes(state.action.kind)) this._updateTab(result);
        return { result };
      },
      capture: async state => {
        guard();
        if (["extract", "done"].includes(state.action.kind)) {
          if (sourceUrl(state.result.url) !== state.observation.url) throw new AgentRunError("changed_capture", "The page changed before evidence capture could be confirmed.");
          await this._capture(state.observation, state.capturedAt, signal); guard();
        }
        this._note(`${state.action.kind}: ${state.action.reason || "Browser action confirmed."}`);
        await this._publish(); guard();
        if (state.action.kind === "done") {
          this._state.status = "completed"; this._note("The task finished with its captured evidence.");
          return { finished: true };
        }
        if (state.step >= this.settings.maxSteps) {
          this._state.status = "limit_reached";
          this._state.error = "The step limit was reached. Collected evidence is retained.";
          this._note(this._state.error);
          return { finished: true };
        }
        return { finished: false };
      },
      finalize: () => { guard(); return { finished: true }; },
    });
  }
  async _invoke(input, signal, continuation = false) {
    let checkingPermission = false;
    try {
      this._guard(signal);
      if (continuation) {
        checkingPermission = true;
        await permissionWait(this.driver.resumeAfterPermission(signal), signal); this._guard(signal);
        checkingPermission = false;
        this._permissionApproved = true;
        this._note("Website access approved. Continuing the same task with a fresh observation and model review.");
      }
      await this._publish(); this._guard(signal);
      if (!continuation) this.graph = this._workflow(signal);
      const result = await this.graph.invoke(input, { signal, callbacks: [], configurable: { thread_id: this._state.id }, recursionLimit: browserGraphRecursionLimit(this.settings.maxSteps) });
      this._guard(signal);
      if (isInterrupted(result)) {
        const pauses = result[INTERRUPT];
        if (pauses.length !== 0 || result.needsPermission !== true || this._state.status !== "awaiting_permission" || !this._safePermissionBoundary()) {
          throw new AgentRunError("not_resumable", "The task cannot safely continue from this interruption.");
        }
        this._permissionWait = true;
      } else if (this._state.status === "awaiting_permission") {
        throw new AgentRunError("not_resumable", "The permission checkpoint could not be confirmed.");
      }
    } catch (error) {
      const needsReview = checkingPermission && !signal.aborted && error instanceof BrowserDriverError &&
        error.code === "permission_review_required" && this._safePermissionBoundary();
      this._permissionWait = needsReview;
      this._permissionReviewRequired = needsReview;
      if (this._pending) this._pending.status = this._dispatched ? "unconfirmed" : "cancelled";
      if (needsReview) { this._state.status = "awaiting_permission"; this._state.error = publicError(error); this._note(this._state.error); }
      else if (signal.aborted || error?.name === "AbortError") { this._state.status = "stopped"; this._state.error = null; this._note("Stopped. No further actions will run."); }
      else { this._state.status = error?.code === "source_limit" ? "limit_reached" : "failed"; this._state.error = publicError(error); this._note(this._state.error); }
    } finally {
      this._permissionApproved = false; this._permissionTarget = null;
      try { await this.driver.cancel(); }
      catch { this._permissionWait = false; this._permissionReviewRequired = false; this._state.status = "failed"; this._state.error = "Browser control could not be released cleanly. Close this panel and review the tab."; this._note(this._state.error); }
      this._running = false;
    }
    try { await this._publish(); }
    catch (error) { this._permissionWait = false; this._permissionReviewRequired = false; this._state.status = "failed"; this._state.error = publicError(error); throw error; }
    return this.state;
  }
  async start(goal) {
    if (this._running || this._permissionWait) throw new AgentRunError("already_running", "Stop the current task before starting another.");
    goal = text(goal, LIMITS.maxGoalChars).trim();
    this._abort?.abort();
    this._abort = new AbortController(); this._running = true; this._pending = null; this._dispatched = false;
    this._permissionWait = false; this._permissionApproved = false;
    this._permissionReviewRequired = false; this._permissionTarget = null; this._reviewing = null;
    this._state = initialState(this.idFactory(), goal, this.settings.maxSteps, this.now());
    this._state.decisionModel = this.settings.decisionModel;
    this._state.status = "running";
    this._note("Starting on the explicitly selected tab.");
    return this._invoke({ goal, step: 0, approved: false, finished: false, needsPermission: false }, this._abort.signal);
  }
  /** Only an explicit same-panel gesture can grant access and resume this graph. */
  async continueAfterPermission() {
    if (this._running || this._reviewing) throw new AgentRunError("already_running", "The task is already running or reviewing a website.");
    if (!this.canContinue) throw new AgentRunError("not_resumable", "This task cannot continue. Start a new task after reviewing the page.");
    if (this._permissionReviewRequired && !this._permissionTarget) throw new AgentRunError("permission_review_required", "Review the current website before continuing this task.");
    this._permissionWait = false; this._running = true;
    this._state.status = "running"; this._state.error = null;
    return this._invoke(null, this._abort.signal, true);
  }
  async stop() {
    this._permissionTarget = null; this._permissionReviewRequired = false;
    if (this._permissionWait && !this._running) {
      this._permissionWait = false; this._permissionApproved = false; this._abort?.abort();
      this._state.status = "stopped"; this._state.error = null;
      this._note("Stopped while waiting for website access. This continuation is no longer available.");
      await Promise.all([this.driver.cancel(), this._publish()]);
      return;
    }
    if (!this._running || this._abort.signal.aborted) return;
    this._permissionWait = false; this._permissionApproved = false;
    this._abort.abort(); this._state.status = "stopping";
    this._note("Stopping the task and disconnecting browser control.");
    await Promise.all([this.driver.cancel(), this._publish()]);
  }
}
