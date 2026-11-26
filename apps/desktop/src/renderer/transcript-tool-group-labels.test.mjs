import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';

import i18n from './i18n';
import { installTestDom } from './test-support/test-dom.mjs';
import { projectSettledTranscriptRows } from './transcript-rows.ts';
import { desktopToolActivitySummary } from './transcript-tool-core.ts';
import { desktopToolActivityItemPresentation } from './transcript-tool-model.ts';
import { ToolActivityGroup } from './TranscriptView.tsx';

const LOCALES = new URL('./locales/', import.meta.url);
const CATALOGS = readdirSync(LOCALES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => [file.slice(0, -'.json'.length), JSON.parse(readFileSync(new URL(file, LOCALES), 'utf8'))]);
for (const [language, catalog] of CATALOGS) i18n.addResourceBundle(language, 'translation', catalog, true, false);
const LANGUAGES = ['en', ...CATALOGS.map(([language]) => language)];

const running = (name, args, id = `${name}-${JSON.stringify(args)}`) => ({ kind: 'tool', id, name, args, at: 1 });
const finished = (name, args, id) => ({ ...running(name, args, id), result: 'ok', completedAt: 2 });
const failed = (name, args, id) => ({ ...finished(name, args, id), result: `Error: ${name} failed`, isError: true });
const stopped = (name, args, id) => ({ ...finished(name, args, id), result: 'Cancelled', isError: true });
// The runtime's bare stop body, without the error flag.
const halted = (name, args, id) => ({ ...finished(name, args, id), result: 'Cancelled' });
const answered = (name, args, result, id) => ({ ...finished(name, args, id), result });

async function summaries(items) {
  const lines = {};
  try {
    for (const lng of ['en', 'ko']) {
      await i18n.changeLanguage(lng);
      lines[lng] = [
        desktopToolActivitySummary(
          items.map((item) => ({ ...item, result: undefined, completedAt: undefined })),
          false
        ),
        desktopToolActivitySummary(items, true),
      ];
    }
  } finally {
    await i18n.changeLanguage('en');
  }
  return lines;
}

