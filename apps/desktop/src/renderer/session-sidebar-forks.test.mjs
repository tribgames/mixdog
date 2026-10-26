import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { commitForkGroupOrder, groupForkRows, visibleForkRootIds } from './session-fork-groups.ts';

const row = (id, extra = {}) => ({
  id,
  title: 'Shared title',
  preview: '',
  updatedAt: 1,
  activityAt: 1,
  messageCount: 1,
  cwd: '',
  classification: 'task',
  projectPath: null,
  ...extra,
});

const shape = (groups) => groups.map((group) => [group.session.id, group.forks.map((fork) => fork.id)]);

test('forks group under their root, including a fork of a fork, numbered by creation time', () => {
  const rows = [
    row('c', { inheritedFromSessionId: 'b', createdAt: 30 }),
    row('b', { inheritedFromSessionId: 'a', createdAt: 20 }),
    row('d', { inheritedFromSessionId: 'a', createdAt: 10 }),
    row('a', { createdAt: 1 }),
  ];
  assert.deepEqual(shape(groupForkRows(rows)), [['a', ['d', 'b', 'c']]]);
});

test('a fork whose original is not in the list is a normal row', () => {
  const rows = [row('f', { inheritedFromSessionId: 'gone' }), row('x')];
  assert.deepEqual(shape(groupForkRows(rows)), [
    ['f', []],
    ['x', []],
  ]);
  // A chain stops at the first ancestor that is missing: b is the root of c.
  assert.deepEqual(
    shape(groupForkRows([row('c', { inheritedFromSessionId: 'b' }), row('b', { inheritedFromSessionId: 'gone' })])),
    [['b', ['c']]]
  );
});

test('a group sits where its most recently active member does', () => {
  // Activity-descending list: the fork is the newest, then an unrelated row, then the original.
  const rows = [row('fork', { inheritedFromSessionId: 'orig' }), row('other'), row('orig')];
  assert.deepEqual(shape(groupForkRows(rows)), [
    ['orig', ['fork']],
    ['other', []],
  ]);
});

test('a cyclic inheritance chain does not loop', () => {
  const rows = [row('a', { inheritedFromSessionId: 'b' }), row('b', { inheritedFromSessionId: 'a' })];
  assert.equal(
    groupForkRows(rows).reduce((count, group) => count + 1 + group.forks.length, 0),
    2
  );
});

test('the visible limit never cuts a group', () => {
  const rows = [
    row('a'),
    row('f1', { inheritedFromSessionId: 'a', createdAt: 2 }),
    row('f2', { inheritedFromSessionId: 'a', createdAt: 3 }),
    row('z'),
  ];
  assert.deepEqual(shape(groupForkRows(rows, 1)), [['a', ['f1', 'f2']]]);
  assert.deepEqual(shape(groupForkRows(rows, 4)), [
    ['a', ['f1', 'f2']],
    ['z', []],
  ]);
});

async function mount(t, sessions, handlers = {}, storage = {}) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const render = (list) =>
    act(async () =>
      root.render(
        React.createElement(SessionSidebar, {
          open: true,
          sessions: list,
          sessionsReady: true,
          selection: { kind: 'new' },
          onNewTask() {},
          onNewStudio() {},
          onResumeSession() {},
          async onRenameSession() {},
          async onArchiveSession() {},
          async onFavoriteSession() {},
          async onDeleteSession() {},
          ...handlers,
        })
      )
    );
  await render(sessions);
  return { document, window, root, render };
}

const ids = (document) =>
  [...document.querySelectorAll('section[aria-label="Recent sessions"] .session-row[data-session-id]')].map(
    (el) => el.dataset.sessionId
  );
const title = (document, id) => document.querySelector(`[data-session-id="${id}"] .session-row-copy b`).textContent;

const forked = () => [
  row('orig', { activityAt: 10, createdAt: 1 }),
  row('f2', { activityAt: 30, createdAt: 3, inheritedFromSessionId: 'f1' }),
  row('f1', { activityAt: 20, createdAt: 2, inheritedFromSessionId: 'orig' }),
  row('solo', { title: 'Solo', activityAt: 25 }),
];

test('the sidebar shows the original with a fork icon and chevron, then numbered forks', async (t) => {
  const opened = [];
  const { document } = await mount(t, forked(), { onResumeSession: (id) => opened.push(id) });
  // f2 is the newest member, so the group leads; solo follows.
  assert.deepEqual(ids(document), ['orig', 'f1', 'f2', 'solo']);
  assert.equal(title(document, 'orig'), 'Shared title');
  assert.equal(title(document, 'f1'), 'Shared title (fork 1)');
  assert.equal(title(document, 'f2'), 'Shared title (fork 2)');
  const root = document.querySelector('[data-session-id="orig"]');
  const main = root.querySelector('.session-row-main');
  const [icon, copy, toggle] = [...main.children];
  assert.equal(icon.getAttribute('data-fork'), 'root');
  assert.ok(copy.classList.contains('session-row-copy'));
  assert.ok(toggle.classList.contains('session-row-fork-toggle'));
  assert.equal(toggle.textContent, '', 'the chevron carries no count or badge');
  assert.equal(document.querySelector('[data-session-id="f1"] [data-fork="child"]') !== null, true);
  assert.equal(document.querySelector('[data-session-id="solo"] .session-row-fork-toggle'), null);
  // The title still opens the session; the chevron does not.
  await act(async () => toggle.click());
  assert.deepEqual(opened, []);
  await act(async () => root.querySelector('.session-row-main').click());
  assert.deepEqual(opened, ['orig']);
});

