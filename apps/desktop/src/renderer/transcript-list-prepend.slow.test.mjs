import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { SurfaceActiveContext } from './surface-activity.ts';

const VIEWPORT = 400;

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
  const heightOf = (target) =>
    target === viewport ? viewport.clientHeight : (heights.get(target.dataset?.timelineKey) ?? 0);
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

  const viewportRef = { current: viewport };
  const render = (rows, shown = true, renderRow = (row) => React.createElement('div', null, row.key)) =>
    act(async () => {
      root.render(
        React.createElement(
          SurfaceActiveContext.Provider,
          { value: shown },
          React.createElement(TranscriptList, {
            sessionKey,
            rows,
            viewport: viewportRef,
            content: { current: null },
            shouldAnchorBottom: false,
            scrollToEndRef: { current: () => {} },
            renderRow,
            markProgrammaticScroll: () => {},
            hasScrollGesture: gesture,
            hasTouchScroll: touch,
            touchHoldsCorrections: touchHolds,
            onSelectionAutoScroll: () => {},
          })
        )
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
  /** From here on an animation frame runs only when the returned `frame()`
   *  runs it: every frame requested so far, as one painted frame. */
  const holdFrames = () => {
    const frames = new Map();
    let nextFrame = 0;
    dom.window.requestAnimationFrame = (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    };
    dom.window.cancelAnimationFrame = (id) => frames.delete(id);
    return () =>
      act(async () => {
        const now = dom.window.performance.now();
        for (const [id, callback] of [...frames]) {
          if (frames.delete(id)) callback(now);
        }
      });
  };
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
    holdFrames,
    jump,
    positioned,
    viewport,
    writes,
    cleanup,
  };
}

test('parking a transcript at zero height keeps the live reply and question choice and restores the reading offset', async () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({
    _tag: 'UserMessage',
    key: `u${i}`,
    turnKey: `turn${i}`,
    item: { kind: 'user', text: `prompt ${i}` },
  }));
  rows.push(
    { _tag: 'ToolActivity', key: 'question', turnKey: 'live', items: [{ kind: 'tool', name: 'ask_user' }] },
    {
      _tag: 'AssistantPart',
      key: 'reply',
      turnKey: 'live',
      active: true,
      live: true,
      item: { kind: 'assistant', text: 'Writing' },
    },
    { _tag: 'Thinking', key: 'thinking', turnKey: 'live', active: true }
  );
  const renderRow = (row) =>
    row.key === 'question'
      ? React.createElement('input', { type: 'checkbox' })
      : React.createElement('div', null, row.key);
  const rig = await mountTranscript(new Map(rows.map(({ key }) => [key, 120])), 'park');
  try {
    await rig.render(rows, true, renderRow);
    await rig.scrollTo(660);
    const before = rig.firstVisible();
    assert.ok(before);
    const choice = rig.viewport.querySelector('input');
    choice.click();
    const reply = rig.viewport.querySelector('[data-timeline-key="reply"]');
    assert.ok(reply);
    await rig.render(rows, false, renderRow);
    Object.defineProperty(rig.viewport, 'clientHeight', { configurable: true, value: 0 });
    await rig.measure();
    assert.deepEqual(
      rig.positioned().map(({ key }) => key),
      ['question', 'reply', 'thinking']
    );
    assert.equal(rig.viewport.querySelector('[data-timeline-key="reply"]'), reply);
    assert.ok(rig.viewport.scrollTop > 0);
    await rig.render(rows, true, renderRow);
    Object.defineProperty(rig.viewport, 'clientHeight', { configurable: true, value: VIEWPORT });
    await rig.measure();
    assert.equal(rig.viewport.querySelector('input'), choice);
    assert.equal(choice.checked, true);
    assert.deepEqual(rig.firstVisible(), before);
  } finally {
    await rig.cleanup();
  }
});

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

