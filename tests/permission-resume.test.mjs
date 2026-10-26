import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../config.mjs";
import { AgentRun, restoreCheckpoint } from "../controller.mjs";
import { BrowserDriverError } from "../policy.mjs";

const SEARCH_URL = "https://search.fixture.example/jobs";
const EMPLOYER_URL = "https://employer.fixture.example/roles/123";
const REDIRECTED_URL = "https://destination.fixture.example/roles/456";
const SEARCH_TEXT = "Observed employer result for a senior backend role in Israel.";
const EMPLOYER_TEXT = "Senior Backend Engineer. Location: Israel. Requirements: distributed systems and Python.";
const GOAL = "Find and research a senior AI or backend engineering job in Israel.";
const NOW = "2026-10-26T06:00:00.000Z";
const TEST_TIMEOUT_MS = 4000;
const copy = value => JSON.parse(JSON.stringify(value));
const accessError = () => new BrowserDriverError("site_access_required", "Grant site access to this task page in Chrome.");
const reviewError = () => new BrowserDriverError("permission_review_required", "Chrome must disclose the redirected website before it can be reviewed.");
const notResumable = { name: "AgentRunError", code: "not_resumable" };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Fake external services; AgentRun, its LangGraph and its LangChain tool are real. */
function fixture({ transition = "open_tab", maxSteps = 6, score = 1, reviewUrl = EMPLOYER_URL } = {}) {
  const calls = [];
  const updates = [];
  const observations = [];
  const modelCalls = [];
  const executed = [];
  const permissionSignals = [];
  const hooks = {};
  const settings = { ...DEFAULT_SETTINGS, maxSteps };
  let current = "task-search";
  let opened = false;
  let granted = false;
  let disclosedEmployerUrl = EMPLOYER_URL;
  let bound = false;
  let registryValid = true;
  let observed = 0;
  let proposed = 0;
  let ids = 0;
  const catalog = () => transition === "navigate"
    ? [{ ref: "task-search", url: current === "task-search" ? SEARCH_URL : disclosedEmployerUrl, title: "Task page", active: true }]
    : [
      { ref: "task-search", url: SEARCH_URL, title: "Job search", active: current === "task-search" },
      ...(opened ? [{ ref: "task-employer", url: disclosedEmployerUrl, title: "Employer role", active: current === "task-employer" }] : []),
    ];
  const page = () => ({
    url: current === "task-search" ? SEARCH_URL : disclosedEmployerUrl,
    title: current === "task-search" ? "Job search" : "Employer role",
    tab_ref: transition === "navigate" ? "task-search" : current,
    tabs: catalog(),
  });
  const driver = {
    get canContinuePermission() { return bound && registryValid; },
    async bindCurrentTab() {
      calls.push("bind");
      if (hooks.bind) await hooks.bind();
      bound = true;
      return { tabId: 7, ...page() };
    },
    async observe() {
      calls.push("observe");
      if (hooks.observe) await hooks.observe({ current, granted });
      if (current !== "task-search" && !granted) throw accessError();
      const observation = {
        snapshot_id: `fresh-${++observed}`, ...page(),
        text: current === "task-search" ? SEARCH_TEXT : EMPLOYER_TEXT,
        elements: [{ id: "employer-link", tag: "a", label: "Read employer role", href: EMPLOYER_URL }],
      };
      observations.push(copy(observation));
      return observation;
    },
    async execute(action) {
      calls.push(`execute:${action.kind}`);
      executed.push(copy(action));
      if (hooks.execute) await hooks.execute(action);
      if (["open_tab", "navigate"].includes(action.kind)) {
        opened = action.kind === "open_tab";
        current = "task-employer";
      }
      return { status: "executed", ...page() };
    },
    async resumeAfterPermission(signal) {
      permissionSignals.push({ operation: "resume", signal });
      calls.push("resume-permission");
      if (hooks.resume) await hooks.resume(signal);
      signal.throwIfAborted();
      granted = true;
    },
    async reviewPermissionTarget(signal) {
      permissionSignals.push({ operation: "review", signal });
      calls.push("review-permission");
      const target = hooks.review ? await hooks.review(signal) : { url: reviewUrl, origin: new URL(reviewUrl).origin };
      signal.throwIfAborted();
      // The fake browser discloses its redirected page; reviewing never navigates it.
      disclosedEmployerUrl = target.url;
      return target;
    },
    async cancel() {
      calls.push("cancel");
      if (hooks.cancel) await hooks.cancel();
    },
  };
  const plan = [
    { kind: "extract" },
    transition === "open_tab" ? { kind: transition, target_id: "employer-link" } : { kind: transition, url: EMPLOYER_URL },
    { kind: "extract" },
    { kind: "done" },
  ];
  const client = {
    async route(goal, observation) {
      calls.push("route");
      modelCalls.push({ phase: "route", goal, observation: copy(observation) });
      if (hooks.route) await hooks.route(observation);
      return { model: settings.fastModel, modelRole: "fast", tool: "read", confidence: 1, durationMs: 1, fallbackReason: null };
    },
    async propose(goal, observation, history) {
      calls.push("propose");
      modelCalls.push({ phase: "propose", goal, observation: copy(observation), history: copy(history) });
      if (hooks.propose) await hooks.propose(observation);
      const action = plan[proposed++];
      if (!action) throw new Error("The test planner exhausted its bounded plan.");
      return { ...action, snapshot_id: observation.snapshot_id, reason: "Research the employer evidence" };
    },
    async judge(goal, observation, action) {
      calls.push("judge");
      modelCalls.push({ phase: "judge", goal, observation: copy(observation), action: copy(action) });
      if (hooks.judge) await hooks.judge(action);
      return { score: typeof score === "function" ? score(action) : score, durationMs: 1 };
    },
  };
  const run = new AgentRun(settings, {
    client, driver, onUpdate: async state => { updates.push(state); },
    now: () => NOW, idFactory: () => `permission-task-${++ids}`,
  });
  return {
    run, driver, client, hooks, calls, updates, observations, modelCalls, executed, permissionSignals,
    invalidateRegistry() { registryValid = false; },
    get idCount() { return ids; },
  };
}

