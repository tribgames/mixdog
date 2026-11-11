#!/usr/bin/env node
// Recording of apps/desktop/src/main/remote-idle-state.test.mjs (b6f10295a): an idle session whose Goal clock runs and whose agent
// job streams is re-read on the 2 s route pulse; only a real change may reach the relay. Real goal-state.mjs (goalStateSnapshot,
// publicGoal, activeElapsedMs), the real job views (standalone/agent-tool/job-views.mjs, liveAgentStatusRow), the registered background
// task, and the real snapshot delta encoder/decoder (apps/desktop/src/main/state-delta.ts) in both its compact and plain wire. The
// renderer's goal labels (session-goal-presentation.ts) are read off the held snapshot as the phone does.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-remote-idle-state-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('remote-idle-state-cases', import.meta.url, { clock: false });
const { registerBackgroundTask } = await set.load('src/runtime/shared/background-tasks.mjs');
const { activeElapsedMs, goalStateSnapshot, publicGoal } = await set.load('src/session-runtime/goal-state.mjs');
const { createJobViews } = await set.load('src/standalone/agent-tool/job-views.mjs');
const { liveAgentStatusRow } = await set.load('src/standalone/agent-tool/job-views/session-progress.mjs');
const { formatGoalDuration, goalElapsedLabel, goalTimeLabel } = await set.load('apps/desktop/src/renderer/session-goal-presentation.ts');
const { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder, isNoDelta, markCompactWire } = await set.load('apps/desktop/src/main/state-delta.ts');

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
function withClock(now, read) {
  const original = Date.now;
  Date.now = () => now;
  try { return read(); } finally { Date.now = original; }
}
Date.now = () => T0;

function idleFixture() {
  const worker = {
    id: 'idle-churn-worker', agent: 'worker', provider: 'openai', model: 'gpt-5', status: 'streaming', createdAt: '2026-03-01T09:59:00.000Z',
    messages: [{ role: 'user', content: 'go' }], tools: [], clientHostPid: 4242,
    runtime: { stage: 'streaming', lastStreamDeltaAt: T0 - 30_000, lastProgressAt: T0 - 30_000 }, snapshot: { stage: 'streaming', lastStreamDeltaAt: T0 - 30_000 },
  };
  const sessions = new Map([[worker.id, worker]]);
  const views = createJobViews({
    mgr: { getSession: (id) => sessions.get(id) || null, getSessionRuntime: (id) => sessions.get(id)?.runtime || null, getSessionProgressSnapshot: (id) => sessions.get(id)?.snapshot || null, getSessionPendingMessageDepth: () => null },
    getLiveSession: (id) => sessions.get(id) || null, reg: { getProvider: () => null }, DEFAULT_SPAWN_PREP_TIMEOUT_MS: 1000, refreshTagsFromSessions: () => {},
    agentSessionEntries: () => [{ tag: 'idle-churn', session: worker }], tags: new Map(), cfgMod: { loadConfig: () => ({}) },
  });
  withClock(T0 - 60_000, () => registerBackgroundTask({ surface: 'agent', operation: 'spawn', meta: { tag: 'idle-churn', sessionId: worker.id, agent: 'worker', provider: 'openai', model: 'gpt-5' }, input: { tag: 'idle-churn' } }));
  const goal = { id: 'idle-churn-goal', revision: 3, objectiveRevision: 1, tasksObjectiveRevision: 1, sessionId: 'idle-churn-session', objective: 'Ship the remote diet', title: 'Ship the remote diet', status: 'active', timeLimitMs: 60 * 60_000, timeUsedMs: 5 * 60_000, createdAt: T0 - 10 * 60_000, updatedAt: T0 - 60_000, lastStartedAt: T0 - 90_000 };
  const agentRows = (now, project) => withClock(now, () => ({ agentWorkers: views.list({ context: {} }).map(project), agentJobs: views.listJobs({}).filter((row) => row.tag === 'idle-churn').map(project) }));
  const items = [{ id: 'u1', kind: 'user', text: 'keep going' }];
  const snapshotAt = (now, { anchored = true } = {}) => ({ sessionId: 'idle-churn-session', items, streamingTail: null, busy: false, goal: anchored ? goalStateSnapshot(publicGoal(goal, now)) : publicGoal(goal, now), ...agentRows(now, anchored ? liveAgentStatusRow : (row) => row) });
  return { goal, worker, snapshotAt };
}

