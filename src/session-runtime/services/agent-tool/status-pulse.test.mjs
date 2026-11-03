import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

const mgr = await import('../../../runtime/agent/orchestrator/session/manager.mjs');
const { saveSession } = await import('../../../runtime/agent/orchestrator/session/store.mjs');
const { cleanupBackgroundTasks, completeBackgroundTask, registerBackgroundTask } = await import(
  '../../../runtime/shared/background-tasks.mjs'
);
const { createStandaloneAgent } = await import('../agent-tool.mjs');
const { createRoutedAgentTool } = await import('../../agent-tool-routing.mjs');
const { createWorkerIndex } = await import('./worker-index.mjs');
const { flushAllIndexWrites } = await import('./index-write-queue.mjs');
const { MAINTENANCE_EVENT_DELAY_MS, agentMaintenanceSettled, runAgentMaintenancePass } = await import(
  './maintenance-pass.mjs'
);
const { resolveAgentTerminalReapMs } = await import('../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
const { TAG_TOMBSTONE_TTL_MS } = await import('./worker-rows.mjs');
const { _liveSessions } = await import('../../../runtime/agent/orchestrator/session/store/live-state.mjs');
const { sessionPath } = await import('../../../runtime/agent/orchestrator/session/store/session-paths.mjs');
const { eventually, trackWatchers } = await import('../../../runtime/shared/watched-file-cache.test-helpers.mjs');
const { executeTodoTool } = await import('../../../runtime/agent/orchestrator/runtime-core/todo-list.mjs');
const { emitSessionActivityChange } = await import('../../../runtime/shared/session-activity-signal.mjs');
const { tagTombstoneKey } = await import('../../../runtime/shared/agent-reap-state.mjs');
const { agentWatchdogPolicyActive, resolveAgentWatchdogPolicy } = await import(
  '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs'
);

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
let caseSeq = 0;

// Every synchronous fs call (named imports included) made while `run` runs.
function syncFsCalls(run) {
  const calls = [];
  const originals = new Map();
  for (const name of Object.keys(fs).filter((key) => key.endsWith('Sync'))) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function countedSync(...args) {
      calls.push(`${name} ${String(args[0])}`);
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
  }
  return calls;
}

function workerRow(lead, id, tag, status, ageMs, now) {
  return {
    tag,
    sessionId: id,
    ownerSessionId: lead,
    parentSessionId: lead,
    agent: 'worker',
    provider: 'p',
    model: 'm',
    status,
    stage: status,
    runtimePid: process.pid,
    clientHostPid: process.pid,
    createdAt: iso(now - ageMs),
    updatedAt: iso(now - ageMs),
    ...(status === 'running' ? {} : { finishedAt: iso(now - ageMs) }),
  };
}

// The worker's session record, saved (and so live) in this process.
function saveWorkerSession(row) {
  saveSession(
    {
      id: row.sessionId,
      owner: 'agent',
      agent: row.agent,
      agentTag: row.tag,
      ownerSessionId: row.ownerSessionId,
      parentSessionId: row.parentSessionId,
      clientHostPid: row.clientHostPid,
      status: row.status,
      provider: row.provider,
      model: row.model,
      messages: [],
      createdAt: Date.parse(row.createdAt),
      updatedAt: Date.parse(row.updatedAt),
    },
    { sync: true }
  );
}

// Another agent tool of this process (the daemon's canonical one) writing the
// same worker index.
function indexWriter(t, ctx) {
  const writer = createWorkerIndex({
    dataDir: ctx.dataDir,
    cfgMod: { loadConfig: () => ({}) },
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  t.after(() => writer.dispose());
  return writer;
}

// A running row whose session is gone and whose stamp is long past the reap window.
const ghostRow = (lead, name) => workerRow(lead, `${lead}_${name}`, `${name}-w`, 'running', 30 * DAY, Date.now());

// One Lead agent tool per session (the daemon's per-session runtimes) over one
// worker index, with the file-backed session manager. Each Lead has a running
// worker with a running job, an idle one and long-finished ones.
// `sharedTool`: one agent tool serves every Lead's status reads instead.
// `sessionManager`: the manager the tools are built with. `role`: the workers' agent.
function scenario(t, { leads = 4, sharedTool = false, sessionManager = mgr, role = 'worker' } = {}) {
  const tag = `c${++caseSeq}`;
  const dataDir = join(process.env.MIXDOG_DATA_DIR, `pulse-${tag}`);
  mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  const leadIds = Array.from({ length: leads }, (_, i) => `sess_${tag}_lead${i}`);
  const workers = {};
  const running = new Map();
  for (const lead of leadIds) {
    for (const [status, ageMs] of [
      ['running', 1000],
      ['idle', 60_000],
      ['completed', 3 * DAY],
      ['error', 30 * DAY],
    ]) {
      const id = `${lead}_${status}`;
      const row = { ...workerRow(lead, id, `${status}-w`, status, ageMs, now), agent: role };
      saveWorkerSession(row);
      workers[id] = row;
      if (status === 'running') running.set(lead, id);
    }
  }
  const file = join(dataDir, 'agent-workers.json');
  // A legacy tombstone (no owner): its owner is recovered from the sessions.
  const tombstones = {
    legacy: { tag: 'gone-w', agent: 'worker', clientHostPid: process.pid, sessionId: `${tag}_gone`, reapedAt: iso(now) },
  };
  writeFileSync(file, JSON.stringify({ version: 2, workers, tombstones }));
  const jobs = leadIds.map((lead) =>
    registerBackgroundTask({
      surface: 'agent',
      operation: 'spawn',
      label: 'running-w',
      input: { type: 'spawn', tag: 'running-w', sessionId: running.get(lead), agent: role },
      context: { callerSessionId: lead, clientHostPid: process.pid },
      meta: { tag: 'running-w', sessionId: running.get(lead), agent: role },
    })
  );
  const createAgent = () =>
    createStandaloneAgent({
      cfgMod: { loadConfig: () => ({ providers: {}, presets: [] }) },
      reg: {},
      mgr: sessionManager,
      dataDir,
      cwd: dataDir,
    });
  const agents = sharedTool ? [createAgent()] : leadIds.map(createAgent);
  const statusStates = leadIds.map(
    (lead, i) =>
      createRoutedAgentTool({
        rt: { session: { id: lead, clientHostPid: process.pid } },
        agentTool: agents[sharedTool ? 0 : i],
      }).agentStatusState
  );
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const agent of agents) agent.dispose();
  };
  t.after(async () => {
    for (const job of jobs) completeBackgroundTask(job.taskId, { status: 'completed', notify: false });
    cleanupBackgroundTasks({ surface: 'agent', force: true });
    dispose();
    await flushAllIndexWrites();
  });
  const pulse = () => statusStates.map((state) => state());
  const shown = (states) =>
    states.map((state) => ({
      workers: state.agentWorkers.map((row) => `${row.tag}:${row.status}:${row.sessionId}`),
      jobs: state.agentJobs.map((row) => `${row.tag}:${row.status}:${row.sessionId}`),
    }));
  return { dataDir, file, now, leadIds, running, workers, tombstones, jobs, agents, dispose, pulse, shown };
}

// The first reads ask for a maintenance pass, whose reaping writes the index
// (and the next read takes that write from disk): run it now so what follows
// is steady state.
async function settleBookkeeping(ctx) {
  ctx.pulse();
  await runAgentMaintenancePass();
  await flushAllIndexWrites();
  ctx.pulse();
}

// Pulses (`pulse()` → value) until `done(value)`, counting every sync fs call
// they made along the way.
async function pulseUntil(pulse, done) {
  const calls = [];
  let value;
  await eventually(() => {
    calls.push(
      ...syncFsCalls(() => {
        value = pulse();
      })
    );
    return done(value);
  });
  return { value, calls };
}

// The worker's session as another process would leave it: its record
// rewritten in place, with no live copy in this process.
function rewriteRecord(sessionId, patch) {
  const file = sessionPath(sessionId);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...stored, ...patch }));
}

