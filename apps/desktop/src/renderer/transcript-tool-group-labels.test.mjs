// Tool-group labels and grouping, run on the shapes of real sessions (the Lead
// desktop session and its workers): what a group's summary line says while it
// runs and once it is finished, in English and Korean, and which calls share
// one group.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import i18n from './i18n';
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
const CASES = [
  [
    'explore reads like every other group',
    [finished('explore', EXPLORE)],
    ['Explore 3 questions', 'Explored 3 questions'],
    ['질문 3개 탐색', '질문 3개 탐색함'],
  ],
  [
    'git and shell commands',
    [finished('git', { command: ['git status', 'git diff'] }), finished('shell', { command: 'npm test' })],
    ['Run 2 Git commands, Run 1 command', 'Ran 2 Git commands, Ran 1 command'],
    ['Git 커맨드 2회 실행, 커맨드 1회 실행', 'Git 커맨드 2회 실행함, 커맨드 1회 실행함'],
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
    ['에이전트 2회 호출, 작업 대기, 작업 상태 확인', '에이전트 2회 호출함, 작업 대기함, 작업 상태 확인함'],
  ],
  [
    'stopping an agent is not calling it',
    [finished('agent', { type: 'cancel', task_id: 'task_agent_1' })],
    ['Agent cancellations', 'Agent cancellations'],
    ['에이전트 취소', '에이전트 취소'],
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
    ['브라우저 작업 2회, 컴퓨터 조작 2회', '브라우저 작업 2회, 컴퓨터 조작 2회'],
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
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  dom.window.Element.prototype.getAnimations = () => [];
  dom.window.Document.prototype.getAnimations = () => [];
  const previous = new Map(
    [
      'window',
      'document',
      'navigator',
      'IS_REACT_ACT_ENVIRONMENT',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback) => setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id) => clearTimeout(id) });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    window: dom.window,
    root: createRoot(dom.window.document.getElementById('root')),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
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
