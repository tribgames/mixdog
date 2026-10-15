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

async function mount(t, sessions, handlers = {}) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const moves = [];
  await act(async () =>
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
      })
    )
  );
  return { document, window, moves };
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
