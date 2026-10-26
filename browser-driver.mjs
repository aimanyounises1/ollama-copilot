/** Tab-bound Chrome adapter. Model work belongs to the visible side panel. */
import {
  BrowserDriverError, CHANNEL, MAX_CONTROLS, MAX_CONTROL_LABEL, MAX_EVIDENCE_TEXT,
  NAVIGATION_TIMEOUT_MS, PORT_TIMEOUT_MS, safePublicUrl, validateSnapshotAction,
} from "./policy.mjs";
export { BrowserDriverError } from "./policy.mjs";

const abortError = () => new DOMException("The browser task was stopped.", "AbortError");

export class BrowserDriver {
  constructor(settings, { chromeApi = globalThis.chrome } = {}) {
    this.settings = settings;
    this.chrome = chromeApi;
    this.tabId = null;
    this.startUrl = null;
    this.port = null;
    this.documentId = null;
    this.lastDocumentId = null;
    this.observation = null;
    this.history = [];
    this.pending = new Map();
    this.waiters = new Set();
    this.cancelled = false;
    this.generation = 0;
    this.pendingOrigin = null;
    this.allowNewDocument = false;
    this.taskTabs = new Map();
    this.tabRef = null;
    this.windowId = null;
  }

  _saveTab() {
    const tab = this.taskTabs.get(this.tabRef);
    if (!tab) return;
    Object.assign(tab, { startUrl: this.startUrl, history: this.history,
      lastDocumentId: this.lastDocumentId, pendingOrigin: this.pendingOrigin,
      allowNewDocument: this.allowNewDocument });
  }

  _tabMetadata() {
    return [...this.taskTabs.values()].map((tab) => ({ ref: tab.ref, title: tab.title,
      url: tab.url, active: tab.ref === this.tabRef }));
  }

  _adoptTab(tab) {
    this._saveTab();
    this._closePort(new BrowserDriverError("tab_switched", "The task moved to another controlled tab."));
    this.tabId = tab.id;
    this.tabRef = tab.ref;
    this.startUrl = tab.startUrl;
    this.history = tab.history;
    this.lastDocumentId = tab.lastDocumentId;
    this.pendingOrigin = tab.pendingOrigin;
    this.allowNewDocument = tab.allowNewDocument;
  }

  _assertGeneration(generation) {
    if (this.cancelled || generation !== this.generation) throw abortError();
  }