async function pausedFixture(options) {
  const f = fixture(options);
  const state = await f.run.start(GOAL);
  assert.equal(state.status, "awaiting_permission", state.error);
  assert.equal(f.run.canContinue, true);
  assert.equal(f.run.isRunning, false);
  f.paused = state;
  f.idCountAtPause = f.idCount;
  return f;
}

function workSince(f, index) {
  return f.calls.slice(index).filter(call => call !== "cancel");
}

for (const transition of ["open_tab", "navigate"]) {
  test(`a fresh observation after confirmed ${transition} waits without losing task evidence`, async () => {
    const f = await pausedFixture({ transition });
    const state = f.paused;
    assert.equal(state.goal, GOAL);
    assert.equal(state.step, 2);
    assert.equal(state.maxSteps, 6);
    assert.deepEqual(state.actions.map(action => [action.kind, action.status]), [["extract", "executed"], [transition, "executed"]]);
    assert.equal(state.sources.length, 1);
    assert.equal(state.sources[0].text, SEARCH_TEXT);
    assert.equal(state.tab.url, EMPLOYER_URL);
    assert.equal(state.tab.tab_ref, transition === "open_tab" ? "task-employer" : "task-search");
    assert.equal(state.tabs.length, transition === "open_tab" ? 2 : 1);
    assert.equal(f.modelCalls.length, 6);
    assert.equal(f.executed.length, 2);
    assert.equal(f.calls.filter(call => call === "observe").length, 3);
    assert.equal(f.calls.filter(call => call === "resume-permission").length, 0);
    assert.ok(f.updates.some(update => update.status === "awaiting_permission"));
  });

  test(`explicit continuation after ${transition} observes and reviews again without rebinding or replaying`, async () => {
    const f = await pausedFixture({ transition });
    const boundary = f.calls.length;
    const pausedGraph = f.run.graph;
    assert.ok(pausedGraph);
    const finished = await f.run.continueAfterPermission();
    assert.equal(f.run.graph, pausedGraph);
    assert.equal(finished.status, "completed");
    assert.equal(finished.id, f.paused.id);
    assert.equal(finished.goal, f.paused.goal);
    assert.equal(finished.startedAt, f.paused.startedAt);
    assert.equal(finished.maxSteps, f.paused.maxSteps);
    assert.equal(f.idCount, f.idCountAtPause);
    assert.deepEqual(finished.actions.slice(0, 2), f.paused.actions);
    assert.deepEqual(finished.activity.slice(0, f.paused.activity.length), f.paused.activity);
    assert.deepEqual(finished.sources[0], f.paused.sources[0]);
    assert.deepEqual(finished.tabs, f.paused.tabs);
    assert.deepEqual(finished.tab, f.paused.tab);
    assert.deepEqual(finished.actions.map(action => action.step), [1, 2, 3, 4]);
    assert.deepEqual(workSince(f, boundary), [
      "resume-permission", "observe", "route", "propose", "judge", "execute:extract",
      "observe", "route", "propose", "judge", "execute:done",
    ]);
    const freshPlan = f.modelCalls.filter(call => call.phase === "propose")[2];
    assert.equal(freshPlan.goal, GOAL);
    assert.equal(freshPlan.observation.url, EMPLOYER_URL);
    assert.equal(freshPlan.observation.text, EMPLOYER_TEXT);
    assert.equal(freshPlan.observation.snapshot_id, f.observations[2].snapshot_id);
    assert.ok(!f.paused.actions.some(action => action.snapshot_id === freshPlan.observation.snapshot_id));
    assert.deepEqual(freshPlan.history, f.paused.actions);
    assert.deepEqual(finished.sources.map(source => source.url), [SEARCH_URL, EMPLOYER_URL]);
    assert.equal(finished.sources[1].text, EMPLOYER_TEXT);
    assert.ok(finished.report.includes(`](<${EMPLOYER_URL}>)`));
    assert.equal(f.run.canContinue, false);
    await assert.rejects(f.run.continueAfterPermission(), notResumable);
  });
}

