import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const A = { path: 'C:\\Work\\Alpha', name: 'Alpha', alias: null };
const SUB = { path: 'C:\\Work\\Alpha\\packages\\sub', name: 'Sub', alias: null };
const B = { path: 'C:\\Work\\Beta', name: 'Beta', alias: null };

const row = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  preview: '',
  updatedAt: 1,
  activityAt: 10,
  messageCount: 1,
  cwd: 'D:\\elsewhere',
  classification: 'task',
  projectPath: null,
  working: false,
  ...extra,
});

const membership = (groups) => Object.fromEntries(groups.map((g) => [g.name, g.rows.map((r) => r.id).sort()]));

test('sessions group by containing folder, worktree project, normalized path and deepest project', async (t) => {
  installTestDom(t);
  const { groupProjectSessions } = await import('./session-sidebar-sections.tsx');
  const groups = groupProjectSessions(
    [A, SUB, B],
    [
      row('exact', { cwd: 'C:\\Work\\Alpha' }),
      row('inside', { cwd: 'C:\\Work\\Alpha\\src\\deep' }),
      row('deepest', { cwd: 'C:\\Work\\Alpha\\packages\\sub\\lib' }),
      row('normalized', { cwd: 'c:/work/ALPHA/' }),
      row('lookalike', { cwd: 'C:\\Work\\AlphaBeta' }),
      row('worktree', {
        cwd: 'D:\\worktrees\\feature',
        projectPath: 'D:\\worktrees\\feature',
        workspace: {
          projectPath: 'C:\\Work\\Beta',
          repoCommonDir: null,
          cwd: 'D:\\worktrees\\feature',
          worktreeId: 'w1',
        },
      }),
      row('unrelated'),
    ]
  );
  assert.deepEqual(membership(groups), {
    Alpha: ['exact', 'inside', 'normalized'],
    Sub: ['deepest'],
    Beta: ['worktree'],
  });
});

test('a legacy stored sidebar assignment is ignored: membership follows the working folder', async (t) => {
  installTestDom(t);
  const { groupProjectSessions } = await import('./session-sidebar-sections.tsx');
  const groups = groupProjectSessions(
    [A, B],
    [
      row('moved', { cwd: 'C:\\Work\\Alpha\\x', projectAssignment: 'c:/work/beta' }),
      row('removed', { cwd: 'C:\\Work\\Alpha\\x', projectAssignment: '' }),
      row('adopted', { projectAssignment: 'C:\\Work\\Alpha' }),
    ]
  );
  assert.deepEqual(membership(groups), { Alpha: ['moved', 'removed'], Beta: [] });
});

async function mount(t, sessions, handlers = {}, before = () => {}) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  before(window);
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const moves = [];
  const render = (extra = {}) =>
    act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions,
          sessionsReady: true,
          projects: [A, B],
          selection: { kind: 'new' },
          onNewTask() {},
          onNewStudio() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession() {},
          async onFavoriteSession() {},
          async onDeleteSession() {},
          async onMoveSessionToProject(id, path) {
            moves.push([id, path]);
          },
          ...handlers,
          ...extra,
        })
      )
    );
  await render();
  return { document, window, moves, rerender: render };
}

const dataTransfer = () => ({ setData() {}, getData: () => '', setDragImage() {}, effectAllowed: '', dropEffect: '' });
const fire = (window, target, type, init = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: dataTransfer(), clientX: 5, clientY: 5, relatedTarget: null, ...init });
  target.dispatchEvent(event);
  return event;
};
const group = (document, name) =>
  [...document.querySelectorAll('.project-group')].find((el) => el.textContent.includes(name));
const recentRow = (document, id) => document.querySelector(`.recent-session-list [data-session-id="${id}"]`);

test('dragging a session outlines only valid project folders and drops move it', async (t) => {
  const { document, window, moves } = await mount(t, [row('free'), row('inA', { cwd: 'C:\\Work\\Alpha' })]);
  const alpha = group(document, 'Alpha');
  const beta = group(document, 'Beta');

  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));
  await act(async () => void fire(window, alpha, 'dragover'));
  assert.equal(alpha.dataset.sessionDrop, 'true');
  assert.equal(beta.dataset.sessionDrop, undefined);
  await act(async () => void fire(window, alpha, 'dragleave'));
  assert.equal(alpha.dataset.sessionDrop, undefined, 'leaving the folder clears the outline');

  await act(async () => void fire(window, beta, 'dragover'));
  assert.equal(beta.dataset.sessionDrop, 'true');
  await act(async () => void fire(window, beta, 'drop'));
  assert.deepEqual(moves, [['free', B.path]]);
  assert.equal(beta.dataset.sessionDrop, undefined);
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragend'));

  // A session already inside a folder gets no highlight or drop on that folder.
  await act(async () => void fire(window, recentRow(document, 'inA'), 'dragstart'));
  await act(async () => void fire(window, alpha, 'dragover'));
  assert.equal(alpha.dataset.sessionDrop, undefined);
  await act(async () => void fire(window, alpha, 'drop'));
  assert.equal(moves.length, 1);
});

