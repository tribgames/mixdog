import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

function makeTransitionEndEvent(window, propertyName) {
  const event = new window.Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: propertyName });
  return event;
}

test('ToolActivityGroup commits 0fr via double-rAF and unmounts on grid-template-rows transitionend', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement', 'MouseEvent', 'Event'],
  });
  const frames = [];
  window.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = () => ({ matches: false });

  const { ToolActivityGroup, resetToolDisclosureScope } = await import('./transcript-tool-ui.tsx');
  const scope = 'test-disclosure-group';
  resetToolDisclosureScope(scope);
  t.after(() => resetToolDisclosureScope(scope));

  const items = [
    {
      id: 'call-group-1',
      kind: 'tool',
      name: 'shell',
      args: { command: 'echo hello' },
      result: 'hello\n',
      status: 'done',
    },
  ];

  await act(async () => {
    root.render(React.createElement(ToolActivityGroup, { items, disclosureScope: scope }));
  });

  const article = document.querySelector('article.tool-activity');
  assert.equal(article.dataset.open, 'false');
  assert.equal(article.dataset.rendered, 'false');
  assert.equal(document.querySelector('.tool-activity-reveal'), null);

  // Open: mounts at 0fr and marks in-flight disclosure before the second rAF.
  await act(async () => {
    document.querySelector('.tool-activity-header').click();
  });
  const reveal = document.querySelector('.tool-activity-reveal');
  assert.ok(reveal, 'reveal container mounts on open');
  assert.equal(article.dataset.open, 'true');
  assert.equal(article.dataset.rendered, 'true');
  assert.equal(reveal.dataset.expanded, 'false', 'initial 0fr frame is committed before expanding');
  assert.equal(reveal.dataset.disclosureAnimating, 'true');

  // First rAF schedules the second rAF; still at 0fr.
  assert.equal(frames.length, 1);
  await act(async () => {
    frames.shift()();
  });
  assert.equal(reveal.dataset.expanded, 'false', 'first rAF keeps 0fr until the next frame');
  assert.equal(frames.length, 1);

  // Second rAF flips to 1fr.
  await act(async () => {
    frames.shift()();
  });
  assert.equal(reveal.dataset.expanded, 'true');
  assert.equal(reveal.dataset.disclosureAnimating, 'true');

  // Unrelated property transitionend must not clear animating.
  await act(async () => {
    reveal.dispatchEvent(makeTransitionEndEvent(window, 'opacity'));
  });
  assert.equal(reveal.dataset.disclosureAnimating, 'true');

  // Matching grid-template-rows transitionend settles the open transition.
  await act(async () => {
    reveal.dispatchEvent(makeTransitionEndEvent(window, 'grid-template-rows'));
  });
  assert.equal(reveal.dataset.disclosureAnimating, undefined);
  assert.equal(article.dataset.rendered, 'true');

  // Collapse: keeps mounted (data-rendered="true") until grid-template-rows transitionend.
  await act(async () => {
    document.querySelector('.tool-activity-header').click();
  });
  assert.equal(article.dataset.open, 'false');
  assert.equal(article.dataset.rendered, 'true');
  assert.equal(reveal.dataset.expanded, 'false');
  assert.equal(reveal.dataset.disclosureAnimating, 'true');
  assert.ok(document.querySelector('.tool-activity-reveal'));

  await act(async () => {
    reveal.dispatchEvent(makeTransitionEndEvent(window, 'grid-template-rows'));
  });
  assert.equal(document.querySelector('.tool-activity-reveal'), null);
  assert.equal(article.dataset.rendered, 'false');
});