test("continuation spends only the original remaining action budget", async () => {
  const f = await pausedFixture({ maxSteps: 3 });
  const state = await f.run.continueAfterPermission();
  assert.equal(state.status, "limit_reached");
  assert.equal(state.maxSteps, 3);
  assert.equal(state.step, 3);
  assert.deepEqual(state.actions.map(action => action.kind), ["extract", "open_tab", "extract"]);
  assert.equal(state.sources.length, 2);
  assert.equal(f.calls.filter(call => call === "bind").length, 1);
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
});

test("a freshly resumed proposal still needs a passing relevance judgment", async () => {
  let judgments = 0;
  const f = await pausedFixture({ score: () => ++judgments < 3 ? 1 : 0 });
  const state = await f.run.continueAfterPermission();
  assert.equal(state.status, "paused");
  assert.equal(state.actions[2].status, "paused");
  assert.equal(state.actions[2].snapshot_id, f.observations[2].snapshot_id);
  assert.deepEqual(state.sources, f.paused.sources);
  assert.equal(f.executed.length, 2);
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
});

test("Stop while awaiting site access permanently disables that continuation", async () => {
  const f = await pausedFixture();
  const boundary = f.calls.length;
  await f.run.stop();
  assert.equal(f.run.state.status, "stopped");
  assert.equal(f.run.state.error, null);
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
  assert.deepEqual(workSince(f, boundary), []);
  assert.deepEqual(f.run.state.actions, f.paused.actions);
  assert.deepEqual(f.run.state.sources, f.paused.sources);
});

test("an invalidated task registry cannot request access or run a fresh observation", async () => {
  const f = await pausedFixture();
  f.invalidateRegistry();
  const boundary = f.calls.length;
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
  assert.deepEqual(workSince(f, boundary), []);
  assert.deepEqual(f.run.state, f.paused);
});

for (const boundary of ["permission denied", "foreign tab", "foreign window", "closed tab"]) {
  test(`a driver rejection for ${boundary} cannot reach observation, planning or dispatch`, async () => {
    const f = await pausedFixture();
    const index = f.calls.length;
    f.hooks.resume = async () => { throw new BrowserDriverError("task_access_rejected", boundary); };
    const state = await f.run.continueAfterPermission();
    assert.equal(state.status, "failed");
    assert.equal(state.error, boundary);
    assert.equal(state.id, f.paused.id);
    assert.deepEqual(state.actions, f.paused.actions);
    assert.deepEqual(state.sources, f.paused.sources);
    assert.deepEqual(workSince(f, index), ["resume-permission"]);
    assert.equal(f.run.canContinue, false);
    await assert.rejects(f.run.continueAfterPermission(), notResumable);
  });
}

test("a second site-access failure waits for another explicit continuation without automatic retry", async () => {
  const f = await pausedFixture();
  let blockFreshObservation = true;
  f.hooks.observe = async ({ granted }) => {
    if (granted && blockFreshObservation) { blockFreshObservation = false; throw accessError(); }
  };
  const boundary = f.calls.length;
  const waiting = await f.run.continueAfterPermission();
  assert.equal(waiting.status, "awaiting_permission", waiting.error);
  assert.equal(waiting.step, f.paused.step);
  assert.deepEqual(waiting.actions, f.paused.actions);
  assert.deepEqual(workSince(f, boundary), ["resume-permission", "observe"]);
  assert.equal(f.run.canContinue, true);
  const complete = await f.run.continueAfterPermission();
  assert.equal(complete.status, "completed");
  assert.equal(complete.id, f.paused.id);
  assert.equal(f.calls.filter(call => call === "bind").length, 1);
  assert.equal(f.executed.filter(action => action.kind === "open_tab").length, 1);
});