test('collapsing hides only the forks and the choice persists per original', async (t) => {
  const { document, window } = await mount(t, forked());
  const toggle = () => document.querySelector('[data-session-id="orig"] .session-row-fork-toggle');
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  await act(async () => toggle().click());
  assert.deepEqual(ids(document), ['orig', 'solo']);
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog:session-sidebar-fork-open')), { orig: false });
  await act(async () => toggle().click());
  assert.deepEqual(ids(document), ['orig', 'f1', 'f2', 'solo']);
});

test('a stored collapsed choice is restored on mount', async (t) => {
  const { document } = await mount(t, forked(), {}, { 'mixdog:session-sidebar-fork-open': '{"orig":false}' });
  assert.deepEqual(ids(document), ['orig', 'solo']);
});

test('forks of an archived original render as normal rows', async (t) => {
  const { document } = await mount(t, [
    row('orig', { archived: true }),
    row('f1', { inheritedFromSessionId: 'orig', createdAt: 2 }),
  ]);
  assert.deepEqual(ids(document), ['f1']);
  assert.equal(title(document, 'f1'), 'Shared title');
  assert.equal(document.querySelector('.session-row-fork-toggle'), null);
});

const dragRow = (document, window, source, target) => {
  const dataTransfer = { setData() {}, getData: () => '', setDragImage() {}, effectAllowed: '', dropEffect: '' };
  const fire = (el, type) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer, clientY: 10, clientX: 0 });
    el.dispatchEvent(event);
    return event;
  };
  const from = document.querySelector(`[data-session-id="${source}"]`);
  const to = document.querySelector(`[data-session-id="${target}"]`);
  return {
    dragover: () => fire(to, 'dragover'),
    start: () => fire(from, 'dragstart'),
    drop: () => fire(to, 'drop'),
    end: () => fire(from, 'dragend'),
  };
};

test('dragging an original after another session moves its whole group there', async (t) => {
  const { document, window } = await mount(t, forked());
  assert.deepEqual(ids(document), ['orig', 'f1', 'f2', 'solo']);
  const drag = dragRow(document, window, 'orig', 'solo');
  await act(async () => {
    drag.start();
    drag.dragover();
  });
  // The drop line moves below the group's last visible row, not between the original and its forks.
  assert.equal(document.querySelector('[data-session-id="orig"]').getAttribute('data-drop-position'), null);
  await act(async () => {
    drag.drop();
    drag.end();
  });
  assert.deepEqual(ids(document), ['solo', 'orig', 'f1', 'f2']);
});

test('dragging another session before a group lands above the whole group', async (t) => {
  const { document, window } = await mount(t, forked());
  const drag = dragRow(document, window, 'solo', 'orig');
  const target = document.querySelector('[data-session-id="orig"]');
  target.getBoundingClientRect = () => ({ top: 100, bottom: 130, height: 30, left: 0, right: 0 });
  await act(async () => {
    drag.start();
    drag.dragover();
    drag.drop();
    drag.end();
  });
  assert.deepEqual(ids(document), ['solo', 'orig', 'f1', 'f2']);
});

test('a fork is not a drop target of its own', async (t) => {
  const { document, window } = await mount(t, forked());
  const drag = dragRow(document, window, 'solo', 'f1');
  let over;
  await act(async () => {
    drag.start();
    over = drag.dragover();
    drag.drop();
    drag.end();
  });
  assert.equal(over.defaultPrevented, false);
  assert.deepEqual(ids(document), ['orig', 'f1', 'f2', 'solo']);
});

test('reordering counts whole groups: the head never ends inside a group', () => {
  const rows = [
    row('a'),
    row('f1', { inheritedFromSessionId: 'a', createdAt: 2 }),
    row('f2', { inheritedFromSessionId: 'a', createdAt: 3 }),
    row('b'),
    row('c'),
  ];
  // A 2-row head covers the 3-row group; b and c are paged out, not draggable.
  assert.deepEqual(visibleForkRootIds(rows, 2), ['a']);
  assert.deepEqual(visibleForkRootIds(rows, 4), ['a', 'b']);
  assert.deepEqual(visibleForkRootIds(rows, 0), []);
});

test('committing a group order keeps forks after their original and paged-out groups below', () => {
  const rows = [
    row('f1', { inheritedFromSessionId: 'a', createdAt: 2 }),
    row('b'),
    row('a', { createdAt: 1 }),
    row('c'),
    row('d'),
  ];
  // Rendered groups: a(f1), b, c, d. Visible head of 4 rows covers a, b, c; d is paged out.
  assert.deepEqual(visibleForkRootIds(rows, 4), ['a', 'b', 'c']);
  assert.deepEqual(commitForkGroupOrder(rows, 4, ['b', 'c', 'a']), ['b', 'c', 'a', 'f1', 'd']);
  // The committed order renders as dropped: the group follows its original's position.
  const ordered = ['b', 'c', 'a', 'f1', 'd'].map((id) => rows.find((entry) => entry.id === id));
  assert.deepEqual(shape(groupForkRows(ordered)), [
    ['b', []],
    ['c', []],
    ['a', ['f1']],
    ['d', []],
  ]);
});