test('a status pulse over every Lead reads no file in steady state, with the same contents', async (t) => {
  const ctx = scenario(t);
  const first = ctx.shown(ctx.pulse());
  assert.deepEqual(
    first,
    ctx.leadIds.map((lead) => ({
      workers: [`running-w:running:${ctx.running.get(lead)}`],
      jobs: [`running-w:running:${ctx.running.get(lead)}`],
    }))
  );
  // A job row carries its worker's live fields (jobWorkerSnapshot).
  assert.equal(ctx.pulse()[0].agentJobs[0].workerStatus, 'running');
  let states = null;
  const calls = syncFsCalls(() => {
    for (let i = 0; i < 10; i += 1) states = ctx.pulse();
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(ctx.shown(states), first);
});

test("the pulse sees this process's index writes at once and another process's once it lands", async (t) => {
  const ctx = scenario(t, { leads: 2 });
  const [lead] = ctx.leadIds;
  ctx.pulse();
  const writer = indexWriter(t, ctx);
  const added = workerRow(lead, `${lead}_added`, 'added-w', 'running', 0, Date.now());
  // Its spawn created the session: live in this process.
  saveWorkerSession(added);
  writer.writeWorkerRows((byKey) => byKey.set(added.sessionId, added));
  let states = null;
  assert.deepEqual(
    syncFsCalls(() => {
      states = ctx.pulse();
    }),
    [],
    'unpersisted writes are read from the projection'
  );
  assert.deepEqual(ctx.shown(states)[0].workers, [
    `running-w:running:${ctx.running.get(lead)}`,
    `added-w:running:${added.sessionId}`,
  ]);
  await flushAllIndexWrites();
  assert.deepEqual(ctx.shown(ctx.pulse()), ctx.shown(states));
  assert.deepEqual(
    syncFsCalls(() => ctx.pulse()),
    []
  );

  // Another process settles the running worker: a plain rewrite of the file.
  const doc = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
  const runningId = ctx.running.get(lead);
  doc.workers[runningId] = { ...doc.workers[runningId], status: 'idle', stage: 'idle', finishedAt: iso(Date.now()) };
  writeFileSync(ctx.file, JSON.stringify(doc));
  const stamp = new Date(Date.now() + 5000);
  utimesSync(ctx.file, stamp, stamp);
  // Read back off the loop: the pulses meanwhile serve the last document.
  const settled = await pulseUntil(
    () => ctx.shown(ctx.pulse())[0].workers,
    (workers) => !workers.some((row) => row.startsWith('running-w:'))
  );
  assert.deepEqual(settled.calls, [], 'no pulse read the changed index');
  assert.deepEqual(settled.value, [`added-w:running:${added.sessionId}`]);
  assert.deepEqual(
    syncFsCalls(() => ctx.pulse()),
    []
  );
});

test('a stale row is reaped on the index event that brings it, never by a status read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = scenario(t, { leads: 2 });
  const [lead] = ctx.leadIds;
  // The first reads register their scopes and ask for one pass.
  ctx.pulse();
  t.mock.timers.tick(MAINTENANCE_EVENT_DELAY_MS);
  await agentMaintenanceSettled();
  const writer = indexWriter(t, ctx);
  const listed = () => ctx.shown(ctx.pulse())[0].workers;
  const ghost = ghostRow(lead, 'ghost');
  writer.writeWorkerRows((byKey) => byKey.set(ghost.sessionId, ghost));
  assert.ok(listed().includes(`ghost-w:running:${ghost.sessionId}`), 'pulses alone never reap');
  t.mock.timers.tick(MAINTENANCE_EVENT_DELAY_MS);
  await agentMaintenanceSettled();
  assert.ok(!listed().includes(`ghost-w:running:${ghost.sessionId}`), 'the write that brought it was the event');
  assert.ok(
    writer.readAllTagTombstones().some((row) => row.sessionId === ghost.sessionId),
    'the reap left its tag tombstone'
  );
});

test('a row coming due later is reaped by one timer at its exact deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const ctx = scenario(t, { leads: 1 });
  const [lead] = ctx.leadIds;
  ctx.pulse();
  t.mock.timers.tick(MAINTENANCE_EVENT_DELAY_MS);
  await agentMaintenanceSettled();
  const writer = indexWriter(t, ctx);
  const listed = () => ctx.shown(ctx.pulse())[0].workers;
  // A running row whose session is gone, 5 s short of its reap window.
  const window = resolveAgentTerminalReapMs({}, 'p') ?? TAG_TOMBSTONE_TTL_MS;
  const stamp = Date.now() - window + 5_000;
  const ghost = workerRow(lead, `${lead}_due`, 'due-w', 'running', Date.now() - stamp, Date.now());
  writer.writeWorkerRows((byKey) => byKey.set(ghost.sessionId, ghost));
  t.mock.timers.tick(MAINTENANCE_EVENT_DELAY_MS);
  await agentMaintenanceSettled();
  assert.ok(listed().includes(`due-w:running:${ghost.sessionId}`), 'not due yet');
  t.mock.timers.tick(5_000 - MAINTENANCE_EVENT_DELAY_MS - 1);
  await agentMaintenanceSettled();
  assert.ok(listed().includes(`due-w:running:${ghost.sessionId}`), 'nothing ran before the deadline');
  t.mock.timers.tick(1);
  await agentMaintenanceSettled();
  assert.ok(!listed().includes(`due-w:running:${ghost.sessionId}`), 'reaped at the deadline');
});

