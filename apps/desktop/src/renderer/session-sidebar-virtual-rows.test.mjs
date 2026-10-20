import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const COUNT = 320;

function catalog() {
  return Array.from({ length: COUNT }, (_, i) => ({
    id: `s-${i}`,
    title: `Session ${i}`,
    preview: '',
    updatedAt: COUNT - i,
    activityAt: COUNT - i,
    messageCount: 1,
    cwd: '',
    classification: 'task',
    projectPath: null,
    working: false,
  }));
}

/** Row pitch the list assumes before it can measure (jsdom has no layout). */
const PITCH = 32;
/** The deep selection reveals Recent down to s-100; s-101.. stay paged out. */
const SELECTED = 's-100';

/** The sidebar over a 320-session catalog, Recent revealed to SELECTED, with a
 *  scroller whose scrollTop/clientHeight the test drives. */
async function mountSidebar(t, handlers = {}) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const props = {
    open: true,
    sessions: catalog(),
    sessionsReady: true,
    selection: { kind: 'session', id: SELECTED },
    onNewTask() {},
    onNewStudio() {},
    onResumeSession() {},
    async onRenameSession() {},
    async onArchiveSession() {},
    async onFavoriteSession() {},
    async onDeleteSession() {},
    ...handlers,
  };
  const render = (extra = {}) =>
    act(async () => root.render(React.createElement(SessionSidebar, { ...props, ...extra })));
  await render();
  const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value) => {
      top = value;
    },
  });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => window.innerHeight });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const scrollToRow = async (index) => {
    top = index * PITCH;
    await act(async () => scroller.dispatchEvent(new window.Event('scroll')));
    await settle();
  };
  const row = (id) => document.querySelector(`.recent-session-list .session-row[data-session-id="${id}"]`);
  const mountedIds = () =>
    [...document.querySelectorAll('.recent-session-list .session-row[data-session-id]')].map(
      (element) => element.dataset.sessionId
    );
  return { document, window, render, settle, scrollToRow, row, mountedIds, scrollTop: () => top };
}

const key = (window, target, init) =>
  act(async () => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    key.last = event;
  });

test('the origin row of a session menu stays mounted while the menu is open and after', async (t) => {
  const list = await mountSidebar(t);
  const { document, window } = list;
  const rightClick = (id) =>
    act(async () =>
      list
        .row(id)
        .dispatchEvent(
          new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
        )
    );
  const menuItem = (label) =>
    [...document.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent === label);
  // A pointer menu: the row never takes focus, only the menu pin holds it.
  await rightClick('s-5');
  assert.ok(menuItem('Rename'), 'the menu is open');
  // Scrolling dismisses the menu and moves the window far past the origin.
  await list.scrollToRow(80);
  assert.equal(list.row('s-6'), null, 'the window moved away from the origin');
  assert.ok(list.row('s-5'), 'the origin row stays mounted');

  // A keyboard menu (Shift+F10) hands focus back to its origin row on close,
  // wherever the window is by then.
  await list.scrollToRow(0);
  const main = list.row('s-7').querySelector('.session-row-main');
  await act(async () => main.focus());
  await key(window, main, { key: 'F10', shiftKey: true });
  await list.settle();
  assert.ok(menuItem('Rename'));
  await list.scrollToRow(80);
  assert.ok(main.isConnected, 'the origin row is the same mounted element');
  assert.equal(document.activeElement, main, 'focus returned to the origin row');

  // Rename from the menu runs after the menu has closed and still finds its row.
  await rightClick('s-7');
  await act(async () => menuItem('Rename').click());
  await list.settle();
  assert.ok(list.row('s-7')?.classList.contains('editing'), 'Rename from the menu opens on its row');
});

test('Tab and Shift+Tab cross the window edge onto the next logical row', async (t) => {
  const list = await mountSidebar(t);
  const { document, window } = list;
  const ids = list.mountedIds();
  const lastMounted = ids.filter((id) => Number(id.slice(2)) < 100).at(-1);
  const edge = Number(lastMounted.slice(2));
  const next = `s-${edge + 1}`;
  assert.equal(list.row(next), null, 'the next row is outside the window');
  // From the last stop of the edge row (its archive action), Tab mounts and
  // focuses the next row's first stop.
  const archive = list.row(lastMounted).querySelector('.session-row-archive');
  await act(async () => archive.focus());
  await key(window, archive, { key: 'Tab' });
  assert.equal(key.last.defaultPrevented, true);
  assert.equal(document.activeElement, list.row(next)?.querySelector('.session-row-main'));
  assert.ok(list.scrollTop() > 0, 'the list scrolls the newly focused row into view');

  // Scroll the window well past both rows: the focused row stays (pinned),
  // its previous neighbour is released.
  await list.scrollToRow(edge + 40);
  assert.ok(list.row(next), 'the focused row stays mounted');
  assert.equal(list.row(lastMounted), null);
  // Shift+Tab from its first stop mounts the previous row and lands on its
  // last stop (a nested action button).
  await key(window, document.activeElement, { key: 'Tab', shiftKey: true });
  assert.equal(key.last.defaultPrevented, true);
  assert.equal(document.activeElement, list.row(lastMounted)?.querySelector('.session-row-archive'));
  assert.equal(list.scrollTop(), edge * PITCH, 'the previous row scrolls into view');
  // Inside a row and between mounted neighbours, Tab stays native.
  await key(window, document.activeElement, { key: 'Tab', shiftKey: true });
  assert.equal(key.last.defaultPrevented, false);
});

