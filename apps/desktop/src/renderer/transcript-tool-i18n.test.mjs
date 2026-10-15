// Tool-card labels follow the ACTIVE UI language: they are resolved when read,
// never frozen at module load, and a composed label is a catalog template.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n, { t } from './i18n';
import { TOOL_DETAIL_LABELS, shortMachineId, toolActivityFieldValue } from './transcript-tool-format.ts';
import { toolActivityStripInstructions, toolStatusLabel } from './transcript-tool-result.ts';
import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import { toolActivityMetaLine, toolActivityOutcomeText } from './transcript-tool-ui.tsx';
import { toolActivityItemTone } from './transcript-tool-core.ts';
const live = JSON.parse(readFileSync(new URL('./transcript-tool-live-rows.fixture.json', import.meta.url), 'utf8'));
import { CodeDiff } from './transcript-diff.tsx';
import { desktopToolActivitySummary } from './transcript-tool-core.ts';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);

test('tool detail labels resolve in the language active when they are read', async () => {
  try {
    await i18n.changeLanguage('ko');
    assert.equal(TOOL_DETAIL_LABELS.plan, t('Plan'));
    assert.notEqual(TOOL_DETAIL_LABELS.plan, 'Plan');
    assert.equal(TOOL_DETAIL_LABELS.arguments, t('Arguments'));
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('boolean tool arguments read as translated Yes / No', async () => {
  const hadYes = i18n.exists('Yes', { lng: 'ko' });
  const hadNo = i18n.exists('No', { lng: 'ko' });
  try {
    await i18n.changeLanguage('ko');
    if (!hadYes) i18n.addResource('ko', 'translation', 'Yes', '예');
    if (!hadNo) i18n.addResource('ko', 'translation', 'No', '아니요');
    assert.equal(toolActivityFieldValue('dry_run', true), t('Yes'));
    assert.equal(toolActivityFieldValue('dry_run', false), t('No'));
    assert.notEqual(toolActivityFieldValue('dry_run', true), 'Yes');
  } finally {
    if (!hadYes) i18n.removeResource?.('ko', 'translation', 'Yes');
    if (!hadNo) i18n.removeResource?.('ko', 'translation', 'No');
    await i18n.changeLanguage('en');
  }
});

test('the per-file diff copy label is the interpolated catalog template', async () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  try {
    await i18n.changeLanguage('ko');
    const markup = renderToStaticMarkup(React.createElement(CodeDiff, { patch }));
    const label =
      /class="tool-detail-copy diff-copy"[^>]*aria-label="([^"]*)"|aria-label="([^"]*)"[^>]*class="tool-detail-copy diff-copy"/.exec(
        markup
      );
    const actual = label?.[1] ?? label?.[2];
    assert.ok(actual, markup);
    assert.equal(actual, t('Copy diff for {{value0}}', { value0: 'src/a.ts' }));
    assert.notEqual(actual, 'Copy diff for src/a.ts');
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('desktop tool activity summary translates to natural verb phrases in Korean', async () => {
  const items = [
    { kind: 'tool', id: 'read-1', name: 'read', args: { file_path: 'src/a.ts' } },
    { kind: 'tool', id: 'grep-1', name: 'grep', args: { pattern: 'first' } },
    { kind: 'tool', id: 'grep-2', name: 'grep', args: { pattern: 'second' } },
    { kind: 'tool', id: 'bash-1', name: 'shell', args: { command: 'npm test' } },
    { kind: 'tool', id: 'edit-1', name: 'edit', args: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
  ];
  try {
    // File changes lead; the rest keep call order, as one list.
    await i18n.changeLanguage('en');
    // File changes and commands always carry their count.
    assert.equal(desktopToolActivitySummary(items), 'Edit 1 file, Read file, Search 2 patterns, Run 1 command');

    await i18n.changeLanguage('ko');
    assert.equal(desktopToolActivitySummary(items), '파일 1개 수정, 파일 읽기, 패턴 2개 검색, 명령어 1회 실행');
  } finally {
    await i18n.changeLanguage('en');
  }
});

const JOB = 'job_1790959235138_971b88';
const toolItem = (name, args, result) => ({ kind: 'tool', id: name, name, args, result, completedAt: 1 });

async function inKorean(run) {
  try {
    await i18n.changeLanguage('ko');
    run();
  } finally {
    await i18n.changeLanguage('en');
  }
}

test('task and tool statuses read as the Korean status words', async () => {
  await inKorean(() => {
    const expected = {
      queued: '대기열',
      running: '실행 중',
      completed: '완료',
      failed: '실패',
      cancelled: '취소됨',
      canceled: '취소됨',
      timeout: '시간 초과',
      timed_out: '시간 초과',
      pending: '대기 중',
    };
    for (const [status, label] of Object.entries(expected)) assert.equal(toolStatusLabel(status), label, status);
    assert.equal(toolStatusLabel('mystery'), 'mystery');
  });
});

test('one formatter shortens machine ids and leaves short ids alone', () => {
  assert.equal(shortMachineId(JOB), '971b88');
  assert.equal(shortMachineId(`wait ${JOB} and a1`), 'wait 971b88 and a1');
  assert.equal(shortMachineId('a1'), 'a1');
});

test('an open background shell row reads verb, background, short id', async () => {
  await inKorean(() => {
    const started = [
      'background task',
      `task_id: ${JOB}`,
      'label: sleep 100',
      'status: running',
      'started: 2026-10-11T14:00:00.000Z',
      '',
      'auto-backgrounded after 15s; still running. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
    ].join('\n');
    const presentation = desktopToolActivityItemPresentation(toolItem('shell', { command: 'sleep 100' }, started));
    assert.equal([presentation.verb, toolActivityMetaLine(presentation)].join(' · '), '실행 · 백그라운드 · 971b88');
    assert.equal(presentation.resultLabel, '');
    assert.equal(presentation.outputText, '');
    assert.equal(presentation.outputNote, '백그라운드에서 실행 · 완료되면 알림을 표시합니다');
  });
});

test('a completed task notification row reads verb, completed, short id with no instruction or raw fields', async () => {
  await inKorean(() => {
    const notice = [
      '<task-notification>',
      `<task-id>${JOB}</task-id>`,
      '<status>completed</status>',
      '<exit-code>0</exit-code>',
      '<summary>Shell task completed (exit 0): sleep 1</summary>',
      '<result>',
      `Retrieve output with task read (task_id: ${JOB}) only if it has not already been received.`,
      '</result>',
      '</task-notification>',
    ].join('\n');
    const args = { command: 'sleep 1', type: 'task-notification', status: 'completed', task_id: JOB };
    const presentation = desktopToolActivityItemPresentation(toolItem('shell', args, notice));
    assert.equal([presentation.verb, toolActivityMetaLine(presentation)].join(' · '), '실행 · 완료 · 971b88');
    assert.equal(presentation.outputText, '');
    assert.equal(presentation.resultLabel, '');
    assert.doesNotMatch(presentation.subject, /Retrieve/);
    assert.deepEqual(presentation.fields, []);
  });
});

test('instructions written for the model never reach the row body, result or subject', () => {
  const instructions = [
    `Retrieve output with task read (task_id: ${JOB}) only if it has not already been received.`,
    'auto-backgrounded after 15s; still running. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
    'shell admission wait exceeded 30000ms; queued as background task [task_id: shell_8d84b6b4] that starts when an execution slot frees. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
    'agent task: t1\nstatus: running\nagent: worker',
    'agent result\nstatus: completed',
  ];
  for (const text of instructions) assert.equal(toolActivityStripInstructions(text), '', text);
  assert.equal(toolActivityStripInstructions('agent task: t1\nstatus: running\n\nreal answer'), 'real answer');
  assert.equal(toolActivityStripInstructions('plain output\nsecond'), 'plain output\nsecond');
  // "Job still running" is a task read's label, never a line of a body.
  assert.equal(toolActivityStripInstructions('Job still running; 3 new lines.', true), '');
  assert.equal(toolActivityStripInstructions('Job still running; 3 new lines.'), 'Job still running; 3 new lines.');
  // Payload positions keep guidance-looking lines: an agent's fenced example
  // and task stdout; only a trailing runtime paragraph is dropped.
  const fenced = 'Example output:\n```\nJob still running; 1 new line.\n```\nDone.';
  assert.equal(toolActivityStripInstructions(fenced), fenced);
  const stdout = 'build ok\nJob still running; 1 new line.\nnext step';
  assert.equal(toolActivityStripInstructions(stdout), stdout);
  const sentence =
    'auto-backgrounded after 15s; still running. Completion arrives automatically; call task wait (not task read polling) when the result is due.';
  const quoted = `Docs say:\n${sentence}\nend`;
  assert.equal(toolActivityStripInstructions(quoted), quoted);
  // Output is never filtered, whatever follows it or how its fence is written.
  assert.equal(toolActivityStripInstructions(`real output\n\n${sentence}`), `real output\n\n${sentence}`);
  const retrieve = `Retrieve output with task read (task_id: ${JOB}) only if it has not already been received.`;
  for (const fence of ['~~~', '````']) {
    const text = `Example:\n${fence}\nlog\n\n${retrieve}`;
    assert.equal(toolActivityStripInstructions(text), text, fence);
    const nested = `${fence}\ncode\n\`\`\`\n\n${retrieve}\n${fence}`;
    assert.equal(toolActivityStripInstructions(nested), nested, fence);
  }
  const section = `[stdout]\nDocumented message:\n\n${retrieve}`;
  assert.equal(toolActivityStripInstructions(section), section);
  // The producer's own wait cue is the last paragraph after the rendered task.
  const cue =
    'Wait ceiling reached; task still running. If periodic reports were requested, write the user-facing report now, then call task wait for the next interval; otherwise continue independent work or end the turn.';
  // Only a task wait result carries the cue; elsewhere it is payload.
  assert.equal(toolActivityStripInstructions(`[stdout]\nbuilding\n\n${cue}`, false, true), '[stdout]\nbuilding');
  assert.equal(toolActivityStripInstructions(`[stdout]\nbuilding\n\n${cue}`), `[stdout]\nbuilding\n\n${cue}`);
  const agentAnswer = `Example:\n\`\`\`\nlog\n\n${cue}`;
  assert.equal(toolActivityStripInstructions(agentAnswer), agentAnswer);
  const prose = 'Agent task succeeded after retry.\nDiagnosis: temporary timeout\nNo further action needed.';
  assert.equal(toolActivityStripInstructions(prose), prose);
  const lowerProse = 'agent task finished after retry\nstatus: ok\nnotes here';
  assert.equal(toolActivityStripInstructions(lowerProse), lowerProse);
  assert.equal(
    toolActivityStripInstructions('see below\nagent task: t1\nstatus: running'),
    'see below\nagent task: t1\nstatus: running'
  );
  assert.equal(toolActivityStripInstructions('agent result agent=worker tag=x\nstatus: completed\n\nanswer'), 'answer');
  for (const text of instructions) {
    const presentation = desktopToolActivityItemPresentation(toolItem('task', { action: 'read', task_id: JOB }, text));
    const waiting = /^Job still running/.test(text)
      ? t('Running in the background · a notice appears when it completes')
      : '';
    assert.equal(presentation.outputText, '', text);
    assert.equal(presentation.outputNote, waiting, text);
    assert.doesNotMatch(presentation.resultLabel, /Retrieve|auto-backgrounded|queued as|agent task/, text);
    assert.doesNotMatch(presentation.subject, /Retrieve|auto-backgrounded|still running/, text);
  }
});

test('a task read keeps a non-zero exit, timeout or signal visible and exit 0 silent', async () => {
  await inKorean(() => {
    const read = (fields) =>
      desktopToolActivityItemPresentation(
        toolItem(
          'task',
          { action: 'read', task_id: JOB },
          `background task\ntask_id: ${JOB}\nstatus: completed\n${fields}\n\ndone`
        )
      );
    const ok = read('exit_code: 0');
    const bad = read('exit_code: 2');
    assert.equal(ok.tone, 'neutral');
    assert.equal(ok.resultLabel, '');
    assert.equal(bad.tone, 'error');
    assert.equal(bad.resultLabel, '실패 · 종료 2');
    assert.match(bad.metaText, /실패 · 종료 2/);
    assert.equal(read('timed_out: true').resultLabel, '시간 초과');
    assert.equal(read('signal: SIGKILL').tone, 'error');
    const notice = (code) =>
      `<task-notification>\n<task-id>${JOB}</task-id>\n<status>completed</status>\n<exit-code>${code}</exit-code>\n<summary>Shell task completed (exit ${code}): x</summary>\n</task-notification>`;
    assert.equal(desktopToolActivityItemPresentation(toolItem('shell', { command: 'x' }, notice(2))).tone, 'error');
    assert.equal(desktopToolActivityItemPresentation(toolItem('shell', { command: 'x' }, notice(0))).tone, 'neutral');
  });
});

test('a failed task keeps its error detail, its signal and a single outcome', async () => {
  await inKorean(() => {
    const present = (name, args, text) => desktopToolActivityItemPresentation(toolItem(name, args, text));
    const read = (fields, body) =>
      present(
        'task',
        { action: 'read', task_id: JOB },
        `background task\ntask_id: ${JOB}\nstatus: completed\n${fields}\n\n${body}`
      );
    const denied = read('exit_code: 2', 'fatal: permission denied');
    assert.equal(denied.outputText, 'fatal: permission denied');
    assert.equal(denied.resultLabel, '실패 · 종료 2');
    // The outcome span shows 실패 · 종료 2 and the subject shows the id: nothing repeats.
    assert.equal(toolActivityMetaLine(denied), '');
    const killed = read('signal: SIGKILL', 'stopped');
    assert.equal(killed.resultLabel, '실패 · SIGKILL');
    assert.equal(killed.tone, 'error');
    assert.equal(read('timed_out: true', 'stopped').resultLabel, '시간 초과');
    const withError = present(
      'task',
      { action: 'read', task_id: JOB },
      `background task\ntask_id: ${JOB}\nstatus: failed\nerror: spawn ENOENT\n\n`
    );
    assert.equal(withError.outputText, 'spawn ENOENT');
    const notice = (extra, result) =>
      `<task-notification>\n<task-id>${JOB}</task-id>\n<status>failed</status>\n<exit-code>2</exit-code>\n<summary>Shell task failed (exit 2): make</summary>\n${result}${extra}</task-notification>`;
    const shell = present('shell', { command: 'make' }, notice('', '<result>\nfatal: permission denied\n</result>\n'));
    assert.equal(shell.outputText, 'fatal: permission denied');
    assert.equal(shell.resultLabel, '실패 · 종료 2');
    assert.equal(toolActivityOutcomeText(shell), '실패 · 종료 2 · 971b88');
    assert.equal(toolActivityMetaLine(shell), '');
    const summaryOnly = present('shell', { command: 'make' }, notice('', ''));
    assert.equal(summaryOnly.outputText, 'make');
    const explicit = present('shell', { command: 'make' }, notice('<error>disk full</error>\n', ''));
    assert.match(explicit.outputText, /disk full/);
    assert.equal(explicit.resultLabel, '실패 · disk full');
    assert.equal(toolActivityOutcomeText(explicit), '실패 · disk full · 971b88');
  });
});

test('only the exact runtime guidance lines are hidden, and truncated forms only when 50-80 characters of the sentence remain', () => {
  const guidance = [
    'auto-backgrounded after 15s; still running. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
    'moved to background at timeout after 120s; still running. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
    'auto-backgrounded after 9s; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
    'auto-backgrounded; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
    'shell admission wait exceeded 30000ms; queued as background task [task_id: shell_8d84b6b4] that starts when an execution slot frees. Completion arrives automatically; call task wait (not task read polling) when the result is due.',
    `Retrieve output with task read (task_id: ${JOB}) only if it has not already been received.`,
  ];
  for (const line of guidance) {
    assert.equal(toolActivityStripInstructions(line), '', line);
    assert.equal(toolActivityStripInstructions(`${line.slice(0, 80)}...`, true), '', line);
    assert.equal(toolActivityStripInstructions(`${line.slice(0, 80)}...`), `${line.slice(0, 80)}...`, line);
  }
  const lookalikes = [
    'The service was queued as background task [task_id: queue-1], then rejected for missing credentials.',
    'auto-backgrounded after 15s; still running, see the log',
    `Retrieve output with task read (task_id: ${JOB}) only if you like.`,
    `${guidance[5].slice(0, 40)}...`,
    'Job still running; many new lines.',
  ];
  for (const line of lookalikes) assert.equal(toolActivityStripInstructions(line, true), line, line);
  const present = (text) =>
    desktopToolActivityItemPresentation(toolItem('task', { action: 'wait', task_id: JOB }, text));
  const fallback = guidance[3];
  assert.equal(present(fallback).outputText, '');
  assert.equal(present(fallback).resultLabel, '');
});

test('ordinary output and subjects that resemble instructions are never stripped', () => {
  const wording =
    'Please explicitly ask for approval before deleting files.\nTo continue independent work, use read for full output.';
  const shell = desktopToolActivityItemPresentation(toolItem('shell', { command: 'cat notes.txt' }, wording));
  assert.equal(shell.outputText, wording);
  const memory = desktopToolActivityItemPresentation(
    toolItem('memory', { action: 'remember', text: 'Please explicitly ask first' }, 'ok')
  );
  assert.match(memory.subject, /explicitly ask/);
  assert.equal(toolActivityStripInstructions(wording), wording);
});

test('task list entries read as short id, localized surface and status', async () => {
  await inKorean(() => {
    const list = `background tasks: 2\n- ${JOB} shell/shell running label=sleep 100\n- agent_1790959235138_aa11bb agent/spawn completed`;
    const presentation = desktopToolActivityItemPresentation(toolItem('task', { action: 'list' }, list));
    assert.deepEqual(presentation.outputText.split('\n').slice(1), [
      '971b88 · 명령 · 실행 중 · sleep 100',
      'aa11bb · 에이전트 · 시작 · 완료',
    ]);
  });
});

test('the header does not repeat an id already in the subject', async () => {
  await inKorean(() => {
    const done = `<task-notification>\n<task-id>${JOB}</task-id>\n<status>completed</status>\n<summary>Task completed</summary>\n<result>ok</result>\n</task-notification>`;
    const presentation = desktopToolActivityItemPresentation(toolItem('task', { action: 'wait', task_id: JOB }, done));
    assert.equal(presentation.subject, '대기 · 971b88');
    assert.equal(toolActivityMetaLine(presentation), '완료');
  });
});

test('envelope lines are never the result label', () => {
  for (const text of ['background task\ntask_id: t\nsurface: web_search\nstatus: completed', 'surface: web_search']) {
    const presentation = desktopToolActivityItemPresentation(toolItem('task', { action: 'wait', task_id: 't' }, text));
    assert.doesNotMatch(presentation.resultLabel, /background task|surface/, text);
  }
});

test('task subjects, agent titles, fallbacks and result labels are localized', async () => {
  await inKorean(() => {
    const present = (name, args, result) => desktopToolActivityItemPresentation(toolItem(name, args, result));
    assert.equal(present('task', { action: 'wait', task_id: JOB }, 'ok').subject, '대기 · 971b88');
    assert.equal(present('task', { action: 'cancel', task_id: 'a1' }, 'cancelled').resultLabel, '취소됨');
    assert.equal(present('task', { action: 'list' }, 'background tasks: 2').resultLabel, '백그라운드 작업 2개');
    assert.equal(present('glob', { pattern: 'x' }, '[]').resultLabel, '파일 1개');
    assert.equal(
      present('agent', { type: 'spawn', role: 'worker', prompt: 'x' }, 'agent task: t\nstatus: running').subject,
      '시작'
    );
    assert.equal(present('request_user_input', { questions: [{}] }, 'ok').structuredRows[0].text, '질문 1');
    const asked = present(
      'ask_user',
      { questions: [{ question: 'Which "db"?' }, { question: 'Features?' }, { question: 'Name?' }] },
      'User has answered your questions: "Which \\"db\\"?"="PG"; "Features?"="X" + "own text" (typed); "Name?"=(no answer). You can now continue with these answers in mind.'
    );
    assert.deepEqual(
      asked.structuredRows.map((row) => [row.text, row.answer, row.status]),
      [
        ['Which "db"?', 'PG', 'completed'],
        ['Features?', 'X, own text', 'completed'],
        ['Name?', '', 'pending'],
      ]
    );
    assert.equal(asked.outputText, '');
    // Escaped quotes, a label holding ", " and typed text kept apart from the picks.
    const quoted = present(
      'ask_user',
      { questions: [{ question: 'Q1?' }, { question: 'Q2?' }] },
      'User has answered your questions: "Q1?"="A, B" + "say \\"; \\"hi" (typed); "Q2?"="x". You can now continue with these answers in mind.'
    );
    assert.deepEqual(
      quoted.structuredRows.map((row) => row.answer),
      ['A, B, say "; "hi', 'x']
    );
    assert.equal(present('update_plan', { todos: [{}] }, 'ok').structuredRows[0].text, '할 일 1');
    assert.equal(
      present('browser', { action: 'navigate', url: 'https://example.com/x' }, 'ok').subject,
      '이동 · example.com/x'
    );
    assert.equal(present('media', { action: 'generate_image', prompt: 'cat' }, '{"ok":true}').verb, '이미지 생성');
    const gh = present('github', { action: 'pr.list', state: 'open', repo: 'a/b', meta: true, mode: 'x' }, 'x');
    assert.deepEqual(
      gh.fields.map((field) => field.label),
      ['상태', '저장소']
    );
  });
});

test('the shell completion summary is localized and keeps the command', async () => {
  const note = (code) =>
    `<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n<exit-code>${code}</exit-code>\n<summary>Shell task completed (exit ${code}): npm test</summary>\n</task-notification>`;
  const present = () => desktopToolActivityItemPresentation(toolItem('shell', { command: 'npm test' }, note(2)));
  await inKorean(() => {
    assert.equal(present().resultLabel, '실패 · 종료 2');
  });
  assert.equal(present().resultLabel, 'Failed · Exit 2');
});

const ko = (run) => async () => {
  try {
    await i18n.changeLanguage('ko');
    await run();
  } finally {
    await i18n.changeLanguage('en');
  }
};
const present = (name, args, text = 'ok') => desktopToolActivityItemPresentation(toolItem(name, args, text));

test(
  'a running background shell shows a quiet placeholder and no empty stdout label',
  ko(() => {
    const running = (body) =>
      `background task\ntask_id: ${JOB}\nstatus: running\nstarted: 2026-10-11T14:00:00.000Z\n\n${body}`;
    for (const body of ['', '[stdout]', '[stdout]\n\n[stderr]\n']) {
      assert.equal(
        present('shell', { command: 'sleep 9' }, running(body)).outputNote,
        '백그라운드에서 실행 · 완료되면 알림을 표시합니다',
        body
      );
    }
    assert.equal(present('shell', { command: 'x' }, running('[stdout]\nbuilding')).outputText, 'building');
    assert.equal(
      present('shell', { command: 'x' }, running('[stdout]\n[stderr]\nwarn: low disk')).outputText,
      '[stderr]\nwarn: low disk'
    );
    assert.equal(
      present('task', { action: 'read', task_id: JOB }, 'Job still running; 0 new lines.').outputNote,
      '백그라운드에서 실행 · 완료되면 알림을 표시합니다'
    );
  })
);

test(
  'a failed row reads status and short reason; the id stays in the meta',
  ko(() => {
    const failed = present(
      'task',
      { action: 'wait', task_id: JOB },
      `background task\ntask_id: ${JOB}\nstatus: failed\nerror: boom\n\n`
    );
    assert.equal(failed.resultLabel, '실패 · boom');
    assert.equal(failed.outputText, 'boom');
    const long = present(
      'task',
      { action: 'wait', task_id: JOB },
      `background task\ntask_id: ${JOB}\nstatus: failed\nerror: ${'e'.repeat(80)}\n\n`
    );
    assert.equal(long.resultLabel, `실패 · ${'e'.repeat(59)}…`);
    assert.equal(long.outputText, 'e'.repeat(80));
    const shell = present(
      'shell',
      { command: 'make' },
      `<task-notification>\n<task-id>${JOB}</task-id>\n<status>failed</status>\n<exit-code>2</exit-code>\n<summary>Shell task failed (exit 2): make</summary>\n</task-notification>`
    );
    assert.equal(shell.resultLabel, '실패 · 종료 2');
    assert.equal(toolActivityOutcomeText(shell), '실패 · 종료 2 · 971b88');
  })
);

test(
  'a body-less failure is a localized line from the parsed parts',
  ko(() => {
    const read = (fields) =>
      present(
        'task',
        { action: 'read', task_id: JOB },
        `background task\ntask_id: ${JOB}\nstatus: completed\n${fields}\n\n`
      );
    assert.equal(read('signal: SIGKILL').outputText, 'SIGKILL 신호로 실패');
    assert.equal(read('timed_out: true').outputText, '시간 초과');
    assert.equal(read('exit_code: 3').outputText, '종료 코드 3로 실패');
  })
);

test(
  'agent start, field labels and action subjects are localized',
  ko(() => {
    assert.equal(
      present('agent', { type: 'spawn', role: 'worker', prompt: 'x' }, 'agent task: t\nstatus: running').subject,
      '시작'
    );
    assert.equal(TOOL_DETAIL_LABELS.completed, '완료');
    const labels = present(
      'github',
      { action: 'pr.list', repo: 'a/b', url: 'https://x.y', task_id: 'a1' },
      'x'
    ).fields.map((field) => field.label);
    assert.deepEqual(labels, ['저장소', '주소', '작업 번호']);
    const subject = (name, action) => present(name, { action }, 'x').subject;
    const expected = [
      ['github', 'list_issues', '이슈 목록'],
      ['github', 'view_issue', '이슈 보기'],
      ['github', 'pr.list', 'PR 목록'],
      ['github', 'list_prs', 'PR 목록'],
      ['github', 'view_pr', 'PR 보기'],
      ['github', 'create_pr', 'PR 만들기'],
      ['github', 'merge', '머지'],
      ['github', 'comment', '댓글'],
      ['browser', 'click', '클릭'],
      ['browser', 'navigate', '이동'],
      ['browser', 'type', '입력'],
      ['browser', 'screenshot', '스크린샷'],
      ['browser', 'scroll', '스크롤'],
      ['office', 'docx_edit', '문서 편집'],
      ['media', 'generate_image', '이미지 생성'],
      ['github', 'something_new', 'something new'],
    ];
    for (const [name, action, text] of expected) assert.equal(subject(name, action), text, action);
  })
);

test(
  'a row whose only detail is the meta cannot open and shows it beside the verb',
  ko(() => {
    const notice = `<task-notification>\n<task-id>${JOB}</task-id>\n<status>completed</status>\n<exit-code>0</exit-code>\n<summary>Shell task completed (exit 0): sleep 1</summary>\n</task-notification>`;
    const presentation = present('shell', { command: 'sleep 1' }, notice);
    assert.equal(presentation.hasDetails, false);
    assert.equal(presentation.outputText, '');
  })
);

test(
  'live dev-profile row: a shell completion notice reads verb · status · id with no body or chevron',
  ko(() => {
    const row = desktopToolActivityItemPresentation(live.completionRow);
    assert.equal(
      [row.verb, toolActivityMetaLine({ ...row, resultLabel: '', fields: [] })].join(' · '),
      '실행 · 완료 · f2e11f'
    );
    assert.equal(row.metaText, '완료 · f2e11f');
    assert.equal(row.outputText, '');
    assert.equal(row.resultLabel, '');
    assert.equal(row.hasDetails, false);
    assert.deepEqual(row.fields, []);
    // The cut summary of the full-id sentence is hidden too, whatever the id's length.
    const cutLong = 'Retrieve output with task read (task_id: job_1791730080304_f2e11f) only if it ha...';
    const cutShort = 'Retrieve output with task read (task_id: f2e11f) only if it ha...';
    for (const text of [cutLong, cutShort]) assert.equal(toolActivityStripInstructions(text, true), '', text);
    // A raw body line is never matched by a truncated prefix.
    for (const text of [cutLong, cutShort]) assert.equal(toolActivityStripInstructions(text), text, text);
  })
);

test(
  'live dev-profile row: a running ping shows no stream label as outcome, and a clean LF body',
  ko(() => {
    const row = desktopToolActivityItemPresentation(live.runningRow);
    assert.equal(row.resultLabel, '');
    assert.equal(row.metaText, '백그라운드 · 552eb2');
    assert.equal(toolActivityMetaLine(row), '백그라운드 · 552eb2');
    assert.doesNotMatch(row.outputText, /\[stdout\]|\r/);
    assert.match(row.outputText, /^Ping 127\.0\.0\.1/);
    assert.equal(row.command, 'ping -n 90 127.0.0.1');
  })
);

test('a shell completion notice is filtered, ordinary shell output never is', () => {
  const sentence = 'Retrieve output with task read (task_id: a1) only if it has not already been received.';
  const notice = present('shell', { type: 'result', status: 'completed', task_id: 'a1', surface: 'shell' }, sentence);
  assert.equal(notice.outputText, '');
  assert.equal(present('shell', { command: 'echo' }, sentence).outputText, sentence);
  assert.equal(present('shell', { command: 'echo' }, `${sentence}\nnext`).outputText, `${sentence}\nnext`);
});

test(
  'live dev-profile row: a failed foreground command reads 실패 · its error and keeps stderr and exit in the body',
  ko(() => {
    const row = desktopToolActivityItemPresentation(live.foregroundFailure);
    assert.equal(row.verb, '실행');
    assert.equal(row.resultLabel, '실패 · fatal: permission denied');
    // A failed command wears the failure tone like every other failure; the
    // internal tone of the item stays "warning".
    assert.equal(row.tone, 'error');
    assert.equal(toolActivityItemTone(live.foregroundFailure), 'warning');
    assert.equal(row.command, 'cmd /c "echo fatal: permission denied 1>&2 & exit 2"');
    assert.doesNotMatch(row.outputText, /exit code/);
    assert.equal(row.outputNote, '종료 코드 2');
    assert.match(row.outputText, /fatal: permission denied/);
    const silent = desktopToolActivityItemPresentation({
      ...live.foregroundFailure,
      result: '',
      rawResult: '[exit code: 2]\n',
    });
    assert.equal(silent.resultLabel, '실패 · 종료 2');
  })
);

test(
  'live dev-profile row: a background failure notice reads 실패 · 종료 1 · id, with only the command as body',
  ko(() => {
    const row = desktopToolActivityItemPresentation(live.failedNotice);
    assert.equal(row.verb, '실행');
    assert.equal(row.tone, 'error');
    assert.equal(row.resultLabel, '실패 · 종료 1');
    assert.equal(row.metaText, '실패 · 종료 1 · 711cd8');
    assert.equal(
      row.outputText,
      live.failedNotice.args.command ?? 'powershell -NoProfile -Command "Start-Sleep 20; Write-Error \'boom\'; exit 3"'
    );
    assert.doesNotMatch(row.outputText, /실패/);
    assert.equal(toolActivityMetaLine(row), '');
    assert.equal(toolActivityOutcomeText(row), '실패 · 종료 1 · 711cd8');
  })
);

test(
  'live dev-profile row: a failed task wait shows the decoded error output',
  ko(() => {
    const row = desktopToolActivityItemPresentation(live.taskWaitFailure);
    assert.equal(row.resultLabel, '실패 · 종료 1');
    assert.match(row.outputText, /^\[stderr\]\nStart-Sleep 20; Write-Error 'boom'; exit 3 : boom/);
    assert.match(row.outputText, /CategoryInfo/);
    assert.doesNotMatch(row.outputText, /<Objs|CLIXML|_x000D_|Preparing modules/);
  })
);

test(
  'live dev-profile row: a running PowerShell job drops the CLIXML marker and its empty stream label',
  ko(() => {
    const row = desktopToolActivityItemPresentation(live.runningPowerShell);
    assert.doesNotMatch(row.outputText, /CLIXML|\[stderr\]/);
    assert.equal(row.outputText, '');
    assert.equal(row.outputNote, '백그라운드에서 실행 · 완료되면 알림을 표시합니다');
    assert.equal(row.resultLabel, '');
  })
);