test("restoring a waiting checkpoint retains evidence but never restores executable permission state", async () => {
  const f = await pausedFixture();
  const restored = restoreCheckpoint(f.paused);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.id, f.paused.id);
  assert.deepEqual(restored.sources, f.paused.sources);
  assert.deepEqual(restored.actions, f.paused.actions);
  assert.deepEqual(restored.tabs, f.paused.tabs);
  const reopened = fixture();
  assert.equal(reopened.run.canContinue, false);
  await assert.rejects(reopened.run.continueAfterPermission(), notResumable);
  assert.deepEqual(reopened.calls, []);
});

test("an uncertain dispatched action is failed and cannot become a permission continuation", async () => {
  const f = fixture();
  f.hooks.execute = async action => { if (action.kind === "open_tab") throw accessError(); };
  const state = await f.run.start(GOAL);
  assert.equal(state.status, "failed");
  assert.equal(state.actions[1].status, "unconfirmed");
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
  assert.equal(f.executed.filter(action => action.kind === "open_tab").length, 1);
  assert.equal(f.calls.filter(call => call === "resume-permission").length, 0);
});

for (const phase of ["bind", "route", "propose", "judge"]) {
  test(`site-access errors during ${phase} cannot authorize the fresh-observe continuation`, async () => {
    const f = fixture();
    f.hooks[phase] = async () => { throw accessError(); };
    const state = await f.run.start(GOAL);
    assert.equal(state.status, "failed");
    assert.equal(f.run.canContinue, false);
    await assert.rejects(f.run.continueAfterPermission(), notResumable);
    assert.equal(f.executed.length, 0);
    assert.equal(f.calls.filter(call => call === "resume-permission").length, 0);
  });
}

test("an error carrying the same permission name and code does not mint a continuation capability", async () => {
  const f = fixture();
  f.hooks.observe = async () => {
    const lookalike = new Error("Not a driver-verified permission failure.");
    lookalike.name = "BrowserDriverError";
    lookalike.code = "site_access_required";
    throw lookalike;
  };
  const state = await f.run.start(GOAL);
  assert.equal(state.status, "failed");
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
  assert.equal(f.executed.length, 0);
});

test("Stop wins against a late permission response before any resumed browser work", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await pausedFixture();
  const entered = deferred();
  const permit = deferred();
  f.hooks.resume = async () => { entered.resolve(); await permit.promise; };
  const boundary = f.calls.length;
  const continuing = f.run.continueAfterPermission();
  await entered.promise;
  await f.run.stop();
  permit.resolve();
  const state = await continuing;
  assert.equal(state.status, "stopped");
  assert.equal(state.error, null);
  assert.equal(f.run.canContinue, false);
  assert.deepEqual(state.actions, f.paused.actions);
  assert.deepEqual(state.sources, f.paused.sources);
  assert.deepEqual(workSince(f, boundary), ["resume-permission"]);
});

test("concurrent Continue clicks cannot create a second permission request or action sequence", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await pausedFixture();
  const entered = deferred();
  const permit = deferred();
  f.hooks.resume = async () => { entered.resolve(); await permit.promise; };
  const continuing = f.run.continueAfterPermission();
  await entered.promise;
  await assert.rejects(f.run.continueAfterPermission(), { name: "AgentRunError", code: "already_running" });
  permit.resolve();
  assert.equal((await continuing).status, "completed");
  assert.equal(f.calls.filter(call => call === "resume-permission").length, 1);
  assert.equal(f.executed.length, 4);
});

test("a resumed approved action still waits for its saved checkpoint and Stop cancels it before dispatch", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await pausedFixture();
  const saving = deferred();
  const permitSave = deferred();
  f.run.onUpdate = async state => {
    f.updates.push(state);
    if (state.actions[2]?.status === "pending") { saving.resolve(); await permitSave.promise; }
  };
  const continuing = f.run.continueAfterPermission();
  await saving.promise;
  assert.equal(f.executed.length, 2);
  const stopping = f.run.stop();
  permitSave.resolve();
  await stopping;
  const state = await continuing;
  assert.equal(state.status, "stopped");
  assert.equal(state.actions[2].status, "cancelled");
  assert.equal(f.executed.length, 2);
  assert.deepEqual(state.sources, f.paused.sources);
  assert.equal(f.run.canContinue, false);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
});

