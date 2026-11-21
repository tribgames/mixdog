import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';

import i18n from './i18n';
import { installTestDom } from './test-support/test-dom.mjs';
import { projectSettledTranscriptRows } from './transcript-rows.ts';
import { desktopToolActivitySummary } from './transcript-tool-core.ts';
import { ToolActivityGroup } from './TranscriptView.tsx';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);

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
    ['3개 항목 탐색', '3개 항목 탐색함'],
  ],
  [
    'git and shell commands',
    [finished('git', { command: ['git status', 'git diff'] }), finished('shell', { command: 'npm test' })],
    ['Run 2 Git commands, Run 1 command', 'Ran 2 Git commands, Ran 1 command'],
    ['Git 명령 2회 실행, 명령 1회 실행', 'Git 명령 2회 실행함, 명령 1회 실행함'],
  ],
  [
    'a viewed image and a read resource are files read, one phrase',
    [
      finished('read', { file_path: 'a.ts' }, 'r1'),
      finished('view_image', { path: 'a.png' }),
      finished('read_mcp_resource', { uri: 'mcp://x' }),
    ],
    ['Read 3 files', 'Read 3 files'],
    ['파일 3개 읽기', '파일 3개 읽음'],
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
    ['에이전트 2회 호출, 작업 대기, 작업 상태 확인', '에이전트 2회 호출함, 작업 대기함, 작업 상태 확인함'],
  ],
  [
    'stopping an agent is not calling it',
    [finished('agent', { type: 'cancel', task_id: 'task_agent_1' })],
    ['Agent cancellations', 'Agent cancellations'],
    ['에이전트 취소', '에이전트 취소함'],
  ],
  [
    'closing a finished agent ends it, it does not cancel it',
    [finished('agent', { type: 'close', tag: 'worker-a' })],
    ['Ended agents', 'Ended agents'],
    ['에이전트 종료', '에이전트 종료함'],
  ],
  [
    'git worktree operations',
    [finished('git', { action: 'worktree', worktree_action: 'enter', worktree: 'x' })],
    ['Worktree management', 'Worktree management'],
    ['워크트리 관리', '워크트리 관리함'],
  ],
  [
    'session create is not a project check',
    [finished('session', { action: 'create', project: 'mixdog', title: 'UI 테스트', worktree: { mode: 'branch' } })],
    ['Session creation', 'Session creation'],
    ['세션 생성', '세션 생성함'],
  ],
  [
    'session send, rename and status',
    [
      finished('session', { action: 'send', session_id: 'sess_a', prompt: 'hi' }),
      finished('session', { action: 'rename', title: 'T' }),
      finished('session', { action: 'status' }),
    ],
    ['Session message, Session management, Session status', 'Session message, Session management, Session status'],
    ['세션 메시지, 세션 관리, 세션 상태', '세션 메시지 보냄, 세션 관리함, 세션 상태 확인함'],
  ],
  [
    'a unit without a count phrase shows its count as ×N, in Korean N회 like the other labels',
    [
      finished('session', { action: 'create', title: 'a' }, 's1'),
      finished('session', { action: 'create', title: 'b' }, 's2'),
    ],
    ['Session creation ×2', 'Session creation ×2'],
    ['세션 생성 2회', '세션 생성 2회 함'],
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
    ['워크트리 관리 4회', '워크트리 관리 4회 함'],
  ],
  [
    'directory listings count the same way running and finished',
    [finished('list', { path: ['apps', 'src'] })],
    ['List 2 directories', 'Listed 2 directories'],
    ['폴더 목록 2회 조회', '폴더 목록 2회 조회함'],
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
    ['브라우저 작업 2회, 컴퓨터 조작 2회', '브라우저 2회 조작함, 컴퓨터 2회 조작함'],
  ],
  [
    'a failed edit, glob, git command or search says it failed, as a command does',
    [
      failed('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e'),
      failed('glob', { pattern: ['*.ts', '*.tsx', '*.css', '*.md', '*.json', '*.rs'] }, 'g'),
      failed('git', { command: 'git push' }, 'p'),
      failed('grep', { pattern: 'x' }, 's'),
    ],
    [
      'Edit 1 file, Find files for 6 patterns, Run Git command, Search code',
      'File editing failed, File lookup failed, Git command failed, Content search failed',
    ],
    ['파일 1개 수정, 패턴 6개로 파일 찾기, Git 명령 실행, 코드 검색', '파일 수정 실패, 파일 찾기 실패, Git 명령 실패, 내용 검색 실패'],
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
    ['파일 2개 수정, 파일 읽기', '파일 1개 수정함, 파일 읽음, 1회 실패'],
  ],
  [
    'a stopped change did not happen',
    [stopped('tidy', { action: 'fix', apply: true }, 't')],
    ['Tidy code', 'Code Tidy stopped'],
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
    ['계획 업데이트', '계획 업데이트함'],
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
    ['목표, 반응, 사용자에게 넘기기, 터미널 명령', '목표, 반응함, 사용자에게 넘김, 터미널 명령 실행함'],
  ],
  [
    'closing a session and listing worktrees are not a project check',
    [finished('session', { action: 'close' }), finished('session', { action: 'list-worktrees' })],
    ['Session management, Worktree management', 'Session management, Worktree management'],
    ['세션 관리, 워크트리 관리', '세션 관리함, 워크트리 관리함'],
  ],
  [
    'a stopped edit did not change its file, even without an error flag',
    [halted('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e')],
    ['Edit 1 file', 'File editing stopped'],
    ['파일 1개 수정', '파일 수정 중지됨'],
  ],
  [
    'a cancel action that did its work is not a stop',
    [answered('task', { action: 'cancel', task_id: 't1' }, 'Cancelled')],
    ['Cancel task', 'Cancelled task'],
    ['작업 취소', '작업 취소함'],
  ],
  [
    'a failure and a stop of the same unit are both said',
    [failed('edit', { file_path: 'a.css', old_string: 'x', new_string: 'y' }, 'e1'), halted('edit', { file_path: 'b.css', old_string: 'x', new_string: 'y' }, 'e2')],
    ['Edit 2 files', 'File editing failed, File editing stopped'],
    ['파일 2개 수정', '파일 수정 실패, 파일 수정 중지됨'],
  ],
  [
    'a failed read is not counted as read',
    [finished('read', { file_path: 'a.ts' }, 'r1'), failed('read', { file_path: 'b.ts' }, 'r2')],
    ['Read 2 files', 'Read file, 1 failed'],
    ['파일 2개 읽기', '파일 읽음, 1회 실패'],
  ],
  [
    'a stopped read is not counted as read',
    [finished('read', { file_path: 'a.ts' }, 'r1'), halted('read', { file_path: 'b.ts' }, 'r2')],
    ['Read 2 files', 'Read file, 1 stopped'],
    ['파일 2개 읽기', '파일 읽음, 1회 중지됨'],
  ],
  [
    'a stopped fetch fetched no page',
    [finished('web_fetch', { url: 'https://a.example' }, 'f1'), halted('web_fetch', { url: 'https://b.example' }, 'f2')],
    ['Fetch 2 pages', 'Fetched page, 1 stopped'],
    ['웹페이지 2개 가져오기', '웹페이지 가져옴, 1회 중지됨'],
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
    ['명령 2회 실행', '명령 1회 실행함, 1회 중지됨'],
  ],
  [
    'a command that ran to a failing exit ran; one that never started did not',
    [
      finished('shell', { command: 'a' }, 's1'),
      { ...finished('shell', { command: 'b' }, 's2'), result: 'boom', exitErrorCount: 1 },
      { ...failed('shell', { command: 'c' }, 's3'), callErrorCount: 1 },
    ],
    ['Run 3 commands', 'Ran 2 commands, 2 failed'],
    ['명령 3회 실행', '명령 2회 실행함, 2회 실패'],
  ],
  [
    'an interrupted cancel action did not cancel',
    [answered('task', { action: 'cancel', task_id: 't1' }, 'Interrupted by process restart')],
    ['Cancel task', 'Task cancellation stopped'],
    ['작업 취소', '작업 취소 중지됨'],
  ],
  [
    'a file whose name opens like an empty-result message is a file found',
    [answered('glob', { pattern: '*.md' }, 'No files.md')],
    ['Find files', 'Found files'],
    ['파일 찾기', '파일 찾음'],
  ],
  [
    'a path lookup and a symbol search that matched nothing found none',
    [
      answered('find', { query: 'zzz' }, '(no fuzzy match for "zzz")'),
      answered('code_graph', { mode: 'find_symbol', symbols: 'zzz' }, '(no symbol matches in cwd=C:/repo)\ngraph: nodes=12'),
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
    ['파일 2개 수정', '파일 2개 수정함'],
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
    ['계획 보기, 정리 검사, 정리 확인', '계획 확인함, 정리 검사함, 정리 확인함'],
  ],
  [
    'a settled web search reads in the past tense',
    [finished('web_search', { query: ['a', 'b', 'c'] })],
    ['Search web 3 times', 'Searched web 3 times'],
    ['웹 검색 3회', '웹 3회 검색함'],
  ],
];

for (const [name, items, en, ko] of CASES) {
  test(`group label: ${name}`, async () => {
    const lines = await summaries(items);
    assert.deepEqual(lines.en, en, 'English [running, finished]');
    assert.deepEqual(lines.ko, ko, 'Korean [running, finished]');
  });
}

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
