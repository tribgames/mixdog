import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserPerformanceTrace,
  createBrowserPerformanceCommands,
  formatPerformanceMetrics,
} from './performance.ts';
import { createBrowserSettle } from './settle.ts';

test('browser performance trace aggregates event counts and durations', () => {
  const trace = new BrowserPerformanceTrace();
  trace.add([
    { name: 'FunctionCall', dur: 2_500 },
    { name: 'FunctionCall', dur: 1_500 },
    { name: 'Layout', dur: 3_000 },
  ]);
  const summary = trace.summary(trace.startedAt + 250);
  assert.match(summary, /Trace duration: 250ms/);
  assert.match(summary, /FunctionCall: 2 event\(s\), 4\.00ms total/);
  assert.match(summary, /Layout: 1 event\(s\), 3\.00ms total/);
});

test('browser performance trace bounds attacker-controlled event names', () => {
  const trace = new BrowserPerformanceTrace(10, 2);
  trace.add([
    { name: 'first', dur: 1 },
    { name: 'second', dur: 2 },
    { name: 'third', dur: 3 },
    { name: 'fourth', dur: 4 },
  ]);
  const summary = trace.summary();
  assert.match(summary, /first/);
  assert.match(summary, /second/);
  assert.match(summary, /\(other\): 2 event/);
  assert.doesNotMatch(summary, /third|fourth/);
});

test('browser performance metrics format durations and heap sizes', () => {
  const formatted = formatPerformanceMetrics([
    { name: 'Nodes', value: 42 },
    { name: 'TaskDuration', value: 0.125 },
    { name: 'JSHeapUsedSize', value: 2 * 1024 * 1024 },
  ]);
  assert.match(formatted, /Nodes: 42/);
  assert.match(formatted, /TaskDuration: 125\.00 ms/);
  assert.match(formatted, /JSHeapUsedSize: 2\.00 MB/);
});

test('performance trace setup ends tracing when reload settlement fails', async () => {
  const guest = { reload() {} };
  const traces = new WeakMap();
  const methods = [];
  const performanceCommands = createBrowserPerformanceCommands({
    guestDebugger: async () => ({}),
    sendCdp: async (_guest, _cdp, method) => {
      methods.push(method);
      return {};
    },
    tracesByGuest: traces,
    settleAfterAction: async () => {
      throw new Error('fixture settle failure');
    },
    pause: async () => {},
    cdpTimeoutMs: 100,
  });

  await assert.rejects(
    performanceCommands.performanceResult(guest, { operation: 'start', reload: true }),
    /fixture settle failure/,
  );
  assert.deepEqual(methods, ['Tracing.start', 'Tracing.end']);
  assert.equal(traces.has(guest), false);
});

test('performance trace setup keeps its ledger when cleanup must be retried', async () => {
  const guest = { reload() {} };
  const traces = new WeakMap();
  const performanceCommands = createBrowserPerformanceCommands({
    guestDebugger: async () => ({}),
    sendCdp: async (_guest, _cdp, method) => {
      if (method === 'Tracing.end') throw new Error('fixture cleanup failure');
      return {};
    },
    tracesByGuest: traces,
    settleAfterAction: async () => {
      throw new Error('fixture settle failure');
    },
    pause: async () => {},
    cdpTimeoutMs: 100,
  });

  await assert.rejects(
    performanceCommands.performanceResult(guest, { operation: 'start', reload: true }),
    /trace cleanup also failed.*operation:"stop"/,
  );
  assert.equal(traces.has(guest), true);
});

function settleHarness() {
  return createBrowserSettle({
    diagnostics: () => ({
      pendingDialog: null,
      network: {
        pendingCount: 0,
        recentInflight: () => [],
      },
    }),
    evaluate: async () => undefined,
    quietMs: 20,
    domTimeoutMs: 100,
    loadTimeoutMs: 1_000,
  });
}

test('browser load settle closes completion and cancellation registration races', async () => {
  const settle = settleHarness();
  let loadingChecks = 0;
  const completedDuringRegistration = {
    isLoading: () => loadingChecks++ === 0,
    on() {},
    removeListener() {},
  };
  const completedAt = performance.now();
  await settle.waitForLoadSettle(completedDuringRegistration, 1_000);
  assert.ok(performance.now() - completedAt < 100);

  const controller = new AbortController();
  const cancelledDuringRegistration = {
    isLoading: () => true,
    on: () => controller.abort(new Error('cancelled')),
    removeListener() {},
  };
  const cancelledAt = performance.now();
  await settle.waitForLoadSettle(
    cancelledDuringRegistration,
    1_000,
    controller.signal,
  );
  assert.ok(performance.now() - cancelledAt < 100);
});

test('browser sequence step settling propagates cancellation instead of absorbing it', async () => {
  const controller = new AbortController();
  const settle = createBrowserSettle({
    diagnostics: () => ({
      pendingDialog: null,
      network: {
        pendingCount: 0,
        recentInflight: () => [],
      },
    }),
    evaluate: async (_guest, _script, signal) => {
      controller.abort(new Error('fixture sequence cancelled'));
      throw signal.reason;
    },
    quietMs: 20,
    domTimeoutMs: 100,
    loadTimeoutMs: 1_000,
  });

  await assert.rejects(
    settle.stepSettleResult({}, controller.signal),
    /fixture sequence cancelled/,
  );
});
