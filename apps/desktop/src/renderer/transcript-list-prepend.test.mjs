import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const VIEWPORT = 400;

// A layout stand-in: the viewport scrolls over the spacer the virtual list
// sizes directly, clamped the way Chromium clamps, and a ResizeObserver
// reports each row's border box from the heights below.
function installLayout(dom, heights) {
  const viewport = dom.window.document.getElementById('viewport');
  const spacerHeight = () =>
    Number.parseFloat(viewport.querySelector('.transcript-virtual-space')?.style.height || '0') || 0;
  let top = 0;
  let writes = 0;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    offsetHeight: { configurable: true, get: () => VIEWPORT },
    offsetWidth: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => Math.max(VIEWPORT, spacerHeight()) },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        writes += 1;
        top = Math.max(0, Math.min(Number(value) || 0, Math.max(0, spacerHeight() - VIEWPORT)));
      },
    },
  });
  viewport.scrollTo = ({ top: next }) => {
    viewport.scrollTop = next;
  };
  // A row's box, for the landing's synchronous measurement. A row without a
  // height has no box yet (no width either); a laid-out row that paints
  // nothing is one set to 0.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const known = this === viewport || heights.has(this.dataset?.timelineKey);
    const height = this === viewport ? VIEWPORT : (heights.get(this.dataset?.timelineKey) ?? 0);
    const width = known ? 600 : 0;
    return { top: 0, bottom: height, height, left: 0, right: width, width, x: 0, y: 0 };
  };
  const observers = new Set();
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.add(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  }
  const heightOf = (target) => (target === viewport ? VIEWPORT : (heights.get(target.dataset?.timelineKey) ?? 0));
  const deliver = () => {
    for (const observer of [...observers]) {
      const entries = [...observer.targets]
        .filter((target) => target.isConnected)
        .map((target) => {
          const height = heightOf(target);
          return {
            target,
            borderBoxSize: [{ blockSize: height, inlineSize: 600 }],
            contentRect: { height, width: 600 },
          };
        });
      if (entries.length) observer.callback(entries, observer);
    }
  };
  return { viewport, deliver, FakeResizeObserver, writes: () => writes };
}

async function mountTranscript(
  heights,
  sessionKey,
  gesture = () => false,
  touch = () => false,
  touchHolds = () => false
) {
  const dom = new JSDOM("<div id='viewport'></div>", { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'HTMLElement', 'Element'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { viewport, deliver, FakeResizeObserver, writes } = installLayout(dom, heights);
  dom.window.ResizeObserver = FakeResizeObserver;
  for (const [key, value] of [
    ['window', dom.window],
    ['document', dom.window.document],
    ['ResizeObserver', FakeResizeObserver],
    ['HTMLElement', dom.window.HTMLElement],
    ['Element', dom.window.Element],
  ]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { TranscriptList } = await import('./TranscriptList.tsx');
  const root = createRoot(viewport);
  // One ref for the mount's life, as the pane passes it: the list's hooks key
  // on its identity.
  const viewportRef = { current: viewport };
  const render = (rows) =>
    act(async () => {
      root.render(
        React.createElement(TranscriptList, {
          sessionKey,
          rows,
          viewport: viewportRef,
          content: { current: null },
          shouldAnchorBottom: false,
          scrollToEndRef: { current: () => {} },
          renderRow: (row) => React.createElement('div', null, row.key),
          markProgrammaticScroll: () => {},
          hasScrollGesture: gesture,
          hasTouchScroll: touch,
          touchHoldsCorrections: touchHolds,
          onSelectionAutoScroll: () => {},
        })
      );
    });
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      await act(async () => {
        deliver();
        viewport.dispatchEvent(new dom.window.Event('scroll'));
        // Deferred sizes flush on an animation frame once motion is idle.
        await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
      });
    }
  };
  /** Mounted rows whose box runs into (or leaves a gap before) the next one. */
  const overlaps = () => {
    const rows = [...viewport.querySelectorAll('.transcript-virtual-row')]
      .map((element) => ({
        index: Number(element.dataset.index),
        top: Number.parseFloat(element.style.top),
        height: heights.get(element.dataset.timelineKey),
      }))
      .sort((a, b) => a.index - b.index);
    return rows.filter((row, i) => {
      const next = rows[i + 1];
      return next && next.index === row.index + 1 && Math.abs(row.top + row.height - next.top) > 1;
    }).length;
  };
  const scrollTo = async (top) => {
    viewport.scrollTop = top;
    await settle();
  };
  /** The row space's held touch offset (its translateY, negated). */
  const deviation = () => {
    const match = /translateY\((-?[\d.]+)px\)/.exec(
      viewport.querySelector('.transcript-virtual-space')?.style.transform
    );
    return match ? -Number(match[1]) : 0;
  };
  /** The first row in view that `keys` carries, and its offset from the top. */
  const firstVisible = (keys) => {
    const top = viewport.scrollTop + deviation();
    const hit = [...viewport.querySelectorAll('.transcript-virtual-row')]
      .map((element) => ({
        key: element.dataset.timelineKey,
        top: Number.parseFloat(element.style.top),
        height: heights.get(element.dataset.timelineKey),
      }))
      .sort((a, b) => a.top - b.top)
      .find((row) => row.top + row.height > top && row.top < top + VIEWPORT && (!keys || keys.has(row.key)));
    return hit ? { key: hit.key, offset: hit.top - top } : null;
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  /** Observer deliveries only: no scroll event re-reads the offset. */
  const measure = () => act(async () => deliver());
  /** Time passing with no input — long enough for scroll-idle timers. */
  const idle = (ms) => act(() => new Promise((resolve) => dom.window.setTimeout(resolve, ms)));
  /** A scroll that lands before any row there was measured. */
  const jump = (top) =>
    act(async () => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new dom.window.Event('scroll'));
    });
  /** Mounted rows as the list positions them. */
  const positioned = () =>
    [...viewport.querySelectorAll('.transcript-virtual-row')]
      .map((element) => ({
        key: element.dataset.timelineKey,
        index: Number(element.dataset.index),
        top: Number.parseFloat(element.style.top),
      }))
      .sort((a, b) => a.index - b.index);
  return {
    render,
    settle,
    scrollTo,
    firstVisible,
    deviation,
    overlaps,
    measure,
    idle,
    jump,
    positioned,
    viewport,
    writes,
    cleanup,
  };
}

