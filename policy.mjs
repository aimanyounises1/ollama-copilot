/** Deterministic browser policy, independent of model confidence. */
export const CHANNEL = "jev-browser-v1";
export const MAX_CONTROLS = 40;
export const MAX_PAGE_TEXT = 8000;
export const MAX_EVIDENCE_TEXT = 8000;
export const MAX_CONTROL_LABEL = 120;
export const MAX_ACTION_TEXT = 1000;
export const MAX_URL_CHARS = 4096;
export const MAX_ACTION_REASON = 240;
export const PORT_TIMEOUT_MS = 30000;
export const NAVIGATION_TIMEOUT_MS = 30000;
export const SENSITIVE = /\b(password|passcode|otp|credit|card|billing|payment|checkout|purchase|buy|pay|delete|remove|unsubscribe|subscribe|sign[ -]?in|log[ -]?in|logout|register|send|upload|accept|agree|email|address|phone|apply|post|comment|message|publish|save)\b|\b(?:close|deactivate|disable|terminate|cancel|erase|open|create)[\s_-]+(?:(?:my|your|this|the|new|bank)[\s_-]+)*(?:account|accounts|membership|subscription|profile)\b|\b(?:account|membership|subscription|profile)[\s_-]+(?:closure|deactivation|termination|cancellation|deletion)\b/i;
const KINDS = new Set(["navigate", "click", "type", "press", "back", "search", "extract", "done"]);
const FIELDS = new Set(["kind", "snapshot_id", "target_id", "url", "text", "key", "reason", "query"]);

export class BrowserDriverError extends Error {
  constructor(code, message) { super(message); this.name = "BrowserDriverError"; this.code = code; }
}

export function safePublicUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_CHARS) {
    throw new BrowserDriverError("unsafe_url", "Choose a public HTTP or HTTPS website.");
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new BrowserDriverError("unsafe_url", "Choose a complete public website URL."); }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port ||
      !hostname.includes(".") || hostname.includes(":") || /^\d+(?:\.\d+)*$/.test(hostname) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|arpa|invalid)$/.test(hostname)) {
    throw new BrowserDriverError("unsafe_url", "Local, credential-bearing and non-web destinations are not automated.");
  }
  return parsed.href;
}

export function validateSnapshotAction(action, observation, startUrl, history = []) {
  if (!action || typeof action !== "object" || Array.isArray(action) ||
      Object.keys(action).some((key) => !FIELDS.has(key)) || !KINDS.has(action.kind) ||
      typeof action.snapshot_id !== "string" || action.snapshot_id !== observation?.snapshot_id ||
      (action.reason != null && (typeof action.reason !== "string" || action.reason.length > MAX_ACTION_REASON))) {
    throw new BrowserDriverError("stale_action", "The proposed action does not match this observation.");
  }
  const needed = { navigate: "url", type: "text", press: "key", search: "query" }[action.kind];
  for (const field of ["url", "text", "key", "query"]) {
    if (field === needed) {
      if (typeof action[field] !== "string" || (field !== "text" && !action[field])) {
        throw new BrowserDriverError("invalid_action", "The proposed action has invalid arguments.");
      }
    } else if (action[field] != null) {
      throw new BrowserDriverError("invalid_action", "The proposed action contains unused arguments.");
    }
  }
  const targeted = ["click", "type", "press"].includes(action.kind);
  const target = targeted ? observation.elements.find((element) => element.id === action.target_id) : null;
  if (targeted && !target || !targeted && action.target_id != null) {
    throw new BrowserDriverError("unknown_target", "The proposed control was not observed on this page.");
  }
  if (action.text?.length > MAX_ACTION_TEXT || action.query?.length > MAX_ACTION_TEXT ||
      action.kind === "press" && !["Enter", "Tab", "Escape"].includes(action.key)) {
    throw new BrowserDriverError("invalid_action", "The proposed input exceeds the supported action limits.");
  }
  if (target && (target.disabled || target.sensitive || SENSITIVE.test([target.label, target.type, target.autocomplete].join(" ")))) {
    throw new BrowserDriverError("manual_review", "This control requires manual handling in Chrome.");
  }
  if (action.kind === "navigate") {
    const destination = safePublicUrl(action.url);
    const allowed = new Set([startUrl, observation.url, ...observation.elements.map((element) => element.href).filter(Boolean)]);
    if (!allowed.has(destination) || SENSITIVE.test(new URL(destination).pathname) ||
        observation.elements.some((element) => element.href === destination && (element.sensitive || SENSITIVE.test(element.label)))) {
      throw new BrowserDriverError("unobserved_url", "Navigate only to an observed public reading destination.");
    }
  }
  if (action.kind === "back" && history.length < 2) {
    throw new BrowserDriverError("no_history", "There is no previous page observed during this task.");
  }
  return target;
}
