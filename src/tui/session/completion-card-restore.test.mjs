// Regression: persisted async-completion wrappers must restore as tool cards.
// 2026-08-17 field report — background shell completions (bench runs) resumed
// the model turn but left NO transcript card: the live notification push is
// event-ephemeral, and the transcript rebuild dropped the persisted wrapper
// row via the internal-display suppression. restoreTranscriptItems now
// projects wrapper rows through the same synthetic tool-card shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreTranscriptItems } from './session-api-ext.mjs';

const wrapper = (taskId, body) => [
  `The async shell task ${taskId} has finished (completed, exit 0) - review this result in your next step. Final result follows; do not recheck.`,
  '',
  'Result:',
  ...body.split('\n').map((line) => `> ${line}`),
].join('\n');

const bodyFor = (taskId) => [
  'background task',
  `task_id: ${taskId}`,
  'label: pwsh run.ps1',
  'status: completed',
  '',
  `[task_id: ${taskId}]`,
  '[status: completed]',
  '[exit: 0]',
  '',
  'Summary: report jobs/report.json',
  '',
  '[stdout preview]',
  '8/8 Mean: 1.000',
].join('\n');

test('completion wrapper user rows restore as tool cards, not dropped rows', () => {
  const messages = [
    { role: 'user', content: '벤치 돌려줘' },
    { role: 'assistant', content: '돌립니다.' },
    { role: 'user', content: wrapper('job_regress_1', bodyFor('job_regress_1')) },
    { role: 'assistant', content: '완료 보고.' },
  ];
  const restored = restoreTranscriptItems(messages, { sessionId: 'sess_test' });
  const items = Array.isArray(restored) ? restored : restored.items;
  const card = items.find((it) => it?.kind === 'tool' && it?.args?.task_id === 'job_regress_1');
  assert.ok(card, 'wrapper row must project a tool card');
  assert.equal(card.isError, false);
  assert.match(String(card.result || ''), /8\/8 Mean: 1\.000/);
  // The raw wrapper must never surface as a plain user bubble.
  assert.ok(!items.some((it) => it?.kind === 'user' && /The async shell task/.test(it.text || '')));
});

test('non-wrapper internal rows stay suppressed on restore', () => {
  const messages = [
    { role: 'user', content: '<system-reminder>internal</system-reminder>' },
    { role: 'user', content: '[mixdog-runtime] nudge' },
  ];
  const restored = restoreTranscriptItems(messages, { sessionId: 'sess_test2' });
  const items = Array.isArray(restored) ? restored : restored.items;
  assert.equal(items.filter((it) => it?.kind === 'user').length, 0);
});

test('restored shell results preserve command-failure and no-match taxonomy', () => {
  const offload = `[tool output offloaded: shell → C:/safe/result.txt (60 KB, 900 lines, sha256 ${'a'.repeat(64)})]`;
  const messages = [
    {
      role: 'assistant',
      toolCalls: [{ id: 'call_fail', name: 'shell', arguments: { command: 'npm test' } }],
    },
    {
      role: 'tool',
      toolCallId: 'call_fail',
      toolKind: 'error',
      content: `${offload}\n\n[exit code: 2]\nfailed tests`,
    },
    {
      role: 'assistant',
      content: '다음 조회',
      toolCalls: [{ id: 'call_probe', name: 'shell', arguments: { command: 'rg missing .' } }],
    },
    {
      role: 'tool',
      toolCallId: 'call_probe',
      toolKind: 'error',
      content: '[exit code: 1]\n[outcome: no-match]\n\n(no output)',
    },
  ];
  const items = restoreTranscriptItems(messages, { sessionId: 'sess_shell_restore' });
  const failed = items.find((item) => item?.args?.command === 'npm test');
  const probe = items.find((item) => item?.args?.command === 'rg missing .');
  assert.equal(failed?.isError, false);
  assert.equal(failed?.exitErrorCount, 1);
  assert.equal(probe?.isError, false);
  assert.equal(probe?.exitErrorCount, 0);
});
