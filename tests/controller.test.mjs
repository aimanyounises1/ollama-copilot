import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../config.mjs";
import { createBrowserActionTool } from "../agent-tools.mjs";
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

for (const kind of ["type", "search"]) test(`rejected ${kind} identifies the planner proposal without logging raw input`, async () => {
  const f = fixture({ score: 0.48 });
  const hiddenInput = "raw-input-must-not-appear-in-activity";
  const reason = "Inspect public role details before claiming a matching job";
  f.client.route = async () => ({ model: f.settings.fastModel, modelRole: "fast", tool: kind === "search" ? "search" : "interact", confidence: 0.05, durationMs: 1, fallbackReason: "Tool selection was uncertain; use the interact strategy with observed controls." });
  f.client.propose = async (goal, observation) => ({ kind, snapshot_id: observation.snapshot_id, reason,
    ...(kind === "type" ? { target_id: "e0", text: hiddenInput } : { query: hiddenInput }) });
  const state = await f.run.start("Find a suitable public role");
  const activity = state.activity.map(entry => entry.message);
  assert.equal(state.status, "paused");
  assert.equal(state.actions[0].status, "paused");
  assert.equal(state.actions[0].score, 0.48);
  assert.equal(f.settings.minimumRelevance, 0.55);
  assert.ok(activity.includes(`Planner proposal: ${kind}; reason: ${reason}`));
  assert.ok(activity.includes(`Rejected ${kind}; not executed.`));
  assert.ok(activity.includes("Action judgment: 0.48; minimum 0.55."));
  assert.ok(activity.every(message => message.length <= CAPTURE_LIMITS.activityChars && !message.includes(hiddenInput)));
  assert.ok(!activity.some(message => /judge reason|decision model reason/i.test(message)));
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
  assert.equal(state.sources.length, 0);
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), error => error.code === "not_resumable");
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

