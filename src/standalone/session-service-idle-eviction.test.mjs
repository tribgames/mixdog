// The daemon reclaims a runtime left idle and unwatched at its own exact
// deadline, as an idle unload does: one timer per session, counted from the
// end of its work, and no periodic sweep.
import assert from 'node:assert/strict';
import test from 'node:test';

import { waitUntil } from '../runtime/shared/wait-until.test-support.mjs';
import { createSessionService } from './session-service.mjs';

function stubService(delayMs) {
  const runtimes = new Map();
  const service = createSessionService({
    createSessionRuntime: async ({ sessionId }) => {
      let state = { sessionId, items: [], queued: [], busy: false };
      const listeners = new Set();
      const runtime = {
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(next) {
          state = { ...state, ...next };
          for (const listener of listeners) listener();
        },
        dispose: async () => {},
      };
      runtimes.set(sessionId, runtime);
      return runtime;
    },
    publishIntervalMs: 0,
    idleEvictMs: delayMs,
  });
  const evicted = (message) => waitUntil(() => service.status.live === 0, { timeoutMs: 20 * delayMs, message });
  return { service, runtimes, evicted };
}

test('an idle unwatched runtime goes at its own deadline, counted from the end of its work, with no sweep', async (t) => {
  const delayMs = 300;
  // Every interval the service starts (a sweep would be one).
  const startInterval = globalThis.setInterval;
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', function (...args) {
    intervals.push(new Error().stack);
    return startInterval.apply(this, args);
  });
  const { service, runtimes, evicted } = stubService(delayMs);
  try {
    const createdAt = Date.now();
    await service.createSession({ sessionId: 'sess_evict_idle' });
    assert.equal(service.status.live, 1);
    await evicted('the idle unwatched runtime was never evicted');
    assert.ok(Date.now() - createdAt >= delayMs - 20, 'evicted before its idle delay');

    // Work keeps it however long it runs; the delay counts from its end.
    await service.createSession({ sessionId: 'sess_evict_busy' });
    runtimes.get('sess_evict_busy').set({ busy: true });
    await new Promise((resolve) => setTimeout(resolve, 3 * delayMs));
    assert.equal(service.status.live, 1, 'evicted while its turn ran');
    const endedAt = Date.now();
    runtimes.get('sess_evict_busy').set({ busy: false });
    await evicted('the runtime was never evicted after its turn');
    assert.ok(Date.now() - endedAt >= delayMs - 20, 'evicted before its idle delay after the turn');

    const sweeps = intervals.filter((stack) => /session-service/.test(stack));
    assert.deepEqual(sweeps, [], 'the service started a periodic timer');
  } finally {
    await service.stop('test complete');
  }
});

test('a retained runtime that stops reporting its address is still reclaimed at its deadline', async () => {
  const delayMs = 300;
  const { service, runtimes, evicted } = stubService(delayMs);
  try {
    const createdAt = Date.now();
    await service.createSession({ sessionId: 'sess_evict_unaddressed' });
    // Its runtime drops the address it published: it leaves the address index.
    runtimes.get('sess_evict_unaddressed').set({ sessionId: '' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(service.status.live, 1);
    await evicted('the runtime with no address was never reclaimed');
    assert.ok(Date.now() - createdAt >= delayMs - 20, 'evicted before its idle delay');
  } finally {
    await service.stop('test complete');
  }
});