test('ToolActivityItem keeps header flex children invariant and places FullToolOutputButton inside body-inner', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement', 'MouseEvent', 'Event'],
  });
  window.matchMedia = () => ({ matches: true });
  window.mixdogDesktop = {
    readTranscriptItem: async () => ({ id: 'call-item-1', result: 'full output' }),
  };

  const { ToolActivityGroup, resetToolDisclosureScope } = await import('./transcript-tool-ui.tsx');
  const scope = 'test-disclosure-item';
  resetToolDisclosureScope(scope);
  t.after(() => resetToolDisclosureScope(scope));

  const items = [
    {
      id: 'call-item-1',
      kind: 'tool',
      name: 'shell',
      args: { command: 'npm test', background: true },
      result: 'head\n[… 500 characters omitted …]\ntail',
      remoteOutputTruncated: 5000,
      status: 'done',
    },
  ];

  await act(async () => {
    root.render(React.createElement(ToolActivityGroup, { items, disclosureScope: scope }));
  });
  await act(async () => {
    document.querySelector('.tool-activity-header').click();
  });

  const item = document.querySelector('.tool-activity-item');
  const header = item.querySelector('.tool-activity-item-header');
  const snapshotHeader = () => ({
    children: [...header.children].map((node) => `${node.tagName}:${node.className}`),
    titleChildren: [...header.querySelector('.tool-activity-item-title').children].map((node) => node.tagName),
    text: header.textContent,
  });

  const closedHeader = snapshotHeader();
  assert.equal(header.querySelector('.tool-activity-item-meta'), null);

  await act(async () => {
    item.querySelector('.tool-activity-item-toggle').click();
  });

  assert.equal(item.dataset.open, 'true');
  assert.deepEqual(snapshotHeader(), closedHeader, 'header flex children stay invariant on expand');
  assert.equal(item.children.length, 2, 'item grid has only header and collapsing body (no 3rd implicit row)');
  assert.equal(item.children[0], header);
  assert.equal(item.children[1].className, 'tool-activity-item-body');

  const bodyInner = item.querySelector('.tool-activity-item-body-inner');
  assert.ok(bodyInner, 'body-inner is rendered');
  const fullButton = bodyInner.querySelector('button.tool-activity-preview-more');
  assert.ok(fullButton, 'FullToolOutputButton renders inside .tool-activity-item-body-inner');
  assert.equal(item.querySelector(':scope > button.tool-activity-preview-more'), null);
});

