import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from './i18n';
import { renderBackgroundTask } from '../../../../src/runtime/shared/background-tasks.mjs';
import { renderShellCompletionNotice } from '../../../../src/runtime/shared/task-notification-envelope.mjs';
import { toolActivityStripInstructions } from './transcript-tool-result.ts';
import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import { ToolRowOutcome, toolActivityOutcomeText } from './transcript-tool-ui.tsx';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);
const inLanguage = (language, run) => async () => {
  try {
    await i18n.changeLanguage(language);
    await run();
  } finally {
    await i18n.changeLanguage('en');
  }
};
const present = (item) => desktopToolActivityItemPresentation({ kind: 'tool', completedAt: 1, ...item });
const source = (path) => readFileSync(new URL(`../../../../src/runtime/${path}`, import.meta.url), 'utf8');
const literal = (text, pattern) => {
  const match = pattern.exec(text);
  assert.ok(match, `runtime source no longer matches ${pattern}`);
  return match[1];
};
const JOB = 'job_1790959235138_971b88';

// ── paired fixtures: the same call in English and Korean ────────────────────
const LONG_ERROR =
  '권한이 거부되었습니다: C:\\Users\\tempe\\secret\\config.json 파일을 열 수 없어 작업을 계속할 수 없습니다 (EACCES)';
const FIXTURES = {
  shell: {
    item: {
      id: 's',
      name: 'shell',
      args: { command: 'type C:\\secret\\config.json' },
      result: `${LONG_ERROR}  \r\n`,
      rawResult: `[exit code: 1]\n\n${LONG_ERROR}  \r\n`,
      exitErrorCount: 1,
    },
    en: {
      verb: 'Run',
      header: 'type C:\\secret\\config.json',
      tone: 'error',
      status: 'Failed · ',
      note: 'Exit code 1',
    },
    ko: { verb: '실행', header: 'type C:\\secret\\config.json', tone: 'error', status: '실패 · ', note: '종료 코드 1' },
  },
  grep: {
    item: {
      id: 'g',
      name: 'grep',
      args: { pattern: 'TODO', path: 'src', include_noise: true, text: true, context: 2 },
      result: 'src/a.ts:3:// TODO: fix\nsrc/b.ts:9:// TODO later',
    },
    en: { verb: 'Search', header: '"TODO" · src', outcome: '2 matches', fields: [] },
    ko: { verb: '검색', header: '"TODO" · src', outcome: '2건 일치', fields: [] },
  },
  read: {
    item: {
      id: 'r',
      name: 'read',
      args: { file_path: 'src/app/main.ts' },
      result: '1\tconst a = 1;\n2\texport { a };',
    },
    en: { verb: 'Read', header: 'main.ts', outcome: '2 lines' },
    ko: { verb: '읽기', header: 'main.ts', outcome: '2줄' },
  },
  edit: {
    item: {
      id: 'e',
      name: 'edit',
      args: { file_path: 'src/app/main.ts', old_string: 'a = 1', new_string: 'a = 2' },
      result: 'OK Modify src/app/main.ts — +1 -1',
    },
    en: { verb: 'Edit', header: 'main.ts' },
    ko: { verb: '편집', header: 'main.ts' },
  },
  patch: {
    item: {
      id: 'p',
      name: 'apply_patch',
      args: {
        patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** Update File: b.txt\n@@\n-a\n+b\n*** End Patch',
      },
      result: 'OK Modify a.txt — +1 -1\nOK Modify b.txt — +1 -1',
    },
    // A settled change says what happened to its files.
    en: { verb: 'Edited file', header: '2 files' },
    ko: { verb: '편집됨', header: '파일 2개' },
  },
  github: {
    item: {
      id: 'h',
      name: 'github',
      args: { action: 'pr.create', repo: 'acme/app', title: 'Fix login redirect' },
      result: '{"number":12,"url":"https://github.com/acme/app/pull/12"}',
    },
    en: {
      verb: 'GitHub',
      header: 'Create pull request · acme/app · Fix login redirect',
      fields: ['Repo', 'Pull request title'],
    },
    ko: { verb: 'GitHub', header: 'PR 만들기 · acme/app · Fix login redirect', fields: ['저장소', '제목'] },
  },
  browser: {
    item: { id: 'b', name: 'browser', args: { action: 'navigate', url: 'https://example.com/docs?a=1' }, result: 'ok' },
    en: { verb: 'Browser', header: 'Navigate · example.com/docs?a=1', hasDetails: false },
    ko: { verb: '브라우저', header: '이동 · example.com/docs?a=1', hasDetails: false },
  },
  agent: {
    item: {
      id: 'a',
      name: 'agent',
      args: { type: 'spawn', agent: 'worker', model: 'gpt-6', tag: 'review' },
      result: 'agent task: t1\nstatus: running',
    },
    en: { verb: 'Agent', header: 'Spawn Worker (GPT-6, review)' },
    ko: { verb: '에이전트', header: '시작 Worker (GPT-6, review)' },
  },
};

