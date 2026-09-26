import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBackgroundTask } from '../../../../src/runtime/shared/background-tasks.mjs';
import { activeElapsedMs, goalStateSnapshot, publicGoal } from '../../../../src/session-runtime/goal-state.mjs';
import { createJobViews } from '../../../../src/standalone/agent-tool/job-views.mjs';
import { liveAgentStatusRow } from '../../../../src/standalone/agent-tool/job-views/session-progress.mjs';
import { formatGoalDuration, goalElapsedLabel, goalTimeLabel } from '../renderer/session-goal-presentation.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder, isNoDelta, markCompactWire } from './state-delta.ts';

// An idle session whose Goal clock runs and whose agent job streams is re-read
// on the 2s route pulse. Only a real change may reach the relay; the phone and
// desktop keep deriving the running clocks from the anchors they hold.

const T0 = Date.parse('2026-03-01T10:00:00.000Z');

function withClock(now, read) {
  const original = Date.now;
  Date.now = () => now;
  try {
    return read();
  } finally {
    Date.now = original;
  }
}

function idleFixture() {
  const worker = {
    id: 'idle-churn-worker',
    agent: 'worker',
    provider: 'openai',
    model: 'gpt-5',
    status: 'streaming',
    createdAt: '2026-03-01T09:59:00.000Z',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    clientHostPid: 4242,
    runtime: { stage: 'streaming', lastStreamDeltaAt: T0 - 30_000, lastProgressAt: T0 - 30_000 },
    snapshot: { stage: 'streaming', lastStreamDeltaAt: T0 - 30_000 },
  };
  const sessions = new Map([[worker.id, worker]]);
  const views = createJobViews({
    mgr: {
      getSession: (id) => sessions.get(id) || null,
      getSessionRuntime: (id) => sessions.get(id)?.runtime || null,
      getSessionProgressSnapshot: (id) => sessions.get(id)?.snapshot || null,
      getSessionPendingMessageDepth: () => null,
    },
    getLiveSession: (id) => sessions.get(id) || null,
    reg: { getProvider: () => null },
    DEFAULT_SPAWN_PREP_TIMEOUT_MS: 1000,
    refreshTagsFromSessions: () => {},
    agentSessionEntries: () => [{ tag: 'idle-churn', session: worker }],
    tags: new Map(),
    cfgMod: { loadConfig: () => ({}) },
  });
  withClock(T0 - 60_000, () =>
    registerBackgroundTask({
      surface: 'agent',
      operation: 'spawn',
      meta: { tag: 'idle-churn', sessionId: worker.id, agent: 'worker', provider: 'openai', model: 'gpt-5' },
      input: { tag: 'idle-churn' },
    })
  );
  const goal = {
    id: 'idle-churn-goal',
    revision: 3,
    objectiveRevision: 1,
    tasksObjectiveRevision: 1,
    sessionId: 'idle-churn-session',
    objective: 'Ship the remote diet',
    title: 'Ship the remote diet',
    status: 'active',
    tasks: [],
    timeLimitMs: 60 * 60_000,
    timeMode: 'max',
    timeUsedMs: 5 * 60_000,
    createdAt: T0 - 10 * 60_000,
    updatedAt: T0 - 60_000,
    lastStartedAt: T0 - 90_000,
  };
  const agentRows = (now, project) =>
    withClock(now, () => ({
      agentWorkers: views.list({ context: {} }).map(project),
      agentJobs: views
        .listJobs({})
        .filter((row) => row.tag === 'idle-churn')
        .map(project),
    }));
  const items = [{ id: 'u1', kind: 'user', text: 'keep going' }];
  const snapshotAt = (now, { anchored = true } = {}) => ({
    sessionId: 'idle-churn-session',
    items,
    streamingTail: null,
    busy: false,
    goal: anchored ? goalStateSnapshot(publicGoal(goal, now)) : publicGoal(goal, now),
    ...agentRows(now, anchored ? liveAgentStatusRow : (row) => row),
  });
  return { goal, worker, snapshotAt };
}

