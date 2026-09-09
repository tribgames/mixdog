import assert from 'node:assert/strict';
import test from 'node:test';
import { browserTimingRow } from './timing.mjs';

test('browser diagnostics expose bounded numeric facets, never page content or credentials', () => {
  const row = browserTimingRow(
    { sessionId: 's1', turnId: 9, action: 'sequence', text: 'secret input' },
    50,
    { ok: true, value: {
      text: 'private page', image: { data: 'pixels' },
      timing: { commandMs: 40, waitMs: 10, snapshots: 1, screenshotMs: -1, queueMs: NaN, url: 'private URL' },
    } },
    200,
  );
  assert.deepEqual(row, {
    kind: 'browser_timing', sessionId: 's1', turn_id: 9, action: 'sequence',
    bridge_ms: 50, http_status: 200, ok: true,
    payload: { commandMs: 40, waitMs: 10, snapshots: 1 },
  });
  const failed = browserTimingRow({ sessionId: 's1', action: 'click' }, 2, undefined, undefined);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.payload, {});
});

test('step timing logs have a numeric allowlist and a six-step bound', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({
    index: i + 1, commandMs: 10, targetMs: 3, actionabilityMs: 2, inputMs: 1,
    waitMs: Infinity, snapshotMs: -1, text: 'secret', target: { name: 'private' },
  }));
  const row = browserTimingRow({}, 1, { ok: true, value: { timing: { steps } } }, 200);
  assert.equal(row.payload.steps.length, 6);
  assert.deepEqual(row.payload.steps[0], { index: 1, commandMs: 10, targetMs: 3, actionabilityMs: 2, inputMs: 1 });
  assert.doesNotMatch(JSON.stringify(row), /secret|private|Infinity/);
});

test('failure timings and click events exclude error text, coordinates, and unknown events', () => {
  const row = browserTimingRow({}, 9, { ok: false, error: 'secret', timing: {
    commandMs: 8, mouseEvents: {
      mouseMoved: { count: 1, totalMs: 2, x: 10, target: 'private' },
      mousePressed: { count: -1, totalMs: NaN },
      arbitrary: { count: 1, totalMs: 4 },
    },
  } }, 200);
  assert.deepEqual(row.payload, {
    commandMs: 8, mouseEvents: { mouseMoved: { count: 1, totalMs: 2 } },
  });
  assert.equal(row.ok, false);
  assert.doesNotMatch(JSON.stringify(row), /secret|private|arbitrary/);
});
