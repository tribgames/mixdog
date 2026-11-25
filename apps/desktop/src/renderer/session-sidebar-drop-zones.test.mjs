import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const A = { path: 'C:\\Work\\Alpha', name: 'Alpha', alias: null };

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

async function mount(t, sessions = [row('star', { favorite: true }), row('free')]) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const favorited = [];
  const moves = [];
  await act(async () =>
    root.render(
      React.createElement(SessionSidebar, {
        open: true,
        sessions,
        sessionsReady: true,
        projects: [A],
        selection: { kind: 'new' },
        onNewTask() {},
        onNewStudio() {},
        onResumeSession() {},
        async onRenameSession() {},
        async onArchiveSession() {},
        async onFavoriteSession(id, favorite) {
          favorited.push([id, favorite]);
        },
        async onDeleteSession() {},
        async onMoveSessionToProject(id, path) {
          moves.push([id, path]);
        },
      })
    )
  );
  return { document, window, favorited, moves };
}

const dataTransfer = () => ({ setData() {}, getData: () => '', setDragImage() {}, effectAllowed: '', dropEffect: '' });
const fire = (window, target, type, init = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: dataTransfer(), clientX: 5, clientY: 5, relatedTarget: null, ...init });
  target.dispatchEvent(event);
  return event;
};
const rect = (top, bottom) => ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top });
const recentRow = (document, id) => document.querySelector(`.recent-session-list [data-session-id="${id}"]`);
const favoriteRow = (document, id) => document.querySelector(`.favorite-session-list [data-session-id="${id}"]`);
const projectRow = (document, id) => document.querySelector(`.project-group [data-session-id="${id}"]`);
const recentSection = (document) => document.querySelector('#recent-session-list').closest('section');

test('a favorite dragged onto Recent is unfavorited', async (t) => {
  const { document, window, favorited, moves } = await mount(t);
  const recent = recentSection(document);
  await act(async () => void fire(window, favoriteRow(document, 'star'), 'dragstart'));
  const over = fire(window, recent, 'dragover');
  await act(async () => void 0);
  assert.equal(over.defaultPrevented, true, 'Recent accepts the drop');
  assert.equal(recent.dataset.sessionDrop, 'true');

  await act(async () => void fire(window, recent, 'drop'));
  assert.deepEqual(favorited, [['star', false]]);
  assert.deepEqual(moves, []);
  assert.equal(recent.dataset.sessionDrop, undefined);
});

test('a session dragged out of a project folder onto Recent leaves the project', async (t) => {
  const { document, window, favorited, moves } = await mount(t, [row('inA', { cwd: 'C:\\Work\\Alpha' })]);
  const recent = recentSection(document);
  await act(async () => void fire(window, projectRow(document, 'inA'), 'dragstart'));
  await act(async () => void fire(window, recent, 'dragover'));
  assert.equal(recent.dataset.sessionDrop, 'true');
  await act(async () => void fire(window, recent, 'drop'));
  assert.deepEqual(moves, [['inA', '']]);
  assert.deepEqual(favorited, []);
  assert.equal(recent.dataset.sessionDrop, undefined);
});

test('a favorite in a project dragged from Favorites onto an empty Recent is unfavorited and stays in its project', async (t) => {
  const { document, window, favorited, moves } = await mount(t, [
    row('starA', { cwd: 'C:\\Work\\Alpha', favorite: true }),
  ]);
  const recent = recentSection(document);
  assert.equal(recent.querySelectorAll('[data-session-id]').length, 0, 'Recent lists no session');
  await act(async () => void fire(window, favoriteRow(document, 'starA'), 'dragstart'));
  await act(async () => void fire(window, recent, 'dragover'));
  assert.equal(recent.dataset.sessionDrop, 'true');
  await act(async () => void fire(window, recent, 'drop'));
  assert.deepEqual(favorited, [['starA', false]]);
  assert.deepEqual(moves, []);
});

test('a session dragged from Recent is no Recent target and leaves the gap to its neighbours', async (t) => {
  const { document, window, favorited, moves } = await mount(t, [
    row('star', { favorite: true }),
    row('free'),
    row('inA', { cwd: 'C:\\Work\\Alpha' }),
  ]);
  const scroller = document.querySelector('.session-sidebar-sessions > .session-sidebar-scroll');
  const favorites = document.querySelector('.sidebar-favorites');
  const recent = recentSection(document);
  favorites.getBoundingClientRect = () => rect(100, 200);
  recent.getBoundingClientRect = () => rect(212, 400);

  // A plain session, and a project session dragged from its Recent copy.
  for (const id of ['free', 'inA']) {
    await act(async () => void fire(window, recentRow(document, id), 'dragstart'));
    const over = fire(window, recent, 'dragover');
    await act(async () => void 0);
    assert.equal(over.defaultPrevented, false, `${id}: Recent accepts no drop`);
    assert.equal(recent.dataset.sessionDrop, undefined);
    // The gap nearer Recent still reaches Favorites.
    await act(async () => void fire(window, scroller, 'dragover', { clientY: 208 }));
    assert.equal(favorites.dataset.sessionDrop, 'true');
    assert.equal(recent.dataset.sessionDrop, undefined);
    await act(async () => void fire(window, recent, 'drop'));
    await act(async () => void fire(window, recentRow(document, id), 'dragend'));
  }
  assert.deepEqual(moves, []);
  assert.deepEqual(favorited, []);

  // A favorite's drag: the same gap resolves to Recent.
  await act(async () => void fire(window, favoriteRow(document, 'star'), 'dragstart'));
  await act(async () => void fire(window, scroller, 'dragover', { clientY: 208 }));
  assert.equal(recent.dataset.sessionDrop, 'true');
  assert.equal(favorites.dataset.sessionDrop, undefined);
  await act(async () => void fire(window, scroller, 'drop', { clientY: 208 }));
  assert.deepEqual(favorited, [['star', false]]);
});

