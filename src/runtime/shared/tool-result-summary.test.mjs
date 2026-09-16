import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLineDelta, summarizeToolResult } from './tool-result-summary.mjs';
import { formatAggregateDetail } from './tool-surface.mjs';

test('line deltas accept native, JS, legacy, and aggregated count fields', () => {
  for (const text of [
    '+292/-2',
    '+292 -2',
    '+292 Lines · -2 Lines',
    '(+292 lines, -2 lines)',
    '+291 lines · -1 line, +1 line · -1 line',
  ]) {
    assert.deepEqual(parseLineDelta(text), { added: 292, removed: 2, seen: true }, text);
  }
  assert.deepEqual(parseLineDelta('+0 -0'), { added: 0, removed: 0, seen: true });
});

test('line deltas ignore signed numbers in filenames and unrelated details', () => {
  for (const filename of [
    'report-20260920.md',
    'report-2026-09-20.md',
    'report+20260920.md',
    'report -20260920.md',
    '-20260920',
    'report-20260920',
  ]) {
    const summary = `Created ${filename}`;
    assert.deepEqual(parseLineDelta(summary), { added: 0, removed: 0, seen: false }, summary);
    assert.deepEqual(
      parseLineDelta(`${summary} · +292 lines · -2 lines`),
      { added: 292, removed: 2, seen: true },
      summary
    );
  }
  for (const text of [null, '', 'Exit -1', 'cost +1.25', 'version-123', 'read 20 lines']) {
    assert.deepEqual(parseLineDelta(text), { added: 0, removed: 0, seen: false }, String(text));
  }
});

test('patch summaries and card aggregation preserve only actual edit counts', () => {
  const created = summarizeToolResult(
    'apply_patch',
    {},
    'Applied 1 File (Native)\n  OK Add reports/report-20260920.md — +292'
  );
  const modified = summarizeToolResult(
    'apply_patch',
    {},
    'Applied 1 File (JS)\n  OK Modify reports/report+20260912.md — +1 Line · -2 Lines'
  );
  assert.equal(created, 'Created report-20260920.md · +292 lines');
  assert.equal(modified, 'Updated report+20260912.md · +1 line · -2 lines');
  assert.deepEqual(parseLineDelta(created), { added: 292, removed: 0, seen: true });
  assert.equal(formatAggregateDetail([created, modified]), '+293 lines · -2 lines');
  assert.equal(formatAggregateDetail(['Created report-20260920.md']), 'Created report-20260920.md');
});