async function pageProjector(sessionKey, items, heights) {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  return (from) => {
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
    const sessionKey = `anchor-${windowStart}`;
    const items = turnItems(20);
    const heights = new Map();
    const project = await pageProjector(sessionKey, items, heights);
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

async function mountReaderMidHistory(sessionKey) {
  const heights = new Map();
  const project = await pageProjector(sessionKey, turnItems(20), heights);
  const held = project(6 * 10);
  const mount = await mountTranscript(heights, sessionKey);
  await mount.render(held);
  await mount.settle();
  await mount.scrollTo(3000);
  const before = mount.firstVisible();
  assert.ok(before, 'a row is in view');
  return { mount, before, landedRows: project(6 * 6) };
}

test('a landing page keeps the mounted rows the reader sees, never unmounting and rebuilding them', async () => {
  const { mount, before, landedRows } = await mountReaderMidHistory('landing-keeps-rows');
  try {
    const elements = new Map(
      [...mount.viewport.querySelectorAll('.transcript-virtual-row')].map((element) => [
        element.dataset.timelineKey,
        element,
      ])
    );
    const removed = [];
    const observer = new window.MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes) if (node.dataset?.timelineKey) removed.push(node.dataset.timelineKey);
    });
    observer.observe(mount.viewport, { childList: true, subtree: true });
    await mount.render(landedRows);
    observer.takeRecords().forEach((record) => {
      for (const node of record.removedNodes) if (node.dataset?.timelineKey) removed.push(node.dataset.timelineKey);
    });
    observer.disconnect();
    const landed = mount.firstVisible(new Set([before.key]));
    assert.equal(landed?.key, before.key);
    assert.ok(Math.abs(landed.offset - before.offset) <= 1, `landed ${landed.offset} vs ${before.offset}`);
    const mountedRows = [...mount.viewport.querySelectorAll('.transcript-virtual-row')];
    const mountedKeys = new Set(mountedRows.map((element) => element.dataset.timelineKey));
    const rebuilt = [...elements.keys()].filter((key) => removed.includes(key) && mountedKeys.has(key));
    assert.deepEqual(rebuilt, [], 'no row the reader saw was unmounted and mounted again');
    assert.ok(
      mountedRows.some((element) => element.dataset.timelineKey === before.key && elements.get(before.key) === element),
      'the reader row kept its element'
    );
  } finally {
    await mount.cleanup();
  }
});

test('a rows commit under a landed hold that moved nothing above the reader writes no scrollTop', async () => {
  const { mount, landedRows } = await mountReaderMidHistory('landing-no-rewrite');
  try {
    await mount.render(landedRows);
    const writesAfterLanding = mount.writes();
    await mount.render([...landedRows]);
    await mount.render([...landedRows]);
    assert.equal(mount.writes(), writesAfterLanding, 'an unchanged reading offset is not written again');
  } finally {
    await mount.cleanup();
  }
});
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

