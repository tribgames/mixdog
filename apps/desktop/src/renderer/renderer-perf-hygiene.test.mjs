import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { mirrorTextareaBox, useComposerSkillHighlight } from './composer-skill-mentions.tsx';
import { PaneDockDiffColumn } from './pane-dock-diff-column.tsx';
import { useDiffColumnResize, useDockCellWidth } from './pane-side-dock-hooks.ts';
import { resolveDockLayout } from './pane-side-dock-layout.ts';
import { PaneSplitLayout } from './PaneSplitLayout.tsx';
import { SettingsView } from './settings/SettingsView.tsx';

const rendererDir = path.dirname(fileURLToPath(import.meta.url));

test('mirrorTextareaBox reads geometry before style writes and caches static computed styles across keystrokes', async (t) => {
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'HTMLTextAreaElement', 'HTMLDivElement', 'MutationObserver'],
  });

  const events = [];
  const source = document.createElement('textarea');
  const layer = document.createElement('div');
  document.body.append(source, layer);

  const dims = { offsetWidth: 320, clientWidth: 304, offsetLeft: 12, offsetTop: 8, offsetHeight: 64, scrollTop: 0 };
  for (const prop of ['offsetWidth', 'clientWidth', 'offsetLeft', 'offsetTop', 'offsetHeight']) {
    Object.defineProperty(source, prop, {
      configurable: true,
      get() {
        events.push(`read:${prop}`);
        return dims[prop];
      },
    });
  }
  Object.defineProperty(source, 'scrollTop', {
    configurable: true,
    get() {
      events.push('read:scrollTop');
      return dims.scrollTop;
    },
    set(value) {
      dims.scrollTop = value;
    },
  });

  const rawStyle = layer.style;
  const styleProxy = new Proxy(rawStyle, {
    set(target, prop, value) {
      events.push(`write:${String(prop)}`);
      target[prop] = value;
      return true;
    },
  });
  Object.defineProperty(layer, 'style', { configurable: true, get: () => styleProxy });

  let computedStyleCalls = 0;
  let currentFontSize = '14px';
  window.getComputedStyle = () => {
    computedStyleCalls += 1;
    events.push('read:getComputedStyle');
    return {
      boxSizing: 'border-box',
      direction: 'ltr',
      fontFamily: 'sans-serif',
      fontSize: currentFontSize,
      fontStyle: 'normal',
      fontWeight: '400',
      fontStretch: 'normal',
      fontVariant: 'normal',
      fontKerning: 'auto',
      fontFeatureSettings: 'normal',
      fontVariationSettings: 'normal',
      fontOpticalSizing: 'auto',
      lineHeight: '20px',
      letterSpacing: '0px',
      wordSpacing: '0px',
      textIndent: '0px',
      textTransform: 'none',
      textRendering: 'auto',
      tabSize: '2',
      whiteSpace: 'pre-wrap',
      wordBreak: 'normal',
      overflowWrap: 'break-word',
      lineBreak: 'auto',
      hyphens: 'none',
      paddingTop: '8px',
      paddingBottom: '8px',
      paddingLeft: '10px',
      paddingRight: '10px',
      borderTopWidth: '1px',
      borderRightWidth: '1px',
      borderBottomWidth: '1px',
      borderLeftWidth: '1px',
      borderTopStyle: 'solid',
      borderRightStyle: 'solid',
      borderBottomStyle: 'solid',
      borderLeftStyle: 'solid',
    };
  };

  mirrorTextareaBox(source, layer);
  const firstWrite = events.findIndex((entry) => entry.startsWith('write:'));
  const lastRead = events.findLastIndex((entry) => entry.startsWith('read:'));
  assert.ok(firstWrite > 0 && lastRead < firstWrite, 'all geometry and style reads precede every layer.style write');
  assert.equal(computedStyleCalls, 1);

  events.length = 0;
  mirrorTextareaBox(source, layer);
  assert.equal(computedStyleCalls, 1, 'unchanged typing reuses cached computed styles');
  assert.equal(
    events.filter((entry) => entry.startsWith('write:')).length,
    0,
    'unchanged geometry performs zero style writes'
  );

  // Hook integration: typing characters with active $skill does not re-read getComputedStyle,
  // while ResizeObserver, theme attribute mutation, and font load refresh cached styles.
  const resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(cb) {
      resizeCallbacks.push(cb);
    }
    observe() {}
    disconnect() {}
  };
  const fontListeners = new Set();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      addEventListener(type, fn) {
        if (type === 'loadingdone') fontListeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === 'loadingdone') fontListeners.delete(fn);
      },
    },
  });

  computedStyleCalls = 0;
  const isSkill = (name) => name === 'review';
  function Harness({ text }) {
    const ref = useRef(null);
    const { layer: highlightLayer } = useComposerSkillHighlight({ textarea: ref, text, isSkill, disabled: false });
    return React.createElement(
      'div',
      null,
      React.createElement('textarea', { ref, value: text, readOnly: true }),
      highlightLayer
    );
  }

  await act(async () => root.render(React.createElement(Harness, { text: '$review check' })));
  assert.equal(computedStyleCalls, 1, 'initial active render populates style cache once');

  await act(async () => root.render(React.createElement(Harness, { text: '$review check more' })));
  await act(async () => root.render(React.createElement(Harness, { text: '$review check more text' })));
  assert.equal(computedStyleCalls, 1, 'typing characters does not call getComputedStyle again');

  currentFontSize = '16px';
  await act(async () => {
    for (const cb of resizeCallbacks) cb();
  });
  assert.equal(computedStyleCalls, 2, 'ResizeObserver refreshes cached styles');
  assert.equal(document.querySelector('.composer-skill-highlight')?.style.fontSize, '16px');

  currentFontSize = '18px';
  await act(async () => {
    document.documentElement.setAttribute('data-mixdog-theme', 'dark');
    await Promise.resolve();
  });
  assert.equal(computedStyleCalls, 3, 'theme attribute change refreshes cached styles');
  assert.equal(document.querySelector('.composer-skill-highlight')?.style.fontSize, '18px');

  currentFontSize = '20px';
  await act(async () => {
    for (const listener of fontListeners) listener();
  });
  assert.equal(computedStyleCalls, 4, 'font loadingdone event refreshes cached styles');
  assert.equal(document.querySelector('.composer-skill-highlight')?.style.fontSize, '20px');
});