test('a due row kept for its live work is reaped when that work ends', async (t) => {
  const busy = new Set();
  const ctx = scenario(t, { leads: 1, sessionManager: { ...mgr, isSessionTurnInFlight: (id) => busy.has(id) } });
  const kept = `${ctx.leadIds[0]}_error`;
  busy.add(kept);
  const indexed = async () => {
    await flushAllIndexWrites();
    return Object.values(JSON.parse(fs.readFileSync(ctx.file, 'utf8')).workers).some((row) => row.sessionId === kept);
  };
  await settleBookkeeping(ctx);
  // Every pass the first reads and their own index writes asked for has run.
  await new Promise((resolve) => setTimeout(resolve, MAINTENANCE_EVENT_DELAY_MS + 200));
  await agentMaintenanceSettled();
  assert.equal(await indexed(), true, 'its turn in flight keeps the aged-out row');
  // The turn ends: the activity change is the event that looks again.
  busy.delete(kept);
  emitSessionActivityChange(kept);
  await new Promise((resolve) => setTimeout(resolve, MAINTENANCE_EVENT_DELAY_MS + 200));
  await agentMaintenanceSettled();
  assert.equal(await indexed(), false, 'reaped once the work that kept it ended');
});

test('memory-only status reports what the session record says when no live copy exists', async (t) => {
  const ctx = scenario(t, { leads: 1 });
  const [lead] = ctx.leadIds;
  const sessionId = ctx.running.get(lead);
  await settleBookkeeping(ctx);
  // The record settled (this process evicted it, or another process wrote it)
  // while the index row still says running.
  saveSession({ ...mgr.getSession(sessionId), status: 'completed' }, { sync: true });
  _liveSessions.delete(sessionId);
  const recordStatus = () => mgr.getSession(sessionId).status;
  assert.equal(recordStatus(), 'completed');
  let changes = 0;
  ctx.agents[0].onStatusChange(() => {
    changes += 1;
  });
  const view = () => {
    const [state] = ctx.pulse();
    const job = state.agentJobs.find((row) => row.sessionId === sessionId);
    const worker = state.agentWorkers.find((row) => row.sessionId === sessionId);
    return { workerStatus: job.workerStatus, stage: job.stage, workerStage: worker.worker_stage };
  };
  const expected = (status) => ({ workerStatus: status, stage: status, workerStage: status });
  // Unknown until the record is read, off the pulse; then the record's answer.
  const cold = await pulseUntil(view, (value) => value.workerStatus === 'completed');
  assert.deepEqual(cold.calls, [], 'not even the first read touches a file');
  assert.deepEqual(cold.value, expected(recordStatus()));
  assert.ok(changes > 0, 'the loaded record was announced');

  // Another process keeps rewriting the record: reloads stay off the pulse.
  for (const status of ['error', 'completed']) {
    const before = changes;
    rewriteRecord(sessionId, { status, updatedAt: Date.now() });
    const changed = await pulseUntil(view, (value) => value.workerStatus === status);
    assert.deepEqual(changed.calls, [], `no read on the pulse after the record became ${status}`);
    assert.deepEqual(changed.value, expected(recordStatus()));
    await eventually(() => changes > before);
  }
});