test("a failed saved checkpoint after fresh judgment blocks resumed dispatch", async () => {
  const f = await pausedFixture();
  f.run.onUpdate = async state => {
    if (state.actions[2]?.status === "pending") throw new Error("The fixture checkpoint write failed.");
  };
  const state = await f.run.continueAfterPermission();
  assert.equal(state.status, "failed");
  assert.equal(state.actions[2].status, "cancelled");
  assert.equal(f.executed.length, 2);
  assert.deepEqual(state.sources, f.paused.sources);
  assert.equal(f.run.canContinue, false);
});


test("site access can wait on the first fresh observation only after binding the task", async () => {
  const f = fixture();
  f.hooks.observe = async () => { throw accessError(); };
  const waiting = await f.run.start(GOAL);
  assert.equal(waiting.status, "awaiting_permission", waiting.error);
  assert.equal(waiting.step, 0);
  assert.deepEqual(waiting.actions, []);
  assert.deepEqual(waiting.sources, []);
  assert.equal(f.run.canContinue, true);
  delete f.hooks.observe;
  const completed = await f.run.continueAfterPermission();
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, waiting.id);
  assert.equal(f.calls.filter(call => call === "bind").length, 1);
});

test("a delayed permission-pause checkpoint cannot re-enable continuation after Stop", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = fixture();
  const saving = deferred();
  const permitSave = deferred();
  f.run.onUpdate = async state => {
    f.updates.push(state);
    if (state.status === "awaiting_permission") { saving.resolve(); await permitSave.promise; }
  };
  const starting = f.run.start(GOAL);
  await saving.promise;
  const stopping = f.run.stop();
  permitSave.resolve();
  await stopping;
  const state = await starting;
  assert.equal(state.status, "stopped");
  assert.equal(f.run.state.status, "stopped");
  assert.equal(f.run.canContinue, false);
  assert.equal(f.updates.at(-1).status, "stopped");
  assert.equal(f.calls.filter(call => call === "resume-permission").length, 0);
  assert.equal(f.executed.length, 2);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
});

test("a late permission response cannot overtake a still-pending cancellation", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await pausedFixture();
  const permissionEntered = deferred();
  const permitPermission = deferred();
  const cancelEntered = deferred();
  const cleanupEntered = deferred();
  const permitCancel = deferred();
  let cancels = 0;
  f.hooks.resume = async () => { permissionEntered.resolve(); await permitPermission.promise; };
  f.hooks.cancel = async () => {
    if (++cancels === 1) cancelEntered.resolve();
    else cleanupEntered.resolve();
    await permitCancel.promise;
  };
  const boundary = f.calls.length;
  const continuing = f.run.continueAfterPermission();
  await permissionEntered.promise;
  const stopping = f.run.stop();
  await cancelEntered.promise;
  permitPermission.resolve();
  await cleanupEntered.promise;
  assert.deepEqual(workSince(f, boundary), ["resume-permission"]);
  assert.equal(f.run.canContinue, false);
  permitCancel.resolve();
  await stopping;
  const state = await continuing;
  assert.equal(state.status, "stopped");
  assert.deepEqual(state.actions, f.paused.actions);
  assert.deepEqual(state.sources, f.paused.sources);
});


function assertTaskEvidenceRetained(actual, before) {
  assert.equal(actual.id, before.id);
  assert.equal(actual.goal, before.goal);
  assert.equal(actual.startedAt, before.startedAt);
  assert.equal(actual.step, before.step);
  assert.equal(actual.maxSteps, before.maxSteps);
  assert.deepEqual(actual.actions, before.actions);
  assert.deepEqual(actual.sources, before.sources);
  assert.deepEqual(actual.tab, before.tab);
  assert.deepEqual(actual.tabs, before.tabs);
  assert.deepEqual(actual.activity.slice(0, before.activity.length), before.activity);
}

async function redirectReviewFixture(options) {
  const f = await pausedFixture({ reviewUrl: REDIRECTED_URL, ...options });
  let needsReview = true;
  f.hooks.resume = async () => {
    if (needsReview) { needsReview = false; throw reviewError(); }
  };
  const boundary = f.calls.length;
  f.reviewWait = await f.run.continueAfterPermission();
  assert.equal(f.reviewWait.status, "awaiting_permission", f.reviewWait.error);
  assert.equal(f.run.canContinue, true);
  assert.equal(f.run.permissionReviewRequired, true);
  assert.equal(f.run.reviewedPermissionOrigin, null);
  assertTaskEvidenceRetained(f.reviewWait, f.paused);
  assert.deepEqual(workSince(f, boundary), ["resume-permission"]);
  return f;
}