// Six items per turn: prompt, three tools, the reply, its "Worked for…" row.
function turnItems(turns) {
  return Array.from({ length: turns * 6 }, (_, index) => {
    const turn = Math.floor(index / 6);
    const id = `i${index}`;
    switch (index % 6) {
      case 0:
        return { id, kind: 'user', text: `question ${turn}` };
      case 4:
        return { id, kind: 'assistant', text: `answer ${turn}` };
      case 5:
        return { id, kind: 'turndone', status: 'done', label: 'Worked for 3s' };
      default:
        return { id, kind: 'tool', name: 'shell', status: 'done', text: `tool ${index}` };
    }
  });
}

// Phone-sized rows: a reply is thousands of pixels, far from the 60 px estimate.
function rowHeight(row) {
  if (row._tag === 'TurnGap') return 16;
  if (row._tag === 'UserMessage') return 120;
  if (row._tag === 'ToolActivity') return 40 + 30 * row.items.length;
  if (row.item?.kind === 'turndone') return 30;
  return 2716 + (row.completion ? 30 : 0);
}

// The reader position is where the page request fires; a gesture is the
// wheel/touch window (or fling) still open when the page lands.
for (const [scenario, windowStart, pageStart, readerGesture, readerTop] of [
  ['a page that supplies the reply of a visible "Worked for" row', 6 * 10 + 5, 6 * 6, false, 20],
  ['a page that supplies the head of a cut tool group', 6 * 10 + 2, 6 * 6 + 3, false, 20],
  ['a mid-turn window and a mid-turn page', 6 * 10 + 4, 6 * 7 + 1, false, 20],
  ['a reply page landing inside the wheel gesture window', 6 * 10 + 5, 6 * 6, true, 20],
  ['a turn-start page landing inside the wheel gesture window', 6 * 11, 6 * 7, true, 20],
  ['a page landing at scrollTop 0 during a fling', 6 * 10 + 4, 6 * 6 + 2, true, 0],
]) {
  test(`${scenario} keeps the first visible surviving row within 1 px`, async () => {
    const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
    const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
    const sessionKey = `anchor-${windowStart}`;
    const items = turnItems(20);
    const heights = new Map();
    const project = (from) => {
      const window = items.slice(from);
      const { rows } = projectSettledTranscriptRows({
        sessionKey,
        items: window,
        turnKeys: transcriptTurnKeys(window),
        failedTurns: new Set(),
      });
      for (const row of rows) heights.set(row.key, rowHeight(row));
      return rows;
    };
    const held = project(windowStart);
    let gesture = false;
    const mount = await mountTranscript(heights, sessionKey, () => gesture);
    try {
      await mount.render(held);
      await mount.settle();
      // The reader sits just below the head of the window, where the page
      // lands and the history request fires.
      await mount.scrollTo(readerTop);
      const paged = project(pageStart);
      const survivors = new Set(paged.map((row) => row.key));
      const before = mount.firstVisible(survivors);
      assert.ok(before, 'a surviving row is in view');
      gesture = readerGesture;
      await mount.render(paged);
      // Before any ResizeObserver delivery: the landing measured its rows.
      assert.equal(mount.overlaps(), 0, 'the first painted frame draws no row over another');
      const landed = mount.firstVisible(new Set([before.key]));
      assert.equal(landed?.key, before.key);
      assert.ok(Math.abs(landed.offset - before.offset) <= 1, `landed ${landed.offset} vs ${before.offset}`);
      // A landed row right above the anchor finishes rendering (lazy
      // Markdown) a few frames later — still inside the gesture window, and
      // intersecting the viewport top, so it is never a deferred size.
      // First the scroll-idle timer of the reader's last scroll event runs out
      // (the page landed inside that window) with no scroll event since the
      // landing's own offset write: the idle report must not restore the
      // pre-landing offset for the next correction to start from.
      await mount.idle(200);
      const anchorIndex = paged.findIndex((row) => row.key === before.key);
      const above = paged[anchorIndex - 1];
      if (above) heights.set(above.key, heights.get(above.key) + 1500);
      await mount.measure();
      const grown = mount.firstVisible(new Set([before.key]));
      assert.equal(grown?.key, before.key);
      assert.ok(Math.abs(grown.offset - before.offset) <= 1, `grown ${grown.offset} vs ${before.offset}`);
      assert.equal(mount.overlaps(), 0, 'no landed row draws over the reader while the gesture lasts');
      gesture = false;
      await mount.settle();
      assert.equal(mount.overlaps(), 0, 'every observed size reached the timeline');
      const measured = mount.firstVisible(new Set([before.key]));
      assert.equal(measured?.key, before.key);
      assert.ok(Math.abs(measured.offset - before.offset) <= 1, `measured ${measured.offset} vs ${before.offset}`);
    } finally {
      await mount.cleanup();
    }
  });
}

