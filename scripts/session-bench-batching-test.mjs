import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function batch(sessionId, ts) {
  return { session_id: sessionId, ts, kind: 'batch', payload: { tool_call_count: 1 } };
}

function tool(sessionId, ts, iteration, name) {
  return {
    session_id: sessionId,
    ts,
    kind: 'tool',
    payload: {
      iteration,
      tool_name: name,
      tool_args_summary: name === 'shell' ? { command: 'npm test' } : {},
      tool_ms: 1,
      result_kind: 'normal',
    },
  };
}

test('session bench separates same-session batch candidates from interleaved sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-bench-batch-'));
  const trace = join(dir, 'trace.jsonl');
  const base = Date.now() - 60_000;
  const rows = [
    batch('session-a', base + 1000),
    tool('session-a', base + 1001, 1, 'apply_patch'),
    batch('session-b', base + 1500),
    tool('session-b', base + 1501, 1, 'read'),
    batch('session-a', base + 2000),
    tool('session-a', base + 2001, 2, 'shell'),
    batch('session-b', base + 2500),
    tool('session-b', base + 2501, 2, 'grep'),
    batch('session-c', base + 3000),
    tool('session-c', base + 3001, 1, 'read'),
    batch('session-d', base + 3002),
    tool('session-d', base + 3003, 2, 'grep'),
  ];
  writeFileSync(trace, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  try {
    const run = spawnSync(process.execPath, [
      join(ROOT, 'scripts', 'session-bench.mjs'),
      '--trace', trace,
      '--session', 'all',
      '--json',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const report = JSON.parse(run.stdout);
    assert.equal(report.tools.ordered_followup_candidates.patch_then_shell, 1);
    assert.equal(report.tools.missed_parallelism_heuristic.consecutive_single_tool_batches, 1);
    assert.deepEqual(report.tools.missed_parallelism_heuristic.candidates[0].tools, ['read', 'grep']);
    assert.equal(report.issues.some((issue) => issue.type === 'missed_parallelism'), false);
    assert.equal(report.issues.some((issue) => issue.type === 'ordered_followup'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
