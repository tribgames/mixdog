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
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    offsetHeight: { configurable: true, get: () => VIEWPORT },
    offsetWidth: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => Math.max(VIEWPORT, spacerHeight()) },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(Number(value) || 0, Math.max(0, spacerHeight() - VIEWPORT)));
      },
    },
  });
  viewport.scrollTo = ({ top: next }) => {
    viewport.scrollTop = next;
  };
  // A row's box, for the landing's synchronous measurement.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = this === viewport ? VIEWPORT : (heights.get(this.dataset?.timelineKey) ?? 0);
    return { top: 0, bottom: height, height, left: 0, right: 600, width: 600, x: 0, y: 0 };
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
          return { target, borderBoxSize: [{ blockSize: height, inlineSize: 600 }], contentRect: { height, width: 600 } };
        });
      if (entries.length) observer.callback(entries, observer);
    }
  };
  return { viewport, deliver, FakeResizeObserver };
}

async function mountTranscript(heights, sessionKey, gesture = () => false) {
  const dom = new JSDOM("<div id='viewport'></div>", { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'HTMLElement', 'Element'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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
  const root = createRoot(viewport);
  const render = (rows) =>
    act(async () => {
      root.render(
        React.createElement(TranscriptList, {
          sessionKey,
          rows,
          viewport: { current: viewport },
          content: { current: null },
          shouldAnchorBottom: false,
          scrollToEndRef: { current: () => {} },
          renderRow: (row) => React.createElement('div', null, row.key),
          markProgrammaticScroll: () => {},
          hasScrollGesture: gesture,
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
  /** The first row in view that `keys` carries, and its offset from the top. */
  const firstVisible = (keys) => {
    const top = viewport.scrollTop;
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
  return { render, settle, scrollTo, firstVisible, overlaps, measure, idle, jump, positioned, viewport, cleanup };
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
    // A fling toward rows never mounted before: they arrive at the estimate.
    gesture = true;
    const total = Number.parseFloat(mount.viewport.querySelector('.transcript-virtual-space').style.height);
    await mount.jump(Math.floor(total / 2));
    const crossing = mount.positioned().find((row, i, all) => {
      const next = all[i + 1];
      return next && next.index === row.index + 1 && next.top - row.top === 60 && heights.get(row.key) > 60;
    });
    assert.ok(crossing, 'a row still at the estimate');
    // The viewport top cuts through it.
    await mount.jump(crossing.top + 30);
    const next = mount.positioned().find((row) => row.index === crossing.index + 1);
    const before = next.top - mount.viewport.scrollTop;
    await mount.measure();
    const after = mount.positioned().find((row) => row.key === next.key).top - mount.viewport.scrollTop;
    assert.ok(Math.abs(after - before) <= 1, `the row below moved ${after - before} px`);
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