test('a row above the reader that grows into view during a gesture is corrected, not drawn over the reader', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(20).slice(6 * 10);
  const { rows } = projectSettledTranscriptRows({
    sessionKey: 'grow-into-view',
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  });
  const heights = new Map(rows.map((row) => [row.key, rowHeight(row)]));
  let gesture = false;
  const mount = await mountTranscript(heights, 'grow-into-view', () => gesture);
  try {
    await mount.render(rows);
    await mount.settle();
    const reply = rows.find((row) => row._tag === 'AssistantPart' && row.item.kind === 'assistant');
    const index = rows.indexOf(reply);
    const start = rows.slice(0, index).reduce((sum, row) => sum + heights.get(row.key), 0);
    // The reply sits just above the viewport; the reader is mid-wheel.
    await mount.scrollTo(start + heights.get(reply.key) + 5);
    const before = mount.firstVisible();
    gesture = true;
    heights.set(reply.key, heights.get(reply.key) + 400);
    await mount.measure();
    assert.equal(mount.overlaps(), 0, 'the grown row is not drawn over the rows in view');
    const after = mount.firstVisible(new Set([before.key]));
    assert.ok(Math.abs(after.offset - before.offset) <= 1, `after ${after.offset} vs ${before.offset}`);
  } finally {
    await mount.cleanup();
  }
});