const EXPLORE = { query: ['q1', 'q2', 'q3'] };
// What the runtime's glob writes when its patterns match no file.
const EMPTY_GLOB = '(no files found) pattern="*.zz" path=.; .: path exists (dir)';
const CASES = [
  [
    'explore reads like every other group',
    [finished('explore', EXPLORE)],
    ['Explore 3 questions', 'Explored 3 questions'],
    ['3개 항목 탐색', '3개 항목 탐색'],
  ],
  [
    'git and shell commands',
    [finished('git', { command: ['git status', 'git diff'] }), finished('shell', { command: 'npm test' })],
    ['Run 2 Git commands, Run 1 command', 'Ran 2 Git commands, Ran 1 command'],
    ['Git 커맨드 2회 실행, 커맨드 1회 실행', 'Git 커맨드 2회 실행, 커맨드 1회 실행'],
  ],
  [
    'a viewed image and a read resource are files read, one phrase',
    [
      finished('read', { file_path: 'a.ts' }, 'r1'),
      finished('view_image', { path: 'a.png' }),
      finished('read_mcp_resource', { uri: 'mcp://x' }),
    ],
    ['Read 3 files', 'Read 3 files'],
    ['파일 3개 읽기', '파일 3개 읽기'],
  ],
  [
    'agent and task calls keep one tense per state',
    [
      finished('agent', { type: 'spawn', agent: 'worker', prompt: 'p' }, 'a1'),
      finished('agent', { type: 'spawn', agent: 'worker', prompt: 'q' }, 'a2'),
      finished('task', { action: 'wait', task_id: 't1' }),
      finished('task', { action: 'read', task_id: 't1' }),
    ],
    ['Call 2 agents, Wait for task, Check task', 'Called 2 agents, Waited for task, Checked task'],
    ['에이전트 2회 호출, 작업 대기, 작업 상태 확인', '에이전트 2회 호출, 작업 대기, 작업 상태 확인'],
  ],
  [
    'stopping an agent is not calling it',
    [finished('agent', { type: 'cancel', task_id: 'task_agent_1' })],
    ['Agent cancellations', 'Agent cancellations'],
    ['에이전트 취소', '에이전트 취소'],
  ],
  [
    'closing a finished agent ends it, it does not cancel it',
    [finished('agent', { type: 'close', tag: 'worker-a' })],
    ['Ended agents', 'Ended agents'],
    ['에이전트 종료', '에이전트 종료'],
  ],
  [
    'git worktree operations',
    [finished('git', { action: 'worktree', worktree_action: 'enter', worktree: 'x' })],
    ['Worktree management', 'Worktree management'],
    ['워크트리 관리', '워크트리 관리'],
  ],
  [
    'session create is not a project check',
    [finished('session', { action: 'create', project: 'mixdog', title: 'UI 테스트', worktree: { mode: 'branch' } })],
    ['Session creation', 'Session creation'],
    ['세션 생성', '세션 생성'],
  ],
  [
    'session send, rename and status',
    [
      finished('session', { action: 'send', session_id: 'sess_a', prompt: 'hi' }),
      finished('session', { action: 'rename', title: 'T' }),
      finished('session', { action: 'status' }),
    ],
    ['Session message, Session management, Session status', 'Session message, Session management, Session status'],
    ['세션 메시지, 세션 관리, 세션 상태', '세션 메시지, 세션 관리, 세션 상태'],
  ],
  [
    'a unit without a count phrase shows its count as ×N, in Korean N회 like the other labels',
    [
      finished('session', { action: 'create', title: 'a' }, 's1'),
      finished('session', { action: 'create', title: 'b' }, 's2'),
    ],
    ['Session creation ×2', 'Session creation ×2'],
    ['세션 생성 2회', '세션 생성 2회'],
  ],
  [
    'repeated worktree operations count in 회',
    [
      finished('git', { action: 'worktree', worktree_action: 'remove', branch: 'a' }, 'w1'),
      finished('git', { action: 'worktree', worktree_action: 'remove', branch: 'b' }, 'w2'),
      finished('git', { action: 'worktree', worktree_action: 'remove', branch: 'c' }, 'w3'),
      finished('git', { action: 'worktree', worktree_action: 'remove', branch: 'd' }, 'w4'),
    ],
    ['Worktree management ×4', 'Worktree management ×4'],
    ['워크트리 관리 4회', '워크트리 관리 4회'],
  ],
  [
    'directory listings count the same way running and finished',
    [finished('list', { path: ['apps', 'src'] })],
    ['List 2 directories', 'Listed 2 directories'],
    ['폴더 목록 2회 조회', '폴더 목록 2회 조회'],
  ],
  [
    'browser and computer actions both count in 회',
    [
      finished('browser', { action: 'click' }, 'b1'),
      finished('browser', { action: 'fill' }, 'b2'),
      finished('computer', { action: 'act' }, 'c1'),
      finished('computer', { action: 'capture' }, 'c2'),
    ],
    ['Browser 2 actions, Computer 2 actions', 'Browser 2 actions, Computer 2 actions'],
    ['브라우저 작업 2회, 컴퓨터 조작 2회', '브라우저 작업 2회, 컴퓨터 조작 2회'],
  ],
  [
    'a failed edit, glob, git command or search keeps the line it ran under, marked failed',
    [
      failed('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e'),
      failed('glob', { pattern: ['*.ts', '*.tsx', '*.css', '*.md', '*.json', '*.rs'] }, 'g'),
      failed('git', { command: 'git push' }, 'p'),
      failed('grep', { pattern: 'x' }, 's'),
    ],
    [
      'Edit 1 file, Find files for 6 patterns, Run Git command, Search code',
      'Edit 1 file failed, Find files for 6 patterns failed, Run Git command failed, Search code failed',
    ],
    [
      '파일 1개 편집, 패턴 6개로 파일 찾기, Git 커맨드 실행, 코드 검색',
      '파일 1개 편집 실패, 패턴 6개로 파일 찾기 실패, Git 커맨드 실행 실패, 코드 검색 실패',
    ],
  ],
  [
    'a change claims only the files it changed; a failure among them closes the list',
    [
      finished('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e1'),
      finished('edit', { file_path: 'a.css', old_string: 'y', new_string: 'z' }, 'e2'),
      failed('edit', { file_path: 'b.css', old_string: 'x', new_string: 'y' }, 'e3'),
      finished('read', { file_path: 'a.css' }, 'r'),
    ],
    ['Edit 2 files, Read file', 'Edited 1 file, Read file, 1 failed'],
    ['파일 2개 편집, 파일 읽기', '파일 1개 편집, 파일 읽기, 1회 실패'],
  ],
  [
    'a stopped change did not happen',
    [stopped('tidy', { action: 'fix', apply: true }, 't')],
    ['Tidy code', 'Tidy code stopped'],
    ['코드 정리', '코드 정리 중지됨'],
  ],
  [
    'glob counts its patterns, not files',
    [finished('glob', { pattern: ['*.ts', '*.tsx', '*.css', '*.md', '*.json', '*.rs', '*.mjs', '*.toml', '*.yml'] })],
    ['Find files for 9 patterns', 'Found files for 9 patterns'],
    ['패턴 9개로 파일 찾기', '패턴 9개로 파일 찾음'],
  ],
  [
    'one todo call is one plan update, whatever steps it carries',
    [finished('todo', { op: 'set', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })],
    ['Plan updates', 'Plan updates'],
    ['계획 업데이트', '계획 업데이트'],
  ],
  [
    'goal, reaction, handoff and a terminal run are their own units',
    [
      finished('goal', { action: 'complete' }),
      finished('react', { emoji: '👍' }),
      finished('handoff_user', { handoff: { kind: 'takeover', surface: 'computer', need: 'sign_in' } }),
      finished('terminal', { action: 'run', command: 'npm run dev' }),
    ],
    ['Goal, Reaction, Hand off to user, Terminal commands', 'Goal, Reaction, Hand off to user, Terminal commands'],
    ['목표, 반응, 사용자에게 넘기기, 터미널 커맨드', '목표, 반응, 사용자에게 넘기기, 터미널 커맨드'],
  ],
  [
    'closing a session and listing worktrees are not a project check',
    [finished('session', { action: 'close' }), finished('session', { action: 'list-worktrees' })],
    ['Session management, Worktree management', 'Session management, Worktree management'],
    ['세션 관리, 워크트리 관리', '세션 관리, 워크트리 관리'],
  ],
  [
    'a stopped edit did not change its file, even without an error flag',
    [halted('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e')],
    ['Edit 1 file', 'Edit 1 file stopped'],
    ['파일 1개 편집', '파일 1개 편집 중지됨'],
  ],
  [
    'a cancel action that did its work is not a stop',
    [answered('task', { action: 'cancel', task_id: 't1' }, 'Cancelled')],
    ['Cancel task', 'Cancelled task'],
    ['작업 취소', '작업 취소'],
  ],
  [
    'a failure and a stop of the same unit are both said',
    [
      failed('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e1'),
      halted('edit', { file_path: 'b.css', old_string: 'x', new_string: 'y' }, 'e2'),
    ],
    ['Edit 2 files', 'Edit 2 files: 1 failed, 1 stopped'],
    ['파일 2개 편집', '파일 2개 편집: 1회 실패, 1회 중지됨'],
  ],
  [
    'a failed read is not counted as read',
    [finished('read', { file_path: 'a.ts' }, 'r1'), failed('read', { file_path: 'b.ts' }, 'r2')],
    ['Read 2 files', 'Read file, 1 failed'],
    ['파일 2개 읽기', '파일 읽기, 1회 실패'],
  ],
  [
    'a stopped read is not counted as read',
    [finished('read', { file_path: 'a.ts' }, 'r1'), halted('read', { file_path: 'b.ts' }, 'r2')],
    ['Read 2 files', 'Read file, 1 stopped'],
    ['파일 2개 읽기', '파일 읽기, 1회 중지됨'],
  ],
  [
    'a stopped fetch fetched no page',
    [
      finished('web_fetch', { url: 'https://a.example' }, 'f1'),
      halted('web_fetch', { url: 'https://b.example' }, 'f2'),
    ],
    ['Fetch 2 pages', 'Fetched page, 1 stopped'],
    ['웹페이지 2개 가져오기', '웹페이지 가져오기, 1회 중지됨'],
  ],
  [
    'an empty lookup and a stopped one found no file between them',
    [answered('glob', { pattern: '*.zz' }, EMPTY_GLOB, 'g1'), halted('glob', { pattern: '*.yy' }, 'g2')],
    ['Find files for 2 patterns', 'Found no files, 1 stopped'],
    ['패턴 2개로 파일 찾기', '찾은 파일 없음, 1회 중지됨'],
  ],
  [
    'a stopped command is not counted as run',
    [finished('shell', { command: 'a' }, 's1'), stopped('shell', { command: 'b' }, 's2')],
    ['Run 2 commands', 'Ran 1 command, 1 stopped'],
    ['커맨드 2회 실행', '커맨드 1회 실행, 1회 중지됨'],
  ],
  [
    'a command that ran to a failing exit ran; one that never started did not',
    [
      finished('shell', { command: 'a' }, 's1'),
      { ...finished('shell', { command: 'b' }, 's2'), result: 'boom', exitErrorCount: 1 },
      { ...failed('shell', { command: 'c' }, 's3'), callErrorCount: 1 },
    ],
    ['Run 3 commands', 'Ran 2 commands, 2 failed'],
    ['커맨드 3회 실행', '커맨드 2회 실행, 2회 실패'],
  ],
  [
    'an interrupted cancel action did not cancel',
    [answered('task', { action: 'cancel', task_id: 't1' }, 'Interrupted by process restart')],
    ['Cancel task', 'Cancel task stopped'],
    ['작업 취소', '작업 취소 중지됨'],
  ],
  [
    'a file whose name opens like an empty-result message is a file found',
    [answered('glob', { pattern: '*.md' }, 'No files.md')],
    ['Find files', 'Found files'],
    ['파일 찾기', '파일 찾기'],
  ],
  [
    'a path lookup and a symbol search that matched nothing found none',
    [
      answered('find', { query: 'zzz' }, '(no fuzzy match for "zzz")'),
      answered(
        'code_graph',
        { mode: 'find_symbol', symbols: 'zzz' },
        '(no symbol matches in cwd=C:/repo)\ngraph: nodes=12'
      ),
    ],
    ['Find path, Find symbol', 'Found no paths, Found no symbols'],
    ['경로 찾기, 심볼 찾기', '찾은 경로 없음, 찾은 심볼 없음'],
  ],
  [
    'a patch counts each file it names, a path with spaces included',
    [
      finished('apply_patch', {
        patch:
          'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n' +
          'diff --git a/b b b/b b\n--- a/b b\n+++ b/b b\n@@ -1 +1 @@\n-x\n+y\n',
      }),
    ],
    ['Edit 2 files', 'Edited 2 files'],
    ['파일 2개 편집', '파일 2개 편집'],
  ],
  [
    'a lookup that matched nothing does not claim it found files',
    [answered('glob', { pattern: ['*.zz', '*.yy'] }, EMPTY_GLOB)],
    ['Find files for 2 patterns', 'Found no files'],
    ['패턴 2개로 파일 찾기', '찾은 파일 없음'],
  ],
  [
    'viewing the plan and scanning or checking code change nothing',
    [
      finished('todo', { op: 'view' }),
      finished('tidy', { action: 'scan', paths: ['.'] }),
      finished('tidy', { action: 'check' }),
    ],
    ['Plan view, Tidy scan, Tidy check', 'Plan view, Tidy scan, Tidy check'],
    ['계획 보기, 정리 검사, 정리 확인', '계획 보기, 정리 검사, 정리 확인'],
  ],
  [
    'a settled web search reads in the past tense',
    [finished('web_search', { query: ['a', 'b', 'c'] })],
    ['Search web 3 times', 'Searched web 3 times'],
    ['웹 검색 3회', '웹 검색 3회'],
  ],
];

