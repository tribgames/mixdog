import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const ROW_PX = 40;
const VIEWPORT_PX = 300;

const session = (id) => ({
  id,
  title: id,
  preview: '',
  updatedAt: 1,
  activityAt: 1,
  messageCount: 1,
  cwd: '',
  classification: 'task',
  projectPath: null,
  working: false,
});

/** The Sessions scroller with a laid-out list: rows ROW_PX tall under a
 *  VIEWPORT_PX viewport, and a scrollTop the "browser" clamps to the content. */
async function mountList(t) {
  const { root, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  const { useSidebarListScroll } = await import('./session-sidebar-scroll.ts');
  let scroller = null;
  let stored = 0;
  const rowEls = () => [...scroller.querySelectorAll('.session-row[data-session-id]')];
  const maxScroll = () => Math.max(0, rowEls().length * ROW_PX - VIEWPORT_PX);
  const nativeRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function rect() {
    if (this === scroller) return { top: 0, bottom: VIEWPORT_PX, left: 0, right: 200, height: VIEWPORT_PX };
    const index = scroller ? rowEls().indexOf(this) : -1;
    if (index < 0) return nativeRect.call(this);
    const top = index * ROW_PX - scroller.scrollTop;
    return { top, bottom: top + ROW_PX, left: 0, right: 200, height: ROW_PX };
  };
  function List({ rows, favorites = [] }) {
    const scrollerRef = React.useRef(null);
    const { recentScrollerRef, handleRecentScroll } = useSidebarListScroll({
      scrollerRef,
      open: true,
      panelActive: false,
      selection: { kind: 'new' },
      rows,
      visibleRecentRowCount: rows.length,
      revealMoreRecentRows() {},
      recentOpen: true,
      archivedOpen: false,
      archivedRows: [],
      archivedRowLimit: 0,
      setArchivedRowLimit() {},
      allRows: rows,
      automationsOpen: false,
      collapsedAutomations: new Set(),
      projectOpen: {},
      projectGroups: [],
      projectRowLimits: new Map(),
      projectsOpen: false,
      sectionOrder: { orderedIds: [] },
    });
    const attach = (element) => {
      recentScrollerRef.current = element;
      if (!element || element === scroller) return;
      scroller = element;
      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => Math.min(stored, maxScroll()),
        set: (value) => {
          stored = Math.max(0, Math.min(value, maxScroll()));
        },
      });
      Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => rowEls().length * ROW_PX });
      Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => VIEWPORT_PX });
    };
    const list = (key, items) =>
      React.createElement(
        'div',
        { key },
        items.map((row) =>
          React.createElement('div', { key: row.id, className: 'session-row', 'data-session-id': row.id })
        )
      );
    return React.createElement('div', { ref: attach, onScroll: handleRecentScroll }, [
      list('favorites', favorites),
      list('recent', rows),
    ]);
  }
  return {
    render: (rows, favorites) => act(async () => root.render(React.createElement(List, { rows, favorites }))),
    /** The browser moved the list; `report` also delivers its scroll event. */
    scrollTo: async (top, report) => {
      scroller.scrollTop = top;
      if (report) await act(async () => scroller.dispatchEvent(new window.Event('scroll')));
    },
    scrollTop: () => scroller.scrollTop,
  };
}

const ids = (from, to) => Array.from({ length: to - from }, (_, index) => session(`s${from + index}`));

test('a catalog update keeps a scroll whose scroll event has not arrived yet', async (t) => {
  const list = await mountList(t);
  const rows = ids(0, 40);
  await list.render(rows);
  await list.scrollTo(200, true);
  // WebKit order: the drag moved the list, and a live update commits before
  // that move's scroll event. The list stays where the drag left it.
  await list.scrollTo(600, false);
  await list.render([...rows]);
  assert.equal(list.scrollTop(), 600);
  // A row inserted above the reader still shifts the list by exactly its height.
  await list.scrollTo(800, false);
  await list.render([session('fresh'), ...rows]);
  assert.equal(list.scrollTop(), 800 + ROW_PX);
});