  async bindCurrentTab() {
    this.cancel();
    this.cancelled = false;
    const generation = this.generation;
    let tabs;
    // The visible extension page owns this window even when another window has focus.
    try { tabs = await this.chrome.tabs.query({ active: true, currentWindow: true }); }
    catch { throw new BrowserDriverError("site_access_required", "Click Ollama Copilot's toolbar icon on the website you want it to use."); }
    if (generation !== this.generation) throw abortError();
    const tab = tabs[0];
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId) || !tab.url) {
      throw new BrowserDriverError("site_access_required", "Click Ollama Copilot's toolbar icon on a public website, then start the task.");
    }
    this.startUrl = safePublicUrl(tab.url);
    this.lastDocumentId = null;
    this.tabId = tab.id;
    this.history = [this.startUrl];
    this.pendingOrigin = null;
    this.allowNewDocument = true;
    this.windowId = tab.windowId;
    this.tabRef = crypto.randomUUID();
    const title = String(tab.title || "Website").slice(0, MAX_CONTROL_LABEL);
    this.taskTabs = new Map([[this.tabRef, { ref: this.tabRef, id: tab.id, url: this.startUrl, title,
      startUrl: this.startUrl, history: this.history, lastDocumentId: null,
      pendingOrigin: null, allowNewDocument: true }]]);
    return { tabId: this.tabId, url: this.startUrl, title, tab_ref: this.tabRef, tabs: this._tabMetadata() };
  }

  async grantCurrentSite() {
    // This method must be called by the panel's explicit permission button.
    let tabs;
    try { tabs = await this.chrome.tabs.query(this.windowId === null
      ? { active: true, currentWindow: true } : { active: true, windowId: this.windowId }); }
    catch { throw new BrowserDriverError("site_access_required", "Click Ollama Copilot's toolbar icon on this website to grant temporary access."); }
    const tab = tabs[0];
    const target = tab?.url || this.pendingOrigin;
    if (!target || this.tabId !== null && tab?.id !== this.tabId ||
        this.windowId !== null && tab?.windowId !== this.windowId) {
      throw new BrowserDriverError("tab_changed", "Return to the controlled tab or start a new task for the selected tab.");
    }
    const url = new URL(safePublicUrl(target));
    const pattern = `${url.protocol}//${url.hostname}/*`;
    let granted;
    try { granted = await this.chrome.permissions.request({ origins: [pattern] }); }
    catch { throw new BrowserDriverError("site_access_required", "Chrome could not request site access. Use Ollama Copilot's toolbar icon on this website."); }
    if (!granted) throw new BrowserDriverError("site_access_required", "Site access was not granted. You can continue browsing manually.");
    return true;
  }

  async _activeTab() {
    if (this.cancelled) throw abortError();
    if (!Number.isInteger(this.tabId)) throw new BrowserDriverError("not_bound", "Choose the current tab before starting a browser task.");
    const generation = this.generation;
    let tabs;
    try { tabs = await this.chrome.tabs.query({ active: true, windowId: this.windowId }); }
    catch { throw new BrowserDriverError("tab_unavailable", "The controlled Chrome tab is unavailable."); }
    if (this.cancelled || generation !== this.generation) throw abortError();
    const tab = tabs[0];
    if (!tab || tab.id !== this.tabId || tab.windowId !== this.windowId) {
      throw new BrowserDriverError("tab_changed", "The active Chrome tab changed. Return to the controlled tab or start a new task.");
    }
    // Chrome may omit the URL while a newly created or navigating task tab is
    // loading. Only readiness may wait through that state; observation still
    // requires the completed tab's real URL and a successful host-authorized injection.
    if (tab.status === "loading" && this.allowNewDocument && this.pendingOrigin) return tab;
    if (!tab.url) throw new BrowserDriverError("site_access_required", "Click Ollama Copilot's toolbar icon on the new website or use Allow this website.");
    safePublicUrl(tab.url);
    return tab;
  }

  async _readyTab() {
    const tab = await this._activeTab();
    if (tab.status !== "loading") return tab;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.chrome.tabs.onUpdated.removeListener(updated); this.waiters.delete(waiter); };
      const waiter = { cleanup, reject };
      const updated = (id, change) => {
        if (id !== this.tabId || change.status !== "complete") return;
        cleanup();
        this._activeTab().then(resolve, reject);
      };
      const timer = setTimeout(() => { cleanup(); reject(new BrowserDriverError("navigation_timeout", "The website is still loading. Try again after it finishes.")); }, NAVIGATION_TIMEOUT_MS);
      this.waiters.add(waiter);
      this.chrome.tabs.onUpdated.addListener(updated);
      this.chrome.tabs.get(this.tabId).then((current) => {
        if (this.cancelled || generation !== this.generation) { cleanup(); reject(abortError()); }
        else if (current.status !== "loading") { cleanup(); this._activeTab().then(resolve, reject); }
      }, () => { cleanup(); reject(new BrowserDriverError("tab_unavailable", "The controlled tab closed while loading.")); });
    });
  }

  _watchNavigation() {
    // Register before dispatch: Chrome can start loading before the content acknowledgment arrives.
    const state = { started: false, ready: false, error: null, closed: false, resolve: null, reject: null, timer: null };
    const finish = () => {
      if (state.error && state.reject) state.reject(state.error);
      else if (state.ready && state.resolve) state.resolve();
    };
    const cleanup = () => {
      if (state.closed) return;
      state.closed = true; clearTimeout(state.timer);
      this.chrome.tabs.onUpdated.removeListener(updated); this.waiters.delete(waiter);
    };
    const waiter = { cleanup, reject: error => { state.error = error; finish(); } };
    const updated = (id, change) => {
      if (id !== this.tabId || state.closed) return;
      if (change.status === "loading" || typeof change.url === "string") state.started = true;
      if (!state.started) return;
      this.chrome.tabs.get(this.tabId).then(tab => {
        if (state.closed || tab.status === "loading") return;
        if (tab.url) safePublicUrl(tab.url);
        state.ready = true; finish();
      }).catch(() => {
        if (state.closed) return;
        state.error = new BrowserDriverError("navigation_unavailable", "Chrome could not confirm the new page. Review the tab before continuing.");
        finish();
      });
    };
    this.waiters.add(waiter); this.chrome.tabs.onUpdated.addListener(updated);
    return {
      get started() { return state.started; },
      close: cleanup,
      wait: () => {
        if (this.cancelled) return Promise.reject(abortError());
        if (state.error) return Promise.reject(state.error);
        if (state.ready) return Promise.resolve();
        return new Promise((resolve, reject) => {
          state.resolve = resolve; state.reject = reject;
          state.timer = setTimeout(() => {
            state.error = new BrowserDriverError("navigation_timeout", "Chrome did not confirm the destination page within the time limit.");
            finish(); cleanup();
          }, NAVIGATION_TIMEOUT_MS);
          finish();
        });
      },
    };
  }

  _closePort(error) {
    const port = this.port;
    this.port = null;
    this.documentId = null;
    this.observation = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (port) port.disconnect();
  }

  async _ensureDocument() {
    await this._readyTab();
    const generation = this.generation;
    let results;
    try {
      results = await this.chrome.scripting.executeScript({
        target: { tabId: this.tabId, frameIds: [0] }, files: ["content.js"], world: "ISOLATED",
      });
    } catch {
      throw new BrowserDriverError("site_access_required", "Ollama Copilot needs access to this website. Click Allow this website or its toolbar icon.");
    }
    if (this.cancelled || generation !== this.generation) throw abortError();
    const documentId = results.find((result) => result.frameId === 0)?.documentId;
    if (typeof documentId !== "string" || !documentId) {
      throw new BrowserDriverError("document_unavailable", "Chrome could not identify the page document.");
    }
    if (this.port && documentId === this.documentId) return;
    if (this.lastDocumentId && documentId !== this.lastDocumentId && !this.allowNewDocument) {
      this._closePort(new BrowserDriverError("stale_snapshot", "The page changed outside the last browser action. Start again from this page."));
      throw new BrowserDriverError("stale_snapshot", "The controlled page document changed unexpectedly.");
    }
    this._closePort(new BrowserDriverError("stale_snapshot", "The previous page document is no longer current."));
    this.documentId = documentId;
    this.lastDocumentId = documentId;
    const port = this.chrome.tabs.connect(this.tabId, { name: CHANNEL, documentId });
    this.port = port;
    port.onMessage.addListener((message) => {
      if (this.port !== port || !message || typeof message.id !== "string") return;
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.ok === true && message.result && typeof message.result === "object") item.resolve(message.result);
      else {
        const error = message.error;
        item.reject(error?.code === "cancelled" ? abortError() : new BrowserDriverError(
          typeof error?.code === "string" ? error.code : "browser_error",
          typeof error?.message === "string" ? error.message : "The website could not perform this action.",
        ));
      }
    });
    port.onDisconnect.addListener(() => {
      // Read lastError to acknowledge Chrome's expected old-document disconnect.
      const error = this.chrome.runtime.lastError;
      if (this.port !== port) return;
      const message = this.cancelled ? abortError() : new BrowserDriverError("document_disconnected", "The page connection ended. Observe the new page before continuing.");
      this._closePort(message);
      if (error) console.debug("Ollama Copilot page connection ended:", error.message);
    });
  }

  _request(op, options = {}) {
    if (this.cancelled) return Promise.reject(abortError());
    if (!this.port) return Promise.reject(new BrowserDriverError("document_unavailable", "Observe the current page before acting."));
    const port = this.port;
    const id = crypto.randomUUID();
    const pace = options.action?.kind === "type" ? options.action.text.length * this.settings.typingDelayMs : 0;
    const timeout = Math.min(this.settings.requestTimeoutMs, Math.max(PORT_TIMEOUT_MS, pace + PORT_TIMEOUT_MS));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._closePort(new BrowserDriverError("action_timeout", "The browser action exceeded its time limit and was stopped."));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { port.postMessage({ id, op, ...options }); }
      catch {
        this._closePort(new BrowserDriverError("document_disconnected", "The page connection ended before this action could be confirmed."));
      }
    });
  }

  async observe() {
    await this._ensureDocument();
    const observed = await this._request("observe");
    if (typeof observed.snapshot_id !== "string" || typeof observed.url !== "string" ||
        typeof observed.title !== "string" || typeof observed.text !== "string" ||
        observed.text.length > MAX_EVIDENCE_TEXT || !Array.isArray(observed.elements) || observed.elements.length > MAX_CONTROLS) {
      throw new BrowserDriverError("invalid_observation", "The page returned an invalid browser observation.");
    }
    safePublicUrl(observed.url);
    if (this.history.at(-1) !== observed.url) this.history.push(observed.url);
    const current = this.taskTabs.get(this.tabRef);
    current.url = observed.url;
    current.title = observed.title.slice(0, MAX_CONTROL_LABEL);
    this.observation = { ...observed, document_id: this.documentId, tab_ref: this.tabRef, tabs: this._tabMetadata() };
    this.allowNewDocument = false;
    this._saveTab();
    return this.observation;
  }

  async _executeTabAction(action, target) {
    const generation = this.generation;
    // A model may have been thinking while the user navigated or replaced the document.
    await this._ensureDocument();
    const current = await this._activeTab();
    if (current.url !== this.observation?.url) {
      throw new BrowserDriverError("stale_snapshot", "Observe the changed page before switching or opening a tab.");
    }
    if (action.kind === "open_tab") {
      if (!Number.isInteger(this.settings.maxSteps) || this.taskTabs.size >= this.settings.maxSteps + 1) {
        throw new BrowserDriverError("tab_limit", "The task has reached its tab limit.");
      }
      const resolved = await this._request("execute", { action, start_url: this.startUrl });
      const url = safePublicUrl(resolved.destination);
      if (url !== target.href || resolved.url !== this.observation.url) {
        throw new BrowserDriverError("changed_control", "The observed reading link changed before opening.");
      }
      await this._ensureDocument();
      const source = await this._activeTab();
      if (source.url !== resolved.url) throw new BrowserDriverError("stale_snapshot", "The source page changed before opening the tab.");
      this._assertGeneration(generation);
      let created;
      try { created = await this.chrome.tabs.create({ url, active: true, windowId: this.windowId, openerTabId: this.tabId }); }
      catch { this._assertGeneration(generation); throw new BrowserDriverError("tab_unavailable", "Chrome could not open the observed reading link."); }
      this._assertGeneration(generation);
      if (!created || !Number.isInteger(created.id) || created.windowId !== this.windowId ||
          [...this.taskTabs.values()].some((tab) => tab.id === created.id)) {
        throw new BrowserDriverError("tab_unavailable", "Chrome could not confirm the new task tab.");
      }
      const tab = { ref: crypto.randomUUID(), id: created.id, url, title: String(created.title || "New reading tab").slice(0, MAX_CONTROL_LABEL),
        startUrl: url, history: [url], lastDocumentId: null, pendingOrigin: new URL(url).origin, allowNewDocument: true };
      this._adoptTab(tab);
      this.taskTabs.set(tab.ref, tab);
    } else {
      const tab = this.taskTabs.get(action.tab_ref);
      if (!tab || tab.id === this.tabId) throw new BrowserDriverError("unknown_tab", "Choose another tab observed in this task.");
      let destination;
      try { destination = await this.chrome.tabs.get(tab.id); }
      catch { throw new BrowserDriverError("tab_unavailable", "That task tab is no longer available."); }
      this._assertGeneration(generation);
      if (!destination || destination.id !== tab.id || destination.windowId !== this.windowId) {
        throw new BrowserDriverError("tab_changed", "The task tab moved or is no longer available in its original window.");
      }
      if (destination.url && safePublicUrl(destination.url) !== tab.url) {
        throw new BrowserDriverError("stale_snapshot", "The destination tab changed outside this task.");
      }
      await this._activeTab();
      this._assertGeneration(generation);
      let activated;
      try { activated = await this.chrome.tabs.update(tab.id, { active: true }); }
      catch { this._assertGeneration(generation); throw new BrowserDriverError("tab_unavailable", "Chrome could not activate that task tab."); }
      this._assertGeneration(generation);
      if (!activated || activated.id !== tab.id || activated.windowId !== this.windowId) {
        throw new BrowserDriverError("tab_unavailable", "Chrome could not confirm the selected task tab.");
      }
      this._adoptTab(tab);
    }
    // The actual active tab is checked again by observe. An exact host grant may be
    // needed there; keep the created tab and origin so the explicit grant can work.
    return { status: "executed", url: this.taskTabs.get(this.tabRef).url,
      title: this.taskTabs.get(this.tabRef).title, tab_ref: this.tabRef, tabs: this._tabMetadata() };
  }

  async execute(action) {
    await this._activeTab();
    if (!this.observation) throw new BrowserDriverError("stale_snapshot", "Observe the current page before acting.");
    const target = validateSnapshotAction(action, this.observation, this.startUrl, this.history);
    if (["open_tab", "switch_tab"].includes(action.kind)) return this._executeTabAction(action, target);
    const destination = action.kind === "back" ? this.history.at(-2) : action.kind === "search" ? (() => {
      const url = new URL(safePublicUrl(this.settings.searchUrl));
      url.searchParams.set(this.settings.searchParameter || "q", action.query);
      return safePublicUrl(url.href);
    })() : null;
    if (destination) this.pendingOrigin = new URL(destination).origin;
    else if (action.kind === "navigate") this.pendingOrigin = new URL(action.url).origin;
    const navigation = ["navigate", "back", "search", "click", "press"].includes(action.kind) ? this._watchNavigation() : null;
    try {
      const result = await this._request("execute", {
        action, start_url: this.startUrl, destination, typingDelayMs: this.settings.typingDelayMs,
      });
      this.observation = null;
      this.allowNewDocument = navigation !== null;
      if (result.navigation === true) {
        this.pendingOrigin = new URL(safePublicUrl(result.destination)).origin;
        await navigation.wait();
      } else if (navigation?.started) {
        await navigation.wait();
      }
      if (this.cancelled) throw abortError();
      if (action.kind === "back") this.history.pop();
      this._saveTab();
      return result;
    } finally { navigation?.close(); }
  }

  cancel() {
    this.cancelled = true;
    this.generation += 1;
    for (const waiter of [...this.waiters]) { waiter.cleanup(); waiter.reject(abortError()); }
    this._closePort(abortError());
    return Promise.resolve();
  }
}
