import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import { createMaintenanceActions } from './memory-action-handlers/maintenance-actions.mjs';

test('status reports the summarization backlog and the last cycle1 run', async () => {
  const { status } = createMaintenanceActions({
    getDb: () => ({ query: async () => ({ rows: [] }) }),
    entryStats: async () => ({
      total: 10,
      roots: 4,
      unchunked_leaves: 6,
      byStatus: [],
      byCategory: [],
      core_entries: 1,
    }),
    getCycleLastRun: async () => ({ cycle1: Date.now() }),
  });
  const result = await status();
  assert.match(result.text, /cycle1_raw=6/);
  assert.match(result.text, /last_cycle1: 0m ago/);
});

test('the statusline segment shows a running cycle1, else a backlog above the warning threshold', async (t) => {
  let state;
  const read = mock.method(fs, 'readFile', async (file) => {
    assert.match(String(file), /memory-cycle-state\.json$/);
    return JSON.stringify(state);
  });
  syncBuiltinESMExports();
  mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  t.after(() => {
    read.mock.restore();
    syncBuiltinESMExports();
    mock.timers.reset();
  });
  const { memoryCycleStatus } = await import('../../shared/statusline/statusline-segments.mjs');
  const refresh = async (running, unchunked) => {
    mock.timers.tick(1001);
    state = { updatedAt: Date.now(), running, backlog: { unchunked } };
    memoryCycleStatus();
    await new Promise((resolve) => setImmediate(resolve));
    return memoryCycleStatus();
  };
  assert.equal(await refresh(null, 0), null);
  assert.deepEqual(await refresh(null, 700), { kind: 'backlog', pending: 700 });
  const running = await refresh({ cycle: 'cycle1', started_at: Date.now() - 100, pid: process.pid }, 0);
  assert.deepEqual(running, { kind: 'running', startedAt: state.running.started_at });
});
