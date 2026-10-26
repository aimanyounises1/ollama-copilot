/** Trusted extension page: explicit user starts, local inference and safe text-only views. */
import { DEFAULT_SETTINGS, LIMITS, validateSettings } from "./config.mjs";
import { ModelClient } from "./model-client.mjs";
import { BrowserDriver } from "./browser-driver.mjs";
import { AgentRun, restoreCheckpoint, sourceUrl } from "./controller.mjs";

const STORAGE_KEYS = Object.freeze({ settings: "jevSettings", checkpoint: "jevCheckpoint" });
const ACTIVE = new Set(["running", "stopping"]);
const FIELD_IDS = Object.freeze(["ollama-url", "decision-model", "fast-model", "strong-model", "max-steps", "typing-delay", "search-url"]);
const STATUS_TEXT = Object.freeze({ idle: "Ready when you are.", running: "Ollama Copilot is working on the selected tab.", stopping: "Stopping browser control…", stopped: "Stopped. Captured evidence is retained.", completed: "Task complete. Captured evidence is ready.", paused: "Paused for review.", failed: "The task needs attention.", limit_reached: "Step limit reached. Captured evidence is retained.", interrupted: "Previous task interrupted. Start again to continue." });
const byId = id => document.getElementById(id);
let settings = validateSettings(DEFAULT_SETTINGS);
let currentRun = null;
let currentState = null;
let healthAbort = null;
let pendingUi = false;

