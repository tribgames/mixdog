import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRetention } from './session-service/retention.mjs';

function retentionFixture(count, onDestroy = null) {
  const sessions = new Set();
  const disposed = [];
  let turn = 0;
  let beating = true;
  // Runs once per loop iteration: its value at a disposal names that turn.
  const beat = () => {
    turn += 1;
    if (beating) setImmediate(beat);
  };
  setImmediate(beat);
  const retention = createSessionRetention({
    sessions,
    isClosed: () => false,
    idleEvictMs: 1000,
    evictSweepMs: 5,
    projectionIdleMs: 60_000,
    currentSessionId: (entry) => entry.id,
    destroy: async (entry, reason, options) => {
      disposed.push({ id: entry.id, turn, reason, options });
      entry.disposed = true;
      sessions.delete(entry);
      retention.stopEvictionSweepIfIdle();
      onDestroy?.(entry);
      return { ok: true };
    },
  });
  const entries = Array.from({ length: count }, (_, i) => ({
    id: `idle-${i}`,
    subscribers: new Set(),
    retainedAt: Date.now() - 10_000,
    busy: false,
    runtime: {},
  }));
  for (const entry of entries) sessions.add(entry);
  const stop = () => {
    beating = false;
    retention.stopSweep();
  };
  return { sessions, entries, disposed, retention, stop };
}

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('the idle sweep disposes a batch of sessions one per event-loop turn', async () => {
  const f = retentionFixture(32);
  try {
    f.retention.startEvictionSweep();
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
    assert.equal(f.retention.sweepActive(), false, 'the sweep stops once nothing is left to reclaim');
  } finally {
    f.stop();
  }
});

test('a queued eviction is re-checked on its turn: a returning viewer or new work keeps the runtime', async () => {
  // All four are queued by one sweep; while the first is being disposed a
  // viewer returns to the third and the fourth starts a turn.
  const f = retentionFixture(4, (entry) => {
    if (entry.id !== 'idle-0') return;
    f.entries[2].subscribers.add({});
    f.entries[3].busy = true;
  });
  const [, , watched, working] = f.entries;
  try {
    f.retention.startEvictionSweep();
    await until(() => f.disposed.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      f.disposed.map((d) => d.id),
      ['idle-0', 'idle-1']
    );
    assert.equal(watched.disposed, undefined);
    assert.equal(working.disposed, undefined);
    assert.ok(Date.now() - working.retainedAt < 1000, 'busy work restarts the idle clock');
  } finally {
    f.stop();
  }
});