test("post-grant redaction retains only a private wait and cannot implicitly retry or adopt a destination", async () => {
  const f = await redirectReviewFixture();
  const graph = f.run.graph;
  const boundary = f.calls.length;
  await assert.rejects(f.run.continueAfterPermission(), { name: "AgentRunError", code: "permission_review_required" });
  assert.deepEqual(workSince(f, boundary), []);
  assert.deepEqual(f.run.state, f.reviewWait);
  assert.equal(f.run.graph, graph);
  assert.equal(f.calls.filter(call => call === "review-permission").length, 0);
  assert.equal(f.modelCalls.length, 6);
  assert.equal(f.executed.length, 2);
  assert.equal(JSON.stringify(f.run.state).includes(REDIRECTED_URL), false);
});

for (const transition of ["open_tab", "navigate"]) {
  test(`explicit redirected-site review after ${transition} is passive, then the same graph captures the disclosed source`, async () => {
    const f = await redirectReviewFixture({ transition });
    const graph = f.run.graph;
    const boundary = f.calls.length;
    const reviewed = await f.run.reviewPermissionTarget();
    assert.deepEqual(reviewed, { url: REDIRECTED_URL, origin: new URL(REDIRECTED_URL).origin });
    assert.deepEqual(workSince(f, boundary), ["review-permission"]);
    assert.deepEqual(f.run.state, f.reviewWait);
    assert.equal(f.run.reviewedPermissionOrigin, new URL(REDIRECTED_URL).origin);
    assert.equal(f.run.permissionReviewRequired, false);
    reviewed.url = SEARCH_URL;
    reviewed.origin = new URL(SEARCH_URL).origin;
    assert.equal(f.run.reviewedPermissionOrigin, new URL(REDIRECTED_URL).origin);
    const finished = await f.run.continueAfterPermission();
    assert.equal(finished.status, "completed");
    assert.equal(f.run.graph, graph);
    assert.equal(finished.id, f.paused.id);
    assert.equal(finished.goal, GOAL);
    assert.equal(f.idCount, f.idCountAtPause);
    assert.equal(finished.maxSteps, f.paused.maxSteps);
    assert.deepEqual(finished.actions.slice(0, 2), f.paused.actions);
    assert.deepEqual(finished.sources[0], f.paused.sources[0]);
    assert.deepEqual(finished.actions.map(action => action.step), [1, 2, 3, 4]);
    assert.deepEqual(finished.sources.map(source => source.url), [SEARCH_URL, REDIRECTED_URL]);
    assert.equal(finished.sources[1].text, EMPLOYER_TEXT);
    assert.equal(finished.tab.tab_ref, f.paused.tab.tab_ref);
    assert.deepEqual(finished.tabs.map(tab => tab.ref), f.paused.tabs.map(tab => tab.ref));
    assert.equal(f.calls.filter(call => call === "bind").length, 1);
    assert.equal(f.executed.filter(action => action.kind === transition).length, 1);
    const resumedPlan = f.modelCalls.filter(call => call.phase === "propose")[2];
    assert.equal(resumedPlan.observation.url, REDIRECTED_URL);
    assert.deepEqual(resumedPlan.history, f.paused.actions);
    assert.deepEqual(workSince(f, boundary), [
      "review-permission", "resume-permission", "observe", "route", "propose", "judge", "execute:extract",
      "observe", "route", "propose", "judge", "execute:done",
    ]);
    assert.equal(f.run.reviewedPermissionOrigin, null);
    assert.deepEqual(f.permissionSignals.map(record => record.operation), ["resume", "review", "resume"]);
    assert.ok(f.permissionSignals.every(record => record.signal === f.permissionSignals[0].signal));
  });
}

test("a still-redacted explicit review preserves the wait and requires another human review", async () => {
  const f = await redirectReviewFixture();
  const graph = f.run.graph;
  const boundary = f.calls.length;
  f.hooks.review = async () => { throw reviewError(); };
  await assert.rejects(f.run.reviewPermissionTarget(), error => error instanceof BrowserDriverError && error.code === "permission_review_required");
  assert.deepEqual(f.run.state, f.reviewWait);
  assert.equal(f.run.graph, graph);
  assert.equal(f.run.canContinue, true);
  assert.equal(f.run.permissionReviewRequired, true);
  assert.equal(f.run.reviewedPermissionOrigin, null);
  await assert.rejects(f.run.continueAfterPermission(), { name: "AgentRunError", code: "permission_review_required" });
  assert.deepEqual(workSince(f, boundary), ["review-permission"]);
  delete f.hooks.review;
  await f.run.reviewPermissionTarget();
  assert.equal((await f.run.continueAfterPermission()).status, "completed");
});