test("report retains late requirements from the complete bounded source without changing its hash", async () => {
  const raw = "Header\n" + "x".repeat(6000) + "\nRequirements: Python and distributed systems. Location: Israel.\n<script>literal</script> [link](unsafe)\n" + "y".repeat(CAPTURE_LIMITS.maxChars) + "\nAFTER_CAPTURE_BOUNDARY";
  const f = fixture({ contents: [raw] });
  const state = await f.run.start("Read the individual role and its requirements");
  const source = { ...state.sources[0] };
  assert.equal(source.text.length, CAPTURE_LIMITS.maxChars);
  assert.equal(source.contentHash, "c067b7c6feb8a73242e86da5bd68592f7f103fa062b7254b6cf9caa856c7f701");
  assert.ok(state.report.includes("Requirements: Python and distributed systems. Location: Israel."));
  assert.ok(state.report.includes("&lt;script&gt;literal&lt;/script&gt;"));
  assert.ok(!state.report.includes("<script>"));
  assert.ok(!state.report.includes("AFTER_CAPTURE_BOUNDARY"));
  assert.equal(createReport(state), state.report);
  assert.deepEqual(state.sources[0], source);
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


function tabFixture() {
  const f = fixture();
  const home = "https://careers.fixture.example/search";
  const detail = URL;
  let current = "task-search";
  let detailOpened = false;
  let sequence = 0;
  const metadata = () => ({
    tab_ref: current,
    tabs: [
      { ref: "task-search", url: home, title: "Job search", active: current === "task-search", tabId: 7 },
      ...(detailOpened ? [{ ref: "task-detail", url: detail, title: "Senior AI Engineer", active: current === "task-detail", tabId: 9 }] : []),
    ],
  });
  const page = () => ({ url: current === "task-search" ? home : detail, title: current === "task-search" ? "Job search" : "Senior AI Engineer", ...metadata() });
  f.driver.bindCurrentTab = async () => { f.calls.push("bind"); return { tabId: 7, ...page() }; };
  f.driver.observe = async () => { f.calls.push("observe"); return { snapshot_id: `tabs-${sequence++}`, ...page(), text: current === "task-search" ? "Visible search result" : "Exact job detail evidence", elements: [{ id: "role-link", tag: "a", label: "Read role", href: detail }] }; };
  f.driver.execute = async action => {
    f.calls.push(`execute:${action.kind}`);
    if (action.kind === "open_tab") { detailOpened = true; current = "task-detail"; }
    if (action.kind === "switch_tab") current = action.tab_ref;
    return { status: "executed", ...page() };
  };
  const actions = [
    { kind: "open_tab", target_id: "role-link" },
    { kind: "extract" },
    { kind: "switch_tab", tab_ref: "task-search" },
    { kind: "done" },
  ];
  let proposed = 0;
  f.client.propose = async (goal, observation) => { f.calls.push("propose"); return { ...actions[proposed++], snapshot_id: observation.snapshot_id, reason: "Continue the observed job research" }; };
  return f;
}

test("task tabs update current UI metadata and keep captured evidence at its actual source", async () => {
  const f = tabFixture();
  const state = await f.run.start("Open a job detail tab, capture it and return to search");
  assert.equal(state.status, "completed");
  assert.deepEqual(state.actions.map(action => action.kind), ["open_tab", "extract", "switch_tab", "done"]);
  assert.equal(state.actions[2].tab_ref, "task-search");
  assert.equal(state.tab.tab_ref, "task-search");
  assert.equal(state.tab.title, "Job search");
  assert.equal(state.tabs.length, 2);
  assert.deepEqual(Object.keys(state.tabs[0]), ["ref", "title", "url", "active"]);
  assert.equal(state.sources[0].url, URL);
  assert.equal(state.sources[0].text, "Exact job detail evidence");
  assert.equal(state.sources[1].url, "https://careers.fixture.example/search");
  assert.ok(f.updates.some(update => update.tab?.tab_ref === "task-detail" && update.tab.url === URL));
  const restored = restoreCheckpoint(state);
  assert.equal(restored.status, "completed");
  assert.equal(restored.tab.tab_ref, "task-search");
  assert.equal(restored.actions[2].tab_ref, "task-search");
  assert.deepEqual(restored.tabs, state.tabs);
});

test("unknown task tab proposals fail before judgment or dispatch even with an injected planner", async () => {
  const f = tabFixture();
  f.client.propose = async (goal, observation) => ({ kind: "switch_tab", snapshot_id: observation.snapshot_id, tab_ref: "user-private-tab", reason: "Switch" });
  const state = await f.run.start("Read jobs");
  assert.equal(state.status, "failed");
  assert.ok(!f.calls.includes("judge"));
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
  assert.equal(state.sources.length, 0);
});

test("malformed saved tab catalogs are inert and legacy checkpoints still restore", async () => {
  const f = tabFixture();
  const saved = await f.run.start("Read a role");
  saved.tabs[1].ref = saved.tabs[0].ref;
  assert.equal(restoreCheckpoint(saved), null);
  const legacy = await fixture().run.start("Read one page");
  delete legacy.tabs;
  assert.equal(restoreCheckpoint(legacy).status, "completed");
});


test("the compiled graph has distinct review, saved-checkpoint and execution branches", async () => {
  const f = fixture();
  await f.run.start("Read a role through the graph");
  const topology = await f.run.graph.getGraphAsync({});
  for (const name of ["bind", "observe", "route", "propose", "judge", "prepare_action", "execute", "capture", "finalize"]) {
    assert.ok(topology.nodes[name], `Missing graph node: ${name}`);
  }
  const edges = topology.edges.map(edge => `${edge.source}->${edge.target}`);
  assert.ok(edges.includes("judge->prepare_action"));
  assert.ok(edges.includes("judge->finalize"));
  assert.ok(edges.includes("prepare_action->execute"));
  assert.ok(edges.includes("capture->observe"));
  assert.ok(!edges.includes("judge->execute"));
});

test("the graph awaits the saved pending-action checkpoint before invoking its browser tool", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture(); const pendingSaved = deferred(); const permitSave = deferred();
  f.run.onUpdate = async state => {
    f.updates.push(state);
    if (state.actions[0]?.status === "pending") { pendingSaved.resolve(); await permitSave.promise; }
  };
  const pending = f.run.start("Read the requested role");
  await pendingSaved.promise;
  assert.ok(f.calls.includes("judge"));
  assert.ok(!f.calls.some(call => call.startsWith("execute:")));
  permitSave.resolve();
  assert.equal((await pending).status, "completed");
  assert.equal(f.calls.filter(call => call === "execute:done").length, 1);
});

test("a failed browser dispatch is unconfirmed and never retried by the graph or tool", async () => {
  const f = fixture();
  f.driver.execute = async action => {
    f.calls.push(`execute:${action.kind}`);
    throw new Error("private command transport diagnostics");
  };
  const state = await f.run.start("Read the role once");
  assert.equal(state.status, "failed");
  assert.equal(state.actions[0].status, "unconfirmed");
  assert.equal(f.calls.filter(call => call === "execute:done").length, 1);
  assert.equal(f.calls.filter(call => call === "observe").length, 1);
  assert.ok(!state.error.includes("private"));
  assert.ok(f.calls.includes("cancel"));
});

test("an abandoned graph observation cannot change a later mission on the same controller", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture(); const entered = deferred(); const abandoned = deferred();
  const ordinaryObserve = f.driver.observe;
  let first = true;
  f.driver.observe = () => {
    if (first) { first = false; entered.resolve(); return abandoned.promise; }
    return ordinaryObserve();
  };
  const initial = f.run.start("First task");
  await entered.promise;
  await f.run.stop();
  assert.equal((await initial).status, "stopped");
  const finished = await f.run.start("New task");
  assert.equal(finished.status, "completed");
  abandoned.resolve({ snapshot_id: "abandoned", url: URL, title: "Abandoned page", text: "Old evidence", elements: [] });
  await abandoned.promise;
  assert.equal(f.run.state.tab.title, "Senior AI Engineer");
  assert.equal(f.run.state.goal, "New task");
  assert.equal(f.run.state.sources[0].text, "Captured evidence");
  assert.ok(!f.updates.some(state => state.tab?.title === "Abandoned page"));
});

test("the LangChain browser tool validates its own input before dispatch", async () => {
  const calls = [];
  const browserTool = createBrowserActionTool({
    driver: { async execute(action) { calls.push(`execute:${action.kind}`); return { status: "executed", url: URL }; } },
    guard() {}, onDispatch() { calls.push("dispatch"); },
  });
  const valid = { kind: "done", snapshot_id: "observed", reason: "Read evidence" };
  await assert.rejects(browserTool.invoke({ action: { ...valid, javascript: "forged()" } }, { callbacks: [] }));
  await assert.rejects(browserTool.invoke({ action: { kind: "switch_tab", snapshot_id: "observed", reason: "Switch without a ref" } }, { callbacks: [] }));
  assert.deepEqual(calls, []);
  const result = await browserTool.invoke({ action: valid }, { callbacks: [] });
  assert.equal(result.status, "executed");
  assert.deepEqual(calls, ["dispatch", "execute:done"]);
});