test("memory-only status follows loadSession's precedence between a live copy and its record", async (t) => {
  const ctx = scenario(t, { leads: 1 });
  const [lead] = ctx.leadIds;
  const sessionId = ctx.running.get(lead);
  await settleBookkeeping(ctx);
  const live = _liveSessions.get(sessionId);
  assert.ok(live, 'the worker is live in this process');
  const jobStatus = (state) => state.agentJobs.find((row) => row.sessionId === sessionId)?.workerStatus;
  const pulseLead = () => ctx.pulse()[0];
  assert.equal(jobStatus(pulseLead()), 'running');

  // Another process (a `mixdog --plain` REPL on the same data dir) took the
  // session over while this one holds it: its record carries a higher generation.
  const generation = typeof live.generation === 'number' ? live.generation : 0;
  rewriteRecord(sessionId, { status: 'error', generation: generation + 5 });
  const taken = await pulseUntil(pulseLead, (state) => jobStatus(state) === 'error');
  assert.deepEqual(taken.calls, []);
  assert.equal(mgr.getSession(sessionId)?.status, 'error', 'getSession answers with the record');

  // A record that cannot be read owns the id over any live copy.
  saveWorkerSession({ ...ctx.workers[sessionId], status: 'running' });
  await pulseUntil(pulseLead, (state) => jobStatus(state) === 'running');
  writeFileSync(sessionPath(sessionId), '{"id": "not-this-one"');
  const unreadable = await pulseUntil(pulseLead, (state) => jobStatus(state) === undefined);
  assert.deepEqual(unreadable.calls, []);
  assert.equal(mgr.getSession(sessionId), null, 'getSession reports nothing for an unreadable record');
});