function notice(message) { byId("run-status").textContent = message; }
function connection(message, state = "disconnected") {
  byId("connection-status").textContent = message;
  byId("connection-status").dataset.state = state;
}
function fillSettings() {
  const values = { "ollama-url": settings.ollamaUrl, "decision-model": settings.decisionModel, "fast-model": settings.fastModel, "strong-model": settings.strongModel, "max-steps": settings.maxSteps, "typing-delay": settings.typingDelayMs, "search-url": settings.searchUrl };
  for (const [id, value] of Object.entries(values)) byId(id).value = String(value);
  byId("max-steps").min = "1"; byId("max-steps").max = String(LIMITS.maxSteps);
  byId("typing-delay").min = "0"; byId("typing-delay").max = String(LIMITS.maxTypingDelayMs);
  byId("goal").maxLength = Math.min(byId("goal").maxLength, LIMITS.maxGoalChars);
}
function readSettings() {
  return validateSettings({ ...settings, ollamaUrl: byId("ollama-url").value.trim(), decisionModel: byId("decision-model").value.trim(), fastModel: byId("fast-model").value.trim(), strongModel: byId("strong-model").value.trim(), maxSteps: Number(byId("max-steps").value), typingDelayMs: Number(byId("typing-delay").value), searchUrl: byId("search-url").value.trim() });
}
function controls() {
  const busy = pendingUi || ACTIVE.has(currentState?.status);
  byId("start-button").disabled = busy;
  byId("stop-button").disabled = currentState?.status !== "running";
  byId("goal").disabled = busy;
  for (const id of [...FIELD_IDS, "save-settings", "check-models", "grant-site"]) byId(id).disabled = busy;
  byId("export-button").disabled = !currentState?.sources?.length;
}
function render(state) {
  currentState = state;
  if (!state) { controls(); return; }
  notice(state.error || STATUS_TEXT[state.status] || "Task state is unavailable.");
  byId("run-progress").max = state.maxSteps;
  byId("run-progress").value = state.step;
  if (state.tab) byId("tab-status").textContent = `${state.tab.title || "Selected website"}\n${state.tab.url}${state.tabs?.length ? `\n${state.tabs.length} task-owned tab${state.tabs.length === 1 ? "" : "s"}` : ""}`;
  byId("route-status").textContent = state.route ? `Using ${state.route.model} for ${state.route.tool}. Decision model: ${state.decisionModel || "not recorded"}.${state.route.fallbackReason ? ` ${state.route.fallbackReason}` : ""}` : "The decision model chooses a configured LLM.";
  if (state.route) connection("Models ready", "connected");
  const sources = byId("sources-list"); sources.replaceChildren();
  for (const source of state.sources) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.textContent = `[${source.number}] ${source.title || "Captured page"}`;
    link.href = sourceUrl(source.url); link.target = "_blank"; link.rel = "noopener noreferrer";
    const captured = document.createElement("small"); captured.textContent = `Captured ${source.capturedAt}`;
    item.append(link, captured); sources.append(item);
  }
  const activity = byId("activity-list"); activity.replaceChildren();
  for (const entry of [...state.activity].reverse()) {
    const item = document.createElement("li");
    const message = document.createElement("span"); message.textContent = entry.message;
    const time = document.createElement("time"); time.dateTime = entry.at; time.textContent = entry.at;
    item.append(message, time); activity.append(item);
  }
  byId("report-content").textContent = state.report || "Captured page evidence will appear here.";
  controls();
}
function safeMessage(error) {
  return ["ModelClientError", "BrowserDriverError", "AgentRunError"].includes(error?.name) && typeof error.message === "string" ? error.message : "Ollama Copilot could not complete this operation. Check model settings and website access.";
}
async function checkpoint(state) {
  render(state);
  await chrome.storage.session.set({ [STORAGE_KEYS.checkpoint]: state });
}
async function start(event) {
  event.preventDefault();
  if (pendingUi || currentRun?.isRunning) return;
  const goal = byId("goal").value.trim();
  if (!goal) { byId("goal").focus(); return; }
  pendingUi = true; controls();
  try {
    settings = readSettings();
    const client = new ModelClient(settings);
    const driver = new BrowserDriver(settings);
    currentRun = new AgentRun(settings, { client, driver, onUpdate: checkpoint });
    await currentRun.start(goal);
  } catch (error) { notice(safeMessage(error)); }
  finally { pendingUi = false; controls(); }
}
async function stop() {
  if (!currentRun?.isRunning) return;
  try { await currentRun.stop(); }
  catch { notice("Browser control could not confirm a clean Stop. Close this panel and review the tab."); }
}
async function save() {
  if (pendingUi || currentRun?.isRunning) return;
  try {
    settings = readSettings();
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    fillSettings(); connection("Settings saved"); notice("Settings saved. Check models or start a task.");
  } catch (error) { notice(safeMessage(error)); }
}
async function checkModels() {
  if (pendingUi || currentRun?.isRunning) return;
  pendingUi = true; healthAbort = new AbortController(); controls(); connection("Checking models…");
  try {
    const selected = readSettings();
    const client = new ModelClient(selected);
    const models = await client.listModels(healthAbort.signal);
    const names = new Set(models.map(model => model.name));
    const missing = [...new Set([selected.decisionModel, selected.fastModel, selected.strongModel])].filter(name => !names.has(name) && !names.has(`${name}:latest`));
    if (missing.length) { connection("Models missing", "error"); notice(`Install these configured models in Ollama or choose installed models: ${missing.join(", ")}.`); return; }
    if (typeof client.prepareModels === "function") await client.prepareModels(healthAbort.signal);
    connection("Models ready", "connected"); notice("The configured decision and chat models are available.");
  } catch (error) {
    if (error?.name === "AbortError") return;
    connection("Connection failed", "error");
    notice(`${safeMessage(error)} Check that Ollama is running and OLLAMA_ORIGINS allows chrome-extension://${chrome.runtime.id}.`);
  } finally { pendingUi = false; healthAbort = null; controls(); }
}
async function grantSite() {
  if (pendingUi || currentRun?.isRunning) return;
  pendingUi = true; controls();
  try {
    // Keep the ended mission's pinned tab and pending origin. Chrome may hide
    // its URL after cross-origin navigation until the user grants that site.
    const driver = currentRun?.driver || new BrowserDriver(readSettings());
    await driver.grantCurrentSite();
    byId("tab-status").textContent = "Website access granted for the selected tab.";
    notice("Website access granted. Start a new task on this tab.");
  } catch (error) { notice(safeMessage(error)); }
  finally { pendingUi = false; controls(); }
}
function exportResearch() {
  if (!currentState?.sources?.length || !currentState.report) return;
  const blob = new Blob([currentState.report], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url;
  anchor.download = `ollama-copilot-research-${currentState.id.slice(0, 12)}.md`;
  document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}
async function initialize() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const [local, session] = await Promise.all([chrome.storage.local.get(STORAGE_KEYS.settings), chrome.storage.session.get(STORAGE_KEYS.checkpoint)]);
    if (local[STORAGE_KEYS.settings]) {
      try { settings = validateSettings(local[STORAGE_KEYS.settings]); }
      catch { notice("Saved settings were invalid. Review the default settings before starting."); }
    }
    fillSettings();
    const restored = restoreCheckpoint(session[STORAGE_KEYS.checkpoint]);
    if (restored) { byId("goal").value = restored.goal; render(restored); await chrome.storage.session.set({ [STORAGE_KEYS.checkpoint]: restored }); }
    else controls();
    byId("task-form").addEventListener("submit", start);
    byId("stop-button").addEventListener("click", stop);
    byId("save-settings").addEventListener("click", save);
    byId("check-models").addEventListener("click", checkModels);
    byId("grant-site").addEventListener("click", grantSite);
    byId("export-button").addEventListener("click", exportResearch);
  } catch {
    pendingUi = true; controls(); notice("Extension storage could not be initialized. Reopen the panel before starting a task.");
  }
}
window.addEventListener("pagehide", () => {
  healthAbort?.abort();
  if (currentRun?.isRunning) currentRun.stop().catch(() => console.warn("Ollama Copilot could not persist the final Stop checkpoint after the panel closed."));
});
initialize();
