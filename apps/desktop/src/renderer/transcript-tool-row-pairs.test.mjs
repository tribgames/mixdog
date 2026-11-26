import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from './i18n';
import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import { outcomeUnknownPresentation, ToolRowOutcome, toolActivityOutcomeText } from './transcript-tool-ui.tsx';

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
      verb: 'Run command',
      header: 'type C:\\secret\\config.json',
      tone: 'error',
      status: 'Failed · ',
      note: 'Exit code 1',
    },
    ko: { verb: '커맨드 실행', header: 'type C:\\secret\\config.json', tone: 'error', status: '실패 · ', note: '종료 코드 1' },
  },
  grep: {
    item: {
      id: 'g',
      name: 'grep',
      args: { pattern: 'TODO', path: 'src', include_noise: true, text: true, context: 2 },
      result: 'src/a.ts:3:// TODO: fix\nsrc/b.ts:9:// TODO later',
    },
    en: { verb: 'Search code', header: '"TODO" · src', outcome: '2 matches', fields: [] },
    ko: { verb: '코드 검색', header: '"TODO" · src', outcome: '2건 일치', fields: [] },
  },
  read: {
    item: {
      id: 'r',
      name: 'read',
      args: { file_path: 'src/app/main.ts' },
      result: '1\tconst a = 1;\n2\texport { a };',
    },
    en: { verb: 'Read file', header: 'main.ts', outcome: '2 lines' },
    ko: { verb: '파일 읽기', header: 'main.ts', outcome: '2줄' },
  },
  edit: {
    item: {
      id: 'e',
      name: 'edit',
      args: { file_path: 'src/app/main.ts', old_string: 'a = 1', new_string: 'a = 2' },
      result: 'OK Modify src/app/main.ts — +1 -1',
    },
    en: { verb: 'Edit file', header: 'main.ts' },
    ko: { verb: '파일 편집', header: 'main.ts' },
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
    en: { verb: 'Edit file', header: '2 files' },
    ko: { verb: '파일 편집', header: '파일 2개' },
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
    ko: { verb: 'GitHub', header: '풀 리퀘스트 만들기 · acme/app · Fix login redirect', fields: ['저장소', '제목'] },
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
    assert.equal(row({ action: 'pr.create', repo: 'a/b', title: 'New PR' }).subject, '풀 리퀘스트 만들기 · a/b · New PR');
    assert.equal(row({ action: 'issue.list', repo: 'a/b' }).subject, '이슈 목록 · a/b');
    assert.equal(row({ action: 'pr.view', repo: 'a/b', number: 7 }).subject, 'PR 보기 · #7 · a/b');
    assert.equal(row({ action: 'issue.comments', repo: 'a/b', number: 3 }).subject, '댓글 읽기 · #3 · a/b');
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

// ── outcomes the row must state ─────────────────────────────────────────────
test(
  'a call the user stopped reads "stopped" whatever the tool, and a cancelled question no progress',
  inLanguage('ko', () => {
    const takeover = present({
      id: 'c',
      name: 'computer',
      args: { action: 'launch', input: { app: 'https://example.com' } },
      result: 'Error: computer_user_control_active: Computer Use is paused while the user has control',
      isError: true,
    });
    assert.equal(takeover.tone, 'warning');
    assert.equal(takeover.resultLabel, '중지됨');
    const grep = present({ id: 'g', name: 'grep', args: { pattern: 'x' }, result: 'Cancelled', isError: true });
    assert.equal(grep.resultLabel, '중지됨');
    const asked = present({
      id: 'q',
      name: 'ask_user',
      args: { questions: [{ question: 'Scope?' }, { question: 'Storage?' }] },
      result: 'Cancelled',
      isError: true,
    });
    assert.equal(asked.resultLabel, '중지됨');
  })
);

test('a fetch that failed on its address reads the reason below it', () => {
  const raw = 'Error: [https://corporate.example/kr/header.do]\n(error: HTTP 500)\nerrorCode: HTTP_ERROR';
  const row = present({
    id: 'w',
    name: 'web_fetch',
    args: { url: 'https://corporate.example/kr/header.do' },
    result: 'Error: [https://corporate.example/kr/header.do]',
    rawResult: raw,
    isError: true,
  });
  assert.equal(row.resultLabel, 'HTTP 500');
});

// ── each row names its action in the active language, once ────────────────
test(
  'a bridge tool names its action though its arguments ride in `input`',
  inLanguage('ko', () => {
    const browser = present({
      id: 'b',
      name: 'browser',
      args: { action: 'navigate', input: { url: 'https://www.example.com/a', tab: 't1' } },
      result: 'ok',
    });
    assert.equal(browser.subject, '이동 · example.com/a (탭 t1)');
    const bridged = present({
      id: 'bb',
      name: 'call_tool',
      args: { name: 'browser', arguments: { action: 'close_tab', input: { tab: 't1' } } },
      result: 'ok',
    });
    assert.equal(bridged.subject, '탭 닫기 (탭 t1)');
    const computer = present({
      id: 'c',
      name: 'computer',
      args: { action: 'wait_for_user', input: { timeout_ms: 20000 } },
      result: '{"ok":true}',
    });
    assert.equal(computer.subject, '사용자 대기');
  })
);

test(
  'memory, terminal, tidy, office, setup, goal, visualize and GitHub actions read in Korean',
  inLanguage('ko', () => {
    const row = (name, args) => present({ id: name, name, args, result: '{"ok":true}' });
    assert.deepEqual(
      [row('memory', { op: 'add', summary: 'tabs' }).verb, row('memory', { op: 'add', summary: 'tabs' }).subject],
      ['메모리 저장', 'tabs']
    );
    const run = row('terminal', { action: 'run', command: 'npm run dev' });
    assert.deepEqual([run.verb, run.subject], ['터미널 커맨드 실행', 'npm run dev']);
    assert.equal(row('tidy', { action: 'scan', paths: ['.'] }).subject, '.');
    assert.equal(row('office', { action: 'finalize', session: 'office_1' }).subject, '마무리 · office_1');
    assert.equal(row('setup', { action: 'save_automation' }).subject, '자동화 저장');
    const goal = row('goal', { action: 'update_tasks' });
    assert.deepEqual([goal.verb, goal.subject], ['목표', '작업 업데이트']);
    assert.equal(row('visualize', { action: 'act', input: { tab: 'v1' } }).subject, '조작');
    assert.equal(row('github', { action: 'release.list' }).subject, '릴리스 목록');
    assert.equal(row('github', { action: 'workflow.run', workflow: 'ci.yml' }).subject, '워크플로우 실행 · ci.yml');
    assert.equal(row('github', { action: 'pr.comments', number: 4 }).subject, '댓글 읽기 · #4');
  })
);

test('todo, react and a handoff read as their own rows', () => {
  const row = (name, args) => present({ id: name, name, args, result: 'ok' });
  const todo = row('todo', { op: 'advance', note: 'shot taken' });
  assert.deepEqual([todo.verb, todo.subject], ['Update plan', 'Advance · shot taken']);
  const react = row('react', { emoji: '👍' });
  assert.deepEqual([react.verb, react.subject], ['React to message', '👍']);
  const handoff = row('handoff_user', {
    handoff: { kind: 'takeover', surface: 'computer', need: 'sign_in', target: 'GitHub Device Activation' },
  });
  assert.deepEqual([handoff.verb, handoff.subject], ['Hand off to user', 'Sign in · GitHub Device Activation']);
});

test('a structure pass reads as its group does, and a call walk names its direction', () => {
  const row = (args) => present({ id: 'cg', name: 'code_graph', args, result: '' });
  assert.equal(row({ mode: 'imports', files: 'src/a.ts' }).verb, 'Code structure');
  assert.equal(row({ mode: 'callees', symbols: ['run'] }).subject, 'Callees · run');
});

test('an MCP row names its tool in words', () => {
  const row = present({
    id: 'm',
    name: 'mcp__gmail__search_emails',
    args: { query: 'from:boss' },
    result: 'No emails.',
  });
  assert.equal(row.subject, 'Search emails · from:boss');
});

const spoken = (name, args) => {
  const presentation = present({ id: name, name, args, result: '{"ok":true}' });
  return [presentation.verb, presentation.subject].filter(Boolean).join(' ');
};

test(
  'a row never says its action twice',
  inLanguage('ko', () => {
    const row = spoken;
    assert.equal(row('ask_user', { questions: [{ header: '범위', question: 'Scope?' }] }), '질문 범위');
    assert.equal(row('agent', { type: 'list' }), '에이전트 목록');
    assert.equal(row('session', { action: 'status' }), '세션 상태');
    assert.equal(row('session', { action: 'list-projects' }), '프로젝트 목록 조회');
    assert.equal(row('media', { action: 'list', kind: 'image' }), '미디어 목록 이미지');
    assert.equal(row('media', { action: 'generate', kind: 'image', path: 'a.png' }), '이미지 생성 a.png');
    assert.equal(row('media', { action: 'cancel', job: 'j1' }), '미디어 취소 j1');
    assert.equal(row('tidy', { action: 'install', engines: ['biome'] }), '정리 도구 설치 biome');
    assert.equal(row('tidy', { action: 'scan', paths: ['.'] }), '정리 검사 .');
    assert.equal(row('tidy', { action: 'check' }), '정리 확인');
    assert.equal(row('todo', { op: 'view' }), '계획 보기');
    assert.equal(row('computer', { action: 'list', input: { kind: 'windows' } }), '컴퓨터 유즈 목록 · 창');
    assert.equal(row('computer', { action: 'list', input: { kind: 'history' } }), '컴퓨터 유즈 목록 · 기록');
  })
);

test('a row never says its action twice in English either', () => {
  assert.equal(spoken('tidy', { action: 'scan', paths: ['.'] }), 'Tidy scan .');
  assert.equal(spoken('todo', { op: 'view' }), 'Plan view');
});

test(
  'a cancel action that did its work reads its status in the active language; an interrupted one stopped',
  inLanguage('ko', () => {
    const cancel = (name, args, result) => present({ id: name, name, args, result });
    const run = cancel('github', { action: 'run.cancel', id: 7 }, 'Cancelled');
    assert.deepEqual([run.tone, run.resultLabel, run.outputText], ['neutral', '취소됨', '']);
    assert.equal(cancel('media', { action: 'cancel', job: 'j1' }, 'Cancelled').resultLabel, '취소됨');
    assert.equal(cancel('setup', { action: 'cancel_quota_resume' }, 'Cancelled').tone, 'neutral');
    const interrupted = cancel('task', { action: 'cancel', task_id: 't1' }, 'Interrupted by process restart');
    assert.deepEqual([interrupted.tone, interrupted.resultLabel], ['warning', '중지됨']);
  })
);

test('a lookup row counts a file whose name opens like an empty-result message', () => {
  const glob = (result) =>
    toolActivityOutcomeText(present({ id: 'g', name: 'glob', args: { pattern: '*.md' }, result }));
  assert.equal(glob('No files.md'), '1 file');
  assert.equal(glob('(no files found) pattern="*.md" path=.; .: path exists (dir)'), '0 files');
});

test(
  'recall, load_tool, media kinds and long task ids read in Korean',
  inLanguage('ko', () => {
    const row = (name, args, result = 'ok') => present({ id: name, name, args, result });
    assert.equal(row('recall', { query: ['a', 'b'], limit: 8 }).subject, '검색어 2개');
    assert.equal(row('load_tool', { names: 'github' }, 'Already active: github').subject, 'github');
    assert.equal(row('media', { action: 'list', kind: 'video' }).subject, '영상');
    assert.equal(
      row('task', { action: 'wait', task_id: 'task-toolu_01GhcuCTMDNAR4Dy3qeW1Sk2' }).subject,
      '대기 · eW1Sk2'
    );
  })
);

// ── layout: one line that keeps its chevron ────────────────────────────────
test('an outcome the reconnect lost takes the warning colour a neutral row does not', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  try {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('./desktop/13-tool-cards.css', import.meta.url), 'utf8');
    document.head.append(style);
    const base = present({ id: 'r', name: 'read', args: { file_path: 'a.ts' } });
    const verbColours = (tone) => {
      const article = document.createElement('article');
      article.className = `tool-activity-item ${tone}`;
      article.innerHTML =
        '<div class="tool-header tool-activity-item-header"><span class="tool-title tool-activity-item-title"><b>Read</b></span></div>';
      document.body.append(article);
      const verb = article.querySelector('b');
      return [...style.sheet.cssRules]
        .filter((rule) => rule.selectorText && verb.matches(rule.selectorText))
        .map((rule) => rule.style.getPropertyValue('color'))
        .filter(Boolean);
    };
    const tone = outcomeUnknownPresentation(base).tone;
    assert.ok(verbColours(tone).includes('var(--mx-warning)'), tone);
    assert.equal(verbColours(base.tone).includes('var(--mx-warning)'), false);
  } finally {
    restore();
  }
});

