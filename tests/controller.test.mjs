import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../config.mjs";
import { AgentRun, CAPTURE_LIMITS, createReport, restoreCheckpoint, sourceUrl } from "../controller.mjs";

const URL = "https://careers.fixture.example/roles/123";
const NOW = "2026-10-25T06:00:00.000Z";
const TEST_TIMEOUT_MS = 4000;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture({ kinds = ["done"], score = 0.95, contents = ["Captured evidence"], maximum = 6 } = {}) {
  const calls = [];
  const updates = [];
  let observed = 0;
  let proposed = 0;
  const settings = { ...DEFAULT_SETTINGS, maxSteps: maximum };
  const driver = {
    async bindCurrentTab() { calls.push("bind"); return { tabId: 7, url: URL, title: "Senior AI Engineer" }; },
    async observe() { calls.push("observe"); const index = observed++; return { snapshot_id: `snapshot-${index}`, url: URL, title: "Senior AI Engineer", text: contents[Math.min(index, contents.length - 1)], elements: [{ id: "e0", tag: "a", label: "Read role", href: URL }] }; },
    async execute(action) { calls.push(`execute:${action.kind}`); return { status: "executed", url: URL, title: "Senior AI Engineer" }; },
    async cancel() { calls.push("cancel"); },
  };
  const client = {
    async route() { calls.push("route"); return { model: settings.fastModel, modelRole: "fast", tool: "read", confidence: 0.91, durationMs: 5, fallbackReason: null }; },
    async propose(goal, observation) { calls.push("propose"); const kind = kinds[Math.min(proposed++, kinds.length - 1)]; return { kind, snapshot_id: observation.snapshot_id, reason: "Read the requested role", ...(kind === "click" ? { target_id: "e0" } : {}) }; },
    async judge() { calls.push("judge"); return { score, durationMs: 3 }; },
  };
  const run = new AgentRun(settings, { client, driver, onUpdate: async state => updates.push(state), now: () => NOW, idFactory: () => "test-mission" });
  return { run, settings, driver, client, calls, updates };
}

test("routes, proposes, judges and executes in order with source identity", async () => {
  const f = fixture();
  const state = await f.run.start("Find a role");
  assert.equal(state.status, "completed");
  assert.deepEqual(f.calls, ["bind", "observe", "route", "propose", "judge", "execute:done", "cancel"]);
  assert.equal(state.actions[0].status, "executed");
  assert.equal(state.sources[0].url, URL);
  assert.equal(state.sources[0].text, "Captured evidence");
  assert.equal(state.sources[0].capturedAt, NOW);
  assert.equal(state.sources[0].contentHash, "95682092565ae69db29d25738ab9eeb0076c81c095789ada186f314a84b94ce4");
  assert.equal(state.decisionModel, DEFAULT_SETTINGS.decisionModel);
  assert.match(state.report, /Task status: completed/);
  assert.match(state.report, /Captured evidence/);
  assert.ok(f.updates.some(update => update.actions[0]?.status === "pending"));
});

test("low judgment pauses without dispatching or claiming evidence", async () => {
  const f = fixture({ score: 0.1 });
  const state = await f.run.start("Find a role");
  assert.equal(state.status, "paused");
  assert.equal(state.actions[0].status, "paused");
  assert.equal(state.sources.length, 0);
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
});

test("Stop during a pending planner prevents judgment and execution", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  f.client.propose = async (goal, observation) => { f.calls.push("propose"); entered.resolve(); return { ...await release.promise, snapshot_id: observation.snapshot_id }; };
  const pending = f.run.start("Read the role");
  await entered.promise;
  await f.run.stop();
  release.resolve({ kind: "done", reason: "Finish" });
  const state = await pending;
  assert.equal(state.status, "stopped");
  assert.ok(!f.calls.includes("judge"));
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
});

