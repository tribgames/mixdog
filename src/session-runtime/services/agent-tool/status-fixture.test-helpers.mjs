// An agent status world for the status-set tests and the bench: one agent
// tool over one worker index with an in-memory session manager, populated
// (and re-populated, for many seeded sequences) with worker rows, tag
// tombstones, tag-only sessions, agent jobs and status scopes, and every
// source event a status answer depends on (seeded, reproducible). The
// reference read is the status read before the status sets (status-oracle/).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createStandaloneAgent } from '../agent-tool.mjs';
import { createWorkerIndex } from './worker-index.mjs';
import { flushAllIndexWrites } from './index-write-queue.mjs';
import { _setMaintenanceTimersForTest, agentMaintenanceSettled } from './maintenance-pass.mjs';
import { tagTombstoneKey } from './worker-rows.mjs';
import { refreshRolePolicies } from './job-views/session-progress.mjs';
import { createStatusOracle } from './status-oracle/oracle.test-helpers.mjs';
import {
  cleanupBackgroundTasks,
  completeBackgroundTask,
  registerBackgroundTask,
} from '../../../runtime/shared/background-tasks.mjs';
import { emitSessionActivityChange } from '../../../runtime/shared/session-activity-signal.mjs';
import { emitSessionApprovalWaitChange } from '../../../runtime/shared/session-approval-wait.mjs';
import { _clearLiveSession, _liveSessions } from '../../../runtime/agent/orchestrator/session/store/live-state.mjs';
import {
  _publishLiveSession,
  _runSessionPurgeHooks,
} from '../../../runtime/agent/orchestrator/session/store/session-observers.mjs';
import { executeTodoTool } from '../../../runtime/agent/orchestrator/runtime-core/todo-list.mjs';

export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['running', 'running', 'running', 'streaming', 'idle', 'completed', 'error'];
const STAGES = ['connecting', 'requesting', 'streaming', 'tool_running', 'idle', 'done'];
const HOUR = 3_600_000;
let worldSeq = 0;

const START = Date.parse('2026-11-12T00:00:00.000Z');
// The fake clock never covers setTimeout (world): this is the real one.
const realSetTimeout = setTimeout;

/** A world on `t`'s fake clock, populated; the reference read primed (its role
 *  policies) and the announcement audit on. The clock is Date and the watchdog
 *  sweep's interval, plus the maintenance pass's own timers on a scheduler of
 *  this clock: the scenario's time moves only by what its events state. File
 *  I/O (the index lock, a rename retried on Windows) waits on real timers. */
export async function world(t, populate) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: START });
  const due = new Map(); // handle -> { at, fn }
  _setMaintenanceTimersForTest({
    setTimeout: (fn, ms) => {
      const handle = {};
      due.set(handle, { at: Date.now() + ms, fn });
      return handle;
    },
    clearTimeout: (handle) => due.delete(handle),
  });
  t.after(() => _setMaintenanceTimersForTest(null));
  const tick = (ms) => {
    t.mock.timers.tick(ms);
    // Due maintenance timers fire in deadline order (one may arm the next).
    for (;;) {
      let next = null;
      for (const [handle, timer] of due) if (timer.at <= Date.now() && (!next || timer.at < next[1].at)) next = [handle, timer];
      if (!next) break;
      due.delete(next[0]);
      next[1].fn();
    }
  };
  const w = await createStatusWorld({ dataRoot: process.env.MIXDOG_DATA_DIR, now: () => Date.now(), tick });
  t.after(() => w.dispose());
  w.agent._statusAuditForTest.set(true);
  await w.populate(populate);
  await primeOracle(w);
  return w;
}

/** Fails `label` when a pass found an input that moved with no announcement. */
export function assertNoAuditMiss(w, label) {
  const misses = w.agent._statusAuditForTest.misses();
  assert.deepEqual(misses, [], `${label}: inputs changed with no announcement for ${misses.join(', ')}`);
}

