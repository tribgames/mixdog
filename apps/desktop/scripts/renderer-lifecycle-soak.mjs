// Isolated real-time V8 retention probe. Never connects to the installed app.
// node --expose-gc --import tsx scripts/renderer-lifecycle-soak.mjs
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createSessionLaneStore } from '../src/renderer/session-lane-store.ts';
import {
  holdUsageDashboardCadence, refreshUsageDashboard, subscribeUsageDashboard,
} from '../src/renderer/usage-dashboard-store.ts';
import { createRendererClock } from './test-renderer-clock.mjs';

const durationMs = 10 * 60_000;
const clock = createRendererClock();
globalThis.window = clock.win;
const store = createSessionLaneStore({
  maxEntries: 64, maxBytes: 64 * 1024,
  decorator: { decorate: (snapshot) => snapshot, clear() {} },
});
let calls = 0;
const api = { async invokeCapability() {
  calls += 1;
  return { value: { rows: [{ id: 'probe', used: calls }] } };
} };
let cycles = 0;
async function cycle() {
  const sessionId = `soak-${cycles++ % 128}`;
  const close = store.subscribe(sessionId, () => {});
  store.apply({ sessionId, snapshot: { sessionId, items: [] }, frameSource: 'live' });
  store.apply({
    sessionId,
    snapshot: { sessionId, items: [{ id: 'answer', text: `cycle ${cycles} ${'x'.repeat(128 * 1024)}` }] },
    frameSource: 'live',
  });
  const release = holdUsageDashboardCadence(api);
  const unsubscribe = subscribeUsageDashboard(() => {});
  if (cycles % 100 === 0) await refreshUsageDashboard(api, { force: true });
  clock.visibility('hidden');
  clock.visibility('visible');
  close();
  unsubscribe();
  release();
  await clock.settle();
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().subscribedSessions, 0);
  assert.equal(store.stats().notificationKeys, 0);
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
}
const samples = [];
async function sample(elapsedMs) {
  await setImmediate();
  globalThis.gc?.();
  const memory = process.memoryUsage();
  const value = {
    elapsedMs: Math.round(elapsedMs), cycles, calls,
    heapMB: +(memory.heapUsed / 1024 / 1024).toFixed(3),
    rssMB: +(memory.rss / 1024 / 1024).toFixed(3),
  };
  samples.push(value);
  console.log(JSON.stringify(value));
}
try {
  for (let index = 0; index < 200; index += 1) await cycle();
  await sample(0);
  const started = performance.now();
  let nextSample = 60_000;
  while (performance.now() - started < durationMs) {
    await cycle();
    await delay(100);
    const elapsed = performance.now() - started;
    if (elapsed >= nextSample) {
      await sample(elapsed);
      nextSample += 60_000;
    }
  }
  if (samples.at(-1).elapsedMs < durationMs) await sample(performance.now() - started);
  console.log(JSON.stringify({
    complete: true, cycles,
    heapGrowthMB: +(samples.at(-1).heapMB - samples[0].heapMB).toFixed(3),
    residualResources: store.stats().entries + store.stats().subscribedSessions
      + store.stats().notificationKeys + clock.timers.size
      + clock.doc.listenerCount() + clock.win.listenerCount(),
  }));
} finally {
  store.clear();
  delete globalThis.window;
}