test("Stop during in-flight execution records an unconfirmed action and no next action", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture({ kinds: ["click", "done"] }); const entered = deferred(); const release = deferred();
  f.driver.execute = async action => { f.calls.push(`execute:${action.kind}`); entered.resolve(); await release.promise; return { status: "executed", url: URL }; };
  const pending = f.run.start("Open the role");
  await entered.promise; await f.run.stop(); release.resolve();
  const state = await pending;
  assert.equal(state.status, "stopped");
  assert.equal(state.actions[0].status, "unconfirmed");
  assert.equal(state.actions.length, 1);
  assert.equal(state.sources.length, 0);
  assert.equal(f.calls.filter(call => call === "observe").length, 1);
});

test("bounded steps retain exact source evidence with explicit partial status", async () => {
  const f = fixture({ kinds: ["extract"], maximum: 2 });
  const state = await f.run.start("Read the role");
  assert.equal(state.status, "limit_reached");
  assert.equal(state.step, 2);
  assert.equal(state.actions.length, 2);
  assert.equal(state.sources.length, 1);
  assert.match(state.report, /limit reached/);
  assert.ok(state.actions.every(action => action.status === "executed"));
});

test("same URL and hash deduplicate while changed captures remain distinct", async () => {
  const f = fixture({ kinds: ["extract", "extract", "done"], contents: ["First capture", "First capture", "Changed capture"] });
  const state = await f.run.start("Compare role details");
  assert.equal(state.sources.length, 2);
  assert.deepEqual(state.sources.map(source => source.number), [1, 2]);
  assert.deepEqual(state.sources.map(source => source.contentHash), ["f8d42178b19bd11a62758e17ff1c8e5c381520dba5894b33f92c599711ae080e", "4758a7042c76ffeca8798517e5875a25207d923606d48a53d9d5f75983dcd0c2"]);
});

test("captures are bounded and never replace observed text with a browser reply", async () => {
  const raw = "A".repeat(CAPTURE_LIMITS.maxChars + 9);
  const f = fixture({ contents: [raw] });
  f.driver.execute = async () => ({ status: "executed", url: URL, text: "Invented salary" });
  const state = await f.run.start("Read the listing");
  assert.equal(state.sources[0].text, raw.slice(0, CAPTURE_LIMITS.maxChars));
  assert.ok(!state.report.includes("Invented salary"));
});

test("capture navigation mismatch fails while retaining confirmed action outcome", async () => {
  const f = fixture();
  f.driver.execute = async () => ({ status: "executed", url: "https://careers.fixture.example/other" });
  const state = await f.run.start("Read the listing");
  assert.equal(state.status, "failed");
  assert.equal(state.actions[0].status, "executed");
  assert.equal(state.sources.length, 0);
});

test("unknown planner fields and unconfigured routes fail closed", async () => {
  const f = fixture();
  f.client.propose = async (goal, observation) => ({ kind: "done", snapshot_id: observation.snapshot_id, reason: "Done", javascript: "alert(1)" });
  let state = await f.run.start("Read a role");
  assert.equal(state.status, "failed"); assert.ok(!f.calls.some(call => call.startsWith("execute:")));
  const g = fixture();
  g.client.route = async () => ({ model: "invented:model", modelRole: "fast", tool: "read", confidence: 1, durationMs: 1 });
  state = await g.run.start("Read a role");
  assert.equal(state.status, "failed"); assert.ok(!g.calls.includes("propose"));
});

test("restoring an active checkpoint interrupts it without replay and marks pending action uncertain", async () => {
  const f = fixture();
  const saved = await f.run.start("Read a role");
  saved.status = "running"; saved.actions[0].status = "pending";
  const callsBefore = [...f.calls];
  const restored = restoreCheckpoint(saved);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.actions[0].status, "unconfirmed");
  assert.equal(restored.sources[0].contentHash, saved.sources[0].contentHash);
  assert.equal(restored.decisionModel, DEFAULT_SETTINGS.decisionModel);
  assert.deepEqual(f.calls, callsBefore);
});

test("unsafe source URLs and malformed checkpoints stay inert", async () => {
  for (const url of ["javascript:alert(1)", "https://name:secret@example.com/", "http://localhost/", "http://127.0.0.1/", "https://metadata.google.internal/", "https://[::1]/"]) assert.throws(() => sourceUrl(url));
  const f = fixture(); const saved = await f.run.start("Read a role");
  saved.sources[0].url = "javascript:alert(1)";
  assert.equal(restoreCheckpoint(saved), null);
});