async function primeOracle(w) {
  for (const context of w.contexts) w.oracle(context);
  await settle();
  // Each observer starts from the answer it holds now (a role policy the
  // priming read resolved may have changed it since populate's reads).
  for (const context of w.contexts) w.agent.getStatus(context);
  await settle();
  // Setup replaced every input wholesale: the audit starts from here.
  w.agent._statusAuditForTest.misses();
}

/** Runs `steps` seeded events on `w` (after `populate`, when given),
 *  checking after each one that every scope's answer equals the reference
 *  read and that onStatusChange fired exactly when a read changed. Returns how
 *  many steps changed a read. */
export async function runSequence(t, w, steps, label, populate = null) {
  if (populate) {
    await w.populate(populate);
    await primeOracle(w);
  }
  const { agent, contexts } = w;
  let fired = 0;
  const stop = agent.onStatusChange(() => {
    fired += 1;
  });
  const start = contexts.map((context) => agent.getStatus(context));
  let previous = contexts.map((context, i) => {
    const oracle = w.oracle(context);
    assert.deepEqual(start[i], oracle, `${label} start, scope ${JSON.stringify(context)}`);
    return JSON.stringify(oracle);
  });
  let changes = 0;
  try {
    for (let step = 0; step < steps; step += 1) {
      t.mock.timers.setTime(Date.now() + 997);
      const name = w.pick(w.eventNames);
      fired = 0;
      await w.events[name]();
      await settle();
      const told = fired > 0;
      const answers = contexts.map((context) => agent.getStatus(context));
      const oracle = contexts.map((context) => w.oracle(context));
      assertNoAuditMiss(w, `${label} step ${step} (${name})`);
      contexts.forEach((context, i) => {
        assert.deepEqual(answers[i], oracle[i], `${label} step ${step} (${name}), scope ${JSON.stringify(context)}`);
      });
      const current = oracle.map((answer) => JSON.stringify(answer));
      const changed = current.some((answer, i) => answer !== previous[i]);
      assert.equal(told, changed, `${label} step ${step} (${name}): announced ${told}, read changed ${changed}`);
      if (changed) changes += 1;
      previous = current;
    }
  } finally {
    stop();
  }
  return changes;
}

/** Every pending pass (one per event-loop turn, and the role policies they ask for). */
export async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `now()`: the clock; `tick(ms)` (optional): advance it running due timers
 * (the maintenance pass, its deadline timer), else the clock is only read.
 */