await set.run('an idle session with a running Goal and agent job sends no state frames until content changes', () => {
  const { goal, worker, snapshotAt } = idleFixture();
  const ticks = Array.from({ length: 30 }, (_, index) => T0 + index * 2_000);
  const rawA = snapshotAt(ticks[0], { anchored: false });
  const rawB = snapshotAt(ticks[1], { anchored: false });
  const out = { t0: T0, tickMs: 2_000, ticks: ticks.length, goal, rawReads: { a: rawA, b: rawB }, wires: [] };
  for (const compact of [true, false]) {
    const encoder = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    const deliver = (snapshot) => {
      const encoded = encoder.encode(snapshot);
      if (isNoDelta(encoded)) return null;
      const wire = structuredClone(encoded);
      if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
      const decoded = decoder.decode(wire);
      return structuredClone({ wire, ok: decoded.ok, snapshot: decoded.snapshot });
    };
    const rec = { compact };
    const first = deliver(snapshotAt(ticks[0]));
    rec.baseline = first;
    const held = first.snapshot;
    rec.framesAfterBaseline = ticks.slice(1).map((now) => ({ offsetMs: now - T0, delivered: deliver(snapshotAt(now)) }));
    rec.labels = [T0, T0 + 17_000, T0 + 59_000, T0 + 30 * 60_000].map((clock) => ({ clock, elapsed: goalElapsedLabel(held.goal, clock), expectedElapsed: formatGoalDuration(Math.min(goal.timeLimitMs, activeElapsedMs(goal, clock))), time: goalTimeLabel(held.goal, clock), timeOfPublicGoal: goalTimeLabel(publicGoal(goal, clock), clock) }));
    rec.deadline = { held: held.goal.deadlineAt, publicGoal: publicGoal(goal, T0).deadlineAt };
    const last = ticks.at(-1);
    worker.runtime.stage = 'tool_running';
    const changed = deliver(snapshotAt(last + 2_000));
    worker.runtime.stage = 'streaming';
    rec.stageChange = { delivered: changed };
    const paused = { ...goal, status: 'paused', timeUsedMs: 7 * 60_000, lastStartedAt: null };
    const pausedFrame = deliver({ ...snapshotAt(last + 4_000), goal: goalStateSnapshot(publicGoal(paused, last + 4_000)) });
    rec.paused = { delivered: pausedFrame, elapsedLabelLater: pausedFrame ? goalElapsedLabel(pausedFrame.snapshot.goal, last + 60_000) : null, expectedLabel: formatGoalDuration(7 * 60_000) };
    rec.pausedReadLater = { delivered: deliver({ ...snapshotAt(last + 6_000), goal: goalStateSnapshot(publicGoal(paused, last + 6_000)) }) };
    out.wires.push(rec);
  }
  return out;
});
await set.run('goal state snapshots are idempotent and leave clock-less Goals untouched', () => {
  const plain = { id: 'g', status: 'active' };
  const goalInput = { id: 'g', status: 'active', objective: 'x', timeUsedMs: 1_000, timeLimitMs: 0, lastStartedAt: T0, tasks: [] };
  const running = publicGoal(goalInput, T0 + 5_000);
  const anchored = goalStateSnapshot(running);
  return { plain, plainSnapshot: goalStateSnapshot(plain), plainSameObject: goalStateSnapshot(plain) === plain, nullIn: goalStateSnapshot(null), goalInput, now: T0 + 5_000, running, anchored, anchoredSnapshotAt: anchored.snapshotAt, anchoredTimeUsedMs: anchored.timeUsedMs, remainingMs: anchored.remainingMs, deadlineAt: anchored.deadlineAt, idempotent: goalStateSnapshot(anchored) === anchored };
});

await set.finish({
  entry: {
    runs: 'src/session-runtime/goal-state.mjs, standalone/agent-tool/job-views.mjs (createJobViews list/listJobs) and job-views/session-progress.mjs liveAgentStatusRow with a registered background agent task, apps/desktop/src/main/state-delta.ts (encoder compact/plain, decoder, isNoDelta, markCompactWire), renderer/session-goal-presentation.ts labels',
    notRun: 'the relay transport: the wires are taken from the encoder as the relay would send them. Date.now is read through the test\'s own withClock (T0 + offsets); the global clock is T0',
  },
  replay: { entry: 'mixdog-app-server feeds (idle session state frames): replay the 30 pulses against the Rust encoder and compare which pulses deliver a frame and each delivered wire whole; goal snapshot cases mixdog-core-domains goal state', normalised: { clock: 'Date.now is T0 (2026-03-01T10:00:00Z) outside withClock, not the shared fixed clock' } },
});
process.exit(0);