test("report formatting makes hostile HTML and Markdown literal", async () => {
  const f = fixture({ contents: ["<script>alert(1)</script> [Claim](javascript:alert(1))"] });
  const saved = await f.run.start("<img src=x onerror=alert(1)> [task](javascript:alert(1))");
  assert.ok(!saved.report.includes("<script>"));
  assert.ok(!saved.report.includes("<img"));
  assert.ok(!saved.report.includes("[Claim](javascript:"));
  assert.match(saved.report, /&lt;script&gt;/);
  assert.match(saved.report, /\[1\] \[Senior AI Engineer\]\(<https:\/\/careers.fixture.example\/roles\/123>\)/);
});

test("published state clones cannot mutate the live controller", async () => {
  const f = fixture(); await f.run.start("Read a role");
  f.updates.at(-1).sources[0].text = "Changed externally";
  const copy = f.run.state; copy.actions[0].status = "unconfirmed";
  assert.equal(f.run.state.sources[0].text, "Captured evidence");
  assert.equal(f.run.state.actions[0].status, "executed");
});

test("one checkpoint failure stops execution and the terminal retry renders failure", async () => {
  const f = fixture(); const visible = []; let failedOnce = false;
  f.run.onUpdate = async state => {
    visible.push(state);
    if (state.actions[0]?.status === "pending" && !failedOnce) { failedOnce = true; throw new Error("storage unavailable"); }
  };
  const state = await f.run.start("Read a role");
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
  assert.ok(f.calls.includes("cancel"));
  assert.equal(f.run.isRunning, false);
  assert.equal(state.status, "failed");
  assert.equal(visible.at(-1).status, "failed");
  assert.equal(visible.at(-1).actions[0].status, "cancelled");
});

test("persistent checkpoint failure still delivers terminal state and rejects publicly", async () => {
  const f = fixture(); const visible = [];
  f.run.onUpdate = async state => { visible.push(state); throw new Error("private storage diagnostics"); };
  await assert.rejects(f.run.start("Read a role"), error => error.code === "checkpoint_failed" && !error.message.includes("private"));
  assert.ok(!f.calls.includes("bind"));
  assert.ok(f.calls.includes("cancel"));
  assert.equal(f.run.isRunning, false);
  assert.equal(f.run.state.status, "failed");
  assert.equal(visible.at(-1).status, "failed");
});

test("reports escape restored timestamp text rather than interpreting it", async () => {
  const f = fixture(); const saved = await f.run.start("Read a role");
  saved.sources[0].capturedAt = "<script>alert(1)</script>";
  const report = createReport(saved);
  assert.ok(!report.includes("<script>"));
});


test("source count is bounded independently of the action budget", async () => {
  const f = fixture({ kinds: ["extract"], maximum: CAPTURE_LIMITS.maxSources + 2, contents: Array.from({ length: CAPTURE_LIMITS.maxSources + 2 }, (_, index) => `Captured version ${index}`) });
  const state = await f.run.start("Read distinct evidence");
  assert.equal(state.status, "limit_reached");
  assert.equal(state.sources.length, CAPTURE_LIMITS.maxSources);
  assert.equal(state.actions.length, CAPTURE_LIMITS.maxSources + 1);
});

test("nonfinite judgments fail before browser dispatch", async () => {
  const f = fixture(); f.client.judge = async () => ({ score: Number.NaN, durationMs: 1 });
  const state = await f.run.start("Read the listing");
  assert.equal(state.status, "failed");
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
});


test("long browser tab titles are bounded without blocking a readable task", async () => {
  const f = fixture(); const original = f.driver.bindCurrentTab;
  f.driver.bindCurrentTab = async () => ({ ...await original(), title: "Long title ".repeat(100) });
  const state = await f.run.start("Read this page");
  assert.equal(state.status, "completed");
  assert.ok(state.tab.title.length < 300);
});
