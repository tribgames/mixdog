import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLineDelta, summarizeToolResult } from './tool-result-summary.mjs';
import { formatAggregateDetail } from './tool-surface.mjs';
import { renderAgentCompletionEnvelope, renderShellCompletionEnvelope } from './task-notification-envelope.mjs';

test('git summaries accept raw status, mutations, batches, failures and stored JSON', () => {
  assert.equal(summarizeToolResult('git', {}, '## main\n M a.txt\n'), '## main');
  assert.equal(summarizeToolResult('git', {}, ''), '(No Output)');
  assert.equal(summarizeToolResult('git', {}, '[main abc1234] title\n 1 file changed\n'), '[main abc1234] title');
  assert.equal(summarizeToolResult('git', {}, '## git add a.txt\n\n## git status\n## main\nA  a.txt\n'), '## main');
  assert.equal(summarizeToolResult('git', {}, 'exit 128\nfatal: missing ref\n'), 'Exit 128');
  assert.equal(summarizeToolResult('git', {}, '## git show missing\nexit 128\nfatal: missing\nerror: command failed: git show missing'), 'Exit 128');
  assert.equal(summarizeToolResult('git', {}, 'blob contents\nexit 128\n'), 'blob contents');
  assert.equal(summarizeToolResult('git', {}, '## git status\n## main\n\n## git show missing\nexit 128\nfatal: missing\nerror: command failed: git show missing'), 'Exit 128');
  assert.equal(summarizeToolResult('git', {}, 'error: command must begin with git'), 'error: command must begin with git');
  assert.equal(summarizeToolResult('git', {}, '{"ok":true,"clean":true}'), 'Ok');
});

test('tagged completion summaries show result content or failure, not wire fields', () => {
  const completed = renderAgentCompletionEnvelope({ id: 'task_agent_summary', status: 'completed', result: '**Reviewed** three files.' });
  assert.equal(summarizeToolResult('agent', {}, completed), 'Reviewed three files.');
  const failed = renderAgentCompletionEnvelope({ id: 'task_agent_summary', status: 'failed', error: 'quota exhausted' });
  assert.equal(summarizeToolResult('agent', {}, failed, true), 'quota exhausted');
  assert.equal(summarizeToolResult('agent', {}, failed), null);
  const shell = renderShellCompletionEnvelope({ jobId: 'job_summary', status: 'completed', exitCode: 2, command: 'npm test' });
  assert.equal(summarizeToolResult('shell', {}, shell), 'Shell task completed (exit 2): npm test');
});

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

test('shell exit summaries accept both wire marker spellings', () => {
  assert.equal(summarizeToolResult('shell', {}, '[exit: 2]'), 'Exit 2');
  assert.equal(summarizeToolResult('shell', {}, '[exit code: 2]'), 'Exit 2');
  assert.equal(summarizeToolResult('shell', {}, '[status: failed]\n[exit code: 2]'), 'Failed · Exit 2');
});

test('status envelopes do not become successful agent or JSON result bodies', () => {
  assert.equal(summarizeToolResult('agent', {}, 'agent task: task-1\nstatus: completed\nmodel: gpt-5'), null);
  assert.equal(summarizeToolResult('request_user_input', {}, '{"status":"completed","message":"ok"}'), null);
  assert.equal(summarizeToolResult('web_search', {}, 'background task\ntask_id: t1\nstatus: running'), null);
});