test('a resize queued while its row is wholly above the reader lands compensated once the reader has moved the row wholly into view', async () => {
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(20);
  const { rows } = projectSettledTranscriptRows({
    sessionKey: 'queued-into-view',
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  });
  const heights = new Map(rows.map((row) => [row.key, rowHeight(row)]));
  let gesture = false;
  const mount = await mountTranscript(heights, 'queued-into-view', () => gesture);
  try {
    await mount.render(rows);
    await mount.settle();
    // A prompt (120 px) in the middle of the session, and the row under it.
    const target = rows.find((row, index) => index > rows.length / 2 && row._tag === 'UserMessage');
    const index = rows.indexOf(target);
    const below = rows[index + 1];
    const start = rows.slice(0, index).reduce((sum, row) => sum + heights.get(row.key), 0);
    const grown = 30;
    const slot = () => {
      const positioned = mount.positioned();
      return positioned.find((row) => row.key === below.key).top - positioned.find((row) => row.key === target.key).top;
    };
    // The row ends 50 px above the viewport top, the reader mid-gesture; it
    // renders 30 px taller, so its new box still ends above the top: queued.
    await mount.scrollTo(start + heights.get(target.key) + 50);
    // The queue's flush frame runs only when this test runs it, so the
    // reader's move below always comes first.
    const frame = mount.holdFrames();
    gesture = true;
    heights.set(target.key, heights.get(target.key) + grown);
    await mount.measure();
    assert.equal(slot(), heights.get(target.key) - grown, 'the size is queued, not applied');
    // The reader moves the row wholly into view before the queue flushes.
    const writes = mount.writes();
    await mount.jump(start - 100);
    const moved = mount.viewport.scrollTop;
    assert.equal(slot(), heights.get(target.key) - grown, 'still queued after the reader moved');
    const offsetBelow = () => mount.positioned().find((row) => row.key === below.key).top - mount.viewport.scrollTop;
    const before = offsetBelow();
    const writesBefore = mount.writes();
    assert.equal(writesBefore, writes + 1, 'only the reader moved the offset');
    // The pump's next animation frame lands it; the observer delivers nothing new.
    await frame();
    assert.equal(slot(), heights.get(target.key), 'the queued size landed');
    assert.equal(mount.viewport.scrollTop, moved + grown, 'the native offset moved by exactly the landed growth');
    assert.equal(mount.writes(), writesBefore + 1, 'as one write');
    assert.equal(offsetBelow(), before, 'the row below stays where the reader sees it');
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
  const sessionKey = 'touch-landing';
  const items = turnItems(20);
  const heights = new Map();
  const project = await pageProjector(sessionKey, items, heights);
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

// A frame of the page runs its animation-frame callbacks and then delivers its observers' sizes; a size can also be
// delivered before the frame that lands the hold (a layout forced earlier). Both orders are run.
for (const [where, readerTop, sizesFirst] of [
  ['at the very top', 0, true],
  ['below the top but within four viewports', 2 * VIEWPORT, true],
  ['at the very top, its sizes arriving after the landing frame', 0, false],
  ['below the top but within four viewports, its sizes arriving after each frame', 2 * VIEWPORT, false],
]) {
  test(`a page landing under a wheel ramp ${where} writes no scrollTop in its commit and lands once`, async () => {
    const sessionKey = `touch-landing-near-top-${readerTop}-${sizesFirst}`;
    const items = turnItems(20);
    const heights = new Map();
    const project = await pageProjector(sessionKey, items, heights);
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
      // The hold is landed from an animation frame (transcript-list-touch-deviation.ts): the frames run when the
      // case runs them, so what is asserted between two of them does not depend on how long the commit took.
      const frame = mount.holdFrames();
      touching = true;
      const writesBefore = mount.writes();
      await mount.render(paged);
      assert.equal(mount.writes(), writesBefore, 'no scrollTop write lands while the user scrolls');
      assert.equal(mount.viewport.scrollTop, native, 'the native offset is untouched');
      assert.ok(mount.deviation() > 0, 'the content shift is absorbed as a row offset');
      const held = mount.firstVisible(new Set([before.key]));
      assert.equal(held?.key, before.key);
      assert.ok(Math.abs(held.offset - before.offset) <= 1, `held ${held.offset} vs ${before.offset}`);
      if (sizesFirst) {
        // Late sizes of the landed rows keep being held within the frame.
        await mount.measure();
        assert.equal(mount.writes(), writesBefore, 'still no scrollTop write before the next frame');
        await frame();
      } else {
        await frame();
        await mount.measure();
      }
      if (native === 0) {
        // A wheel resting at native 0 has no scroll left for a write to cancel, and no scroll event to come: the
        // hold lands in its next frame, so the history above can be reached while the wheel keeps turning.
        assert.equal(mount.writes(), writesBefore + 1, 'the hold lands in the next frame, as one write');
        assert.equal(mount.deviation(), 0);
      } else {
        assert.equal(mount.writes(), writesBefore, 'a ramp still moving keeps the hold across frames');
        assert.ok(mount.deviation() > 0);
      }
      // Scrolling stops: the hold is landed once in all, no row offset left behind.
      touching = false;
      for (let pass = 0; pass < 6; pass += 1) {
        await act(async () =>
          mount.viewport.dispatchEvent(new mount.viewport.ownerDocument.defaultView.Event('scroll'))
        );
        if (sizesFirst) await mount.measure();
        await frame();
        if (!sizesFirst) await mount.measure();
      }
      assert.equal(mount.deviation(), 0, 'no row offset outlives the scroll');
      assert.equal(mount.writes(), writesBefore + 1, 'the hold lands as exactly one write in all');
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

// iOS WebKit cancels a touch fling on a scrollTop write.
for (const [scenario, readerTop, flingTo, retouch = false] of [
  ['far from the top is held, late sizes too, and lands as one write once the fling settles', 8 * VIEWPORT, null],
  ['stays held when the fling reaches native 0, then lands as one write once it settles', 8 * VIEWPORT, 0],
  ['at native 0 is held too, and lands as one write once the fling settles', 0, null],
  ['held at native 0 lands at the next touch, and that drag reaches the page', 8 * VIEWPORT, 0, true],
]) {
  test(`iOS: a page landing under a touch fling ${scenario}`, async () => {
    const { _resetIOSDetectionForTests } = await import('@tanstack/virtual-core');
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: IPHONE });
    _resetIOSDetectionForTests();
    const sessionKey = `ios-landing-${readerTop}-${flingTo}`;
    const items = turnItems(20);
    const heights = new Map();
    const project = await pageProjector(sessionKey, items, heights);
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
          assert.ok(
            reached && oldTop && indexOf(reached.key) < indexOf(oldTop.key),
            `${reached?.key} lies above the old top ${oldTop?.key}`
          );
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
  const { createSettledProjector } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const items = turnItems(3);
  // One pane's projector owns the keys its groups were given.
  const project = (projector, window) =>
    projector.project({
      sessionKey: 'group-key',
      items: window,
      turnKeys: transcriptTurnKeys(window),
      failedTurns: new Set(),
    }).rows;
  const groupKey = (projector, from) =>
    project(projector, items.slice(from)).find(
      (row) => row._tag === 'ToolActivity' && row.items.some((item) => item.id === 'i9')
    )?.key;
  const pane = createSettledProjector();
  const cut = groupKey(pane, 9);
  assert.ok(cut);
  assert.equal(groupKey(pane, 8), cut);
  assert.equal(groupKey(pane, 0), cut);
  // A live turn appending tools keeps the key as well.
  const live = createSettledProjector();
  const growingKey = project(live, items.slice(0, 9)).at(-1)?.key;
  assert.equal(groupKey(live, 0), growingKey);
});

test('prepending an older page keeps the first visible row at the same viewport offset', async () => {
  const heights = new Map();
  const rowsFrom = (from, to, height) =>
    Array.from({ length: to - from }, (_, offset) => {
      const key = `row-${String(from + offset).padStart(3, '0')}`;
      heights.set(key, height);
      return { _tag: 'TurnGap', key, turnKey: key };
    });
  const held = rowsFrom(100, 140, 100);
  const older = rowsFrom(70, 100, 150);
  const mount = await mountTranscript(heights, 'prepend-test');
  try {
    await mount.render(held);
    await mount.settle();
    await mount.scrollTo(350);
    const before = mount.firstVisible();
    assert.ok(before, 'a row is under the top edge');
    assert.ok(before.key >= 'row-100' && before.key < 'row-110');

    await mount.render([...older, ...held]);
    const landed = mount.firstVisible();
    await mount.settle();
    assert.deepEqual(landed, before, 'the commit that adds the page keeps the reader still');
    assert.deepEqual(mount.firstVisible(), before, 'measuring the page above the reader keeps it still');
  } finally {
    await mount.cleanup();
  }
});
