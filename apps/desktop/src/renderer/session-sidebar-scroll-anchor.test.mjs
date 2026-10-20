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
  function List({ rows }) {
    const { recentScrollerRef, handleRecentScroll } = useSidebarListScroll({
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
    return React.createElement(
      'div',
      { ref: attach, onScroll: handleRecentScroll },
      rows.map((row) =>
        React.createElement('div', { key: row.id, className: 'session-row', 'data-session-id': row.id })
      )
    );
  }
  return {
    render: (rows) => act(async () => root.render(React.createElement(List, { rows }))),
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