test('a wheel ramp never has scrollTop written under it: a correction is held as a row offset and lands once', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(20).slice(6 * 10);
  const { rows } = projectSettledTranscriptRows({
    sessionKey: 'touch-hold',
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  });
  const heights = new Map(rows.map((row) => [row.key, rowHeight(row)]));
  let touching = false;
  const mount = await mountTranscript(
    heights,
    'touch-hold',
    () => touching,
    () => touching
  );
  try {
    await mount.render(rows);
    await mount.settle();
    const reply = rows.find((row) => row._tag === 'AssistantPart' && row.item.kind === 'assistant');
    const index = rows.indexOf(reply);
    const start = rows.slice(0, index).reduce((sum, row) => sum + heights.get(row.key), 0);
    await mount.scrollTo(start + heights.get(reply.key) + 5);
    const before = mount.firstVisible();
    const native = mount.viewport.scrollTop;
    // The finger flings toward older rows; a row above grows into view.
    touching = true;
    const writesBefore = mount.writes();
    heights.set(reply.key, heights.get(reply.key) + 400);
    await mount.measure();
    assert.equal(mount.writes(), writesBefore, 'no scrollTop write lands inside the fling');
    assert.equal(mount.viewport.scrollTop, native);
    assert.equal(mount.deviation(), 400, 'the correction is held as the row offset');
    const held = mount.firstVisible(new Set([before.key]));
    assert.ok(Math.abs(held.offset - before.offset) <= 1, `held ${held.offset} vs ${before.offset}`);
    // The fling keeps moving natively; the held offset rides along.
    await mount.jump(native - 100);
    await mount.measure();
    const flingWrites = mount.writes();
    assert.equal(flingWrites, writesBefore + 1, 'only the fling itself moved the native offset');
    assert.equal(mount.viewport.scrollTop, native - 100, 'the fling owns the native offset');
    const moved = mount.firstVisible(new Set([before.key]));
    assert.ok(Math.abs(moved.offset - (before.offset + 100)) <= 1, `moved ${moved.offset} vs ${before.offset + 100}`);
    // scrollend: the hold lands as one write and the row offset is dropped.
    touching = false;
    await mount.settle();
    assert.equal(mount.deviation(), 0, 'no row offset outlives the touch scroll');
    assert.equal(mount.writes(), flingWrites + 1, 'the hold lands as exactly one write');
    assert.equal(mount.viewport.scrollTop, native - 100 + 400);
    const landed = mount.firstVisible(new Set([before.key]));
    assert.ok(Math.abs(landed.offset - moved.offset) <= 1, `landed ${landed.offset} vs ${moved.offset}`);
    assert.equal(mount.overlaps(), 0);
  } finally {
    await mount.cleanup();
  }
});

test('a page landing under a wheel ramp far from the top is held as a row offset, not written under the ramp', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const sessionKey = 'touch-landing';
  const items = turnItems(20);
  const heights = new Map();
  const project = (from) => {
    const window = items.slice(from);
    const { rows } = projectSettledTranscriptRows({
      sessionKey,
      items: window,
      turnKeys: transcriptTurnKeys(window),
      failedTurns: new Set(),
    });
    for (const row of rows) heights.set(row.key, rowHeight(row));
    return rows;
  };
  let touching = false;
  const mount = await mountTranscript(
    heights,
    sessionKey,
    () => touching,
    () => touching
  );
  try {
    await mount.render(project(6 * 10));
    await mount.settle();
    // Pages are asked for viewports ahead: the reader is still far below the top.
    await mount.scrollTo(8 * VIEWPORT);
    const paged = project(6 * 6);
    const survivors = new Set(paged.map((row) => row.key));
    const before = mount.firstVisible(survivors);
    assert.ok(before, 'a surviving row is in view');
    const native = mount.viewport.scrollTop;
    touching = true;
    const writesBefore = mount.writes();
    await mount.render(paged);
    assert.equal(mount.writes(), writesBefore, 'no scrollTop write lands inside the fling');
    assert.equal(mount.viewport.scrollTop, native, 'the fling keeps the native offset');
    assert.ok(mount.deviation() > 0, 'the landing is held as the row offset');
    const held = mount.firstVisible(new Set([before.key]));
    assert.equal(held?.key, before.key);
    assert.ok(Math.abs(held.offset - before.offset) <= 1, `held ${held.offset} vs ${before.offset}`);
    assert.equal(mount.overlaps(), 0, 'the first painted frame draws no row over another');
    // scrollend: the hold lands as one write and the reader stays put.
    touching = false;
    await mount.settle();
    assert.equal(mount.deviation(), 0, 'no row offset outlives the touch scroll');
    const landed = mount.firstVisible(new Set([before.key]));
    assert.equal(landed?.key, before.key);
    assert.ok(Math.abs(landed.offset - before.offset) <= 1, `landed ${landed.offset} vs ${before.offset}`);
    assert.equal(mount.overlaps(), 0);
  } finally {
    await mount.cleanup();
  }
});

