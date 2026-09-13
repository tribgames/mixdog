import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolBatching } from './tool-batching.mjs';

const call = (id, name, arrays) => ({ tool_call_id: id, tool_name: name, array_lengths: arrays });
const batch = (id, calls, session = 'test') => ({
  kind: 'batch', session_id: session,
  payload: { batch_schema_version: 1, batch_id: id, tool_call_count: calls.length, calls },
});
const tool = (id, callId, intervals, result = 'normal', session = 'test') => ({
  kind: 'tool', session_id: session, result_kind: result,
  payload: { batch: { batch_id: id, tool_call_id: callId },
    execution_intervals: intervals.map(([start, end]) => ({ started_at_ms: start, completed_at_ms: end })) },
});

test('array dimensions and cross-tool overlap are distinct measurements', () => {
  const rows = [
    batch('parallel', [call('read', 'read', { file_path: 8 }), call('git', 'git', { command: 4 })]),
    tool('parallel', 'git', [[15, 30]], 'error'), tool('parallel', 'read', [[10, 20]]),
    batch('serial', [call('grep', 'grep', { pattern: 2, path: 3 }), call('shell', 'shell', null)]),
    tool('serial', 'grep', [[30, 40]]), tool('serial', 'shell', [[40, 50]]),
  ];
  const result = summarizeToolBatching(rows);
  assert.equal(result.internal_arrays.array_batched_calls, 3);
  assert.deepEqual(result.internal_arrays.by_tool.grep.arrays, {
    pattern: { calls: 1, items: 2 }, path: { calls: 1, items: 3 },
  });
  assert.equal(result.internal_arrays.by_tool.read.arrays.file_path.items, 8);
  assert.equal(result.inter_tool.multi_call_groups, 2);
  assert.equal(result.inter_tool.mixed_tool_groups, 2);
  assert.equal(result.inter_tool.groups_with_observed_overlap, 1);
  assert.equal(result.inter_tool.groups_with_observed_mixed_tool_overlap, 1);
  assert.equal(result.inter_tool.max_observed_concurrency, 2);
  assert.equal(result.groups[0].calls[1].result_kind, 'error');
});

test('legacy and missing timing stay unknown rather than zero parallelism', () => {
  const result = summarizeToolBatching([
    { kind: 'batch', payload: { tool_call_count: 2 } },
    batch('missing', [call('a', 'read', {}), call('b', 'git', { command: 2 })]),
  ]);
  assert.equal(result.legacy_groups, 1);
  assert.equal(result.inter_tool.multi_call_groups, 2);
  assert.equal(result.inter_tool.timing_unknown_or_partial_groups, 2);
  assert.equal(result.inter_tool.groups_with_observed_overlap, null);
  assert.equal(result.groups[0].timing_complete, false);
  const legacy = summarizeToolBatching([{ kind: 'batch', payload: { tool_call_count: 1 } }]);
  assert.equal(legacy.internal_arrays, null);
  assert.equal(legacy.inter_tool.mixed_tool_groups, null);
});

test('cache-only calls, retries, partial groups and session identity are preserved', () => {
  const result = summarizeToolBatching([
    batch('same', [call('a', 'read', {}), call('b', 'read', {})]),
    tool('same', 'a', [[10, 20], [30, 40]]),
    tool('same', 'b', [[20, 30]]),
    batch('same', [call('a', 'read', {})], 'other'),
    tool('same', 'a', [], 'cache-hit', 'other'),
    batch('partial', [call('a', 'git', {}), call('b', 'shell', null)]),
    tool('partial', 'a', [[50, 60]]),
  ]);
  assert.equal(result.groups[0].observed_max_concurrency, 1);
  assert.equal(result.groups[1].observed_max_concurrency, 0);
  assert.equal(result.groups[1].timing_complete, true);
  assert.equal(result.groups[1].calls[0].result_kind, 'cache-hit');
  assert.equal(result.groups[2].timing_complete, false);
  assert.equal(result.groups[2].timing_known_calls, 1);
  assert.equal(result.inter_tool.groups_with_observed_overlap, 0);
});
