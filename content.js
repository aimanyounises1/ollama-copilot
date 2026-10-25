/* Packaged main-frame DOM actor. Chrome executes this in the isolated world. */
(() => {
  "use strict";
  const INSTALL_KEY = "__jevBrowserActorV1";
  if (window.top !== window || globalThis[INSTALL_KEY]) return;
  const CHANNEL = "jev-browser-v1";
  const MAX_CONTROLS = 40;
  const MAX_TEXT = 8000;
  const MAX_LABEL = 120;
  const MAX_INPUT = 1000;
  const MAX_URL = 4096;
  const MAX_TYPING_DELAY = 250;
  const TOKEN_BYTES = 16;
  const CONTROLS = 'a[href],button,input:not([type="hidden"]),textarea,[role="button"],[role="link"]';
  const SENSITIVE = /\b(password|passcode|otp|credit|card|billing|payment|checkout|purchase|buy|pay|delete|remove|unsubscribe|subscribe|sign[ -]?in|log[ -]?in|logout|register|send|upload|accept|agree|email|address|phone|apply|post|comment|message|publish|save)\b|\b(?:close|deactivate|disable|terminate|cancel|erase|open|create)[\s_-]+(?:(?:my|your|this|the|new|bank)[\s_-]+)*(?:account|accounts|membership|subscription|profile)\b|\b(?:account|membership|subscription|profile)[\s_-]+(?:closure|deactivation|termination|cancellation|deletion)\b/i;
  const SENSITIVE_TYPES = new Set(["password", "file", "email", "tel", "number", "date", "datetime-local"]);
  const SEARCH_LABEL = /\b(search|query|find|filter|keyword|keywords|job|jobs|role|location|city|country|title)\b/i;
  const READING_BUTTON = /^(?:go|search|find|filter|next|previous|prev|more|show(?: more)?|load more|menu|read|continue reading|learn more)(?:\b|$)/i;
  const UI_BUTTON = /^(?:open|close)(?:\s+(?:dialog|modal|menu|popover|panel|navigation|tab))?$/i;
  function opaqueId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const documentNonce = opaqueId();

  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function publicUrl(value) {
    let url;
    try { url = new URL(value); }
    catch { fail("unsafe_url", "Choose a complete public website URL."); }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (typeof value !== "string" || value.length > MAX_URL || !["http:", "https:"].includes(url.protocol) ||
        url.username || url.password || url.port || !host.includes(".") || host.includes(":") ||
        /^\d+(?:\.\d+)*$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|arpa|invalid)$/.test(host)) {
      fail("unsafe_url", "This destination requires manual navigation in Chrome.");
    }
    return url.href;
  }
  function visible(element) {
    if (!element.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) ||
          style.opacity === "0" || style.contentVisibility === "hidden") return false;
    }
    return true;
  }
  function metadata(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || (tag === "input" ? "text" : "")).toLowerCase();
    const valueLabel = ["submit", "button", "reset"].includes(type) ? element.value : "";
    const label = (element.getAttribute("aria-label") ||
      (element.labels ? Array.from(element.labels, (item) => item.innerText).join(" ") : "") ||
      element.innerText || element.getAttribute("placeholder") || element.getAttribute("title") ||
      valueLabel || element.getAttribute("name") || "").trim().slice(0, MAX_LABEL);
    const form = element.form;
    const info = {
      tag, role: element.getAttribute("role") || "", type, label,
      href: tag === "a" ? element.href : null,
      form_method: form ? (form.method || "get").toLowerCase() : null,
      form_action: form ? form.action : null,
      form_target: form ? form.target : null,
      submit_method: element.getAttribute("formmethod"),
      submit_action: element.getAttribute("formaction"),
      submit_target: element.getAttribute("formtarget"),
      submit_novalidate: element.hasAttribute("formnovalidate"),
      autocomplete: element.getAttribute("autocomplete") || "",
      name: element.getAttribute("name") || "",
      disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
      readonly: element.readOnly === true,
    };
    info.sensitive = SENSITIVE_TYPES.has(type) || SENSITIVE.test([label, info.autocomplete, info.name].join(" "));
    return info;
  }
  function readingText() {
    const selectors = ["main", '[role="main"]', "article"];
    for (const selector of selectors) {
      const text = Array.from(document.querySelectorAll(selector)).filter(visible)
        .map((element) => (element.innerText || "").trim()).filter(Boolean).join("\n\n");
      if (text) return text.slice(0, MAX_TEXT);
    }
    return document.body && visible(document.body) ? (document.body.innerText || "").trim().slice(0, MAX_TEXT) : "";
  }
  function check(state) {
    if (!state.connected) fail("cancelled", "The browser task was stopped.");
    if (documentNonce !== state.documentNonce || state.snapshot?.url !== location.href) {
      fail("stale_snapshot", "The page changed. Observe it again before acting.");
    }
    if (document.visibilityState === "hidden") fail("tab_changed", "Return to the controlled tab before continuing.");
  }
  function observe(state) {
    if (!state.connected) fail("cancelled", "The browser task was stopped.");
    if (state.busy) fail("busy", "The previous browser action is still running.");
    publicUrl(location.href);
    const elements = [];
    state.elements = new Map();
    for (const element of document.querySelectorAll(CONTROLS)) {
      if (elements.length >= MAX_CONTROLS) break;
      if (!visible(element)) continue;
      const info = metadata(element), id = `e${elements.length}`;
      elements.push({ id, ...info });
      state.elements.set(id, { element, fingerprint: JSON.stringify(info) });
    }
    state.snapshot = { snapshot_id: opaqueId(), url: location.href,
      title: document.title.slice(0, MAX_LABEL), text: readingText(), elements };
    return state.snapshot;
  }
  function currentTarget(state, action) {
    check(state);
    if (action.snapshot_id !== state.snapshot.snapshot_id) fail("stale_snapshot", "The proposed browser reference is stale.");
    const entry = state.elements.get(action.target_id);
    if (!entry || !visible(entry.element) || JSON.stringify(metadata(entry.element)) !== entry.fingerprint) {
      fail("changed_control", "The observed control changed before this action.");
    }
    const info = metadata(entry.element);
    if (info.disabled || info.sensitive) fail("manual_review", "This control requires manual handling in Chrome.");
    return entry.element;
  }
  function defaultSubmitter(form) {
    if (!form) return null;
    return Array.from(form.elements).find((element) => {
      const info = metadata(element);
      return !info.disabled && (info.tag === "button" && (!info.type || info.type === "submit") ||
        info.tag === "input" && ["submit", "image"].includes(info.type));
    }) || null;
  }
  function safeForm(form, submitter = null) {
    if (!form || (form.method || "get").toLowerCase() !== "get") fail("manual_review", "Only public GET search forms are automated.");
    const destination = publicUrl(form.action);
    const target = (form.target || "_self").toLowerCase();
    if (target !== "_self" || SENSITIVE.test(new URL(destination).pathname)) fail("manual_review", "This form needs manual handling in Chrome.");
    if (submitter) {
      const method = (submitter.hasAttribute("formmethod") ? submitter.formMethod : form.method || "get").toLowerCase();
      const action = publicUrl(submitter.hasAttribute("formaction") ? submitter.formAction : form.action);
      const browsingTarget = (submitter.hasAttribute("formtarget") ? submitter.formTarget || "_self" : target).toLowerCase();
      if (method !== "get" || action !== destination || browsingTarget !== "_self" || submitter.formNoValidate) {
        fail("manual_review", "This submit control overrides the observed public search form and needs manual handling.");
      }
    }
    for (const control of form.elements) {
      const info = metadata(control);
      if (info.sensitive || /(?:password|token|secret|csrf|auth|session|credential)/i.test(info.name)) {
        fail("manual_review", "This form contains a sensitive control and needs manual handling.");
      }
    }
  }
  function submitWithNavigation(form, dispatch) {
    let submission = null;
    const observed = event => { submission = event; };
    form.addEventListener("submit", observed, { capture: true });
    try { dispatch(); }
    finally { form.removeEventListener("submit", observed, { capture: true }); }
    return submission && !submission.defaultPrevented ? publicUrl(form.action) : null;
  }
  function editable(element) {
    const info = metadata(element);
    if (!((info.tag === "input" && ["text", "search"].includes(info.type)) || info.tag === "textarea") ||
        info.readonly || info.sensitive || !SEARCH_LABEL.test([info.label, info.name, info.type].join(" "))) {
      fail("manual_review", "Automatic typing is limited to observed public search and filter fields.");
    }
    if (element.form) safeForm(element.form);
    else if (info.type !== "search") fail("manual_review", "This input is not an observed public search field.");
  }
  function validateShape(action) {
    const fields = new Set(["kind", "snapshot_id", "target_id", "url", "text", "key", "reason", "query"]);
    const kinds = new Set(["navigate", "click", "type", "press", "back", "search", "extract", "done"]);
    if (!action || typeof action !== "object" || Array.isArray(action) || !kinds.has(action.kind) ||
        Object.keys(action).some((field) => !fields.has(field)) || typeof action.snapshot_id !== "string") {
      fail("invalid_action", "The proposed browser action is invalid.");
    }
    const targeted = ["click", "type", "press"].includes(action.kind);
    if (targeted ? typeof action.target_id !== "string" : action.target_id != null) fail("invalid_action", "Invalid browser target.");
    const required = { navigate: "url", type: "text", press: "key", search: "query" }[action.kind];
    for (const field of ["url", "text", "key", "query"]) {
      if (field === required) {
        if (typeof action[field] !== "string" || (field !== "text" && !action[field])) fail("invalid_action", "Missing browser action argument.");
      } else if (action[field] != null) fail("invalid_action", "Unused browser action argument.");
    }
    if (action.text?.length > MAX_INPUT || action.query?.length > MAX_INPUT ||
        action.kind === "press" && !["Enter", "Tab", "Escape"].includes(action.key)) fail("invalid_action", "Unsupported browser input.");
  }
  function destination(state, action, message) {
    if (action.kind === "navigate") {
      const target = publicUrl(action.url);
      const allowed = new Set([state.snapshot.url, message.start_url, ...state.snapshot.elements.map((item) => item.href)]);
      if (!allowed.has(target) || state.snapshot.elements.some((item) => item.href === target && item.sensitive)) fail("unobserved_url", "The destination was not an observed public reading link.");
      return target;
    }
    return publicUrl(message.destination);
  }
  async function execute(state, message) {
    const { action } = message;
    validateShape(action); check(state);
    if (state.busy) fail("busy", "Another browser action is running.");
    if (action.snapshot_id !== state.snapshot.snapshot_id) fail("stale_snapshot", "The proposed browser reference is stale.");
    state.busy = true;
    try {
      let navigation = null;
      let nativeNavigation = null;
      if (["navigate", "back", "search"].includes(action.kind)) {
        navigation = destination(state, action, message);
        if (SENSITIVE.test(new URL(navigation).pathname)) fail("manual_review", "This destination requires manual navigation.");
      } else if (action.kind === "click") {
        const element = currentTarget(state, action), info = metadata(element);
        if (info.tag === "a") {
          navigation = publicUrl(info.href);
          if (element.hasAttribute("download") || SENSITIVE.test(new URL(navigation).pathname)) fail("manual_review", "This link requires manual handling.");
        } else {
          if (!READING_BUTTON.test(info.label) && !UI_BUTTON.test(info.label)) fail("manual_review", "This button needs manual handling in Chrome.");
          if (element.form) {
            safeForm(element.form, element);
            nativeNavigation = submitWithNavigation(element.form, () => currentTarget(state, action).click());
          } else currentTarget(state, action).click();
        }
      } else if (action.kind === "type") {
        const delay = message.typingDelayMs;
        if (!Number.isFinite(delay) || delay < 0 || delay > MAX_TYPING_DELAY) fail("invalid_action", "Invalid typing pace.");
        const element = currentTarget(state, action);
        editable(element); element.focus();
        currentTarget(state, action); editable(element);
        if (document.activeElement !== element) fail("focus_changed", "The observed input lost focus.");
        element.setRangeText("", 0, element.value.length, "end");
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
        for (const character of action.text) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          currentTarget(state, action); editable(element);
          if (document.activeElement !== element) fail("focus_changed", "The observed input lost focus.");
          const start = element.selectionStart ?? element.value.length;
          const end = element.selectionEnd ?? start;
          element.setRangeText(character, start, end, "end");
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
        }
        currentTarget(state, action); editable(element);
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (action.kind === "press") {
        const element = currentTarget(state, action);
        if (action.key === "Enter") {
          editable(element);
          const submitter = defaultSubmitter(element.form);
          safeForm(element.form, submitter);
          nativeNavigation = submitWithNavigation(element.form, () => element.form.requestSubmit(submitter || undefined));
        } else if (action.key === "Escape") {
          element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          element.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
        } else {
          const entries = Array.from(state.elements.values());
          const index = entries.findIndex((entry) => entry.element === element);
          const next = entries.slice(index + 1).find((entry) => visible(entry.element) && !metadata(entry.element).sensitive && !metadata(entry.element).disabled);
          if (next) next.element.focus();
        }
      }
      check(state);
      const result = { status: "executed", url: location.href, title: document.title.slice(0, MAX_LABEL) };
      if (["extract", "done"].includes(action.kind)) result.text = readingText();
      state.snapshot = null;
      if (nativeNavigation) { result.navigation = true; result.destination = nativeNavigation; }
      if (navigation) {
        result.navigation = true; result.destination = navigation;
        state.pendingNavigation = navigation;
      }
      return result;
    } finally { state.busy = false; }
  }

  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender;
    const expected = chrome.runtime.getURL("sidepanel.html");
    if (port.name !== CHANNEL || sender?.id !== chrome.runtime.id || sender.url?.split(/[?#]/, 1)[0] !== expected) {
      port.disconnect(); return;
    }
    const state = { connected: true, snapshot: null, elements: new Map(), busy: false, documentNonce, pendingNavigation: null };
    port.onDisconnect.addListener(() => { state.connected = false; state.snapshot = null; state.elements.clear(); });
    port.onMessage.addListener((message) => {
      if (!message || typeof message.id !== "string" || !["observe", "execute"].includes(message.op)) return;
      const task = message.op === "observe" ? Promise.resolve().then(() => observe(state)) : execute(state, message);
      task.then((result) => {
        if (!state.connected) return;
        port.postMessage({ id: message.id, ok: true, result });
        if (state.pendingNavigation) {
          const target = state.pendingNavigation; state.pendingNavigation = null;
          queueMicrotask(() => { if (state.connected) location.assign(target); });
        }
      }).catch((error) => {
        if (state.connected) port.postMessage({ id: message.id, ok: false,
          error: { code: error.code || "browser_error", message: error.code ? error.message : "The page could not complete this browser action." } });
      });
    });
  });
  globalThis[INSTALL_KEY] = true;
})();