for (const [name, items, en, ko] of CASES) {
  test(`group label: ${name}`, async () => {
    const lines = await summaries(items);
    assert.deepEqual(lines.en, en, 'English [running, finished]');
    assert.deepEqual(lines.ko, ko, 'Korean [running, finished]');
  });
}

// One call of each kind whose failure or stop, or whose row verb, used to change its wording.
const ONE_LINE_CALLS = [
  ['read', { file_path: 'a.ts' }],
  ['view_image', { path: 'a.png' }],
  ['grep', { pattern: 'x' }],
  ['glob', { pattern: '*.ts' }],
  ['explore', { query: 'q' }],
  ['shell', { command: 'npm test' }],
  ['git', { command: 'git status' }],
  ['agent', { type: 'spawn', agent: 'worker', prompt: 'p' }],
  ['web_fetch', { url: 'https://a.example' }],
  ['media', { action: 'generate', kind: 'image', prompt: 'p' }],
  ['tidy', { action: 'fix', apply: true }],
  ['browser', { action: 'click' }],
  ['computer', { action: 'act' }],
  ['edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }],
  ['write', { file_path: 'n.ts', content: 'x' }],
  ['apply_patch', { patch: '*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch' }],
  ['apply_patch', { patch: '*** Begin Patch\n*** Delete File: n.ts\n*** End Patch' }],
  ['apply_patch', { patch: '*** Begin Patch\n*** Update File: n.ts\n@@\n-a\n+b\n*** End Patch', dry_run: true }],
  ['task', { action: 'wait', task_id: 't1' }],
  ['terminal', { action: 'run', command: 'npm run dev' }],
  ['web_search', { query: 'x' }],
  ['todo', { op: 'set', items: ['a'] }],
];

test('a call that fails or stops keeps the line it ran under, with only the state mark added', async () => {
  try {
    for (const lng of LANGUAGES) {
      await i18n.changeLanguage(lng);
      for (const [name, args] of ONE_LINE_CALLS) {
        const line = desktopToolActivitySummary([running(name, args)]);
        const where = `${lng} ${name}`;
        assert.equal(desktopToolActivitySummary([failed(name, args)], true), i18n.t('{{label}} failed', { label: line }), where);
        assert.equal(desktopToolActivitySummary([stopped(name, args)], true), i18n.t('{{label}} stopped', { label: line }), where);
        const rows = [running(name, args), finished(name, args), failed(name, args), stopped(name, args)].map(
          (item) => desktopToolActivityItemPresentation(item)
        );
        assert.equal(new Set(rows.map((row) => row.title)).size, 1, `${where}: one row title`);
        assert.equal(new Set(rows.map((row) => row.verb)).size, 1, `${where}: one row verb`);
      }
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('a counted unit keeps its count mark when it settles, in every language', () => {
  for (const [language, catalog] of CATALOGS) {
    const runningMark = catalog['{{label}} ×{{count}}'];
    assert.ok(catalog['{{label}} ×{{count}}_done'].includes(runningMark), `${language}: ${runningMark}`);
  }
});

// Calls whose settled line once traded its object or its verb for other words.
const SETTLED_CALLS = {
  read: [['read', { file_path: 'a.ts' }]],
  grep: [['grep', { pattern: 'x' }]],
  list2: [['list', { path: ['src', 'app'] }]],
  edit: [['edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }]],
  websearch: [['web_search', { query: 'x' }]],
  fetch: [['web_fetch', { url: 'https://a.example' }]],
  message2: [['fetch', { messages: 2 }]],
  shell: [['shell', { command: 'npm test' }]],
  git: [['git', { command: 'git status' }]],
  office: [['office', { action: 'edit', path: 'a.docx' }]],
  memsearch: [['memory', { action: 'search', query: 'x' }]],
  questions: [['request_user_input', { questions: [{ question: 'q' }] }]],
  worktree: [['git', { action: 'worktree', worktree_action: 'list' }]],
  sessions2: [
    ['session', { action: 'create', title: 'a' }],
    ['session', { action: 'create', title: 'b' }],
  ],
};

// The words a line keeps from running to settled, per language: what it acts
// on and, where a translation once swapped it, its verb's stem.
const KEPT_WORDS = {
  en: {
    read: ['read file'], grep: ['code'], list2: ['2 directories'], edit: ['1 file'], websearch: ['web'],
    fetch: ['page'], message2: ['2 messages'], shell: ['1 command'], git: ['git command'], office: ['office action'],
    memsearch: ['memory lookup'], questions: ['questions'], worktree: ['worktree management'],
    sessions2: ['session creation ×2'],
  },
  de: {
    read: ['datei', 'les'], grep: ['code', 'durchsuch'], list2: ['2 verzeichnisse', 'list'],
    edit: ['1 datei', 'bearbeit'], websearch: ['web', 'durchsuch'], fetch: ['seite', 'rufen'],
    message2: ['2 nachrichten', 'rufen'], shell: ['1 befehl', 'führ'], git: ['git-befehl', 'führ'],
    office: ['dokument-aktion'], memsearch: ['erinnerungen', 'durchsuch'], questions: ['fragen'],
    worktree: ['worktree', 'verwalt'], sessions2: ['sitzungserstellung ×2'],
  },
  es: {
    read: ['archivo'], grep: ['código', 'busc'], list2: ['directorios', 'list'], edit: ['1 archivo', 'edit'],
    websearch: ['web'], fetch: ['página', 'obten'], message2: ['mensajes', 'obten'], shell: ['comando', 'ejecut'],
    git: ['comando git', 'ejecut'], office: ['acción de documento'], memsearch: ['búsqueda en memoria'],
    questions: ['preguntas'], worktree: ['worktrees', 'gesti'], sessions2: ['creación de sesión ×2'],
  },
  fr: {
    read: ['fichier'], grep: ['code', 'recherch'], list2: ['répertoires', 'list'], edit: ['1 fichier', 'modifi'],
    websearch: ['web', 'recherch'], fetch: ['page', 'récupér'], message2: ['messages', 'récupér'],
    shell: ['commande', 'exécut'], git: ['commande git', 'exécut'], office: ['action de document'],
    memsearch: ['recherche en mémoire'], questions: ['questions'], worktree: ['worktrees'],
    sessions2: ['création de session ×2'],
  },
  it: {
    read: ['file'], grep: ['codice', 'cerca'], list2: ['directory', 'elenc'], edit: ['1 file', 'modific'],
    websearch: ['web'], fetch: ['pagina', 'recuper'], message2: ['messaggi', 'recuper'], shell: ['comando', 'esegu'],
    git: ['comando git', 'esegu'], office: ['azione documento'], memsearch: ['ricerca in memoria'],
    questions: ['domande'], worktree: ['worktree', 'gest'], sessions2: ['creazione sessione ×2'],
  },
  ja: {
    read: ['ファイル', '読み込み'], grep: ['コード', '検索'], list2: ['ディレクトリ一覧を 2 回表示'],
    edit: ['1 件のファイルを編集'], websearch: ['web', '検索'], fetch: ['ページ', '取得'],
    message2: ['2 件のメッセージを取得'], shell: ['コマンドを 1 回実行'], git: ['git コマンド', '実行'],
    office: ['ドキュメント', '操作'], memsearch: ['メモリ', '検索'], questions: ['質問'],
    worktree: ['ワークツリー', '管理'], sessions2: ['セッション作成 2回'],
  },
  ko: {
    read: ['파일 읽기'], grep: ['코드 검색'], list2: ['폴더 목록 2회 조회'], edit: ['파일 1개 편집'], websearch: ['웹 검색'],
    fetch: ['웹페이지 가져오기'], message2: ['메시지 2개 가져오기'], shell: ['커맨드 1회 실행'], git: ['git 커맨드 실행'],
    office: ['문서 작업'], memsearch: ['메모리 조회'], questions: ['질문'], worktree: ['워크트리 관리'],
    sessions2: ['세션 생성 2회'],
  },
  'pt-BR': {
    read: ['arquivo'], grep: ['código', 'pesquis'], list2: ['diretórios', 'list'], edit: ['1 arquivo', 'edit'],
    websearch: ['web', 'pesquis'], fetch: ['página', 'busc'], message2: ['mensagens', 'busc'],
    shell: ['comando', 'execut'], git: ['comando git', 'execut'], office: ['ação de documento'],
    memsearch: ['busca na memória'], questions: ['perguntas'], worktree: ['worktrees', 'gerenc'],
    sessions2: ['criação de sessão ×2'],
  },
  ru: {
    read: ['файл'], grep: ['поиск в коде'], list2: ['каталог', 'просмотр'], edit: ['файл', 'измен'],
    websearch: ['интернет'], fetch: ['страниц', 'получ'], message2: ['сообщени', 'получ'], shell: ['команд', 'выполн'],
    git: ['команд', 'git', 'выполн'], office: ['действие с документом'], memsearch: ['поиск в памяти'],
    questions: ['вопросы'], worktree: ['управление worktree'], sessions2: ['создание сессии ×2'],
  },
  vi: {
    read: ['đọc tệp'], grep: ['tìm mã nguồn'], list2: ['liệt kê 2 thư mục'], edit: ['chỉnh sửa 1 tệp'],
    websearch: ['tìm kiếm web'], fetch: ['lấy trang'], message2: ['lấy 2 tin nhắn'], shell: ['chạy 1 lệnh'],
    git: ['chạy lệnh git'], office: ['thao tác tài liệu'], memsearch: ['tìm trong bộ nhớ'], questions: ['câu hỏi'],
    worktree: ['quản lý worktree'], sessions2: ['tạo phiên ×2'],
  },
  'zh-CN': {
    read: ['读取', '文件'], grep: ['搜索代码'], list2: ['列出 2 个目录'], edit: ['编辑 1 个文件'], websearch: ['网页', '搜索'],
    fetch: ['获取网页'], message2: ['获取 2 条消息'], shell: ['运行 1 条命令'], git: ['运行 git 命令'],
    office: ['文档操作'], memsearch: ['查找记忆'], questions: ['问题'], worktree: ['工作树', '管理'],
    sessions2: ['创建会话 2 次'],
  },
  'zh-TW': {
    read: ['讀取檔案'], grep: ['搜尋程式碼'], list2: ['列出 2 個目錄'], edit: ['編輯 1 個檔案'], websearch: ['網路搜尋'],
    fetch: ['擷取頁面'], message2: ['擷取 2 則訊息'], shell: ['執行 1 個命令'], git: ['執行 git 命令'],
    office: ['文件操作'], memsearch: ['尋找記憶'], questions: ['問題'], worktree: ['工作樹', '管理'],
    sessions2: ['建立工作階段 2 次'],
  },
};

test('a call that finishes keeps its line’s object and verb, only its tense changing, in every language', async () => {
  assert.deepEqual(Object.keys(KEPT_WORDS).sort(), [...LANGUAGES].sort());
  try {
    for (const lng of LANGUAGES) {
      await i18n.changeLanguage(lng);
      for (const [key, calls] of Object.entries(SETTLED_CALLS)) {
        const items = calls.map(([name, args], index) => running(name, args, `${key}-${index}`));
        const lines = [
          desktopToolActivitySummary(items),
          desktopToolActivitySummary(
            items.map((item) => ({ ...item, result: 'ok', completedAt: 2 })),
            true
          ),
        ];
        for (const word of KEPT_WORDS[lng][key]) {
          for (const line of lines) assert.ok(line.toLocaleLowerCase().includes(word), `${lng} ${key}: "${word}" in ${lines.join(' → ')}`);
        }
      }
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('calls of a turn share one group; narration and a new turn start another', () => {
  const git = (id) => ({ ...finished('git', { command: ['git status'] }, id) });
  const items = [
    { kind: 'user', id: 'u1', text: 'go' },
    git('g1'),
    // Control tools never show, so they never split a group.
    finished('todo', { todos: [] }, 'todo1'),
    finished('load_tool', { names: 'session' }, 'lt1'),
    git('g2'),
    { kind: 'assistant', id: 'a1', text: 'Checked both; now the tests.' },
    git('g3'),
    { kind: 'user', id: 'u2', text: 'again' },
    git('g4'),
  ];
  const turnKeys = ['t1', 't1', 't1', 't1', 't1', 't1', 't1', 't2', 't2'];
  const { rows } = projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set() });
  assert.deepEqual(
    rows
      .filter((row) => row._tag !== 'TurnGap')
      .map((row) => `${row._tag}${row.items ? `:${row.items.map((item) => item.id).join('+')}` : ''}`),
    ['UserMessage', 'ToolActivity:g1+g2', 'AssistantPart', 'ToolActivity:g3', 'UserMessage', 'ToolActivity:g4']
  );
});

function installDom() {
  const { window, root, restore } = installTestDom(null, {
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator'],
    rootId: 'root',
  });
  return { window, root, close: restore };
}

test('a running explore group copies as its one summary line', async () => {
  const dom = installDom();
  try {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('./desktop/13-tool-cards.css', import.meta.url), 'utf8');
    document.head.append(style);
    await act(async () => {
      dom.root.render(
        React.createElement(ToolActivityGroup, {
          disclosureScope: 'explore-running',
          items: [{ kind: 'tool', id: 'x', name: 'explore', args: EXPLORE, at: Date.now() - 27_000 }],
        })
      );
    });
    const header = document.querySelector('.tool-activity-header');
    assert.equal(header.querySelector('.tool-activity-title b').textContent, 'Explore 3 questions');
    // Every other piece of the header (the screen-reader status, the elapsed
    // time) is a flex item of its own: copied, each became a line.
    const extras = [...header.querySelectorAll('.sr-only, .tool-working')];
    assert.equal(extras.length, 2, 'status and elapsed time are both present');
    const unselectable = (element) =>
      [...style.sheet.cssRules].some(
        (rule) =>
          rule.selectorText &&
          element.matches(rule.selectorText) &&
          rule.style.getPropertyValue('user-select') === 'none'
      );
    for (const element of extras) assert.equal(unselectable(element), true, element.className);
    assert.equal(unselectable(header.querySelector('.tool-activity-title b')), false);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});