for (const [where, readerTop] of [
  ['at the very top', 0],
  ['below the top but within four viewports', 2 * VIEWPORT],
]) {
  test(`a page landing under a wheel ramp ${where} writes no scrollTop and settles once`, async () => {
    const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
    const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
    const sessionKey = `touch-landing-near-top-${readerTop}`;
    const items = turnItems(20);
    const heights = new Map();
    const project = (from) => {
      const window = items.slice(from);
      const { rows } = projectSettledTranscriptRows({
        sessionKey,
        items: window,
        turnKeys: transcriptTurnKeys(window),
        failedTurns: new Set(),
      });
      for (const row of rows) heights.set(row.key, rowHeight(row));
      return rows;
    };
    let touching = false;
    const mount = await mountTranscript(
      heights,
      sessionKey,
      () => touching,
      () => touching
    );
    try {
      await mount.render(project(6 * 10 + 4));
      await mount.settle();
      await mount.scrollTo(readerTop);
      const paged = project(6 * 6 + 2);
      const survivors = new Set(paged.map((row) => row.key));
      const before = mount.firstVisible(survivors);
      assert.ok(before, 'a surviving row is in view');
      const native = mount.viewport.scrollTop;
      touching = true;
      const writesBefore = mount.writes();
      await mount.render(paged);
      assert.equal(mount.writes(), writesBefore, 'no scrollTop write lands while the user scrolls');
      assert.equal(mount.viewport.scrollTop, native, 'the native offset is untouched');
      assert.ok(mount.deviation() > 0, 'the content shift is absorbed as a row offset');
      const held = mount.firstVisible(new Set([before.key]));
      assert.equal(held?.key, before.key);
      assert.ok(Math.abs(held.offset - before.offset) <= 1, `held ${held.offset} vs ${before.offset}`);
      // Late sizes of the landed rows keep being held while the scroll lasts.
      await mount.measure();
      assert.equal(mount.writes(), writesBefore, 'still no scrollTop write mid-scroll');
      // Scrolling stops: one settle correction, no row offset left behind.
      touching = false;
      await mount.settle();
      assert.equal(mount.deviation(), 0, 'no row offset outlives the scroll');
      assert.equal(mount.writes(), writesBefore + 1, 'the settle lands as exactly one write');
      const landed = mount.firstVisible(new Set([before.key]));
      assert.equal(landed?.key, before.key);
      assert.ok(Math.abs(landed.offset - before.offset) <= 1, `landed ${landed.offset} vs ${before.offset}`);
    } finally {
      await mount.cleanup();
    }
  });
}

const IPHONE = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