for (const [name, fixture] of Object.entries(FIXTURES)) {
  for (const language of ['en', 'ko']) {
    test(
      `paired fixture ${name} (${language})`,
      inLanguage(language, () => {
        const row = present(fixture.item);
        const expected = fixture[language];
        assert.equal(row.verb, expected.verb);
        assert.equal(row.headerSubject, expected.header);
        if (expected.tone) assert.equal(row.tone, expected.tone);
        if (expected.outcome !== undefined) assert.equal(toolActivityOutcomeText(row), expected.outcome);
        if (expected.fields)
          assert.deepEqual(
            row.fields.map((field) => field.label),
            expected.fields
          );
        if (expected.hasDetails !== undefined) assert.equal(row.hasDetails, expected.hasDetails);
        if (expected.status) {
          // A long error: whole status chip, an ellipsized reason, the full text in the body.
          assert.ok(toolActivityOutcomeText(row).startsWith(expected.status));
          assert.ok(row.outcomeReason.endsWith('…') && row.outcomeReason.length <= 60);
          assert.ok(row.outputText.includes(LONG_ERROR));
          assert.equal(row.outputNote, expected.note);
        }
      })
    );
  }
}

// ── 1. GitHub: the localized action, the target as separate parts ──────────
test(
  'github rows keep the target apart from the localized action',
  inLanguage('ko', () => {
    const row = (args) => present({ id: 'h', name: 'github', args, result: '{}' });
    assert.equal(row({ action: 'pr.create', repo: 'a/b', title: 'New PR' }).subject, 'PR 만들기 · a/b · New PR');
    assert.equal(row({ action: 'issue.list', repo: 'a/b' }).subject, '이슈 목록 · a/b');
    assert.equal(row({ action: 'pr.view', repo: 'a/b', number: 7 }).subject, 'PR 보기 · #7 · a/b');
    assert.equal(row({ action: 'issue.comments', repo: 'a/b', number: 3 }).subject, '댓글 · #3 · a/b');
    const labels = row({ action: 'pr.create', repo: 'a/b', title: 'New PR' }).fields.map((field) => field.label);
    assert.deepEqual(labels, ['저장소', '제목']);
  })
);

// ── 2. grep options are operational; meaningful booleans stay ──────────────
test(
  'grep option flags are hidden and a meaningful boolean stays visible',
  inLanguage('ko', () => {
    const grep = present({
      id: 'g',
      name: 'grep',
      args: { pattern: 'x', include_noise: true, text: true, context: 2, limit: 5, offset: 1 },
      result: 'a.ts:1:x',
    });
    assert.deepEqual(grep.fields, []);
    const flagged = present({ id: 'g', name: 'grep', args: { pattern: 'x', dry_run: true }, result: 'a.ts:1:x' });
    assert.equal(flagged.fields.length, 1);
    assert.equal(flagged.fields[0].key, 'dry_run');
    // `text` is a real argument elsewhere: only grep treats it as an option.
    const other = present({ id: 'w', name: 'web_fetch', args: { url: 'https://x.y', text: true }, result: 'ok' });
    assert.ok(other.fields.some((field) => field.key === 'text'));
  })
);

