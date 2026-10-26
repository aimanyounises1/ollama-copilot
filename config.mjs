/** Named defaults and bounded settings for the local-only Chrome agent. */
export const DEFAULT_SETTINGS = Object.freeze({
  ollamaUrl: "http://127.0.0.1:11434", decisionModel: "tev1:4b", fastModel: "qwen3.8:latest", strongModel: "qwen3.8:latest",
  maxSteps: 12, typingDelayMs: 40, requestTimeoutMs: 120000, minimumRelevance: 0.55, routeConfidence: 0.1,
  searchUrl: "https://www.google.com/search", searchParameter: "q",
});
export const LIMITS = Object.freeze({
  maxSteps: 30, maxTypingDelayMs: 250, maxRequestTimeoutMs: 300000, maxGoalChars: 2000,
  decisionGoalChars: 800, maxSourceChars: 20000, maxObservationChars: 8000, decisionObservationChars: 600,
  maxControls: 40, maxLabelChars: 160, maxTitleChars: 200, maxHistory: 12, maxModelNameChars: 200,
  maxModels: 200, maxUrlChars: 4096, maxSnapshotChars: 128, maxTargetChars: 64, maxActionText: 1000,
  maxSearchQuery: 500, maxReasonChars: 240, maxRequestBytes: 65536, maxResponseBytes: 262144,
  plannerOutputTokens: 500, plannerContextTokens: 8192, probabilityTolerance: 0.02,
});
export const ENDPOINTS = Object.freeze({ models: "/api/tags", show: "/api/show", chat: "/api/chat", decisions: "/v1/systemone" });
export function validModelName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= LIMITS.maxModelNameChars
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}
export function validateSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settings must be an object.");
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_SETTINGS, key))) throw new TypeError("Settings contain an unknown option.");
  const result = { ...DEFAULT_SETTINGS, ...input };
  let local;
  let search;
  try { local = new URL(result.ollamaUrl); search = new URL(result.searchUrl); }
  catch { throw new TypeError("Model and search addresses must be valid URLs."); }
  if (local.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(local.hostname)
      || local.username || local.password || local.port === "0" || local.pathname !== "/" || local.search || local.hash) {
    throw new TypeError("Ollama must use a literal loopback HTTP origin without credentials or a path.");
  }
  if (search.protocol !== "https:" || search.username || search.password || search.search || search.hash
      || ["localhost", "127.0.0.1", "[::1]"].includes(search.hostname)
      || /^[\d.:]+$/.test(search.hostname) || !search.hostname.includes(".")) {
    throw new TypeError("The search address must be a public HTTPS URL without credentials, query or fragment.");
  }
  if (typeof result.searchParameter !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(result.searchParameter)) {
    throw new TypeError("The search parameter must be a short query-field name.");
  }
  for (const name of ["decisionModel", "fastModel", "strongModel"]) {
    if (!validModelName(result[name]) || result[name].endsWith(":cloud")) throw new TypeError("Model names must identify local Ollama models.");
  }
  for (const [name, minimum, maximum] of [["maxSteps", 1, LIMITS.maxSteps], ["typingDelayMs", 0, LIMITS.maxTypingDelayMs], ["requestTimeoutMs", 1, LIMITS.maxRequestTimeoutMs]]) {
    if (!Number.isInteger(result[name]) || result[name] < minimum || result[name] > maximum) throw new TypeError(`${name} is outside its supported bounds.`);
  }
  for (const name of ["minimumRelevance", "routeConfidence"]) {
    if (typeof result[name] !== "number" || !Number.isFinite(result[name]) || result[name] < 0 || result[name] > 1) throw new TypeError(`${name} must be a probability from zero through one.`);
  }
  result.ollamaUrl = local.origin; result.searchUrl = search.href;
  return Object.freeze(result);
}
