// Regression: persisted async-completion wrappers must restore as tool cards.
// 2026-08-17 field report — background shell completions (bench runs) resumed
// the model turn but left NO transcript card: the live notification push is
// event-ephemeral, and the transcript rebuild dropped the persisted wrapper
// row via the internal-display suppression. restoreTranscriptItems now
// projects wrapper rows through the same synthetic tool-card shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreTranscriptItems } from './session-api-ext.mjs';
import { preserveGoalStateAfterTurn, transcriptToolCallDisplayMode } from './turn.mjs';

const wrapper = (taskId, body) => [
  `Async shell task ${taskId} (completed, exit 0) finished.`,
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
  assert.ok(!items.some((it) => it?.kind === 'user' && /Async shell task/.test(it.text || '')));
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

test('task wait calls stay hidden when a session transcript is restored', () => {
  const messages = [
    {
      role: 'assistant',
      toolCalls: [
        { id: 'call_wait', name: 'task', arguments: { action: 'wait', task_id: 'task_shell_1' } },
        { id: 'call_read', name: 'task', arguments: { action: 'read', task_id: 'task_shell_1' } },
      ],
    },
    { role: 'tool', toolCallId: 'call_wait', content: 'status: running' },
    { role: 'tool', toolCallId: 'call_read', content: 'status: completed' },
  ];

  const items = restoreTranscriptItems(messages, { sessionId: 'sess_task_wait_restore' });
  assert.equal(items.some((item) => item?.kind === 'tool' && item?.args?.action === 'wait'), false);
  assert.equal(items.some((item) => item?.kind === 'tool' && item?.args?.action === 'read'), true);
});

test('Goal and load control calls never enter restored tool aggregates', () => {
  const hiddenNames = [
    'goal',
    'create_goal',
    'get_goal',
    'set_goal_tasks',
    'update_goal',
    'load_tool',
    'tool_search',
  ];
  const toolCalls = hiddenNames.map((name, index) => ({
    id: `call_hidden_${index}`,
    name,
    arguments: { action: 'status' },
  }));
  toolCalls.push({ id: 'call_read', name: 'read', arguments: { file_path: 'visible.txt' } });
  const messages = [
    { role: 'assistant', toolCalls },
    ...toolCalls.map((call) => ({
      role: 'tool',
      toolCallId: call.id,
      content: 'ok',
    })),
  ];

  const items = restoreTranscriptItems(messages, { sessionId: 'sess_hidden_controls_restore' });
  const toolItems = items.filter((item) => item?.kind === 'tool');
  assert.equal(toolItems.length, 1);
  assert.equal(toolItems[0].name, 'read');
  assert.equal(toolItems.some((item) =>
    (item.toolMembers || []).some((member) => hiddenNames.includes(member?.name))), false);
});

test('restored skill loads keep user/plugin skills and drop built-in ones', () => {
  const messages = [
    {
      role: 'assistant',
      toolCalls: [
        { id: 'call_user_skill', name: 'Skill', arguments: { name: 'mixdog-refs' } },
        { id: 'call_builtin_skill', name: 'Skill', arguments: { name: 'docx' } },
      ],
    },
    { role: 'tool', toolCallId: 'call_user_skill', content: 'Loaded skill: mixdog-refs' },
    { role: 'tool', toolCallId: 'call_builtin_skill', content: 'Loaded built-in skill: docx' },
  ];

  const items = restoreTranscriptItems(messages, { sessionId: 'sess_skill_restore' });
  const skills = items.filter((item) => item?.kind === 'tool').map((item) => item.args?.name);
  assert.deepEqual(skills, ['mixdog-refs']);
});

test('live turn display policy suppresses Goal/load controls without hiding ordinary tools', () => {
  assert.equal(transcriptToolCallDisplayMode('goal', { action: 'create' }), 'hidden-control');
  assert.equal(transcriptToolCallDisplayMode('functions.load_tool', { name: 'browser' }), 'hidden-control');
  assert.equal(transcriptToolCallDisplayMode('task', { action: 'wait' }), 'task-wait');
  assert.equal(transcriptToolCallDisplayMode('read', { file_path: 'visible.txt' }), 'visible');
  // Skill loads are visible; only a known built-in skill hides at call time.
  const builtin = new Set(['docx']);
  assert.equal(transcriptToolCallDisplayMode('Skill', { name: 'mixdog-refs' }), 'visible');
  assert.equal(transcriptToolCallDisplayMode('Skill', { name: 'mixdog-refs' }, builtin), 'visible');
  assert.equal(transcriptToolCallDisplayMode('Skill', { name: 'docx' }, builtin), 'hidden-control');
});

test('surface replacement preserves Goal state while an explicit user cancellation still pauses', () => {
  assert.equal(preserveGoalStateAfterTurn({ cancelled: true, stale: true }), true);
  assert.equal(preserveGoalStateAfterTurn({ cancelled: true, pendingSessionReset: true }), true);
  assert.equal(preserveGoalStateAfterTurn({ cancelled: true, disposed: true }), true);
  assert.equal(preserveGoalStateAfterTurn({ cancelled: true }), false);
  assert.equal(preserveGoalStateAfterTurn({ cancelled: false, stale: true }), false);
});