// ── 3. a failed command's row stays one short line ─────────────────────────
test(
  'a failed command row says only its exit; the error stays in the output',
  inLanguage('ko', () => {
    const row = present(FIXTURES.shell.item);
    assert.ok(row.outcomeReason);
    const html = renderToStaticMarkup(React.createElement(ToolRowOutcome, { presentation: row }));
    assert.doesNotMatch(html, /data-reason/);
    assert.ok(!html.includes(row.outcomeReason.replace(/&/g, '&amp;')));
    assert.equal(html, `<span class="tool-activity-item-result">${row.outputNote || '실패'}</span>`);
    // No output at all: the same short exit line.
    const silent = present({ ...FIXTURES.shell.item, result: '', rawResult: '[exit code: 2]\n' });
    const plain = renderToStaticMarkup(React.createElement(ToolRowOutcome, { presentation: silent }));
    assert.equal(plain, '<span class="tool-activity-item-result">종료 코드 2</span>');
  })
);

// ── 4. exact filtering, generated from the runtime producers ───────────────
// Source-text on purpose: the guidance sentences are private literals inside runtime tool modules whose
// producers need live shell jobs to emit them; the test lifts the literals so the renderer filter cannot drift.
test('guidance lines generated by the runtime producers are hidden; truncated forms only as summaries', () => {
  const promotion = source('agent/orchestrator/tools/lib/shell-run-background/promotion-results.mjs');
  const guidance = literal(promotion, /const BACKGROUND_GUIDANCE =\s*'([^']+)'/);
  const promoted =
    /`moved to background after the \$\{secs\}s hold`/.exec(promotion) && 'moved to background after the 60s hold';
  const timeout =
    /`(moved to background at timeout after) \$\{secs\}s`/.exec(promotion) &&
    'moved to background at timeout after 120s';
  const input =
    /`(moved to background on new user input after) \$\{secs\}s`/.exec(promotion) &&
    'moved to background on new user input after 3s';
  const started = /'(started in the background)'/.exec(promotion)?.[1];
  assert.ok(promoted && timeout && input && started);
  const noJob = literal(promotion, /: `\$\{verb\}(; still running — [^`]+)`/);
  const fallback = literal(
    source('agent/orchestrator/tools/builtin/bash-tool/backgrounded-result.mjs'),
    /DEFAULT_BACKGROUND_MESSAGE =\s*'([^']+)'/
  );
  const shell = source('agent/orchestrator/tools/shell-command.mjs');
  const queued = `shell admission wait exceeded 30000ms; queued as background task [task_id: shell_8d84b6b4] that starts when an execution slot frees. ${literal(shell, /that starts when an execution slot frees\. ` \+\s*'([^']+)'/)}`;
  const taskTool = source('agent/orchestrator/tools/builtin/task-tool.mjs');
  const cues = [/'\\n\\n(Wait ended by new user input[^']+)'/, /'\\n\\n(Wait ceiling reached;[^']+)'/].map((pattern) =>
    literal(taskTool, pattern)
  );
  const notified =
    /`\\n\\n(Wait ended because a notification arrived)\$\{from\}(; it is delivered to you now\. This task \()\$\{taskId\}(\)[^`]+)`/.exec(
      taskTool
    );
  const from = /` \(task_id: \$\{notifiedTaskId\}\)`/.test(taskTool) ? ` (task_id: ${JOB})` : null;
  const again = /`\\n\\n(Wait ceiling reached again \()\$\{hits\}( times\)[^`]+)`/.exec(taskTool);
  assert.ok(notified && from && again);
  cues.push(
    `${notified[1]}${from}${notified[2]}${JOB}${notified[3]}`,
    `${notified[1]}${notified[2]}${JOB}${notified[3]}`,
    `${again[1]}3${again[2]}`
  );
  const notifiedHold = /`(moved to background after) \$\{secs\}(s because a notification arrived[^`]+)`/.exec(
    promotion
  );
  assert.ok(notifiedHold);
  cues.push(`${notifiedHold[1]} 7${notifiedHold[2]}; still running. ${guidance}`);
  const placeholder = literal(source('shared/background-tasks.mjs'), /lines\.push\('', '(\(no result body[^']+)'\)/);
  const notice = renderShellCompletionNotice({ jobId: JOB, status: 'completed', exitCode: 0, command: 'sleep 1' });
  const noticeLine = /<result>\n([^\n]+)\n<\/result>/.exec(notice)[1];
  assert.match(
    renderBackgroundTask({ taskId: JOB, surface: 'shell', status: 'completed', startedAt: 1 }, { includeResult: true }),
    /\(no result body — use read for full output\)|.*/
  );
  const lines = [
    `${promoted}; still running. ${guidance}`,
    `${timeout}; still running. ${guidance}`,
    `${input}; still running. ${guidance}`,
    `${started}; still running. ${guidance}`,
    `${promoted}${noJob}`,
    fallback,
    queued,
    noticeLine,
    ...cues,
    placeholder,
  ];
  for (const line of lines) {
    assert.equal(toolActivityStripInstructions(line), '', line);
    // Only a line longer than the 80-character summary cut is ever truncated.
    if (line.length <= 83) continue;
    const cut = `${line.slice(0, 80)}...`;
    assert.equal(toolActivityStripInstructions(cut, true), '', cut);
    // A raw body line is matched in full only: the cut form survives.
    assert.equal(toolActivityStripInstructions(cut), cut, cut);
  }
});

// ── 6 (note wording) ───────────────────────────────────────────────────────
test(
  'the background note promises a notice, not a state',
  inLanguage('ko', () => {
    const row = present({
      id: 's',
      name: 'shell',
      args: { type: 'result', command: 'sleep 20', task_id: JOB },
      result: `background task\ntask_id: ${JOB}\nstatus: running\nsurface: shell\n\n`,
    });
    assert.equal(row.outputNote, '백그라운드에서 실행 · 완료되면 알림을 표시합니다');
  })
);

// ── 7. the remaining rows ──────────────────────────────────────────────────
test(
  'apply_patch counts, browser meta and agent task lists read in the active language',
  inLanguage('ko', () => {
    assert.equal(present(FIXTURES.patch.item).headerSubject, '파일 2개');
    const browser = present({
      id: 'b',
      name: 'browser',
      args: { action: 'click', ref: 'e5', url: 'https://example.com/x' },
      result: 'ok',
    });
    assert.deepEqual(browser.fields, []);
    assert.equal(browser.hasDetails, false);
    assert.equal(browser.metaText, '');
    const list = present({
      id: 't',
      name: 'task',
      args: { action: 'list' },
      result: `background tasks: 1\n- agent_1790959235138_aa11bb agent/spawn completed`,
    });
    assert.equal(list.outputText, '백그라운드 작업 1개\naa11bb · 에이전트 · 시작 · 완료');
  })
);
const cue =
  'Wait ceiling reached; task still running. If periodic reports were requested, write the user-facing report now, then call task wait for the next interval; otherwise continue independent work or end the turn.';
test('the wait cue is dropped only from a task wait result', () => {
  const body = `[stdout]\nbuilding\n\n${cue}`;
  const task = (action) => present({ id: 't', name: 'task', args: { action, task_id: JOB }, result: body });
  assert.equal(task('wait').outputText, '[stdout]\nbuilding');
  assert.equal(task('read').outputText, body);
  const answer = `Example:\n\`\`\`\nlog\n\n${cue}`;
  assert.equal(present({ id: 'a', name: 'agent', args: { type: 'spawn' }, result: answer }).outputText, answer);
});

test('a task wait envelope loses its cue; the same envelope from a task read keeps it', () => {
  const cues = [
    'Wait interrupted by new user input; task still running. Handle the new message now and reply to it before waiting on this task again.',
    cue,
  ];
  const envelope = `background task\ntask_id: ${JOB}\nlabel: sleep 100\nstatus: running\n\n[stdout]\nbuilding`;
  for (const text of cues) {
    const result = `${envelope}\n\n${text}`;
    const wait = present({ id: 'w', name: 'task', args: { action: 'wait', task_id: JOB }, result });
    assert.equal(wait.outputText.includes('Wait '), false, text);
    assert.match(wait.outputText, /building/);
    const read = present({ id: 'r', name: 'task', args: { action: 'read', task_id: JOB }, result });
    assert.ok(read.outputText.includes(text), text);
  }
});