test('a long outcome gives way inside the row instead of pushing the chevron out', async () => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  try {
    const style = document.createElement('style');
    style.textContent = ['./desktop/13-tool-cards.css', './desktop/shell-overrides.css']
      .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
      .join('\n');
    document.head.append(style);
    document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
    const row = present({
      id: 'e',
      name: 'edit',
      args: { file_path: 'src/17-settings.css', old_string: 'a', new_string: 'b' },
      result: `Error: edit failed (old_string not found; nearest match on line 165: ${'x'.repeat(200)})`,
      isError: true,
    });
    const header = document.createElement('div');
    header.className = 'tool-header tool-activity-item-header';
    header.innerHTML =
      '<span class="tool-title tool-activity-item-title"><b></b><small data-kind="target"><button class="tool-path-link">17-settings.css</button></small></span>' +
      renderToStaticMarkup(React.createElement(ToolRowOutcome, { presentation: row }));
    document.body.append(header);
    const declared = (element, property) =>
      [...style.sheet.cssRules]
        .filter((rule) => rule.selectorText && element.matches(rule.selectorText))
        .map((rule) => rule.style.getPropertyValue(property))
        .filter(Boolean)
        .at(-1);
    const outcome = header.querySelector('.tool-activity-item-result');
    assert.notEqual(Number.parseFloat(declared(outcome, 'flex').split(' ')[1]), 0, 'the outcome can shrink');
    assert.equal(Number.parseFloat(declared(outcome, 'min-width')), 0);
    assert.equal(declared(outcome, 'text-overflow'), 'ellipsis');
    // A phone's file link stays on the row's one line.
    assert.equal(declared(header.querySelector('.tool-path-link'), 'white-space'), 'nowrap');
  } finally {
    restore();
  }
});

test(
  'a stopped edit reads "stopped" without an error flag; a cancel that did its work does not',
  inLanguage('ko', () => {
    const edit = present({
      id: 'e',
      name: 'edit',
      args: { file_path: 'a.css', old_string: 'x', new_string: 'y' },
      result: 'Cancelled',
    });
    assert.equal(edit.resultLabel, '중지됨');
    const cancel = present({ id: 't', name: 'task', args: { action: 'cancel', task_id: 't1' }, result: 'Cancelled' });
    assert.notEqual(cancel.resultLabel, '중지됨');
  })
);

test(
  'setup, window and code structure actions read in Korean',
  inLanguage('ko', () => {
    const row = (name, args, result = '{"ok":true}') => present({ id: name, name, args, result });
    assert.equal(row('setup', { action: 'set_workflow', workflow: 'a' }).subject, '워크플로우 설정 · a');
    assert.equal(
      row('computer', { action: 'window', input: { operation: 'maximize', window_id: 'w' } }).subject,
      '창 · 최대화 · w'
    );
    assert.equal(row('code_graph', { mode: 'overview' }, '').subject, '개요');
  })
);
