import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserPerformanceTrace,
  formatPerformanceMetrics,
} from './browser-performance.ts';

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