// iOS WebKit cancels a touch fling on a scrollTop write, so there a page
// landing under the fling is held as a row offset (with the core's own iOS
// deferral handed over to that hold) and lands once the fling settles. Native
// 0 is no exception: the momentum reaches it, and the page sits above it.
// A finger landing at native 0 with the page still held (inside the quiet
// window, before scrollend) lands it: the momentum already ran into the edge,
// and the drag that finger starts has to reach the page above.
for (const [scenario, readerTop, flingTo, retouch = false] of [
  ['far from the top is held, late sizes too, and lands as one write once the fling settles', 8 * VIEWPORT, null],
  ['stays held when the fling reaches native 0, then lands as one write once it settles', 8 * VIEWPORT, 0],
  ['at native 0 is held too, and lands as one write once the fling settles', 0, null],
  ['held at native 0 lands at the next touch, and that drag reaches the page', 8 * VIEWPORT, 0, true],
]) {
  test(`iOS: a page landing under a touch fling ${scenario}`, async () => {
    const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
    const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
    const { _resetIOSDetectionForTests } = await import('@tanstack/virtual-core');
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: IPHONE });
    _resetIOSDetectionForTests();
    const sessionKey = `ios-landing-${readerTop}-${flingTo}`;
    const items = turnItems(20);
    const heights = new Map();
    const project = (from) => {
      const window = items.slice(from);
      const { rows } = projectSettledTranscriptRows({
        sessionKey,
        items: window,
        turnKeys: transcriptTurnKeys(window),
        failedTurns: new Set(),
      });
      for (const row of rows) heights.set(row.key, rowHeight(row));
      return rows;
    };
    let touching = false;
    const mount = await mountTranscript(
      heights,
      sessionKey,
      () => touching,
      () => touching,
      () => touching
    );
    const touch = (type) => act(async () => mount.viewport.dispatchEvent(new window.Event(type)));
    try {
      await mount.render(project(6 * 10 + 4));
      await mount.settle();
      await mount.scrollTo(readerTop);
      const paged = project(6 * 6 + 2);
      const survivors = new Set(paged.map((row) => row.key));
      const before = mount.firstVisible(survivors);
      assert.ok(before, 'a surviving row is in view');
      const native = mount.viewport.scrollTop;
      touching = true;
      await touch('touchstart');
      const writesBefore = mount.writes();
      await mount.render(paged);
      const landed = mount.firstVisible(new Set([before.key]));
      assert.equal(landed?.key, before.key);
      assert.ok(Math.abs(landed.offset - before.offset) <= 1, `landed ${landed.offset} vs ${before.offset}`);
      assert.equal(mount.writes(), writesBefore, 'no scrollTop write lands inside the fling');
      assert.equal(mount.viewport.scrollTop, native, 'the fling keeps the native offset');
      const held = mount.deviation();
      assert.ok(held > 0, 'the landing is held as the row offset');
      if (flingTo !== null || native <= 1) {
        // The momentum carries the native offset to 0, the old first row:
        // the hold stands there until the fling settles, then lands as one
        // write with the logical offset kept.
        const edge = flingTo ?? native;
        // The momentum's own frame (the test's write stands in for it).
        await mount.jump(edge);
        const momentumWrites = mount.writes();
        await mount.jump(edge);
        assert.equal(mount.writes(), momentumWrites + 1, 'nothing lands under the momentum at native 0');
        assert.equal(mount.deviation(), held, 'the hold stands at native 0');
        if (retouch) {
          // The finger lifted, the momentum stopped at native 0, and a new
          // finger lands before the scroll has been quiet for 150 ms.
          const keys = new Set(paged.map((row) => row.key));
          const indexOf = (key) => paged.findIndex((row) => row.key === key);
          const oldTop = mount.firstVisible(keys);
          await touch('touchend');
          await touch('touchstart');
          assert.equal(mount.deviation(), 0, 'the new touch lands the hold');
          assert.equal(mount.writes(), momentumWrites + 2, 'as exactly one write');
          assert.equal(Math.round(mount.viewport.scrollTop), Math.round(edge + held), 'the logical offset is kept');
          // The drag toward older rows moves into the page above.
          await mount.jump(mount.viewport.scrollTop - 300);
          assert.equal(Math.round(mount.viewport.scrollTop), Math.round(edge + held - 300), 'the page is reachable');
          assert.equal(mount.deviation(), 0, 'no hold returns');
          const reached = mount.firstVisible(keys);
          assert.ok(reached && oldTop && indexOf(reached.key) < indexOf(oldTop.key),`${reached?.key} lies above the old top ${oldTop?.key}`);
          return;
        }
        touching = false;
        await touch('touchend');
        await mount.idle(200);
        await mount.settle();
        assert.equal(mount.deviation(), 0, 'no row offset outlives the fling');
        assert.equal(Math.round(mount.viewport.scrollTop), Math.round(edge + held), 'one write lands the held amount');
        return;
      }
      // A row above the reader finishes rendering mid-fling: its correction
      // joins the hold, never a native write under the fling.
      const anchorIndex = paged.findIndex((row) => row.key === before.key);
      const above = paged[anchorIndex - 1];
      heights.set(above.key, heights.get(above.key) + 1500);
      await mount.measure();
      assert.equal(mount.writes(), writesBefore, 'still no scrollTop write mid-fling');
      const grown = mount.firstVisible(new Set([before.key]));
      assert.equal(grown?.key, before.key);
      assert.ok(Math.abs(grown.offset - before.offset) <= 1, `grown ${grown.offset} vs ${before.offset}`);
      // The finger lifts and the momentum goes quiet: one write, no row offset.
      touching = false;
      await touch('touchend');
      await mount.idle(200);
      await mount.settle();
      assert.equal(mount.deviation(), 0, 'no row offset outlives the fling');
      assert.equal(mount.writes(), writesBefore + 1, 'the hold lands as exactly one write');
      const settled = mount.firstVisible(new Set([before.key]));
      assert.equal(settled?.key, before.key);
      assert.ok(Math.abs(settled.offset - before.offset) <= 1, `settled ${settled.offset} vs ${before.offset}`);
    } finally {
      await mount.cleanup();
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete globalThis.navigator;
      _resetIOSDetectionForTests();
    }
  });
}