test('useDockCellWidth coalesces ResizeObserver callbacks onto one rAF without flushSync', async (t) => {
  const resizeCallbacks = [];
  const frames = [];
  const { window, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
    globals: {
      ResizeObserver: class {
        constructor(cb) {
          resizeCallbacks.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    },
  });
  window.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = () => {};

  let cellWidthValue = 800;
  let observedWidths = [];
  function Harness() {
    const hostRef = useRef(null);
    const width = useDockCellWidth(hostRef, true);
    observedWidths.push(width);
    return React.createElement(
      'div',
      {
        ref: (node) => {
          if (node) {
            Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => cellWidthValue });
          }
        },
      },
      React.createElement('div', { ref: hostRef })
    );
  }

  await act(async () => root.render(React.createElement(Harness)));
  assert.equal(observedWidths.at(-1), 800, 'initial layout measure runs before first paint');
  observedWidths = [];

  cellWidthValue = 720;
  resizeCallbacks[0]();
  cellWidthValue = 640;
  resizeCallbacks[0]();
  assert.equal(observedWidths.length, 0, 'ResizeObserver does not flushSync synchronously');
  assert.equal(frames.length, 1, 'multiple ResizeObserver fires schedule only one rAF');

  await act(async () => {
    frames.shift()(16);
  });
  assert.deepEqual(observedWidths, [640], 'coalesced rAF commits latest width once');
});