test('ceilRowHeight and row measurement round up to device-pixel boundaries', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
  });
  const { ceilRowHeight, measureTranscriptRow } = await import('./transcript-list-geometry.ts');
  const { useMountedRowMeasurement } = await import('./transcript-list-row-measure.ts');

  const setDpr = (dpr) => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });

  setDpr(1);
  assert.equal(ceilRowHeight(100), 100);
  assert.equal(ceilRowHeight(100.2), 101);
  assert.equal(ceilRowHeight(100.5), 101);
  assert.equal(ceilRowHeight(0), 0);

  setDpr(2);
  assert.equal(ceilRowHeight(100), 100);
  assert.equal(ceilRowHeight(100.2), 100.5);
  assert.equal(ceilRowHeight(100.5), 100.5);
  assert.equal(ceilRowHeight(100.6), 101);

  setDpr(1.1);
  assert.equal(ceilRowHeight(100), 100, 'exact integer does not drift upward under non-binary DPR');

  setDpr(2);
  const row = document.createElement('div');
  row.dataset.index = '0';
  row.dataset.timelineKey = 'row-0';
  const instance = {
    options: { anchorTo: 'end', getItemKey: () => 'row-0' },
    itemSizeCache: new Map(),
    measurementsCache: [{ key: 'row-0', index: 0, start: 0, end: 60, size: 60 }],
    indexFromElement: () => 0,
    resizeItem: (index, size) => {
      applied.push([index, size]);
      instance.itemSizeCache.set('row-0', size);
    },
  };
  const applied = [];
  const observed = measureTranscriptRow(row, { borderBoxSize: [{ blockSize: 42.2, inlineSize: 600 }] }, instance);
  assert.equal(observed, 42.5);
  assert.equal(row.style.getPropertyValue('--transcript-measured-height'), '42.5px');

  const spacer = document.createElement('div');
  row.getBoundingClientRect = () => ({ top: 0, left: 0, right: 600, bottom: 42.2, width: 600, height: 42.2 });
  spacer.append(row);
  document.body.append(spacer);
  function Harness() {
    useMountedRowMeasurement({
      rows: useRef([{ _tag: 'ToolActivity', key: 'row-0' }]).current,
      spacer: useRef(spacer),
      virtualizerRef: useRef(instance),
      baseResizeItem: useRef((index, size) => instance.resizeItem(index, size)),
      pendingResizes: useRef(new Map()),
      indexForPendingKey: (_key, hint) => hint,
      laidOutRows: useRef([]),
      pendingAnchor: useRef(null),
      anchorHold: useRef(null),
      restoreReadingAnchor() {},
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  assert.deepEqual(applied, [[0, 42.5]]);
});

test('useVirtualizerResizePatch calls synchronous endPin.now() on resize when anchored to end', async (t) => {
  const { root } = installTestDom(t, { rootId: 'root' });
  const { useVirtualizerResizePatch } = await import('./transcript-list-resize-patch.ts');
  const keys = ['row-0'];
  const calls = [];
  const core = {
    options: { anchorTo: 'end', followOnAppend: true, count: 1, getItemKey: (index) => keys[index] },
    elementsCache: new Map(),
    itemSizeCache: new Map([['row-0', 40]]),
    measurementsCache: [{ key: 'row-0', index: 0, start: 0, end: 40, size: 40 }],
    indexFromElement: () => 0,
    resizeItem: (index, size) => {
      core.itemSizeCache.set(keys[index], size);
      calls.push(`resize:${size}`);
    },
  };
  function Harness() {
    useVirtualizerResizePatch({
      virtualizer: core,
      viewport: { current: null },
      hasScrollGestureRef: useRef(() => false),
      visibleTop: () => 0,
      maxScrollTop: () => 0,
      endPin: {
        request: () => calls.push('endPin.request'),
        now: () => calls.push('endPin.now'),
      },
      resizePinned: useRef([]),
      resizePinFrame: useRef(0),
      pendingResizes: useRef(new Map()),
      baseResizeItem: useRef(null),
      applyingDeferred: useRef(false),
      scheduleResizeFlush() {},
      pendingAnchor: useRef(null),
      anchorHold: useRef(null),
      readingAnchorHeld: () => false,
      queueAnchorRestore() {},
      spacer: { current: null },
      rowsRef: useRef([{ _tag: 'ToolActivity', key: 'row-0' }]),
      scrollInset: useRef(0),
      indexForPendingKey: (_key, hint) => hint,
      restoreReadingAnchor() {},
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  core.resizeItem(0, 120);
  assert.deepEqual(calls, ['resize:120', 'endPin.now']);
});

test('touch deviation quantizes translateY to device pixels and lands on explicit disclosure clicks', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement', 'MouseEvent', 'Event'],
  });
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  const setDpr = (dpr) => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });

  const { createTouchScrollDeviation, useTouchScrollDeviation } = await import('./transcript-list-touch-deviation.ts');

  const viewport = document.createElement('div');
  const spacer = document.createElement('div');
  const button = document.createElement('button');
  button.className = 'tool-header tool-activity-header';
  button.setAttribute('aria-expanded', 'false');
  const plainText = document.createElement('p');
  spacer.append(button, plainText);
  viewport.append(spacer);
  document.body.append(viewport);

  let native = 200;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => native,
    set: (value) => {
      native = value;
    },
  });

  setDpr(2);
  const direct = createTouchScrollDeviation({
    getViewport: () => viewport,
    getSpacer: () => spacer,
    hasTouchScroll: () => true,
    clampAtEdge: () => false,
    markProgrammaticScroll() {},
  });
  assert.equal(direct.hold(212.3), true);
  assert.equal(spacer.style.transform, 'translateY(-12.5px)');
  assert.equal(spacer.style.marginBottom, '-12.5px');

  setDpr(1);
  assert.equal(direct.hold(212.3), true);
  assert.equal(spacer.style.transform, 'translateY(-12px)');
  assert.equal(spacer.style.marginBottom, '-12px');
  direct.drop();

  // Hook-managed disclosure click landing.
  let hookDeviation = null;
  function Harness() {
    hookDeviation = useTouchScrollDeviation({
      viewport: useRef(viewport),
      spacer: useRef(spacer),
      hasTouchScrollRef: useRef(() => true),
      touchHoldsRef: useRef(() => false),
      domTop: useRef(null),
      markProgrammaticScrollRef: useRef(undefined),
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  setDpr(2);
  assert.equal(hookDeviation.hold(218.2), true);
  assert.equal(spacer.style.transform, 'translateY(-18px)');

  // Clicking non-disclosure text keeps the hold intact.
  await act(async () => {
    plainText.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(hookDeviation.amount() > 0, true);

  // Clicking a disclosure header lands the deviation immediately.
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(hookDeviation.amount(), 0);
  assert.equal(spacer.style.transform, '');
  assert.equal(native, 218.2);
});

test('useTranscriptRowEstimates skips recording heights while a disclosure is mid-animation', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement'],
  });
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  const { useTranscriptRowEstimates } = await import('./transcript-list-estimates.ts');
  const { transcriptRowHeightStore } = await import('./transcript-row-estimates.ts');
  const { TRANSCRIPT_COLLAPSED_TOOL_ROW_PX, TRANSCRIPT_PART_STEP_PX } = await import('./transcript-virtual-cache.ts');

  const WIDTH = 749;
  const rows = [
    { _tag: 'ToolActivity', key: 'anim:1', turnKey: 't1', items: [{ id: 'a1', kind: 'tool', name: 'read' }] },
    { _tag: 'ToolActivity', key: 'anim:2', turnKey: 't2', items: [{ id: 'a2', kind: 'tool', name: 'read' }] },
  ];
  const rowsRef = { current: rows };
  let estimates;
  function Probe() {
    estimates = useTranscriptRowEstimates({
      rowsRef,
      viewport: { current: null },
      hasScrollGestureRef: { current: () => false },
      surfaceRef: { current: 'coding' },
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  estimates.timelineWidth.current = WIDTH;

  const instance = {
    indexFromElement: (element) => Number(element.dataset.index),
    options: { getItemKey: (index) => rowsRef.current[index].key, anchorTo: 'start' },
    itemSizeCache: new Map(),
    measurementsCache: [],
  };

  const rowEl = document.createElement('div');
  rowEl.dataset.index = '0';
  const reveal = document.createElement('div');
  reveal.className = 'tool-activity-reveal';
  reveal.setAttribute('data-disclosure-animating', 'true');
  rowEl.append(reveal);

  // Mid-animation measurement returns the live height but must NOT teach the height store.
  const midHeight = estimates.measureRowSize(
    rowEl,
    { borderBoxSize: [{ blockSize: 137, inlineSize: WIDTH }] },
    instance
  );
  assert.equal(midHeight, 137);
  assert.equal(transcriptRowHeightStore().knows(rows[1], WIDTH, 'coding', ''), false);
  assert.equal(estimates.estimateRow(1), TRANSCRIPT_COLLAPSED_TOOL_ROW_PX + TRANSCRIPT_PART_STEP_PX);

  // Once transitionend clears the attribute, the settled height is recorded.
  reveal.removeAttribute('data-disclosure-animating');
  const settledHeight = estimates.measureRowSize(
    rowEl,
    { borderBoxSize: [{ blockSize: 210, inlineSize: WIDTH }] },
    instance
  );
  assert.equal(settledHeight, 210);
  assert.equal(transcriptRowHeightStore().knows(rows[1], WIDTH, 'coding', ''), true);
  assert.equal(transcriptRowHeightStore().estimate(rows[1], WIDTH, 'coding', ''), 210);
});

test('re-opening mid-collapse keeps data-disclosure-animating set across stale collapse transitionend and double-rAF', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement', 'MouseEvent', 'Event'],
  });
  const frames = [];
  window.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = () => ({ matches: false });

  const { ToolActivityGroup, resetToolDisclosureScope } = await import('./transcript-tool-ui.tsx');
  const scope = 'test-disclosure-reopen-race';
  resetToolDisclosureScope(scope);
  t.after(() => resetToolDisclosureScope(scope));

  const items = [
    {
      id: 'call-reopen-1',
      kind: 'tool',
      name: 'shell',
      args: { command: 'echo reopen' },
      result: 'reopen\n',
      status: 'done',
    },
  ];

  await act(async () => {
    root.render(React.createElement(ToolActivityGroup, { items, disclosureScope: scope }));
  });

  const header = document.querySelector('.tool-activity-header');
  // Open and settle via double-rAF + transitionend.
  await act(async () => {
    header.click();
  });
  await act(async () => {
    frames.shift()();
  });
  await act(async () => {
    frames.shift()();
  });
  const reveal = document.querySelector('.tool-activity-reveal');
  await act(async () => {
    reveal.dispatchEvent(makeTransitionEndEvent(window, 'grid-template-rows'));
  });
  assert.equal(reveal.dataset.expanded, 'true');
  assert.equal(reveal.dataset.disclosureAnimating, undefined);

  // Start collapsing (expanded -> false, animating -> true).
  await act(async () => {
    header.click();
  });
  assert.equal(reveal.dataset.expanded, 'false');
  assert.equal(reveal.dataset.disclosureAnimating, 'true');

  // Re-open before collapse transitionend arrives.
  await act(async () => {
    header.click();
  });
  assert.equal(reveal.dataset.expanded, 'false', 'waiting for double-rAF');
  assert.equal(reveal.dataset.disclosureAnimating, 'true');
  assert.equal(frames.length, 1);

  // Finishing collapse fires grid-template-rows transitionend before double-rAF runs.
  await act(async () => {
    reveal.dispatchEvent(makeTransitionEndEvent(window, 'grid-template-rows'));
  });
  assert.equal(reveal.dataset.disclosureAnimating, 'true', 'stale collapse transitionend must not clear animating');
  assert.ok(document.querySelector('.tool-activity-reveal'), 'reveal stays mounted for pending re-open');

  // Flush double-rAF to start expand.
  await act(async () => {
    frames.shift()();
  });
  await act(async () => {
    frames.shift()();
  });
  assert.equal(reveal.dataset.expanded, 'true');
  assert.equal(reveal.dataset.disclosureAnimating, 'true', 'animating stays set during the expand transition');

  // Expand transition finishes cleanly.
  await act(async () => {
    reveal.dispatchEvent(makeTransitionEndEvent(window, 'grid-template-rows'));
  });
  assert.equal(reveal.dataset.disclosureAnimating, undefined);
});