test('session-record watches end with the Lead that read them and are released on dispose', async (t) => {
  const watching = trackWatchers(t);
  const sessionsDir = dirname(sessionPath('sess_probe'));
  const watched = () => watching().includes(sessionsDir);

  // A manager of its own: records are shared per manager.
  const ending = scenario(t, { leads: 1, sessionManager: { ...mgr } });
  const [lead] = ending.leadIds;
  _liveSessions.delete(ending.running.get(lead));
  await pulseUntil(ending.pulse, () => watched());
  // The Lead session closes: its status scope ends, and nothing reads its records.
  saveSession({ id: lead, owner: 'user', closed: true, messages: [], createdAt: Date.now() }, { sync: true });
  await eventually(() => !watched());

  const disposing = scenario(t, { leads: 1, sessionManager: { ...mgr } });
  _liveSessions.delete(disposing.running.get(disposing.leadIds[0]));
  await pulseUntil(disposing.pulse, () => watched());
  disposing.dispose();
  assert.equal(watched(), false, 'the last holder released its records and their watch');
});

test('onStatusChange fires for every change in what getStatus answers, and only then', async (t) => {
  const ctx = scenario(t, { leads: 1 });
  const [lead] = ctx.leadIds;
  const [agent] = ctx.agents;
  let changes = 0;
  agent.onStatusChange(() => {
    changes += 1;
  });
  const status = () => agent.getStatus({ callerSessionId: lead, clientHostPid: process.pid });
  await settleBookkeeping(ctx);
  const changedBy = async (what, action) => {
    status();
    const before = changes;
    const answer = JSON.stringify(status());
    await action();
    await eventually(() => changes > before).catch(() => assert.fail(`no change announced for ${what}`));
    assert.notEqual(JSON.stringify(status()), answer, `${what} changed the answer`);
  };

  // A session's activity: the running worker's todo progress.
  await changedBy('todo progress', () => {
    executeTodoTool(_liveSessions.get(ctx.running.get(lead)), { op: 'init', items: ['one', 'two'] });
  });
  // Job settlement.
  await changedBy('a settled job', () => {
    completeBackgroundTask(ctx.jobs[0].taskId, { status: 'completed', notify: false });
  });
  // A worker-index write in this process.
  const writer = indexWriter(t, ctx);
  const added = workerRow(lead, `${lead}_added`, 'added-w', 'running', 0, Date.now());
  saveWorkerSession(added);
  await changedBy('an index write', () => {
    writer.writeWorkerRows((byKey) => byKey.set(added.sessionId, added));
  });
  // Another process's index write.
  await flushAllIndexWrites();
  await changedBy("another process's index write", () => {
    const doc = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    delete doc.workers[added.sessionId];
    writeFileSync(ctx.file, JSON.stringify(doc));
  });
  // A session record reloaded off the pulse.
  const runningId = ctx.running.get(lead);
  _liveSessions.delete(runningId);
  const workerStage = () => status().workers.find((row) => row.sessionId === runningId)?.worker_stage;
  await eventually(() => workerStage() === 'running');
  await changedBy('a reloaded session record', () => rewriteRecord(runningId, { status: 'error' }));

  // Nothing changed: no announcement.
  status();
  const quiet = changes;
  emitSessionActivityChange(lead);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changes, quiet, 'an activity signal that changed nothing is not announced');
});