test('useDiffColumnResize previews via rAF CSS var, commits on pointerup, reverts on cancel, and applies arrow keys immediately', async (t) => {
  const frames = [];
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
    globals: {
      requestAnimationFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelAnimationFrame: () => {},
    },
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

  const setPrefCalls = [];
  const commitCalls = [];
  function Harness() {
    const [diffPref, setDiffPrefState] = React.useState(480);
    const props = useDiffColumnResize({
      diffPref,
      setDiffPref: (next) => {
        setPrefCalls.push(next);
        setDiffPrefState(next);
      },
      getDiffWidth: () => diffPref,
      minWidth: 240,
      maxWidth: 900,
      commitWidth: (next) => commitCalls.push(next),
    });
    return React.createElement(
      'div',
      { className: 'pane-dock-diff-column', style: { '--pane-dock-diff-width': `${diffPref}px` } },
      React.createElement('div', { className: 'pane-dock-diff-resize', tabIndex: 0, ...props })
    );
  }

  await act(async () => root.render(React.createElement(Harness)));
  const col = document.querySelector('.pane-dock-diff-column');
  const handle = document.querySelector('.pane-dock-diff-resize');
  let captured = false;
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => {
    captured = false;
  };

  const ptr = (type, clientX) => {
    const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  };

  await act(async () => {
    handle.dispatchEvent(ptr('pointerdown', 600));
    handle.dispatchEvent(ptr('pointermove', 560));
    handle.dispatchEvent(ptr('pointermove', 520));
  });
  assert.equal(setPrefCalls.length, 0, 'pointermove does not commit React state');
  assert.equal(commitCalls.length, 0);
  assert.equal(frames.length, 1, 'batches drag previews to a single rAF');

  frames.shift()(16);
  assert.equal(col.style.getPropertyValue('--pane-dock-diff-width'), '560px', 'rAF applies live CSS variable preview');

  await act(async () => {
    handle.dispatchEvent(ptr('pointerup', 520));
  });
  assert.deepEqual(setPrefCalls, [560], 'pointerup commits React state once');
  assert.deepEqual(commitCalls, [560], 'pointerup persists width once');

  // Pointer cancel reverts live preview without committing.
  setPrefCalls.length = 0;
  commitCalls.length = 0;
  await act(async () => {
    handle.dispatchEvent(ptr('pointerdown', 600));
    handle.dispatchEvent(ptr('pointermove', 500));
  });
  frames.shift()(16);
  assert.equal(col.style.getPropertyValue('--pane-dock-diff-width'), '660px');
  await act(async () => {
    handle.dispatchEvent(ptr('pointercancel', 500));
  });
  assert.equal(col.style.getPropertyValue('--pane-dock-diff-width'), '560px', 'cancel restores container CSS var');
  assert.deepEqual(commitCalls, []);

  // Keyboard arrow resizing remains immediate.
  setPrefCalls.length = 0;
  commitCalls.length = 0;
  await act(async () => {
    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  });
  assert.deepEqual(setPrefCalls, [584]);
  assert.deepEqual(commitCalls, [584]);
});

test('useDiffColumnResize clamps live preview to pane bounds and restores clamped React width on pointerup', async (t) => {
  const frames = [];
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
    globals: {
      requestAnimationFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelAnimationFrame: () => {},
    },
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

  // Pane cell is 800px wide; overlayRoom = 800 - 48 = 752; panelPref = 400 -> diffWidth clamped to 352px.
  const cellWidth = 800;
  const panelPref = 400;
  const commitCalls = [];
  function ClampedHarness() {
    const [diffPref, setDiffPref] = React.useState(450);
    const layout = resolveDockLayout({
      cellWidth,
      room: cellWidth - 360 - 4,
      openNow: true,
      mobileSheet: false,
      diffShowing: true,
      sessionSurfaceShowing: false,
      sessionMin: 240,
      sessionPref: panelPref,
      panelPref,
      diffPref,
    });
    const resizeProps = useDiffColumnResize({
      diffPref,
      setDiffPref,
      getDiffWidth: () => layout.diffWidth,
      minWidth: 240,
      maxWidth: 900,
      commitWidth: (next) => commitCalls.push(next),
    });
    return React.createElement(
      'div',
      {
        className: 'pane-cell',
        ref: (node) => {
          if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => cellWidth });
        },
      },
      React.createElement(
        'div',
        {
          className: 'pane-side-dock',
          ref: (node) => {
            if (node) {
              Object.defineProperty(node, 'clientWidth', {
                configurable: true,
                get: () => layout.baseAsideWidth + layout.diffWidth,
              });
            }
          },
        },
        React.createElement(
          PaneDockDiffColumn,
          { showing: true, width: layout.diffWidth, resizeProps },
          React.createElement('div', null, 'diff')
        )
      )
    );
  }

  await act(async () => root.render(React.createElement(ClampedHarness)));
  const col = document.querySelector('.pane-dock-diff-column');
  const handle = document.querySelector('.pane-dock-diff-resize');
  assert.equal(handle.getAttribute('tabindex'), '0', 'PaneDockDiffColumn separator is keyboard-focusable');
  handle.focus();
  assert.equal(document.activeElement, handle, 'PaneDockDiffColumn separator receives keyboard focus');
  assert.equal(col.style.getPropertyValue('--pane-dock-diff-width'), '352px');

  let captured = false;
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => {
    captured = false;
  };
  const ptr = (type, clientX) => {
    const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX });
    Object.defineProperty(event, 'pointerId', { value: 2 });
    return event;
  };

  // Drag far left (attempting to grow diff column to 752px, far past 352px layout cap).
  await act(async () => {
    handle.dispatchEvent(ptr('pointerdown', 600));
    handle.dispatchEvent(ptr('pointermove', 200));
  });
  frames.shift()(16);
  assert.equal(
    col.style.getPropertyValue('--pane-dock-diff-width'),
    '352px',
    'live drag preview clamps to the pane layout ceiling instead of overflowing'
  );

  // Even if DOM had a different preview width before release (e.g. slightly looser bound),
  // pointerup restores React-controlled width when resolveDockLayout clamps diffWidth identically.
  col.style.setProperty('--pane-dock-diff-width', '650px');
  await act(async () => {
    handle.dispatchEvent(ptr('pointerup', 200));
  });
  assert.equal(commitCalls.length, 1);
  assert.equal(
    col.style.getPropertyValue('--pane-dock-diff-width'),
    '352px',
    'pointerup never leaves .pane-dock-diff-column stuck at an unclamped width'
  );
});