test('applyMountedRowSizes coalesces endPin.now() once per multi-row batch while standalone resizeItem stays synchronous', async (t) => {
  const { root, document } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
  });
  const { useVirtualizerResizePatch } = await import('./transcript-list-resize-patch.ts');
  const { useMountedRowMeasurement } = await import('./transcript-list-row-measure.ts');

  const keys = ['row-0', 'row-1', 'row-2'];
  const heights = [90, 110, 130];
  const spacer = document.createElement('div');
  keys.forEach((key, index) => {
    const row = document.createElement('div');
    row.className = 'transcript-virtual-row';
    row.dataset.index = String(index);
    row.dataset.timelineKey = key;
    row.append(document.createElement('div'));
    row.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 600,
      bottom: heights[index],
      width: 600,
      height: heights[index],
    });
    spacer.append(row);
  });
  document.body.append(spacer);

  const calls = [];
  const core = {
    options: { anchorTo: 'end', followOnAppend: true, count: keys.length, getItemKey: (index) => keys[index] },
    elementsCache: new Map(),
    itemSizeCache: new Map(),
    measurementsCache: keys.map((key, index) => ({ key, index, start: index * 60, end: index * 60 + 60, size: 60 })),
    indexFromElement: (element) => Number(element.dataset.index),
    resizeItem: (index, size) => {
      core.itemSizeCache.set(keys[index], size);
      calls.push(`resize:${index}:${size}`);
    },
  };

  function Harness() {
    const virtualizerRef = useRef(core);
    const spacerRef = useRef(spacer);
    const pendingResizes = useRef(new Map());
    const baseResizeItem = useRef(null);
    const rowsRef = useRef(keys.map((key) => ({ _tag: 'ToolActivity', key })));
    const pendingAnchor = useRef(null);
    const anchorHold = useRef(null);
    useVirtualizerResizePatch({
      virtualizer: core,
      viewport: { current: null },
      hasScrollGestureRef: useRef(() => false),
      visibleTop: () => 0,
      maxScrollTop: () => 0,
      endPin: {
        request: () => calls.push('endPin.request'),
        now: () => calls.push('endPin.now'),
      },
      resizePinned: useRef([]),
      resizePinFrame: useRef(0),
      pendingResizes,
      baseResizeItem,
      applyingDeferred: useRef(false),
      scheduleResizeFlush() {},
      pendingAnchor,
      anchorHold,
      readingAnchorHeld: () => false,
      queueAnchorRestore() {},
      spacer: spacerRef,
      rowsRef,
      scrollInset: useRef(0),
      indexForPendingKey: (_key, hint) => hint,
      restoreReadingAnchor() {},
    });
    useMountedRowMeasurement({
      rows: rowsRef.current,
      spacer: spacerRef,
      virtualizerRef,
      baseResizeItem,
      pendingResizes,
      indexForPendingKey: (_key, hint) => hint,
      laidOutRows: useRef([]),
      pendingAnchor,
      anchorHold,
      restoreReadingAnchor() {},
    });
    return null;
  }

  await act(async () => root.render(React.createElement(Harness)));
  assert.deepEqual(
    calls,
    ['resize:0:90', 'resize:1:110', 'resize:2:130', 'endPin.now'],
    'three mounted row resizes coalesce into a single synchronous endPin.now() at the end of the batch'
  );

  // Standalone resizeItem (e.g. from ResizeObserver) still pins synchronously right away.
  calls.length = 0;
  core.resizeItem(1, 180);
  assert.deepEqual(calls, ['resize:1:180', 'endPin.now']);
});