test('reordering folders shows the insertion state, never the session outline', async (t) => {
  const { document, window } = await mount(t, [row('free')]);
  const alpha = group(document, 'Alpha');
  const beta = group(document, 'Beta');
  await act(async () => void fire(window, beta.querySelector('.project-folder'), 'dragstart'));
  assert.equal(beta.dataset.reordering, 'true');
  const header = alpha.querySelector('.project-folder');
  header.getBoundingClientRect = () => ({ top: 0, height: 20, bottom: 20, left: 0, right: 10, width: 10 });
  await act(async () => void fire(window, alpha, 'dragover', { clientY: 2 }));
  assert.equal(alpha.dataset.dropPosition, 'before');
  assert.equal(alpha.dataset.sessionDrop, undefined);
});

test('the session menu moves to another project (excluding the current one) and removes from a project', async (t) => {
  const added = [];
  const { document, window, moves } = await mount(t, [row('inA', { cwd: 'C:\\Work\\Alpha' })], {
    onAddProject(onAdded) {
      added.push(onAdded);
    },
  });
  const openMenu = async () => {
    await act(async () => void fire(window, recentRow(document, 'inA'), 'contextmenu'));
  };
  const action = (id) => document.querySelector(`.dock-scm-context-menu [data-action-id="${id}"]`);
  await openMenu();
  assert.ok(action('remove-from-project'));
  await act(async () => action('move-to-project').click());
  assert.equal(action('move-to-c:/work/alpha'), null, 'the current project is not a destination');
  assert.ok(action('move-to-c:/work/beta'));
  await act(async () => action('move-to-new-project').click());
  assert.equal(added.length, 1);
  added[0]('C:\\Work\\New');
  assert.deepEqual(moves, [['inA', 'C:\\Work\\New']]);

  await openMenu();
  await act(async () => action('remove-from-project').click());
  assert.deepEqual(moves.at(-1), ['inA', '']);
});

const wsRow = (id, activityAt, worktreeId, branch, extra = {}) =>
  row(id, {
    activityAt,
    cwd: worktreeId ? `D:\\wt\\${worktreeId}` : 'C:\\Work\\Alpha',
    workspace: {
      projectPath: 'C:\\Work\\Alpha',
      cwd: worktreeId ? `D:\\wt\\${worktreeId}` : 'C:\\Work\\Alpha',
      worktreeId,
      branch,
      mergeTarget: worktreeId ? 'main' : null,
    },
    ...extra,
  });

test('a project with worktree sessions splits into folder-first subgroups labelled by branch', async (t) => {
  installTestDom(t);
  const { groupProjectSessions } = await import('./session-sidebar-sections.tsx');
  const [alpha] = groupProjectSessions(
    [A],
    [
      wsRow('w-new', 50, 'wt2', 'feat/new'),
      wsRow('m1', 40, null, 'main'),
      wsRow('w-old', 30, 'wt1', null),
      wsRow('w-old2', 20, 'wt1', 'feat/foo'),
      wsRow('m2', 10, null, 'main'),
    ]
  );
  assert.deepEqual(
    alpha.subgroups.map((s) => [s.label, s.rows.map((r) => r.id)]),
    [
      ['main', ['m1', 'm2']],
      ['feat/new', ['w-new']],
      ['feat/foo', ['w-old', 'w-old2']],
    ]
  );
  assert.equal(alpha.rows.length, 5);
});

test('a worktree without a branch is labelled by its id; a project of only folder sessions has no subgroups', async (t) => {
  installTestDom(t);
  const { groupProjectSessions } = await import('./session-sidebar-sections.tsx');
  const [withWt] = groupProjectSessions([A], [wsRow('w', 5, 'wt9', null)]);
  assert.deepEqual(
    withWt.subgroups.map((s) => s.label),
    ['wt9']
  );
  const [plain] = groupProjectSessions([A], [wsRow('m1', 5, null, 'main'), row('legacy', { cwd: 'C:\\Work\\Alpha' })]);
  assert.equal(plain.subgroups, undefined);
});

test('a session switching to a worktree moves subgroup on regroup', async (t) => {
  installTestDom(t);
  const { groupProjectSessions } = await import('./session-sidebar-sections.tsx');
  const before = groupProjectSessions([A], [wsRow('s', 5, null, 'main')])[0];
  const after = groupProjectSessions([A], [wsRow('s', 6, 'wt1', 'feat/x'), wsRow('o', 4, null, 'main')])[0];
  assert.equal(before.subgroups, undefined);
  assert.deepEqual(
    after.subgroups.map((s) => [s.label, s.rows.map((r) => r.id)]),
    [
      ['main', ['o']],
      ['feat/x', ['s']],
    ]
  );
});

