import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'sessionStorage'],
  globals: {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
test.after(() => restore());
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { changedFilePaths, fileKey, mentionedFilePaths, mentionItems, verifiedMentionedFiles } = await import(
  './composer-mention-rows.ts'
);
const { Composer } = await import('./Composer.tsx');

const PROJECT = 'C:/project/app';
const OTHER = 'C:/other';

test('mention candidates: @path in user messages, newest first, `\\` read as `/`, no punctuation guesswork', () => {
  const messages = [
    { id: '1', text: 'older @src/old.ts and mail me@example.com, ask @alice, see @docs/ and @docs\\' },
    { id: '2', text: 'check (@docs/guide.md), then @src/old.ts. Also @C:/project/app/lib/a.ts and @C:/elsewhere/b.ts' },
    { id: '3', text: 'and @../outside.ts @./local.ts @LICENSE @src\\Makefile `@Skipped`' },
  ];
  assert.deepEqual(mentionedFilePaths(messages, PROJECT, false), [
    'src/Makefile',
    'LICENSE',
    'local.ts',
    'lib/a.ts',
    'src/old.ts',
    'docs/guide.md',
    'alice',
  ]);
});

test('mention candidates dedupe on one key: case-insensitive on Windows only', () => {
  const messages = [{ id: '1', text: '@src/a.ts then @SRC/A.ts' }];
  assert.deepEqual(mentionedFilePaths(messages, PROJECT, true), ['SRC/A.ts']);
  assert.deepEqual(mentionedFilePaths(messages, PROJECT, false), ['SRC/A.ts', 'src/a.ts']);
  assert.equal(fileKey('SRC/A.ts', true), 'src/a.ts');
  assert.equal(fileKey('SRC/A.ts', false), 'SRC/A.ts');
});

test('every candidate is checked; missing ones and folders are dropped', async () => {
  const candidates = Array.from({ length: 12 }, (_, index) => `f${index}.ts`);
  const asked = [];
  const verified = await verifiedMentionedFiles(candidates, async (path) => {
    asked.push(path);
    if (path === 'f1.ts' || path === 'f3.ts') throw new Error('ENOENT');
    return { directory: path === 'f5.ts' };
  });
  assert.deepEqual(asked, candidates);
  assert.deepEqual(verified, ['f0.ts', 'f2.ts', 'f4.ts', 'f6.ts', 'f7.ts', 'f8.ts', 'f9.ts', 'f10.ts', 'f11.ts']);
});

test('changed files: git paths are root-relative, made project-relative; outside and deleted ones are dropped', () => {
  const status = {
    repository: true,
    root: 'C:\\project',
    files: [
      { path: 'app/src/changed.ts', index: ' ', worktree: 'M' },
      { path: 'app/new.txt', index: '?', worktree: '?', untracked: true },
      { path: 'app/gone.ts', index: ' ', worktree: 'D' },
      { path: 'app/staged-gone.ts', index: 'D', worktree: ' ' },
      { path: 'outside/skip.ts', index: ' ', worktree: 'M' },
      { path: 'application/skip.ts', index: ' ', worktree: 'M' },
    ],
  };
  assert.deepEqual(changedFilePaths(status, PROJECT), ['src/changed.ts', 'new.txt']);
  assert.deepEqual(changedFilePaths({ ...status, repository: false }, PROJECT), []);
  assert.deepEqual(changedFilePaths(null, PROJECT), []);
});

test('palette rows: Recent first (max 5, deduped, ranked by the query), then results not already shown', () => {
  const mentioned = ['docs/guide.md', 'src/old.ts'];
  const changed = ['src/old.ts', 'src/changed.ts', 'new.txt', 'c1.ts', 'c2.ts'];
  const summary = (items) => items.map((item) => `${item.group}:${item.source ?? '-'}:${item.path}`);
  assert.deepEqual(
    summary(mentionItems({ mentioned, changed, results: ['apps/', 'new.txt'], query: '', windows: false })),
    [
      'recent:mentioned:docs/guide.md',
      'recent:mentioned:src/old.ts',
      'recent:changed:src/changed.ts',
      'recent:changed:new.txt',
      'recent:changed:c1.ts',
      'project:-:apps/',
    ]
  );
  const typed = mentionItems({
    mentioned,
    changed,
    results: ['src/changed.ts', 'lib/chart.ts'],
    query: 'ch',
    windows: false,
  });
  assert.deepEqual(summary(typed), ['recent:changed:src/changed.ts', 'project:-:lib/chart.ts']);
  assert.deepEqual(typed[0].match, { tier: 1, start: 4, end: 6 });
  assert.deepEqual(
    summary(
      mentionItems({ mentioned: ['deep/er/old.ts'], changed: ['old.ts'], results: [], query: 'old', windows: false })
    ),
    ['recent:changed:old.ts', 'recent:mentioned:deep/er/old.ts']
  );
});

test('mention, Changed and search rows dedupe on the same key: SRC/A.ts, src/a.ts and Src/a.ts are one file on Windows', () => {
  const input = { mentioned: ['SRC/A.ts'], changed: ['src/a.ts'], results: ['Src/a.ts', 'src/b.ts'], query: '' };
  assert.deepEqual(
    mentionItems({ ...input, windows: true }).map((item) => item.path),
    ['SRC/A.ts', 'src/b.ts']
  );
  assert.deepEqual(
    mentionItems({ ...input, windows: false }).map((item) => item.path),
    ['SRC/A.ts', 'src/a.ts', 'Src/a.ts', 'src/b.ts']
  );
});

let scopeCounter = 0;
/** A mounted Composer whose palette searches, git reads and stats are all
 *  driven by the test. */
async function mountComposer(t, { projectScope = PROJECT, userMessages = [], api = {} } = {}) {
  const pending = new Map();
  const gitResolvers = new Map();
  window.mixdogDesktop = {
    invokeCapability: async (request) =>
      request.capability === 'getVoiceStatus' ? { value: { installed: false } } : { value: { skills: [] } },
    readCapabilities: async () => [{ ok: true, value: { skills: [] } }],
    searchProjectFiles: (project, query) => new Promise((resolve) => pending.set(`${project}|${query}`, resolve)),
    rendererDiagnostic() {},
    ...api,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const scope = `recent-test-${scopeCounter++}`;
  const render = (overrides = {}) =>
    act(async () =>
      root.render(
        React.createElement(Composer, {
          turnBusy: false,
          commandBusy: false,
          transitioning: false,
          focusRequest: 0,
          historyScope: scope,
          identityScope: scope,
          recoveryScope: scope,
          projectScope,
          sessionId: scope,
          hasConversation: true,
          provider: 'openai-oauth',
          model: 'test-model',
          effort: 'medium',
          fast: false,
          fastCapable: false,
          paneActive: true,
          userMessages,
          submit: async () => true,
          abort: async () => {},
          invokeResult: (action) => action(),
          applySnapshot() {},
          onNewTask() {},
          onResumeSession() {},
          onOpenSessions() {},
          onOpenProjects() {},
          onOpenSettings() {},
          onOpenCommandSurface() {},
          dropTargetRef: { current: null },
          ...overrides,
        })
      )
    );
  await render();
  const input = host.querySelector('textarea');
  const palette = () => document.getElementById('composer-mention-palette');
  const all = (selector) => Array.from(palette()?.querySelectorAll(selector) || []);
  return {
    input,
    render,
    pending,
    gitResolvers,
    palette,
    rows: () => all('[role="option"]').map((node) => node.title),
    headers: () => all('header').map((node) => node.textContent),
    chips: () => all('.mention-chip').map((node) => node.textContent),
    hits: (selector) => all(`${selector} b`).map((node) => node.textContent),
    selected: () => all('[aria-selected="true"]').map((node) => node.title),
    active: () => input.getAttribute('aria-activedescendant'),
    settle: () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 150))),
    answer: (project, query, paths) => act(async () => pending.get(`${project}|${query}`)(paths)),
    git: (cwd, status) => act(async () => gitResolvers.get(cwd)(status)),
    type: async (value) => {
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    key: (name) =>
      act(async () =>
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
      ),
  };
}

