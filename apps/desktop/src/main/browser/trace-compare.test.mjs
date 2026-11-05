import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserPerformanceTrace } from './performance.ts';
import { normalizeTraceDurations, traceTextsEqual } from './trace-compare.ts';

function stopText(events, endedAt) {
  const trace = new BrowserPerformanceTrace();
  trace.add(events);
  return `Performance trace stopped.\n${trace.summary(trace.startedAt + endedAt)}`;
}

const events = [
  { name: 'RunMicrotasks', dur: 1500 },
  { name: 'RunMicrotasks', dur: 500 },
  { name: 'V8.GC', dur: 9000 },
];

test('traces of the same events are equal whatever their durations', () => {
  assert.equal(traceTextsEqual(stopText(events, 40), stopText(events, 95)), true);
  assert.equal(
    traceTextsEqual(stopText(events, 40), stopText(events.map((e) => ({ ...e, dur: e.dur + 7 })), 40)),
    true
  );
  assert.match(normalizeTraceDurations(stopText(events, 40)), /Events: 3\n/);
});

test('traces that differ in an event name or count are different', () => {
  const base = stopText(events, 40);
  assert.equal(traceTextsEqual(base, stopText([events[0], events[1], { name: 'V8.Other', dur: 9000 }], 40)), false);
  assert.equal(traceTextsEqual(base, stopText([...events, { name: 'RunMicrotasks', dur: 0 }], 40)), false);
  assert.equal(traceTextsEqual(base, stopText(events.slice(0, 2), 40)), false);
});

test('text outside the trace format is refused, not normalised', () => {
  assert.throws(() => normalizeTraceDurations('Performance trace stopped.\nTrace duration: 5ms\nEvents: 1\nTop trace events:\n- x: y'));
  assert.throws(() => traceTextsEqual('something else', 'something else'));
});