test('an idle session with a running Goal and agent job sends no state frames until content changes', () => {
  const { goal, worker, snapshotAt } = idleFixture();
  const ticks = Array.from({ length: 30 }, (_, index) => T0 + index * 2_000);

  // The cause: raw reads restate clock readings on every pulse.
  const rawA = snapshotAt(ticks[0], { anchored: false });
  const rawB = snapshotAt(ticks[1], { anchored: false });
  assert.notDeepEqual(rawA.goal, rawB.goal, 'a raw Goal read ticks timeUsedMs/snapshotAt');
  assert.notDeepEqual(rawA.agentJobs, rawB.agentJobs, 'a raw job row ticks its silence diagnostics');

  for (const compact of [true, false]) {
    const encoder = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    const deliver = (snapshot) => {
      const encoded = encoder.encode(snapshot);
      if (isNoDelta(encoded)) return null;
      const wire = JSON.parse(JSON.stringify(encoded));
      if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
      const decoded = decoder.decode(wire);
      assert.equal(decoded.ok, true);
      return { wire, snapshot: decoded.snapshot };
    };
    const first = deliver(snapshotAt(ticks[0]));
    assert.ok(first, 'the baseline is delivered');
    const held = first.snapshot;
    for (const now of ticks.slice(1)) {
      assert.equal(deliver(snapshotAt(now)), null, `no frame at +${now - T0}ms`);
    }

    // The running clock stays derivable from the held snapshot alone.
    for (const clock of [T0, T0 + 17_000, T0 + 59_000, T0 + 30 * 60_000]) {
      const expected = formatGoalDuration(Math.min(goal.timeLimitMs, activeElapsedMs(goal, clock)));
      assert.equal(goalElapsedLabel(held.goal, clock), expected);
      assert.equal(goalTimeLabel(held.goal, clock), goalTimeLabel(publicGoal(goal, clock), clock));
    }
    assert.equal(held.goal.deadlineAt, publicGoal(goal, T0).deadlineAt, 'the deadline an old decoder reads is unchanged');
    const job = held.agentJobs[0];
    assert.equal(job.status, 'running');
    assert.equal(job.stage, 'streaming');
    assert.equal(Date.parse(job.startedAt), T0 - 60_000, 'job elapsed derives from its start');
    assert.equal(held.agentWorkers[0].stage, 'streaming');

    // Real content still travels.
    const last = ticks.at(-1);
    worker.runtime.stage = 'tool_running';
    const changed = deliver(snapshotAt(last + 2_000));
    worker.runtime.stage = 'streaming';
    assert.ok(changed, 'a stage change is delivered');
    const stateFields = compact ? changed.wire.sc : changed.wire.__statePatch.changed;
    assert.deepEqual(Object.keys(stateFields).sort(), ['agentJobs', 'agentWorkers']);
    const paused = { ...goal, status: 'paused', timeUsedMs: 7 * 60_000, lastStartedAt: null };
    const pausedFrame = deliver({ ...snapshotAt(last + 4_000), goal: goalStateSnapshot(publicGoal(paused, last + 4_000)) });
    assert.ok(pausedFrame);
    assert.equal(pausedFrame.snapshot.goal.status, 'paused');
    assert.equal(goalElapsedLabel(pausedFrame.snapshot.goal, last + 60_000), formatGoalDuration(7 * 60_000));
    // A paused Goal read later is still the same Goal.
    assert.equal(
      deliver({ ...snapshotAt(last + 6_000), goal: goalStateSnapshot(publicGoal(paused, last + 6_000)) }),
      null
    );
  }
});

test('goal state snapshots are idempotent and leave clock-less Goals untouched', () => {
  const plain = { id: 'g', status: 'active' };
  assert.equal(goalStateSnapshot(plain), plain);
  assert.equal(goalStateSnapshot(null), null);
  const running = publicGoal(
    { id: 'g', status: 'active', objective: 'x', timeUsedMs: 1_000, timeLimitMs: 0, lastStartedAt: T0, tasks: [] },
    T0 + 5_000
  );
  const anchored = goalStateSnapshot(running);
  assert.equal(anchored.timeUsedMs, 1_000);
  assert.equal(anchored.snapshotAt, T0);
  assert.equal(anchored.remainingMs, null);
  assert.equal(anchored.deadlineAt, null);
  assert.equal(goalStateSnapshot(anchored), anchored);
});
