import assert from 'node:assert/strict';
import test from 'node:test';
import { requestSessionRead } from './session-read-request.ts';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { reportSessionRead } from './session-read-diagnostics.ts';

function fixture(t, prefetchSession) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const records = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout, clearTimeout,
    mixdogDesktop: {
      prefetchSession,
      rendererDiagnostic: (entry) => records.push(entry),
    },
  } });
  defaultSessionLaneStore.clear();
  t.after(() => {
    defaultSessionLaneStore.clear();
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else delete globalThis.window;
  });
  return records;
}

test('a held IPC read records its wait, joins and later frame without changing retry behavior', async (t) => {
  let now = 0, calls = 0, traceId;
  t.mock.method(performance, 'now', () => now);
  const pending = Promise.withResolvers();
  const records = fixture(t, (_id, _limit, trace) => {
    calls++;
    traceId = trace;
    return pending.promise;
  });
  const first = requestSessionRead('trace_pending');
  now = 15_000;
  reportSessionRead('trace_pending', 'wait-expired', { hasLane: false });
  assert.equal(requestSessionRead('trace_pending'), first);
  assert.equal(calls, 1);
  assert.equal(records.find(r => r.stage === 'wait-expired').elapsedMs, 15_000);
  now = 60_000;
  pending.resolve(true);
  assert.equal(await first, true);
  assert.equal(records.find(r => r.stage === 'request-result').hasLane, false);
  const beforeStaleFrame = records.length;
  defaultSessionLaneStore.apply({
    sessionId: 'trace_pending', readTraceId: 'older-read', frameSource: 'replay',
    snapshot: { sessionId: 'trace_pending', items: [] },
  });
  assert.equal(records.length, beforeStaleFrame, 'a different read id must not claim this request arrival');
  defaultSessionLaneStore.apply({
    sessionId: 'trace_pending', readTraceId: traceId, frameSource: 'replay',
    snapshot: { sessionId: 'trace_pending', items: [{ id: 'answer', kind: 'assistant', text: 'private answer' }] },
  });
  assert.deepEqual(records.map(r => r.stage), [
    'request-start', 'wait-expired', 'request-joined', 'request-result', 'frame-received', 'frame-applied',
  ]);
  assert.ok(records.every(r => r.traceId === traceId));
  assert.equal(records.at(-1).elapsedMs, 60_000);
  assert.equal(JSON.stringify(records).includes('private answer'), false);
  const count = records.length;
  defaultSessionLaneStore.apply({
    sessionId: 'trace_pending', frameSource: 'live',
    snapshot: { sessionId: 'trace_pending', items: [{ id: 'next', kind: 'assistant', text: 'next token' }] },
  });
  assert.equal(records.length, count, 'settled streaming traffic is not traced');
});

test('read failures are recorded as failures and keep the existing bounded attempt count', async (t) => {
  let calls = 0;
  const records = fixture(t, async () => { calls++; throw new Error('private provider error'); });
  window.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
  assert.equal(await requestSessionRead('trace_failed'), false);
  assert.equal(calls, 3);
  assert.deepEqual(records.filter(r => r.stage === 'request-failed').map(r => r.attempt), [1, 2, 3]);
  assert.equal(records.some(r => r.stage === 'request-result'), false);
  assert.equal(JSON.stringify(records).includes('private provider error'), false);
});

test('a throwing renderer diagnostic sink does not change a successful read', async (t) => {
  fixture(t, async () => true);
  window.mixdogDesktop.rendererDiagnostic = () => { throw new Error('bridge unavailable'); };
  assert.equal(await requestSessionRead('trace_sink_failure'), true);
});