test("onStatusChange fires as a worker's turn moves through its stages", async (t) => {
  const ctx = scenario(t, { leads: 1 });
  const [lead] = ctx.leadIds;
  const [agent] = ctx.agents;
  const sessionId = ctx.running.get(lead);
  t.after(() => mgr.markSessionDone(sessionId));
  let changes = 0;
  agent.onStatusChange(() => {
    changes += 1;
  });
  const stage = () =>
    agent
      .getStatus({ callerSessionId: lead, clientHostPid: process.pid })
      .workers.find((row) => row.sessionId === sessionId)?.worker_stage;
  await settleBookkeeping(ctx);
  for (const [expected, move] of [
    ['connecting', () => mgr.markSessionAskStart(sessionId)],
    ['streaming', () => mgr.markSessionStreamDelta(sessionId, 'text')],
    ['tool_running', () => mgr.markSessionToolCall(sessionId, 'shell')],
  ]) {
    stage();
    const before = changes;
    await move();
    await eventually(() => changes > before).catch(() => assert.fail(`no change announced for ${expected}`));
    assert.equal(stage(), expected);
  }
});

test('onStatusChange fires when keychain prewarm finishes', async (t) => {
  let ready = false;
  let finish;
  const prewarm = new Promise((resolve) => {
    finish = resolve;
  });
  const dataDir = join(process.env.MIXDOG_DATA_DIR, `pulse-prewarm-${++caseSeq}`);
  mkdirSync(dataDir, { recursive: true });
  const agent = createStandaloneAgent({
    cfgMod: { loadConfig: () => ({ providers: {}, presets: [] }) },
    reg: {},
    mgr,
    dataDir,
    cwd: dataDir,
    awaitKeychainPrewarm: () => prewarm,
    isKeychainPrewarmReady: () => ready,
  });
  t.after(() => agent.dispose());
  let changes = 0;
  agent.onStatusChange(() => {
    changes += 1;
  });
  const lead = 'sess_prewarm_lead';
  assert.deepEqual(agent.getStatus({ callerSessionId: lead }), { workers: [], jobs: [], scope: null });
  ready = true;
  finish();
  await eventually(() => changes > 0);
  assert.deepEqual(agent.getStatus({ callerSessionId: lead }).scope, { sessionId: lead });
});