for (const cause of ["denial", "unknown", "lookalike"]) {
  test(`${cause} permission response cannot create redirected-site review eligibility`, async () => {
    const f = await pausedFixture();
    f.hooks.resume = async () => {
      if (cause === "denial") throw accessError();
      const error = new Error("The permission outcome was not verified.");
      if (cause === "lookalike") { error.name = "BrowserDriverError"; error.code = "permission_review_required"; }
      throw error;
    };
    const state = await f.run.continueAfterPermission();
    assert.equal(state.status, "failed");
    assert.equal(f.run.canContinue, false);
    assert.equal(f.run.permissionReviewRequired, false);
    assert.equal(f.run.reviewedPermissionOrigin, null);
    assertTaskEvidenceRetained(state, f.paused);
    await assert.rejects(f.run.reviewPermissionTarget(), notResumable);
    assert.equal(f.calls.filter(call => call === "review-permission").length, 0);
  });
}

for (const phase of ["observe", "propose", "judge", "execute"]) {
  test(`redirect-review errors during ${phase} cannot retain a permission checkpoint`, async () => {
    const f = fixture();
    f.hooks[phase] = async () => { throw reviewError(); };
    const state = await f.run.start(GOAL);
    assert.equal(state.status, "failed");
    assert.equal(f.run.canContinue, false);
    assert.equal(f.run.permissionReviewRequired, false);
    assert.equal(f.run.reviewedPermissionOrigin, null);
    if (phase === "execute") assert.equal(state.actions[0].status, "unconfirmed");
    await assert.rejects(f.run.reviewPermissionTarget(), notResumable);
    assert.equal(f.calls.filter(call => call === "review-permission").length, 0);
  });
}

for (const failure of [
  new BrowserDriverError("tab_changed", "The pinned tab is no longer active."),
  new BrowserDriverError("window_changed", "The pinned tab moved to another window."),
  new BrowserDriverError("unsafe_url", "Chrome disclosed a non-public destination."),
  new Error("The browser could not confirm the review outcome."),
]) {
  test(`review rejection (${failure.message}) revokes the wait before any model or browser action`, async () => {
    const f = await redirectReviewFixture();
    const boundary = f.calls.length;
    f.hooks.review = async () => { throw failure; };
    await assert.rejects(f.run.reviewPermissionTarget(), error => error === failure);
    assert.equal(f.run.state.status, "failed");
    assert.equal(f.run.canContinue, false);
    assert.equal(f.run.permissionReviewRequired, false);
    assert.equal(f.run.reviewedPermissionOrigin, null);
    assertTaskEvidenceRetained(f.run.state, f.reviewWait);
    assert.deepEqual(workSince(f, boundary), ["review-permission"]);
    await assert.rejects(f.run.continueAfterPermission(), notResumable);
  });
}

for (const target of [
  { url: "file:///private/unavailable", origin: "null" },
  { url: REDIRECTED_URL, origin: new URL(SEARCH_URL).origin },
  { url: REDIRECTED_URL, origin: new URL(REDIRECTED_URL).origin, tabId: 7 },
]) {
  test(`a malformed review target ${JSON.stringify(target)} cannot stage an origin`, async () => {
    const f = await redirectReviewFixture();
    f.hooks.review = async () => target;
    await assert.rejects(f.run.reviewPermissionTarget());
    assert.equal(f.run.state.status, "failed");
    assert.equal(f.run.canContinue, false);
    assert.equal(f.run.reviewedPermissionOrigin, null);
    assertTaskEvidenceRetained(f.run.state, f.reviewWait);
    assert.equal(f.executed.length, 2);
    assert.equal(f.calls.filter(call => call === "resume-permission").length, 1);
  });
}

