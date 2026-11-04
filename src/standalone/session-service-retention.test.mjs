import assert from 'node:assert/strict';
import test from 'node:test';
import { emitSessionActivityChange } from '../runtime/shared/session-activity-signal.mjs';
import { createSessionIdleClock } from './session-service/idle-clock.mjs';
import { createSessionRetention } from './session-service/retention.mjs';

const IDLE_EVICT_MS = 50;

function retentionFixture(count, onDestroy = null) {
  const sessions = new Set();
  const byId = new Map();
  const disposed = [];
  let turn = 0;
  let beating = true;
  // Runs once per loop iteration: its value at a disposal names that turn.
  const beat = () => {
    turn += 1;
    if (beating) setImmediate(beat);
  };
  setImmediate(beat);
  const sessionOwner = (id) => {
    const entry = byId.get(id);
    return entry && !entry.disposed ? entry : null;
  };
  const idleClock = createSessionIdleClock({
    sessionOwner,
    externalViewEntries: new Map(),
    pendingViewers: new Map(),
    sessionBusy: (entry) => retention.sessionBusy(entry),
  });
  const retention = createSessionRetention({
    sessions,
    isClosed: () => false,
    idleClock,
    idleEvictMs: IDLE_EVICT_MS,
    projectionIdleMs: 60_000,
    sessionOwner,
    currentSessionId: (entry) => entry.id,
    destroy: async (entry, reason, options) => {
      disposed.push({ id: entry.id, turn, reason, options });
      entry.disposed = true;
      sessions.delete(entry);
      onDestroy?.(entry);
      return { ok: true };
    },
  });
  const entries = Array.from({ length: count }, (_, i) => ({
    id: `idle-${i}`,
    subscribers: new Set(),
    retainedAt: null,
    busy: false,
    runtime: {},
  }));
  for (const entry of entries) {
    sessions.add(entry);
    byId.set(entry.id, entry);
  }
  const stop = () => {
    beating = false;
    retention.stop();
    idleClock.stop();
  };
  return { sessions, entries, disposed, retention, idleClock, stop };
}

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('a batch of sessions idle since the same moment is disposed one per event-loop turn', async () => {
  const f = retentionFixture(32);
  try {
    for (const entry of f.entries) f.retention.retainUnwatched(entry);
    await until(() => f.disposed.length === 32);
    const perTurn = new Map();
    for (const { turn } of f.disposed) perTurn.set(turn, (perTurn.get(turn) || 0) + 1);
    assert.equal(Math.max(...perTurn.values()), 1, 'never two disposals in one loop turn');
    assert.deepEqual(
      f.disposed.map((d) => d.id),
      f.entries.map((e) => e.id)
    );
    for (const d of f.disposed) {
      assert.equal(d.reason, 'idle and unwatched');
      assert.deepEqual(d.options, { keepBackgroundWork: true });
    }
  } finally {
    f.stop();
  }
});

test('a queued eviction is re-checked on its turn: a returning viewer or new work keeps the runtime', async () => {
  // All four come due together; while the first is being disposed a viewer
  // returns to the third and the fourth starts a turn.
  const f = retentionFixture(4, (entry) => {
    if (entry.id !== 'idle-0') return;
    f.entries[2].subscribers.add({});
    f.entries[3].busy = true;
  });
  const [, , watched, working] = f.entries;
  try {
    for (const entry of f.entries) f.retention.retainUnwatched(entry);
    await until(() => f.disposed.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 3 * IDLE_EVICT_MS));
    assert.deepEqual(
      f.disposed.map((d) => d.id),
      ['idle-0', 'idle-1']
    );
    assert.equal(watched.disposed, undefined);
    assert.equal(working.disposed, undefined);
    // The turn ending starts its idle clock again.
    const endedAt = Date.now();
    f.retention.updateEntryBusy(working, { busy: false });
    await until(() => working.disposed === true);
    assert.ok(Date.now() - endedAt >= IDLE_EVICT_MS - 5, 'disposed before its idle delay after the turn');
    assert.equal(watched.disposed, undefined);
  } finally {
    f.stop();
  }
});

test('activity between a queued eviction and its turn starts the idle clock over', async () => {
  // All three come due together; while the first is being disposed the
  // third shows activity (a turn started and ended, a save landed) and stays
  // just as eligible as before.
  let activityAt = 0;
  const f = retentionFixture(3, (entry) => {
    if (entry.id !== 'idle-0') return;
    activityAt = Date.now();
    emitSessionActivityChange('idle-2');
  });
  const [, , active] = f.entries;
  try {
    for (const entry of f.entries) f.retention.retainUnwatched(entry);
    await until(() => f.disposed.length >= 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.disposed.map((d) => d.id),
      ['idle-0', 'idle-1'],
      'disposed on the turn its eviction was queued for, after its clock restarted'
    );
    await until(() => active.disposed === true);
    assert.ok(Date.now() - activityAt >= IDLE_EVICT_MS - 5, 'disposed before its idle delay after the activity');
  } finally {
    f.stop();
  }
});