export async function createStatusWorld({ dataRoot, now, tick = null }) {
  const dataDir = join(dataRoot, `status-${++worldSeq}`);
  mkdirSync(dataDir, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const pid = process.pid;

  const sessions = new Map();
  const runtimes = new Map();
  const snapshots = new Map();
  // Progress watchdogs (agent-watchdog-registry.mjs) link through the manager;
  // a blocked link leaves one unarmed until a later sweep, and a sweep can fail.
  const linkBlocked = new Set();
  const failing = { sweep: false };
  const mgr = {
    getSession: (sid) => {
      if (failing.sweep) throw new Error('record unreadable');
      return sessions.get(sid) || null;
    },
    linkParentSignalToSession: (sid) => {
      if (linkBlocked.has(sid)) throw new Error('runtime not loaded');
      return () => {};
    },
    getSessionRuntime: (sid) => runtimes.get(sid) || null,
    getSessionProgressSnapshot: (sid) => snapshots.get(sid) || null,
    listSessions: () => [...sessions.values()],
    // A working row's turn runs here (a new index holder settles any other).
    isSessionTurnInFlight: (sid) => ['running', 'streaming'].includes(sessions.get(sid)?.status),
    hasPendingMessages: () => false,
    closeSession: async () => {},
  };

  let ready = true;
  let finishPrewarm = null;
  let prewarm = Promise.resolve();
  const cfgMod = { loadConfig: () => ({ providers: {}, presets: [] }) };
  const writer = createWorkerIndex({ dataDir, cfgMod, mgr, tags: new Map(), tagAgents: new Map(), tagCwds: new Map() });
  const agent = createStandaloneAgent({
    cfgMod,
    reg: {},
    mgr,
    dataDir,
    cwd: dataDir,
    isKeychainPrewarmReady: () => ready,
    awaitKeychainPrewarm: () => prewarm,
  });
  const internals = agent._statusInternalsForTest;
  const oracleRead = createStatusOracle(internals);

  const sessionFor = (sid, lead, tag, status, createdMs) => ({
    id: sid,
    owner: 'agent',
    agent: 'worker',
    agentTag: tag,
    parentSessionId: lead,
    ownerSessionId: lead,
    clientHostPid: pid,
    status,
    provider: 'p',
    model: 'm',
    createdAt: createdMs,
    updatedAt: createdMs,
    messages: [],
  });
  const rowOf = (session) => ({
    tag: session.agentTag,
    sessionId: session.id,
    parentSessionId: session.parentSessionId,
    ownerSessionId: session.ownerSessionId,
    agent: session.agent,
    provider: session.provider,
    model: session.model,
    status: session.status,
    stage: session.status,
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
    clientHostPid: pid,
    runtimePid: pid,
  });

  const world = {
    agent,
    writer,
    mgr,
    sessions,
    runtimes,
    snapshots,
    linkBlocked,
    failing,
    contexts: [],
    leadIds: [],
    rowSids: [],
    tagOnly: [],
    tasks: [],
    random: Math.random,
    pick: (list) => list[Math.floor(world.random() * list.length)],
    /** The status read before the status sets, for `context`. */
    oracle: (context) => oracleRead(context),
    setStage: (sid, stage) => runtimes.set(sid, { ...(runtimes.get(sid) || {}), stage }),
  };
  const { pick } = world;

  const registerTask = (sid, surface = 'agent') => {
    const session = sessions.get(sid);
    const task = registerBackgroundTask({
      surface,
      operation: surface === 'agent' ? 'spawn' : 'run',
      label: session.agentTag,
      input: { type: 'spawn', tag: session.agentTag, sessionId: sid, agent: session.agent },
      context: { callerSessionId: session.parentSessionId, clientHostPid: pid },
      meta: { tag: session.agentTag, sessionId: sid, agent: session.agent },
    });
    world.tasks.push(task);
    return task;
  };
  const replaceSession = (sid, patch) => {
    const next = { ...sessions.get(sid), ...patch, updatedAt: now() };
    sessions.set(sid, next);
    if (_liveSessions.has(sid)) _liveSessions.set(sid, next);
    return next;
  };
  const anySid = () => (world.random() < 0.85 || world.tagOnly.length === 0 ? pick(world.rowSids) : pick(world.tagOnly));
  // Every event ends with a signal that runs a pass, as each source does.
  const ping = () => emitSessionActivityChange(pick(world.leadIds));
  const writeRows = (mutate) => writer.writeWorkerRows(mutate);
  const purgeSession = (sid) => {
    sessions.delete(sid);
    runtimes.delete(sid);
    _clearLiveSession(sid);
    _runSessionPurgeHooks(sid);
  };
  // Every maintenance pass and index write landed (their file I/O waits on
  // real timers), or a failure naming what did not within the deadline.
  const FLUSH_DEADLINE_MS = 30_000;
  const flushWrites = async () => {
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = realSetTimeout(
        () => reject(new Error(`index writes and the maintenance pass did not settle within ${FLUSH_DEADLINE_MS} ms`)),
        FLUSH_DEADLINE_MS
      );
    });
    try {
      await Promise.race([agentMaintenanceSettled().then(() => flushAllIndexWrites()), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** A fresh seeded state; the previous one is purged first (its scopes end). */
  world.populate = async ({
    seed,
    rows = 300,
    tombstones = 500,
    leads = 28,
    tagOnly = 20,
    tasks = 30,
    notReady = false,
    statuses = STATUSES,
  }) => {
    for (const lead of world.leadIds) _runSessionPurgeHooks(lead);
    for (const sid of sessions.keys()) _clearLiveSession(sid);
    for (const map of [sessions, runtimes, snapshots]) map.clear();
    for (const tag of [...internals.tags.keys()]) agent._tagMapsForTest.unbind(tag);
    cleanupBackgroundTasks({ force: true });
    writeRows((byKey, tombstonesByKey) => {
      byKey.clear();
      tombstonesByKey.clear();
    });
    world.random = seededRandom(seed);
    const random = world.random;
    const id = `p${++worldSeq}s${seed}`;
    const t0 = now();
    world.leadIds = Array.from({ length: leads }, (_, i) => `sess_${id}_lead${i}`);
    for (const lead of world.leadIds) {
      sessions.set(lead, { id: lead, owner: 'user', clientHostPid: pid, status: 'idle', createdAt: t0, messages: [] });
    }
    world.rowSids = [];
    for (let i = 0; i < rows; i += 1) {
      const sid = `sess_${id}_r${i}`;
      const age = random() < 0.2 ? 30 * HOUR : HOUR;
      sessions.set(sid, sessionFor(sid, world.leadIds[i % leads], `r${i}-w`, pick(statuses), t0 - age + i * 1000));
      world.rowSids.push(sid);
    }
    world.tagOnly = [];
    for (let i = 0; i < tagOnly; i += 1) {
      const sid = `sess_${id}_t${i}`;
      sessions.set(sid, sessionFor(sid, world.leadIds[i % leads], `t${i}-w`, pick(STATUSES), t0 - 60_000));
      world.tagOnly.push(sid);
    }
    const tombstoneRows = Array.from({ length: tombstones }, (_, i) => {
      const target = random() < 0.1 ? sessions.get(pick(world.rowSids)) : null;
      return {
        tag: target ? target.agentTag : `gone${i}-w`,
        agent: 'worker',
        clientHostPid: pid,
        sessionId: target ? target.id : `sess_${id}_gone${i}`,
        parentSessionId: target ? target.parentSessionId : world.leadIds[i % leads],
        ownerSessionId: target ? target.ownerSessionId : world.leadIds[i % leads],
        reapedAt: iso(t0 - 1000 - i * 60_000),
      };
    });
    writeRows((byKey, tombstonesByKey) => {
      for (const sid of world.rowSids) byKey.set(sid, rowOf(sessions.get(sid)));
      for (const row of tombstoneRows) tombstonesByKey.set(tagTombstoneKey(row), row);
    });
    world.tasks = [];
    for (let i = 0; i < tasks; i += 1) registerTask(world.rowSids[(i * 7) % rows]);
    world.contexts = [
      ...world.leadIds.map((lead) => ({ callerSessionId: lead, clientHostPid: pid })),
      { clientHostPid: pid },
      {},
    ];
    await flushWrites();
    // A prewarm the last sequence left waiting finishes.
    finishPrewarm?.();
    finishPrewarm = null;
    prewarm = Promise.resolve();
    ready = !notReady;
    // A pass sees the new prewarm state before the sequence starts: a
    // not-ready read is not recorded as handed out (as at HEAD), the pass is.
    ping();
    await settle();
    for (const context of world.contexts) agent.getStatus(context);
    await settle();
  };

  const events = {
    // A turn moves: the runtime stage, named.
    stage() {
      const sid = anySid();
      world.setStage(sid, pick(STAGES));
      emitSessionActivityChange(sid);
    },
    // Inputs changed in place, each announced as its source does
    // (sources.md): the request phase (runtime-liveness.mjs), a session
    // written in place then saved, a live copy evicted (_clearLiveSession).
    inPlace() {
      const sid = anySid();
      const roll = world.random();
      if (roll < 0.4) {
        snapshots.set(sid, { stage: pick(STAGES), waitingForTransport: world.random() < 0.5 });
        emitSessionActivityChange(sid);
      } else if (roll < 0.7 && sessions.has(sid)) {
        const session = sessions.get(sid);
        session.totalInputTokens = (session.totalInputTokens || 0) + 10;
        session.messages = session.messages || [];
        session.messages.push({ role: 'assistant' });
        _publishLiveSession(session);
      } else if (!_clearLiveSession(sid)) ping();
    },
    // A settle that names no session (an unowned task).
    unnamed() {
      emitSessionActivityChange('');
    },
    approval() {
      const sid = anySid();
      const waiting = world.random() < 0.5;
      runtimes.set(sid, { ...(runtimes.get(sid) || {}), awaitingUser: waiting ? 'approval' : null });
      emitSessionApprovalWaitChange(sid, waiting ? 'approval' : null);
    },
    // A saved session: a new live copy (and its record).
    save() {
      const sid = anySid();
      if (!sessions.has(sid)) return ping();
      const session = replaceSession(sid, {
        status: pick(STATUSES),
        messages: new Array(Math.floor(world.random() * 5)),
      });
      if (world.random() < 0.5) _liveSessions.set(sid, session);
      _publishLiveSession(session);
      ping();
    },
    todo() {
      const sid = anySid();
      const live = _liveSessions.get(sid) || sessions.get(sid);
      _liveSessions.set(sid, live);
      try {
        executeTodoTool(live, live.todo ? { op: 'start', item: 'b' } : { op: 'init', items: ['a', 'b'] });
      } catch {
        emitSessionActivityChange(sid);
      }
    },
    upsertRow() {
      const sid = pick(world.rowSids);
      if (!sessions.has(sid)) return ping();
      const session = replaceSession(sid, { status: pick(STATUSES) });
      writeRows((byKey) => byKey.set(sid, rowOf(session)));
    },
    removeRow() {
      const sid = pick(world.rowSids);
      writeRows((byKey) => byKey.delete(sid));
    },
    // Rows deleted and written again move to the end of the document.
    reorder() {
      const sids = [pick(world.rowSids), pick(world.rowSids)];
      writeRows((byKey) => {
        for (const sid of sids) {
          const row = byKey.get(sid);
          if (!row) continue;
          byKey.delete(sid);
          byKey.set(sid, row);
        }
      });
    },
    tombstone() {
      const target = sessions.get(anySid());
      if (!target) return ping();
      const add = world.random() < 0.6;
      const row = {
        tag: target.agentTag,
        agent: 'worker',
        clientHostPid: pid,
        sessionId: target.id,
        parentSessionId: target.parentSessionId,
        ownerSessionId: target.ownerSessionId,
        reapedAt: iso(now()),
      };
      writeRows((_byKey, tombstonesByKey) => {
        if (add) tombstonesByKey.set(tagTombstoneKey(row), row);
        else tombstonesByKey.delete(tagTombstoneKey(row));
      });
    },
    // Another process rewrote the index: read back as a new document.
    async external() {
      await flushWrites();
      const file = writer.workerIndexPath();
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const sid = pick(world.rowSids);
      const session = sessions.get(sid);
      if (doc.workers[sid]) doc.workers[sid] = { ...doc.workers[sid], status: pick(STATUSES), updatedAt: iso(now()) };
      else if (session) doc.workers[sid] = rowOf(session);
      writeFileSync(file, JSON.stringify(doc));
      writer.invalidateWorkerRowsCache();
      ping();
    },
    bindTag() {
      if (world.tagOnly.length === 0) return ping();
      const sid = pick(world.tagOnly);
      if (sessions.has(sid)) internals.tags.set(sessions.get(sid).agentTag, sid);
      ping();
    },
    unbindTag() {
      const sid = world.random() < 0.5 && world.tagOnly.length > 0 ? pick(world.tagOnly) : pick(world.rowSids);
      const tag = sessions.get(sid)?.agentTag;
      if (tag) agent._tagMapsForTest.unbind(tag);
      ping();
    },
    taskStart() {
      const sid = pick(world.rowSids);
      if (sessions.has(sid)) registerTask(sid);
      else ping();
    },
    taskEnd() {
      const running = world.tasks.filter((task) => task.status === 'running');
      if (running.length === 0) return ping();
      completeBackgroundTask(pick(running).taskId, { status: pick(['completed', 'failed']), notify: false });
    },
    // A session deleted: its purge (a Lead's ends its status scope).
    purge() {
      purgeSession(world.random() < 0.15 ? pick(world.leadIds) : anySid());
      ping();
    },
    // A row listener whose frame ends a scope (its own or another Lead's)
    // while a list read steps the sets: the read still answers a list.
    listenerEndsScope() {
      const context = pick(world.contexts.filter((item) => item.callerSessionId));
      const target = world.random() < 0.5 ? context.callerSessionId : pick(world.leadIds);
      const row = agent.getStatus(context).workers[0];
      if (!row) return ping();
      let ended = false;
      const stop = agent.onStatusRows(context, () => {
        if (ended) return;
        ended = true;
        purgeSession(target);
      });
      const runtime = runtimes.get(row.sessionId) || {};
      const waiting = runtime.awaitingUser ? null : 'approval';
      runtimes.set(row.sessionId, { ...runtime, awaitingUser: waiting });
      emitSessionApprovalWaitChange(row.sessionId, waiting);
      let list;
      try {
        list = agent.getStatusList(context);
      } finally {
        stop();
      }
      assert.ok(ended, 'the listener heard the frame');
      assert.ok(list.epoch && Number.isInteger(list.seq) && Array.isArray(list.workers) && Array.isArray(list.jobs));
    },
    // A Lead session closed: its status scope ends (and is read again).
    closeLead() {
      const lead = pick(world.leadIds);
      _publishLiveSession({ ...(sessions.get(lead) || { id: lead }), closed: true });
    },
    // A role seen for the first time resolves its policy off the read; the
    // maintenance pass re-resolves every held one.
    rolePolicy() {
      const sid = pick(world.rowSids);
      if (!sessions.has(sid)) return ping();
      if (world.random() < 0.5) {
        const session = replaceSession(sid, { agent: pick(['worker', 'reviewer', 'heavy-worker', 'maintainer']) });
        writeRows((byKey) => byKey.set(sid, rowOf(session)));
      } else {
        refreshRolePolicies();
        ping();
      }
    },
    // Keychain prewarm: the status is empty until it finishes.
    prewarm() {
      if (ready) {
        ready = false;
        prewarm = new Promise((resolve) => {
          finishPrewarm = resolve;
        });
        ping();
        return;
      }
      ready = true;
      finishPrewarm?.();
      ping();
    },
    // Another surface's work fills the task registry past its cap: the oldest
    // finished tasks, an agent job of any scope among them, are evicted.
    capFlood() {
      const owner = pick(world.leadIds);
      for (let i = 0; i < 80; i += 1) {
        const task = registerBackgroundTask({
          surface: 'shell',
          operation: 'run',
          label: `flood${i}`,
          context: { callerSessionId: owner, clientHostPid: pid },
        });
        completeBackgroundTask(task.taskId, { status: 'completed', notify: false });
      }
    },
    // Time passes: a finished job's expiry, a row's reap deadline, retention.
    async time() {
      const ms = pick([60_000, 31 * 60_000, 25 * HOUR]);
      if (tick) tick(ms);
      await flushWrites();
      await settle(60);
      ping();
    },
  };
  world.events = events;
  /** Every index write landed and its document served to the status sets. */
  world.quiesce = async () => {
    await flushWrites();
    ping();
    await settle();
  };
  world.eventNames = Object.keys(events);

  world.dispose = async () => {
    for (const lead of world.leadIds) _runSessionPurgeHooks(lead);
    cleanupBackgroundTasks({ force: true });
    for (const sid of sessions.keys()) _clearLiveSession(sid);
    agent.dispose();
    writer.dispose();
    await flushWrites();
  };
  return world;
}