test('a row first measured across the viewport top grows upward, not into the rows in view', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(20);
  const { rows } = projectSettledTranscriptRows({
    sessionKey: 'first-measure',
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  });
  const heights = new Map(rows.map((row) => [row.key, rowHeight(row)]));
  let gesture = false;
  const mount = await mountTranscript(heights, 'first-measure', () => gesture);
  try {
    await mount.render(rows);
    await mount.settle();
    // A fling toward rows never mounted before, whose content has no box yet
    // when they mount: the commit cannot measure them, so they hold the
    // estimate until their first observer delivery.
    gesture = true;
    const real = new Map(heights);
    heights.clear();
    const total = Number.parseFloat(mount.viewport.querySelector('.transcript-virtual-space').style.height);
    await mount.jump(Math.floor(total / 2));
    const positioned = mount.positioned();
    const crossingAt = positioned.findIndex((row, i, all) => all[i + 1]?.index === row.index + 1);
    const crossing = positioned[crossingAt];
    assert.ok(crossing, 'a row still at its estimate');
    // Rows of a measured shape now mount at their learned height; this one's
    // content renders taller than any row of its shape did.
    const estimate = positioned[crossingAt + 1].top - crossing.top;
    real.set(crossing.key, estimate + 40);
    // The viewport top cuts through it.
    await mount.jump(crossing.top + 30);
    const next = mount.positioned().find((row) => row.index === crossing.index + 1);
    const before = next.top - mount.viewport.scrollTop;
    for (const [key, height] of real) heights.set(key, height);
    await mount.measure();
    const after = mount.positioned().find((row) => row.key === next.key).top - mount.viewport.scrollTop;
    assert.ok(Math.abs(after - before) <= 1, `the row below moved ${after - before} px`);
  } finally {
    await mount.cleanup();
  }
});

test('rows never measured mount at the height their shape measured, so a first pass up writes no corrections', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(24);
  const { rows } = projectSettledTranscriptRows({
    sessionKey: 'learned-shapes',
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  });
  const real = new Map(rows.map((row) => [row.key, rowHeight(row)]));
  const heights = new Map(real);
  let gesture = false;
  const mount = await mountTranscript(heights, 'learned-shapes', () => gesture);
  try {
    await mount.render(rows);
    // The newest turns mount and are measured: their shapes are learned.
    await mount.scrollTo(Number.MAX_SAFE_INTEGER);
    // A fling into history the list never mounted: no box exists yet, so
    // what is laid out is the estimate alone.
    gesture = true;
    heights.clear();
    await mount.jump(Math.floor(mount.viewport.scrollTop / 3));
    const placed = mount.positioned();
    const wrong = placed.filter((row, i) => {
      const next = placed[i + 1];
      return next && next.index === row.index + 1 && next.top - row.top !== real.get(row.key);
    });
    assert.ok(placed.length > 4, 'rows mounted in the middle of history');
    assert.deepEqual(wrong, [], 'every unmeasured row already holds its real height');
    // Their boxes arrive: nothing above the reader moves, nothing is written.
    const anchor = placed[Math.floor(placed.length / 2)];
    const before = anchor.top - mount.viewport.scrollTop;
    const offset = mount.viewport.scrollTop;
    for (const [key, height] of real) heights.set(key, height);
    await mount.measure();
    const after = mount.positioned().find((row) => row.key === anchor.key).top - mount.viewport.scrollTop;
    assert.equal(after, before);
    assert.equal(mount.viewport.scrollTop, offset, 'no corrective scroll write');
  } finally {
    await mount.cleanup();
  }
});

