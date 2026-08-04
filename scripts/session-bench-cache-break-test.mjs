import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('root session bench promotes actionable compact mismatches without hiding intentional transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-bench-'));
  const trace = join(dir, 'trace.jsonl');
  const sessionId = 'cache-break-observability';
  const rows = [
    ...Array.from({ length: 4 }, (_, index) => ({
      ts: index + 1, sessionId, iteration: index + 1, kind: 'cache_break',
      payload: { reason: 'input_prefix_mismatch', intentional_transition: 'automatic_compaction' },
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      ts: index + 5, sessionId, iteration: index + 5, kind: 'cache_break',
      payload: { reason: 'input_prefix_mismatch', intentional_transition: 'transcript_rebuild' },
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      ts: index + 7, sessionId, iteration: index + 7, kind: 'cache_break',
      payload: {
        reason: 'request_properties_changed',
        intentional_transition: 'explorer_hard_cap_final_tool_choice_none',
        request_tool_choice: 'none',
      },
    })),
    {
      ts: 9, sessionId, iteration: 9, kind: 'cache_break',
      payload: { reason: 'response_output_mismatch:function_call' },
    },
    {
      ts: 10, sessionId, iteration: 10, kind: 'cache_break',
      payload: { reason: 'input_prefix_mismatch', intentional_transition: 'unknown_transition' },
    },
    {
      ts: 11, sessionId, iteration: 11, kind: 'cache_break',
      payload: {
        reason: 'response_output_mismatch:function_call',
        intentional_transition: 'automatic_compaction',
      },
    },
    {
      ts: 12, sessionId: `${sessionId}:compact`, iteration: 1, kind: 'cache_break',
      payload: { reason: 'input_prefix_mismatch' },
    },
    {
      ts: 13, sessionId, iteration: 13, kind: 'cache_break',
      payload: {
        reason: 'request_properties_changed',
        intentional_transition: 'explorer_hard_cap_final_tool_choice_none',
      },
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      ts: index + 14, sessionId, iteration: index + 14, kind: 'cache_break',
      payload: { reason: 'response_output_mismatch:function_call' },
    })),
  ];
  writeFileSync(trace, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  try {
    const output = execFileSync(process.execPath, [
      'scripts/session-bench.mjs', '--json', '--trace', trace, '--session', sessionId,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.equal(report.cache.cache_breaks.length, 19, 'raw evidence is retained');
    assert.equal(report.cache.intentional_cache_breaks.length, 8);
    assert.equal(report.cache.actionable_cache_breaks.length, 11);
    assert.deepEqual(
      report.cache.intentional_cache_breaks.map((row) => row.phase),
      [
        ...Array(4).fill('intentional_automatic_compaction'),
        ...Array(2).fill('intentional_transcript_rebuild'),
        ...Array(2).fill('intentional_explorer_hard_cap_final_tool_choice_none'),
      ],
    );
    assert.equal(report.cache.actionable_cache_breaks[0].reason, 'response_output_mismatch:function_call');
    const actionableByTs = new Map(report.cache.actionable_cache_breaks.map((row) => [row.ts, row]));
    assert.equal(actionableByTs.get(10).intentional_transition, 'unknown_transition');
    assert.equal(actionableByTs.get(11).intentional_transition, 'automatic_compaction');
    assert.equal(actionableByTs.get(12).session_id, `${sessionId}:compact`);
    assert.equal(actionableByTs.get(13).intentional_transition, 'explorer_hard_cap_final_tool_choice_none');
    const cacheBreakIssues = report.issues.filter((issue) => issue.type === 'cache_break');
    assert.equal(cacheBreakIssues.length, 10, 'the cache-break issue cap remains bounded');
    assert.equal(cacheBreakIssues.filter((issue) => issue.session_id === sessionId).length, 9);
    assert.ok(
      report.issues.some((issue) => issue.type === 'cache_break' && issue.session_id === `${sessionId}:compact`),
      'the root report must surface a child compact mismatch as an issue',
    );
    assert.ok(
      report.rankings.some((ranking) => ranking.type === 'cache_breaks' && ranking.message.includes('11 actionable cache break(s)')),
      'the root report must rank child compact mismatches with other actionable breaks',
    );
    const text = execFileSync(process.execPath, [
      'scripts/session-bench.mjs', '--trace', trace, '--session', sessionId,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.match(text, /compact cache breaks \(actionable\):/);
    assert.doesNotMatch(text, /compact cache resets \(intentional\):/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