test('an inline rename near the window edge survives scrolling, IME composition included', async (t) => {
  const renamed = [];
  const list = await mountSidebar(t, {
    async onRenameSession(id, title) {
      renamed.push([id, title]);
    },
  });
  const { window } = list;
  const edgeRow = list
    .mountedIds()
    .filter((id) => Number(id.slice(2)) < 100)
    .at(-1);
  await act(async () =>
    list
      .row(edgeRow)
      .querySelector('.session-row-main')
      .dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  );
  const input = () => list.row(edgeRow)?.querySelector('.session-title-input');
  assert.equal(input()?.disabled, false, 'the rename editor is open');
  await act(async () => {
    input().dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
    input().value = '세션 이름';
    input().dispatchEvent(new window.InputEvent('input', { bubbles: true, isComposing: true }));
  });
  await list.scrollToRow(90);
  assert.ok(list.row(edgeRow)?.classList.contains('editing'), 'the edited row stays mounted mid-composition');
  // Enter that confirms the composition is not a commit.
  await key(window, input(), { key: 'Enter', isComposing: true });
  assert.deepEqual(renamed, []);
  await act(async () => input().dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
  await key(window, input(), { key: 'Enter' });
  assert.deepEqual(renamed, [[edgeRow, '세션 이름']]);
});

test('dragging a row across the window edge keeps its source and reorders the full list', async (t) => {
  const list = await mountSidebar(t);
  const { window } = list;
  const dataTransfer = { setData() {}, getData: () => '', setDragImage() {}, effectAllowed: '', dropEffect: '' };
  const fire = (element, type) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer, clientY: 10, clientX: 0 });
    element.dispatchEvent(event);
  };
  await act(async () => fire(list.row('s-3'), 'dragstart'));
  await list.scrollToRow(80);
  assert.ok(list.row('s-3'), 'the drag source stays mounted');
  assert.equal(list.row('s-3').dataset.dragging, 'true');
  assert.equal(list.row('s-4'), null, 'its neighbours left the window');
  assert.ok(list.row('s-90'), 'the drop target mounted');
  // The pointer sits on the target's upper half: the drop lands before it.
  list.row('s-90').getBoundingClientRect = () => ({ top: 0, bottom: 32, height: 32, left: 0, right: 200 });
  await act(async () => {
    fire(list.row('s-90'), 'dragover');
    fire(list.row('s-90'), 'drop');
    fire(list.row('s-3'), 'dragend');
  });
  const stored = JSON.parse(window.localStorage.getItem('mixdog:session-sidebar-session-custom-order')).recent;
  const all = catalog().map((session) => session.id);
  const expected = all.filter((id) => id !== 's-3');
  expected.splice(expected.indexOf('s-90'), 0, 's-3');
  assert.deepEqual(stored, expected, 'dropped before s-90; the paged-out tail keeps its order');
});

test('an unread or status change on an unmounted row shows once it mounts', async (t) => {
  const list = await mountSidebar(t);
  assert.equal(list.row('s-80'), null);
  await list.render({ unreadSessionIds: new Set(['s-80']), workingSessionIds: new Set(['s-81']) });
  assert.equal(list.row('s-80'), null);
  await list.scrollToRow(70);
  assert.ok(list.row('s-80')?.querySelector('.session-row-unread-dot'), 'the unread dot shows');
  assert.ok(list.row('s-81')?.classList.contains('working'), 'the running status shows');
});

test('a long Recent list mounts only the rows near the viewport', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'CustomEvent'],
  });
  const { SessionSidebar } = await import('./session-sidebar.tsx');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const sessions = catalog();
  const props = {
    open: true,
    sessions,
    sessionsReady: true,
    selection: { kind: 'new' },
    onNewTask() {},
    onResumeSession() {},
    async onRenameSession() {},
    async onArchiveSession() {},
    async onFavoriteSession() {},
    async onDeleteSession() {},
  };
  const render = async (extra = {}) =>
    act(async () => root.render(React.createElement(SessionSidebar, { ...props, ...extra })));
  const rows = () => [...document.querySelectorAll('.recent-session-list .session-row[data-session-id]')];
  const scroller = () => document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
  try {
    // A selection deep in the catalog reveals the list down to it, but the
    // window stays bounded and the selected row itself stays mounted.
    const deep = sessions[COUNT - 5].id;
    await render({ selection: { kind: 'session', id: deep } });
    const mounted = rows();
    assert.ok(mounted.length < 80, `bounded window, got ${mounted.length}`);
    assert.ok(
      mounted.some((row) => row.dataset.sessionId === deep),
      'the selected row is mounted'
    );
    assert.ok(
      mounted.some((row) => row.dataset.sessionId === sessions[0].id),
      'the top of the list is mounted'
    );
    assert.ok(document.querySelector('.recent-session-list .session-list-spacer'));

    // Scrolling moves the window: rows far below mount, the top ones leave.
    let top = 0;
    Object.defineProperty(scroller(), 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value;
      },
    });
    top = 150 * 32;
    await act(async () => scroller().dispatchEvent(new dom.window.Event('scroll')));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const scrolled = rows().map((row) => row.dataset.sessionId);
    assert.ok(scrolled.includes('s-150'), 'rows at the new offset are mounted');
    assert.ok(!scrolled.includes('s-0'), 'rows far above are released');
    assert.ok(scrolled.length < 80);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