test('an appended row is laid out at its real size before any observer delivery', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const project = (items) => {
    const { rows } = projectSettledTranscriptRows({
      sessionKey: 'append-measure',
      items,
      turnKeys: transcriptTurnKeys(items),
      failedTurns: new Set(),
    });
    return rows;
  };
  const items = turnItems(2);
  const first = project(items.slice(0, 6));
  const appended = project(items);
  const heights = new Map(appended.map((row) => [row.key, rowHeight(row)]));
  const mount = await mountTranscript(heights, 'append-measure');
  try {
    await mount.render(first);
    await mount.settle();
    // A new turn lands: its gap, prompt, and tool rows mount in this commit.
    await mount.render(appended);
    const rows = mount.positioned();
    const misplaced = rows.filter((row, i) => {
      const next = rows[i + 1];
      return next && next.index === row.index + 1 && next.top - row.top !== heights.get(row.key);
    });
    assert.deepEqual(misplaced, [], 'no mounted row is laid out at the estimate');
  } finally {
    await mount.cleanup();
  }
});

test('a tool group keeps its row key when a page supplies the tools cut off its head', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(3);
  const groupKey = (from) => {
    const window = items.slice(from);
    const { rows } = projectSettledTranscriptRows({
      sessionKey: 'group-key',
      items: window,
      turnKeys: transcriptTurnKeys(window),
      failedTurns: new Set(),
    });
    return rows.find((row) => row._tag === 'ToolActivity' && row.items.some((item) => item.id === 'i9'))?.key;
  };
  const cut = groupKey(9);
  assert.ok(cut);
  assert.equal(groupKey(8), cut);
  assert.equal(groupKey(0), cut);
  // A live turn appending tools keeps the key as well.
  const growing = items.slice(0, 9);
  const { rows } = projectSettledTranscriptRows({
    sessionKey: 'group-key',
    items: growing,
    turnKeys: transcriptTurnKeys(growing),
    failedTurns: new Set(),
  });
  assert.equal(rows.at(-1)?.key, cut);
});

test('prepending an older page keeps the first visible row at the same viewport offset', async () => {
  const dom = new JSDOM("<div id='viewport'></div>", { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'HTMLElement', 'Element'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const heights = new Map();
  const { viewport, deliver, FakeResizeObserver } = installLayout(dom, heights);
  dom.window.ResizeObserver = FakeResizeObserver;
  for (const [key, value] of [
    ['window', dom.window],
    ['document', dom.window.document],
    ['ResizeObserver', FakeResizeObserver],
    ['HTMLElement', dom.window.HTMLElement],
    ['Element', dom.window.Element],
  ]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { TranscriptList } = await import('./TranscriptList.tsx');
  const rowsFrom = (from, to, height) =>
    Array.from({ length: to - from }, (_, offset) => {
      const key = `row-${String(from + offset).padStart(3, '0')}`;
      heights.set(key, height);
      return { _tag: 'TurnGap', key, turnKey: key };
    });
  const held = rowsFrom(100, 140, 100);
  // Older rows measure far from the 60 px estimate.
  const older = rowsFrom(70, 100, 150);
  const root = createRoot(viewport);
  const render = (rows) =>
    act(async () => {
      root.render(
        React.createElement(TranscriptList, {
          sessionKey: 'prepend-test',
          rows,
          viewport: { current: viewport },
          content: { current: null },
          shouldAnchorBottom: false,
          scrollToEndRef: { current: () => {} },
          renderRow: (row) => React.createElement('div', null, row.key),
          markProgrammaticScroll: () => {},
          hasScrollGesture: () => false,
          onSelectionAutoScroll: () => {},
        })
      );
    });
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      await act(async () => {
        deliver();
        viewport.dispatchEvent(new dom.window.Event('scroll'));
      });
    }
  };
  const firstVisible = () => {
    const top = viewport.scrollTop;
    const hit = [...viewport.querySelectorAll('.transcript-virtual-row')]
      .map((element) => ({
        key: element.dataset.timelineKey,
        top: Number.parseFloat(element.style.top),
        height: heights.get(element.dataset.timelineKey),
      }))
      .find((row) => row.top <= top && top < row.top + row.height);
    return hit ? { key: hit.key, offset: hit.top - top } : null;
  };
  try {
    await render(held);
    await settle();
    // Read a few rows below the top of the held window: the overscan above
    // the reader reaches into the page that is about to land.
    viewport.scrollTop = 350;
    await settle();
    const before = firstVisible();
    assert.ok(before, 'a row is under the top edge');
    assert.ok(before.key >= 'row-100' && before.key < 'row-110');

    await render([...older, ...held]);
    const landed = firstVisible();
    await settle();
    assert.deepEqual(landed, before, 'the commit that adds the page keeps the reader still');
    assert.deepEqual(firstVisible(), before, 'measuring the page above the reader keeps it still');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