test('round-robin status reads over many scopes of one tool read no file in steady state', async (t) => {
  const ctx = scenario(t, { leads: 20, sharedTool: true });
  const first = ctx.shown(ctx.pulse());
  ctx.pulse();
  let states = null;
  const calls = syncFsCalls(() => {
    for (let i = 0; i < 3; i += 1) states = ctx.pulse();
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(ctx.shown(states), first);
});

test('the maintenance pass yields between scopes and one failing scope skips no other', async (t) => {
  const sessionReads = []; // [sessionId, loop turn]
  let failFor = null;
  let turn = 0;
  const watchedMgr = {
    ...mgr,
    getSession(id) {
      sessionReads.push([id, turn]);
      if (id === failFor) throw new Error('record unreadable');
      return mgr.getSession(id);
    },
  };
  const ctx = scenario(t, { leads: 3, sharedTool: true, sessionManager: watchedMgr });
  ctx.pulse();
  await runAgentMaintenancePass();
  const [failing, , reaped] = ctx.leadIds;
  const writer = indexWriter(t, ctx);
  const ghost = ghostRow(reaped, 'ghost');
  writer.writeWorkerRows((byKey) => byKey.set(ghost.sessionId, ghost));
  const listedGhost = () =>
    ctx.shown(ctx.pulse())[2].workers.includes(`ghost-w:running:${ghost.sessionId}`);
  assert.ok(listedGhost());

  failFor = ctx.running.get(failing);
  sessionReads.length = 0;
  // Counts loop turns until the test ends, however it ends.
  let ticking = true;
  t.after(() => {
    ticking = false;
  });
  const tick = () => {
    turn += 1;
    if (ticking) setImmediate(tick);
  };
  setImmediate(tick);
  const pass = runAgentMaintenancePass();
  assert.deepEqual(sessionReads, [], 'no step runs in the caller’s task');
  await pass;

  assert.ok(!listedGhost(), 'the scope after the failing one was still reaped');
  const turnOf = (lead) => sessionReads.find(([id]) => id === ctx.running.get(lead))?.[1];
  const turns = ctx.leadIds.map(turnOf);
  assert.ok(
    turns.every((value) => value !== undefined),
    JSON.stringify(sessionReads)
  );
  assert.equal(new Set(turns).size, turns.length, `each scope ran in its own turn: ${turns}`);
});

test("a cold scope's disk-only worker is populated and announced with no further pulse", async (t) => {
  const role = `role-c${caseSeq + 1}`;
  const ctx = scenario(t, { leads: 1, role, sessionManager: { ...mgr } });
  const [lead] = ctx.leadIds;
  const [agent] = ctx.agents;
  const sessionId = ctx.running.get(lead);
  _liveSessions.delete(sessionId);
  // Every once-a-second freshness check (the store folder, the shipped agent
  // definitions) has lapsed: a read that reached one would touch the disk.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10_000 });
  const statusOf = () => agent.getStatus({ callerSessionId: lead, clientHostPid: process.pid });
  const jobOf = (status) => status.jobs.find((row) => row.sessionId === sessionId);
  const announced = [];
  agent.onStatusChange(() => announced.push(statusOf()));

  let first = null;
  assert.deepEqual(
    syncFsCalls(() => {
      first = ctx.pulse()[0];
    }),
    [],
    'the cold scope read no file'
  );
  assert.equal(
    first.agentJobs.find((row) => row.sessionId === sessionId).workerStatus,
    undefined,
    'unknown until loaded'
  );

  // Only announcements read again from here on (the surfaces republishing).
  await eventually(() => {
    const job = announced.length > 0 ? jobOf(announced.at(-1)) : null;
    return job?.workerStatus === 'running' && job.watchdog === expectedWatchdog(role);
  });
  const job = jobOf(announced.at(-1));
  assert.equal(job.workerStatus, mgr.getSession(sessionId).status);
  assert.equal(job.worker_stage, 'running');
});

// The role default watchdog summary of an unarmed running worker.
function expectedWatchdog(role) {
  return agentWatchdogPolicyActive(resolveAgentWatchdogPolicy(role))
    ? 'not armed (no registered progress watchdog)'
    : undefined;
}

// Session-folder watches that report nothing on their own.
function silentSessionWatches(t) {
  const sessionsDir = dirname(sessionPath('sess_probe'));
  const watches = [];
  const realWatch = fs.watch;
  t.mock.method(fs, 'watch', function watch(dir, ...rest) {
    if (String(dir) !== sessionsDir) return realWatch.call(this, dir, ...rest);
    const fake = new EventEmitter();
    fake.close = () => {};
    watches.push(fake);
    return fake;
  });
  return { opened: () => watches.length };
}

// A running worker whose record does not exist yet, read as absent.
async function absentRecordWorker(t, watches) {
  const ctx = scenario(t, { leads: 1, sessionManager: { ...mgr } });
  const sessionId = ctx.running.get(ctx.leadIds[0]);
  _liveSessions.delete(sessionId);
  fs.rmSync(sessionPath(sessionId));
  const workerStatus = () => ctx.pulse()[0].agentJobs.find((row) => row.sessionId === sessionId)?.workerStatus;
  const opened = watches.opened();
  assert.equal(workerStatus(), undefined);
  // The load opens the watch before it reads; the read itself then lands.
  await eventually(() => watches.opened() > opened);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The record appears; no watch event says so.
  saveWorkerSession(ctx.workers[sessionId]);
  _liveSessions.delete(sessionId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(workerStatus(), undefined, 'nothing reported the new record yet');
  return { workerStatus };
}

test("a legacy tombstone's owner is resolved off the status read and announced when it lands", async (t) => {
  const ctx = scenario(t, { leads: 2 });
  const [reapedLead, siblingLead] = ctx.leadIds;
  const writer = indexWriter(t, ctx);
  await settleBookkeeping(ctx);
  let changes = 0;
  ctx.agents[1].onStatusChange(() => {
    changes += 1;
  });
  const siblingWorkers = () => ctx.shown(ctx.pulse())[1].workers;
  const sibling = `running-w:running:${ctx.running.get(siblingLead)}`;
  assert.deepEqual(siblingWorkers(), [sibling]);

  // An older build reaped the first Lead's worker: its tombstone names no
  // owner, so until resolved it holds the tag for the whole terminal.
  const legacy = {
    tag: 'running-w',
    agent: 'worker',
    clientHostPid: process.pid,
    sessionId: ctx.running.get(reapedLead),
    reapedAt: iso(Date.now()),
  };
  writer.writeWorkerRows((_rows, tombstones) => tombstones.set(tagTombstoneKey(legacy), legacy));
  let unresolved = null;
  assert.deepEqual(
    syncFsCalls(() => {
      unresolved = siblingWorkers();
    }),
    [],
    'the status read right after the change lists no sessions'
  );
  assert.deepEqual(unresolved, [], 'unresolved, it blocks the tag terminal-wide');
  await eventually(() => changes > 0);
  assert.deepEqual(siblingWorkers(), [sibling], 'resolved to its owner, the sibling is listed again');
  assert.deepEqual(ctx.shown(ctx.pulse())[0].workers, [], "the owner's worker stays reaped");
  assert.deepEqual(
    syncFsCalls(() => ctx.pulse()),
    []
  );
});

// Counts the async reads of `sessionId`'s record file.
function countRecordReads(t, sessionId) {
  const recordFile = sessionPath(sessionId);
  const readFile = fsp.readFile;
  let reads = 0;
  t.mock.method(fsp, 'readFile', async (path, ...args) => {
    const bytes = await readFile(path, ...args);
    if (String(path) === recordFile) reads += 1;
    return bytes;
  });
  return () => reads;
}

test('a live copy answers until its record is read, and the record stands once the copy goes', async (t) => {
  const ctx = scenario(t, { leads: 1 });
  const sessionId = ctx.running.get(ctx.leadIds[0]);
  const recordReads = countRecordReads(t, sessionId);
  const workerStatus = () => ctx.pulse()[0].agentJobs.find((row) => row.sessionId === sessionId)?.workerStatus;
  assert.equal(workerStatus(), 'running', 'the live copy answers at once');
  await eventually(() => recordReads() > 0);
  // The copy is released: the record read before answers at once.
  _liveSessions.delete(sessionId);
  assert.equal(workerStatus(), mgr.getSession(sessionId).status);
  rewriteRecord(sessionId, { status: 'error', updatedAt: Date.now() });
  const changed = await pulseUntil(workerStatus, (status) => status === 'error');
  assert.deepEqual(changed.calls, []);
});

test('while the sessions folder is watched, nothing re-checks records on a clock', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const watches = silentSessionWatches(t);
  const { workerStatus } = await absentRecordWorker(t, watches);
  t.mock.timers.tick(10 * 60_000);
  await runAgentMaintenancePass();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(workerStatus(), undefined, 'only a watch event would say the record appeared');
});

test('a sessions folder created after the first read is watched from its parent, and its records are seen', async (t) => {
  const ctx = scenario(t, { leads: 1, sessionManager: { ...mgr } });
  const sessionId = ctx.running.get(ctx.leadIds[0]);
  const sessionsDir = dirname(sessionPath(sessionId));
  // Nothing of the folder is left; its sessions are in no process's memory.
  const record = fs.readFileSync(sessionPath(sessionId));
  _liveSessions.delete(sessionId);
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  const workerStatus = () => ctx.pulse()[0].agentJobs.find((row) => row.sessionId === sessionId)?.workerStatus;
  assert.equal(workerStatus(), undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(workerStatus(), undefined, 'no folder, no record');
  // Another process creates the folder and writes the record.
  fs.mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(sessionPath(sessionId), record);
  const seen = await pulseUntil(workerStatus, (status) => status === 'running');
  assert.deepEqual(seen.calls, []);
});