test('PaneResizeHandle applies rAF-batched styles during drag, rolls back on cancel/lost capture, and commits on pointerup/keyboard', async (t) => {
  const frames = [];
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
    globals: {
      requestAnimationFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelAnimationFrame: () => {},
    },
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

  const ratios = [];
  let setParentRatio;
  function Harness() {
    const [ratio, setRatio] = React.useState(0.5);
    setParentRatio = setRatio;
    const node = {
      type: 'split',
      direction: 'row',
      ratio,
      first: { type: 'leaf', id: 'a', tabs: [], activeTabKey: '' },
      second: { type: 'leaf', id: 'b', tabs: [], activeTabKey: '' },
    };
    return React.createElement(PaneSplitLayout, {
      node,
      renderLeaf: (leaf) => React.createElement('div', null, leaf.id),
      onRatioChange: (_path, next) => {
        ratios.push(next);
        setRatio(next);
      },
    });
  }
  await act(async () => root.render(React.createElement(Harness)));

  const split = document.querySelector('.pane-split');
  const [firstCell, secondCell] = document.querySelectorAll('.pane-split-cell');
  const handle = document.querySelector('.pane-resize-handle');
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('tabindex'), '0', 'PaneResizeHandle separator is keyboard-focusable');
  split.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
  let captured = false;
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => {
    if (!captured) return;
    captured = false;
    // Simulate Chromium dispatching lostpointercapture upon releasePointerCapture.
    const lost = new window.Event('lostpointercapture', { bubbles: true });
    Object.defineProperty(lost, 'pointerId', { value: 7 });
    handle.dispatchEvent(lost);
  };
  const ptr = (type, clientX) => {
    const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    return event;
  };

  // Normal drag + pointerup (even with releasePointerCapture firing lostpointercapture) commits once.
  await act(async () => {
    handle.dispatchEvent(ptr('pointerdown', 500));
    handle.dispatchEvent(ptr('pointermove', 600));
    handle.dispatchEvent(ptr('pointermove', 650));
  });
  assert.equal(ratios.length, 0, 'pointermove does not call onRatioChange');
  assert.equal(frames.length, 1, 'drag preview coalesces onto a single rAF');

  frames.shift()(16);
  assert.equal(split.style.getPropertyValue('--pane-split-ratio'), '0.65');
  assert.equal(firstCell.style.flex, '0.65 1 0%');
  assert.equal(secondCell.style.flex, '0.35 1 0%');

  await act(async () => {
    handle.dispatchEvent(ptr('pointerup', 650));
  });
  assert.deepEqual(ratios, [0.65], 'pointerup commits ratio once even when release fires lostpointercapture');
  assert.equal(split.style.getPropertyValue('--pane-split-ratio'), '');
  assert.equal(firstCell.style.flex, '0.65 1 0%', 'committed release is not rolled back by lostpointercapture');

  // Reset ratio via React state before testing cancel/lostpointercapture rollback.
  await act(async () => {
    setParentRatio(0.5);
  });
  ratios.length = 0;

  // pointercancel rolls back flex styles without committing.
  await act(async () => {
    handle.dispatchEvent(ptr('pointerdown', 500));
    handle.dispatchEvent(ptr('pointermove', 620));
  });
  frames.shift()(16);
  assert.equal(firstCell.style.flex, '0.62 1 0%');
  assert.equal(secondCell.style.flex, '0.38 1 0%');
  await act(async () => {
    handle.dispatchEvent(ptr('pointercancel', 620));
  });
  assert.deepEqual(ratios, [], 'pointercancel does not commit onRatioChange');
  assert.equal(split.style.getPropertyValue('--pane-split-ratio'), '');
  assert.equal(firstCell.style.flex, '0.5 1 0%', 'pointercancel restores first cell flex');
  assert.equal(secondCell.style.flex, '0.5 1 0%', 'pointercancel restores second cell flex');

  // lostpointercapture without pointerup rolls back flex styles without committing.
  await act(async () => {
    handle.dispatchEvent(ptr('pointerdown', 500));
    handle.dispatchEvent(ptr('pointermove', 380));
  });
  frames.shift()(16);
  assert.equal(firstCell.style.flex, '0.38 1 0%');
  await act(async () => {
    captured = false;
    const lost = new window.Event('lostpointercapture', { bubbles: true });
    Object.defineProperty(lost, 'pointerId', { value: 7 });
    handle.dispatchEvent(lost);
  });
  assert.deepEqual(ratios, [], 'lostpointercapture without pointerup does not commit onRatioChange');
  assert.equal(split.style.getPropertyValue('--pane-split-ratio'), '');
  assert.equal(firstCell.style.flex, '0.5 1 0%', 'lostpointercapture restores first cell flex');
  assert.equal(secondCell.style.flex, '0.5 1 0%', 'lostpointercapture restores second cell flex');

  // Keyboard arrow resizing works when focused and commits immediately.
  handle.focus();
  assert.equal(document.activeElement, handle, 'PaneResizeHandle receives keyboard focus');
  await act(async () => {
    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  assert.equal(ratios.length, 1);
  assert.ok(ratios[0] > 0.5, 'ArrowRight increases split ratio immediately');
});

test('SettingsView defers non-active tab IPC warmups until idle time after first paint', async (t) => {
  const frames = [];
  const idleCallbacks = [];
  const { window, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'HTMLButtonElement', 'Node', 'Element', 'MutationObserver'],
  });
  window.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = () => {};
  window.requestIdleCallback = (cb) => {
    idleCallbacks.push(cb);
    return idleCallbacks.length;
  };
  window.cancelIdleCallback = () => {};

  const calls = [];
  const api = {
    readCapabilities: async (requests) => {
      for (const req of requests) calls.push(`cap:${req.capability}`);
      return requests.map(() => ({ ok: true, value: null }));
    },
    invokeCapability: async ({ capability }) => {
      calls.push(`invoke:${capability}`);
      return { value: null, snapshot: null };
    },
    getRemoteAccessInfo: async () => {
      calls.push('remoteAccessInfo');
      return null;
    },
    githubCliStatus: async () => {
      calls.push('githubCliStatus');
      return null;
    },
    getRemoteAccessSettings: async () => {
      calls.push('remoteAccessSettings');
      return null;
    },
    subscribeRemoteAccessSettings: () => () => {},
    listRemoteHosts: async () => [],
    listProviderModels: async () => {
      calls.push('listProviderModels');
      return [];
    },
    getSnapshot: async () => null,
    getUpdaterState: async () => ({ status: 'idle' }),
    subscribeState: () => () => {},
    subscribeUpdaterState: () => () => {},
  };

  await act(async () =>
    root.render(React.createElement(SettingsView, { api, open: true, initialSection: 'shortcuts', onClose: () => {} }))
  );
  assert.equal(calls.includes('remoteAccessInfo'), false, 'non-active Connection IPC deferred before first paint');
  assert.equal(calls.includes('githubCliStatus'), false, 'non-active Git IPC deferred before first paint');
  assert.ok(frames.length > 0, 'schedules post-paint animation frame');

  await act(async () => {
    while (frames.length) frames.shift()(16);
  });
  assert.equal(calls.includes('remoteAccessInfo'), false, 'still waits for idle callback after first paint');
  assert.equal(calls.includes('githubCliStatus'), false, 'Git warmup still waits for idle callback');
  assert.ok(idleCallbacks.length > 0, 'schedules idle warmup callback after first paint');

  await act(async () => {
    while (idleCallbacks.length) idleCallbacks.shift()({ didTimeout: false, timeRemaining: () => 50 });
  });
  assert.equal(calls.includes('remoteAccessInfo'), true, 'deferred Connection warmup runs during idle');
  assert.equal(calls.includes('githubCliStatus'), true, 'deferred Git warmup runs during idle');
});

test('33-skin.css uses lightweight translucent surface styling without backdrop-filter on user message bubbles', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'desktop', '33-skin.css'), 'utf8');
  const userBubbleBlocks = [...css.matchAll(/html\[data-mixdog-skin\][^{]*\.message\.user[^{]*\{([^}]*)\}/g)];
  assert.ok(userBubbleBlocks.length > 0, 'user message bubble skin rules exist');
  for (const [, body] of userBubbleBlocks) {
    assert.doesNotMatch(body, /(?:-webkit-)?backdrop-filter\s*:/i, 'no backdrop-filter on per-message user bubble');
  }
});