test('the scroller padding strips and the gap under Favorites still target Favorites', async (t) => {
  const { document, window, favorited } = await mount(t);
  const scroller = document.querySelector('.session-sidebar-sessions > .session-sidebar-scroll');
  const favorites = document.querySelector('.sidebar-favorites');
  favorites.getBoundingClientRect = () => rect(100, 200);

  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));
  // Pointer in the scroller's side padding strip, level with Favorites.
  const strip = fire(window, scroller, 'dragover', { clientX: 2, clientY: 150 });
  await act(async () => void 0);
  assert.equal(strip.defaultPrevented, true, 'the strip accepts the drop');
  assert.equal(favorites.dataset.sessionDrop, 'true');

  // Pointer in the gap below Favorites: still inside the reach, no flicker.
  await act(async () => void fire(window, scroller, 'dragover', { clientY: 215 }));
  assert.equal(favorites.dataset.sessionDrop, 'true');

  await act(async () => void fire(window, scroller, 'drop', { clientY: 215 }));
  assert.deepEqual(favorited, [['free', true]]);
  assert.equal(favorites.dataset.sessionDrop, undefined);

  // Far from every target the scroller accepts nothing and keeps no outline.
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragend'));
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));
  await act(async () => void fire(window, scroller, 'dragover', { clientY: 150 }));
  assert.equal(favorites.dataset.sessionDrop, 'true');
  const far = fire(window, scroller, 'dragover', { clientY: 400 });
  await act(async () => void 0);
  assert.equal(far.defaultPrevented, false);
  assert.equal(favorites.dataset.sessionDrop, undefined);
});

test('the gap reach accepts exactly 20 px and rejects 20.5 px', async (t) => {
  const { document, window } = await mount(t);
  const scroller = document.querySelector('.session-sidebar-sessions > .session-sidebar-scroll');
  const favorites = document.querySelector('.sidebar-favorites');
  favorites.getBoundingClientRect = () => rect(100, 200);
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));

  const at = fire(window, scroller, 'dragover', { clientY: 220 });
  await act(async () => void 0);
  assert.equal(at.defaultPrevented, true);
  assert.equal(favorites.dataset.sessionDrop, 'true');

  const past = fire(window, scroller, 'dragover', { clientY: 220.5 });
  await act(async () => void 0);
  assert.equal(past.defaultPrevented, false);
  assert.equal(favorites.dataset.sessionDrop, undefined);
});

test('a gap highlight clears when the drag leaves the scroller', async (t) => {
  const { document, window } = await mount(t);
  const scroller = document.querySelector('.session-sidebar-sessions > .session-sidebar-scroll');
  const favorites = document.querySelector('.sidebar-favorites');
  favorites.getBoundingClientRect = () => rect(100, 200);
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));
  await act(async () => void fire(window, scroller, 'dragover', { clientY: 210 }));
  assert.equal(favorites.dataset.sessionDrop, 'true');

  // Moving between elements inside the scroller keeps the outline.
  await act(async () => void fire(window, scroller, 'dragleave', { relatedTarget: favorites }));
  assert.equal(favorites.dataset.sessionDrop, 'true');

  // Leaving to outside the scroller (or the window: null) clears it.
  await act(async () => void fire(window, scroller, 'dragleave', { relatedTarget: document.body }));
  assert.equal(favorites.dataset.sessionDrop, undefined);

  await act(async () => void fire(window, scroller, 'dragover', { clientY: 210 }));
  assert.equal(favorites.dataset.sessionDrop, 'true');
  await act(async () => void fire(window, scroller, 'dragleave', { relatedTarget: null }));
  assert.equal(favorites.dataset.sessionDrop, undefined);
});

test('the Favorites outline clears when the pointer is over a non-target without a dragleave', async (t) => {
  const { document, window } = await mount(t);
  const favorites = document.querySelector('.sidebar-favorites');
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));
  await act(async () => void fire(window, favorites, 'dragover'));
  assert.equal(favorites.dataset.sessionDrop, 'true');
  // Chromium can skip the dragleave (pointer left fast, content scrolled under it).
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragover'));
  assert.equal(favorites.dataset.sessionDrop, undefined);
});

test('a session-move drag near the sidebar edge auto-scrolls the list', async (t) => {
  const { document, window } = await mount(t);
  const scroller = document.querySelector('.session-sidebar-sessions > .session-sidebar-scroll');
  scroller.getBoundingClientRect = () => rect(100, 500);
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 });

  await act(async () => void fire(window, recentRow(document, 'free'), 'dragstart'));
  await act(async () => void fire(window, document.body, 'dragover', { clientX: 50, clientY: 495 }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(scroller.scrollTop > 0, 'bottom edge scrolls down');
  await act(async () => void fire(window, recentRow(document, 'free'), 'dragend'));
});