test('a reported scroll still compensates a shift above the reader', async (t) => {
  const list = await mountList(t);
  const rows = ids(0, 40);
  await list.render(rows);
  await list.scrollTo(200, true);
  await list.render([session('fresh-a'), session('fresh-b'), ...rows]);
  assert.equal(list.scrollTop(), 200 + 2 * ROW_PX);
});

test('rows removed above a list at its end keep the reader on the same row', async (t) => {
  const list = await mountList(t);
  const rows = ids(0, 30);
  await list.render(rows);
  // At the end (max 900): removing two rows clamps scrollTop to 820, which is
  // exactly where the anchored row now sits; it must not read as a scroll.
  await list.scrollTo(900, true);
  await list.render(rows.slice(2));
  assert.equal(list.scrollTop(), 820);
});

test('a session listed twice anchors on the copy the reader sees', async (t) => {
  const list = await mountList(t);
  const rows = ids(0, 40);
  // s5 is a favorite inside its folder: one copy at the top (Favorites), one
  // at 240px. The reader sees the second copy at the top of the viewport.
  await list.render(rows, [rows[5]]);
  await list.scrollTo(240, true);
  await list.render([...rows], [rows[5]]);
  assert.equal(list.scrollTop(), 240, 'a live update does not jump to the Favorites copy');
});

test('the reader’s top row re-sorted by activity does not carry the list along', async (t) => {
  const list = await mountList(t);
  const rows = ids(0, 40);
  await list.render(rows);
  // s10 is the first visible row; it gets activity and moves to the top.
  await list.scrollTo(400, true);
  await list.render([rows[10], ...rows.slice(0, 10), ...rows.slice(11)]);
  assert.equal(list.scrollTop(), 400, 'the rows around the reader stay where they were');
});

/** useHeldDuringUserScroll over a scroller element the test touches. */
async function mountHeld(t) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  const { useHeldDuringUserScroll } = await import('./session-sidebar-scroll.ts');
  let shown = null;
  function Probe({ value }) {
    const scrollerRef = React.useRef(null);
    shown = useHeldDuringUserScroll(scrollerRef, value);
    return React.createElement('div', { ref: scrollerRef, className: 'scroller' }, React.createElement('i'));
  }
  const render = (value) => act(async () => root.render(React.createElement(Probe, { value })));
  const fire = (type, target, init = {}) =>
    act(async () => {
      const event = new window.Event(type, { bubbles: true });
      Object.assign(event, init);
      target.dispatchEvent(event);
    });
  const idle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
  return { render, fire, idle, document, shown: () => shown };
}

test('a catalog update holds while a finger scrolls the list and lands once the fling ends', async (t) => {
  const held = await mountHeld(t);
  await held.render('a');
  const row = held.document.querySelector('.scroller > i');
  await held.fire('touchstart', row, { touches: [{}] });
  await held.render('b');
  assert.equal(held.shown(), 'a', 'no re-sort under the finger');
  await held.fire('touchend', row, { touches: [] });
  // The fling keeps scrolling after the finger lifts.
  await held.fire('scroll', held.document.querySelector('.scroller'));
  assert.equal(held.shown(), 'a', 'no re-sort during the fling');
  await held.idle();
  assert.equal(held.shown(), 'b', 'the update lands once the scroll is over');
  await held.render('c');
  assert.equal(held.shown(), 'c', 'a list at rest updates at once');
});

test('a wheel burst holds the update too; touches outside the list do not', async (t) => {
  const held = await mountHeld(t);
  await held.render('a');
  await held.fire('wheel', held.document.querySelector('.scroller > i'));
  await held.render('b');
  assert.equal(held.shown(), 'a');
  await held.idle();
  assert.equal(held.shown(), 'b');
  await held.fire('touchstart', held.document.body, { touches: [{}] });
  await held.render('c');
  assert.equal(held.shown(), 'c');
});