const gitStatusOf = (root, ...paths) => ({
  repository: true,
  root,
  files: paths.map((path) => ({ path, index: ' ', worktree: 'M' })),
});

test('@ palette: Recent group with chips, filtered and highlighted, one index across both groups', async (t) => {
  const gitCalls = [];
  const statCalls = [];
  let gitStatus = async () => ({
    repository: true,
    root: 'C:/project',
    files: [
      { path: 'app/src/old.ts', index: ' ', worktree: 'M' },
      { path: 'app/src/changed.ts', index: ' ', worktree: 'M' },
      { path: 'app/new.txt', index: '?', worktree: '?', untracked: true },
      { path: 'app/c1.ts', index: ' ', worktree: 'M' },
      { path: 'app/c2.ts', index: ' ', worktree: 'M' },
      { path: 'outside/skip.ts', index: ' ', worktree: 'M' },
    ],
  });
  const view = await mountComposer(t, {
    userMessages: [
      { id: 'm1', text: 'look at @src/old.ts' },
      { id: 'm2', text: 'and @docs/guide.md and @Makefile and @alice' },
    ],
    api: {
      gitStatus: (cwd, options) => {
        gitCalls.push([cwd, options]);
        return gitStatus();
      },
      statProjectFile: async (project, path) => {
        statCalls.push([project, path]);
        if (path === 'alice') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { mtimeMs: 0, size: 0 };
      },
    },
  });

  // `@` alone: five Recent rows (mentioned newest first, then changed), then the root entries.
  await view.type('@');
  await view.settle();
  await view.answer(PROJECT, '', ['apps/', 'new.txt']);
  assert.deepEqual(view.headers(), ['Recent work', 'Project']);
  assert.deepEqual(view.rows(), ['Makefile', 'docs/guide.md', 'src/old.ts', 'src/changed.ts', 'new.txt', 'apps/']);
  assert.deepEqual(view.chips(), ['Mentioned', 'Mentioned', 'Mentioned', 'Changed', 'Changed']);
  assert.equal(view.active(), 'composer-mention-option-0');
  assert.deepEqual(gitCalls, [[PROJECT, { skipLineStats: true }]]);
  assert.deepEqual(statCalls.map(([, path]) => path).sort(), ['Makefile', 'alice', 'docs/guide.md', 'src/old.ts']);
  assert.ok(statCalls.every(([project]) => project === PROJECT));

  // A query filters and highlights Recent, then lists results not already shown.
  await view.type('@ch');
  await view.settle();
  await view.answer(PROJECT, 'ch', ['src/changed.ts', 'lib/chart.ts']);
  assert.deepEqual(view.rows(), ['src/changed.ts', 'lib/chart.ts']);
  assert.deepEqual(view.headers(), ['Recent work', 'Project']);
  assert.deepEqual(view.chips(), ['Changed']);
  assert.deepEqual(view.hits('#composer-mention-option-0'), ['ch']);
  assert.deepEqual(view.hits('#composer-mention-option-1'), ['ch']);
  assert.equal(view.palette().querySelector('#composer-mention-option-1 strong b').textContent, 'ch');
  assert.equal(gitCalls.length, 1, 'git is read once per opening, not per keystroke');
  assert.equal(statCalls.length, 4, 'files are checked once per opening, not per keystroke');

  // Arrow keys run across both groups; Enter inserts the selected row.
  await view.key('ArrowDown');
  assert.equal(view.active(), 'composer-mention-option-1');
  assert.deepEqual(view.selected(), ['lib/chart.ts']);
  await view.key('ArrowUp');
  assert.equal(view.active(), 'composer-mention-option-0');
  await view.key('ArrowUp');
  assert.equal(view.active(), 'composer-mention-option-1', 'wraps over the groups');
  await view.key('Enter');
  assert.equal(view.input.value, '@lib/chart.ts ');

  // A new opening reads again; a failed git read leaves only the mentioned rows.
  gitStatus = async () => {
    throw new Error('not a repository');
  };
  await view.type('');
  await view.type('@');
  await view.settle();
  await view.answer(PROJECT, '', ['apps/']);
  assert.equal(gitCalls.length, 2);
  assert.equal(statCalls.length, 8);
  assert.deepEqual(view.rows(), ['Makefile', 'docs/guide.md', 'src/old.ts', 'apps/']);
  assert.deepEqual(view.chips(), ['Mentioned', 'Mentioned', 'Mentioned']);

  // Clicking a Recent row inserts it.
  await act(async () => view.palette().querySelector('#composer-mention-option-1').click());
  assert.equal(view.input.value, '@docs/guide.md ');
});