const ALPHA_KEY = 'c:/work/alpha';
const subKey = (worktreeId) => `${ALPHA_KEY}\u0001${worktreeId}`;
const subgroupEl = (document, worktreeId) =>
  document.querySelector(
    `.sidebar-projects .project-subgroup${worktreeId ? `[data-worktree-id="${worktreeId}"]` : ':not([data-worktree-id])'}`
  );
const subIds = (document, worktreeId) =>
  [...subgroupEl(document, worktreeId).querySelectorAll('[data-session-id]')].map((el) => el.dataset.sessionId);
const mountAlpha = (t, sessions, handlers = {}, before) => mount(t, sessions, { projects: [A], ...handlers }, before);

test('selecting a session inside a collapsed subgroup expands it', async (t) => {
  const { document, rerender } = await mountAlpha(
    t,
    [wsRow('m1', 30, null, 'main'), wsRow('w1', 20, 'wt1', 'feat/x')],
    {},
    (window) =>
      window.localStorage.setItem('mixdog:session-sidebar-project-open', JSON.stringify({ [subKey('wt1')]: false }))
  );
  const toggle = () => subgroupEl(document, 'wt1').querySelector('.project-subgroup-toggle');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(subIds(document, 'wt1'), []);
  await rerender({ selection: { kind: 'session', id: 'w1' } });
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(subIds(document, 'wt1'), ['w1']);
});

test('a subgroup collapses on its own and pages with More', async (t) => {
  const worktreeRows = Array.from({ length: 7 }, (_, i) => wsRow(`w${i}`, 100 - i, 'wt1', 'feat/x'));
  const { document, window } = await mountAlpha(t, [wsRow('m1', 200, null, 'main'), ...worktreeRows]);
  assert.deepEqual(subIds(document, 'wt1'), ['w0', 'w1', 'w2', 'w3', 'w4']);
  const more = subgroupEl(document, 'wt1').querySelector('.project-group-more');
  await act(async () => more.click());
  assert.equal(subIds(document, 'wt1').length, 7);
  assert.equal(subgroupEl(document, 'wt1').querySelector('.project-group-more'), null);
  assert.equal(
    subgroupEl(document, 'wt1').querySelector('.project-subgroup-count'),
    null,
    'an open subgroup shows no count'
  );
  await act(async () => subgroupEl(document, 'wt1').querySelector('.project-subgroup-toggle').click());
  assert.deepEqual(subIds(document, 'wt1'), []);
  assert.equal(subgroupEl(document, 'wt1').querySelector('.project-subgroup-count').textContent, '7');
  assert.ok(
    subgroupEl(document, 'wt1').querySelector('.project-subgroup-icon'),
    'a worktree subgroup carries its icon'
  );
  assert.equal(subgroupEl(document, 'wt1').querySelector('.project-subgroup-prefix').textContent, 'feat/');
  assert.deepEqual(subIds(document, ''), ['m1'], 'the folder subgroup stays open');
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog:session-sidebar-project-open'))[subKey('wt1')], false);
});

test('subgroups start from the saved project order and persist their own reorder', async (t) => {
  const storedOrders = () => JSON.parse(window.localStorage.getItem('mixdog:session-sidebar-session-custom-order'));
  let window;
  const folder = [wsRow('f1', 30, null, 'main'), wsRow('f2', 20, null, 'main'), wsRow('f3', 10, null, 'main')];
  const mounted = await mountAlpha(t, [...folder, wsRow('w1', 5, 'wt1', 'feat/x')], {}, (win) => {
    window = win;
    win.localStorage.setItem(
      'mixdog:session-sidebar-session-order-mode',
      JSON.stringify({ sessions: 'custom', favorites: 'custom' })
    );
    win.localStorage.setItem(
      'mixdog:session-sidebar-session-custom-order',
      JSON.stringify({ [`project:${ALPHA_KEY}`]: ['f3', 'f1', 'w1', 'f2'] })
    );
  });
  const { document } = mounted;
  // Migration: the folder subgroup keeps the user's project order, filtered to its sessions.
  assert.deepEqual(subIds(document, ''), ['f3', 'f1', 'f2']);
  assert.deepEqual(storedOrders()[`project:${subKey('')}`], ['f3', 'f1', 'f2']);

  const rowOf = (id) => subgroupEl(document, '').querySelector(`[data-session-id="${id}"]`);
  rowOf('f3').getBoundingClientRect = () => ({ top: 0, height: 20, bottom: 20, left: 0, right: 10, width: 10 });
  await act(async () => void fire(window, rowOf('f2'), 'dragstart'));
  await act(async () => void fire(window, rowOf('f3'), 'dragover', { clientY: 2 }));
  await act(async () => void fire(window, rowOf('f3'), 'drop'));
  assert.deepEqual(subIds(document, ''), ['f2', 'f3', 'f1']);
  assert.deepEqual(storedOrders()[`project:${subKey('')}`], ['f2', 'f3', 'f1']);
  assert.deepEqual(subIds(document, 'wt1'), ['w1']);
});