test("Stop wins against a late redirected-site review and cannot stage its origin", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await redirectReviewFixture();
  const entered = deferred();
  const permit = deferred();
  f.hooks.review = async () => { entered.resolve(); await permit.promise; return { url: REDIRECTED_URL, origin: new URL(REDIRECTED_URL).origin }; };
  const boundary = f.calls.length;
  const reviewing = f.run.reviewPermissionTarget();
  const rejected = assert.rejects(reviewing, { name: "AbortError" });
  await entered.promise;
  await f.run.stop();
  permit.resolve();
  await rejected;
  assert.equal(f.run.state.status, "stopped");
  assert.equal(f.run.canContinue, false);
  assert.equal(f.run.permissionReviewRequired, false);
  assert.equal(f.run.reviewedPermissionOrigin, null);
  assertTaskEvidenceRetained(f.run.state, f.reviewWait);
  assert.deepEqual(workSince(f, boundary), ["review-permission"]);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
});

test("review gestures serialize with both Review and Continue without requesting another grant", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await redirectReviewFixture();
  const entered = deferred();
  const permit = deferred();
  f.hooks.review = async () => { entered.resolve(); await permit.promise; return { url: REDIRECTED_URL, origin: new URL(REDIRECTED_URL).origin }; };
  const boundary = f.calls.length;
  const reviewing = f.run.reviewPermissionTarget();
  await entered.promise;
  await assert.rejects(f.run.reviewPermissionTarget(), { name: "AgentRunError", code: "already_running" });
  await assert.rejects(f.run.continueAfterPermission(), { name: "AgentRunError", code: "already_running" });
  assert.deepEqual(workSince(f, boundary), ["review-permission"]);
  permit.resolve();
  assert.deepEqual(await reviewing, { url: REDIRECTED_URL, origin: new URL(REDIRECTED_URL).origin });
  assert.equal((await f.run.continueAfterPermission()).status, "completed");
  assert.equal(f.calls.filter(call => call === "review-permission").length, 1);
});

test("a late review from a stopped mission cannot stage a target for a newly started mission", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await redirectReviewFixture();
  const entered = deferred();
  const permit = deferred();
  f.hooks.review = async () => { entered.resolve(); await permit.promise; return { url: REDIRECTED_URL, origin: new URL(REDIRECTED_URL).origin }; };
  const reviewing = f.run.reviewPermissionTarget();
  const rejected = assert.rejects(reviewing, { name: "AbortError" });
  await entered.promise;
  await f.run.stop();
  const nextGoal = "Continue independent public job research in a new task.";
  const next = await f.run.start(nextGoal);
  assert.equal(next.status, "awaiting_permission");
  assert.notEqual(next.id, f.reviewWait.id);
  permit.resolve();
  await rejected;
  assert.equal(f.run.state.id, next.id);
  assert.equal(f.run.state.goal, nextGoal);
  assert.equal(f.run.reviewedPermissionOrigin, null);
  assert.equal(f.run.permissionReviewRequired, false);
  assert.equal(f.run.state.step, 0);
  assert.deepEqual(f.run.state.actions, []);
  await f.run.stop();
});

test("a delayed review-required checkpoint cannot recreate private review eligibility after Stop", { timeout: TEST_TIMEOUT_MS }, async () => {
  const f = await pausedFixture({ reviewUrl: REDIRECTED_URL });
  const saving = deferred();
  const permitSave = deferred();
  f.hooks.resume = async () => { throw reviewError(); };
  f.run.onUpdate = async state => {
    f.updates.push(state);
    if (state.status === "awaiting_permission") { saving.resolve(); await permitSave.promise; }
  };
  const continuing = f.run.continueAfterPermission();
  await saving.promise;
  const stopping = f.run.stop();
  permitSave.resolve();
  await stopping;
  const state = await continuing;
  assert.equal(state.status, "stopped");
  assert.equal(f.run.canContinue, false);
  assert.equal(f.run.permissionReviewRequired, false);
  assert.equal(f.run.reviewedPermissionOrigin, null);
  assert.equal(f.updates.at(-1).status, "stopped");
  assertTaskEvidenceRetained(state, f.paused);
  await assert.rejects(f.run.reviewPermissionTarget(), notResumable);
});

test("a failed browser release cannot retain the private review-required continuation", async () => {
  const f = await pausedFixture({ reviewUrl: REDIRECTED_URL });
  f.hooks.resume = async () => { throw reviewError(); };
  f.hooks.cancel = async () => { throw new Error("The browser release outcome was not confirmed."); };
  const state = await f.run.continueAfterPermission();
  assert.equal(state.status, "failed");
  assert.equal(f.run.canContinue, false);
  assert.equal(f.run.permissionReviewRequired, false);
  assert.equal(f.run.reviewedPermissionOrigin, null);
  assertTaskEvidenceRetained(state, f.paused);
  await assert.rejects(f.run.continueAfterPermission(), notResumable);
});