test('@ palette: a real file is found among many stale mentions; a folder named without a slash is not a file', async (t) => {
  const stale = Array.from({ length: 10 }, (_, index) => `@gone${index}.ts`).join(' ');
  const view = await mountComposer(t, {
    userMessages: [
      { id: 'm1', text: 'first @real.ts' },
      { id: 'm2', text: `then ${stale} and @src` },
    ],
    api: {
      statProjectFile: async (_project, path) => {
        if (path.startsWith('gone')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { mtimeMs: 0, size: 0, directory: path === 'src' };
      },
    },
  });
  await view.type('@');
  await view.settle();
  await view.answer(PROJECT, '', ['apps/']);
  assert.deepEqual(view.rows(), ['real.ts', 'apps/']);
  assert.deepEqual(view.chips(), ['Mentioned']);
});

test('@ palette: search rows from another project never show or click while the new project searches', async (t) => {
  const view = await mountComposer(t);
  await view.type('@a');
  await view.settle();
  await view.answer(PROJECT, 'a', ['apps/', 'a.ts']);
  assert.deepEqual(view.rows(), ['apps/', 'a.ts']);

  const submitted = [];
  await view.render({ projectScope: OTHER, submit: async (content) => submitted.push(content) });
  await view.settle();
  assert.deepEqual(view.rows(), [], 'the first project rows are gone');
  assert.equal(view.palette().querySelector('p[role="status"]').textContent, 'Searching project files…');
  assert.equal(view.palette().querySelector('[role="option"]'), null, 'nothing left to click');
  // Enter while the new project searches neither inserts nor sends the half-typed mention.
  await view.key('Enter');
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  assert.deepEqual(submitted, []);
  assert.equal(view.input.value, '@a');

  // Within one project the previous query's rows still stay while the next one searches.
  await view.answer(OTHER, 'a', ['b-app/']);
  assert.deepEqual(view.rows(), ['b-app/']);
  await view.type('@ap');
  await view.settle();
  assert.deepEqual(view.rows(), ['b-app/']);
});

test('@ palette: Changed rows read for another project never show while the new project is read', async (t) => {
  const view = await mountComposer(t, {
    api: { gitStatus: (cwd) => new Promise((resolve) => view.gitResolvers.set(cwd, resolve)) },
  });
  await view.type('@');
  await view.settle();
  await view.answer(PROJECT, '', ['apps/']);
  await view.git(PROJECT, gitStatusOf('C:/project', 'app/c1.ts', 'app/c2.ts'));
  assert.deepEqual(view.rows(), ['c1.ts', 'c2.ts', 'apps/']);

  await view.render({ projectScope: OTHER });
  await view.settle();
  await view.answer(OTHER, '', ['apps/']);
  assert.deepEqual(view.rows(), ['apps/'], 'the first project Changed rows are gone while the other one is read');
  assert.deepEqual(view.chips(), []);
  await view.key('Enter');
  assert.equal(view.input.value, '@apps/ ', 'only the other project rows can be picked');

  await view.type('@');
  await view.settle();
  await view.answer(OTHER, '', ['apps/']);
  await view.git(OTHER, gitStatusOf('C:/other', 'b1.ts'));
  assert.deepEqual(view.rows(), ['b1.ts', 'apps/']);
  assert.deepEqual(view.chips(), ['Changed']);
});

test('@ palette: the highlighted row stays inside the list when it shrinks', async (t) => {
  const view = await mountComposer(t, {
    api: { gitStatus: (cwd) => new Promise((resolve) => view.gitResolvers.set(cwd, resolve)) },
  });
  await view.type('@');
  await view.settle();
  await view.answer(PROJECT, '', ['r1/', 'r2/', 'r3/']);
  await view.git(PROJECT, gitStatusOf('C:/project', 'app/c1.ts', 'app/c2.ts', 'app/c3.ts'));
  assert.equal(view.rows().length, 6);
  await view.key('End');
  assert.equal(view.active(), 'composer-mention-option-5');

  // The first project's rows go; the other project answers with three rows.
  await view.render({ projectScope: OTHER });
  await view.settle();
  assert.deepEqual(view.rows(), []);
  await view.answer(OTHER, '', ['r1/', 'r2/', 'r3/']);
  assert.deepEqual(view.rows(), ['r1/', 'r2/', 'r3/']);
  assert.equal(view.active(), 'composer-mention-option-2');
  assert.deepEqual(view.selected(), ['r3/']);
  await view.key('ArrowUp');
  assert.equal(view.active(), 'composer-mention-option-1', 'the keyboard moves from the clamped row');
  assert.deepEqual(view.selected(), ['r2/']);

  // The list grows again: the row stays where the user had it.
  await view.git(OTHER, gitStatusOf('C:/other', 'b1.ts', 'b2.ts'));
  assert.equal(view.rows().length, 5);
  assert.equal(view.active(), 'composer-mention-option-1');
});