test('automatic ToolActivityGroup open from incoming live call bypasses 2-rAF while user clicks still animate', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement', 'MouseEvent', 'Event', 'CustomEvent'],
  });
  const frames = [];
  window.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = () => ({ matches: false });

  const { setToolActivityExpansion } = await import('./tool-activity-expansion.ts');
  const { ToolActivityGroup, resetToolDisclosureScope } = await import('./transcript-tool-ui.tsx');
  const scope = 'test-auto-open-instant';
  setToolActivityExpansion('commands');
  resetToolDisclosureScope(scope);

  try {
    const readCall = { id: 'c1', kind: 'tool', name: 'read', args: { path: 'a.ts' }, result: 'ok', status: 'done' };
    const shellCall = { id: 'c2', kind: 'tool', name: 'shell', args: { command: 'echo hi' }, status: 'running' };

    await act(async () => {
      root.render(React.createElement(ToolActivityGroup, { items: [readCall], disclosureScope: scope, running: true }));
    });
    assert.equal(document.querySelector('.tool-activity')?.getAttribute('data-open'), 'false');
    assert.equal(document.querySelector('.tool-activity-reveal'), null);

    // Incoming expanding live call opens immediately without scheduling 2-rAF.
    await act(async () => {
      root.render(
        React.createElement(ToolActivityGroup, { items: [readCall, shellCall], disclosureScope: scope, running: true })
      );
    });
    const reveal = document.querySelector('.tool-activity-reveal');
    assert.ok(reveal, 'group body mounts immediately on automatic live open');
    assert.equal(reveal.getAttribute('data-expanded'), 'true', 'expanded immediately without 2-rAF');
    assert.equal(reveal.getAttribute('data-disclosure-animating'), null, 'no disclosure animation flag on auto open');
    assert.equal(frames.length, 0, 'no rAF frames queued for automatic open');

    // User click collapse and re-open still animates via 2-rAF.
    const header = document.querySelector('.tool-activity-header');
    await act(async () => {
      header.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(document.querySelector('.tool-activity-reveal')?.getAttribute('data-disclosure-animating'), 'true');
    await act(async () => {
      header.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(frames.length > 0, 'user click re-open still schedules rAF animation');
  } finally {
    setToolActivityExpansion('collapsed');
    resetToolDisclosureScope(scope);
  }
});
