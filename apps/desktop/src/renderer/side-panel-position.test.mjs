import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  getSidePanelPosition,
  normalizeSidePanelPosition,
  resolveSidePanelPlacement,
  setSidePanelPosition,
  SIDE_PANEL_AUTO_BOTTOM_MAX_WIDTH,
  subscribeSidePanelPosition,
} from './side-panel-preferences.ts';
import {
  clampPaneDockHeight,
  PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR,
  PANE_SIDE_DOCK_MIN_HEIGHT,
  paneDockResizeAxis,
} from './pane-side-dock-hooks.ts';
import { PaneSideDock } from './pane-side-dock.tsx';

const POSITION_KEY = 'mixdog.desktop.side-panel-position.v1';
const HEIGHT_KEY = 'mixdog.desktop.pane-side-dock-height.v1';

function dom() {
  return installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
}

test('side panel position persists and unknown values normalize to right', () => {
  const { dom: jsdom, restore } = dom();
  try {
    assert.equal(normalizeSidePanelPosition('bottom'), 'bottom');
    assert.equal(normalizeSidePanelPosition('auto'), 'auto');
    assert.equal(normalizeSidePanelPosition('left'), 'right');
    assert.equal(normalizeSidePanelPosition(null), 'right');
    assert.equal(normalizeSidePanelPosition(3), 'right');
    assert.equal(getSidePanelPosition(), 'right');
    jsdom.window.localStorage.setItem(POSITION_KEY, 'sideways');
    assert.equal(getSidePanelPosition(), 'right');

    let changes = 0;
    const unsubscribe = subscribeSidePanelPosition(() => changes++);
    assert.equal(setSidePanelPosition('bottom'), true);
    assert.equal(jsdom.window.localStorage.getItem(POSITION_KEY), 'bottom');
    assert.equal(getSidePanelPosition(), 'bottom');
    setSidePanelPosition('auto');
    assert.equal(getSidePanelPosition(), 'auto');
    unsubscribe();
    setSidePanelPosition('bogus');
    assert.equal(jsdom.window.localStorage.getItem(POSITION_KEY), 'right');
    assert.equal(changes, 2);
  } finally {
    restore();
  }
});

test('placement follows the mode, and Auto docks below on narrow or portrait windows', () => {
  assert.equal(resolveSidePanelPlacement('right', 800, 1200), 'right');
  assert.equal(resolveSidePanelPlacement('bottom', 2560, 1440), 'bottom');
  assert.equal(resolveSidePanelPlacement('auto', 1920, 1080), 'right');
  assert.equal(resolveSidePanelPlacement('auto', SIDE_PANEL_AUTO_BOTTOM_MAX_WIDTH, 800), 'right');
  assert.equal(resolveSidePanelPlacement('auto', SIDE_PANEL_AUTO_BOTTOM_MAX_WIDTH - 1, 800), 'bottom');
  // Portrait wins even on a wide window.
  assert.equal(resolveSidePanelPlacement('auto', 1440, 2560), 'bottom');
  assert.equal(resolveSidePanelPlacement('auto', 1440, 1440), 'right');
});

test('the resize edge drags width on the right and height below; height leaves the chat its floor', () => {
  assert.equal(paneDockResizeAxis('right'), 'width');
  assert.equal(paneDockResizeAxis('bottom'), 'height');
  assert.equal(clampPaneDockHeight(320, null), 320);
  assert.equal(clampPaneDockHeight(320, 0), PANE_SIDE_DOCK_MIN_HEIGHT, 'a measured zero holds the floor');
  assert.equal(clampPaneDockHeight(10, 900), PANE_SIDE_DOCK_MIN_HEIGHT);
  assert.equal(clampPaneDockHeight(5000, 900), 900 - PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR);
  assert.equal(clampPaneDockHeight(5000, 200), PANE_SIDE_DOCK_MIN_HEIGHT);
  assert.equal(clampPaneDockHeight(Number.NaN, null), 320);
});

async function renderDockInCell(position) {
  const { dom: jsdom, restore } = dom();
  jsdom.window.localStorage.setItem(POSITION_KEY, position);
  jsdom.window.localStorage.setItem(HEIGHT_KEY, '300');
  // jsdom lays nothing out: the cell reports a real pane's height, so the
  // dock is measured with room to spare (a measured 0 would pin it to its floor).
  Object.defineProperty(jsdom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('pane-cell') ? 900 : 0;
    },
  });
  const noop = () => {};
  const Icon = () => React.createElement('span');
  const descriptors = new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]);
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(
        'div',
        { className: 'pane-cell' },
        React.createElement('div', { className: 'pane-surface-stack' }, 'chat'),
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          entry: { open: true, view: 'source-control', surface: '', diff: null },
          groups: [['source-control']],
          descriptors,
          focused: true,
          onSelect: noop,
          onClose: noop,
          onCloseDiff: noop,
          onMoveGroup: noop,
          onMoveView: noop,
          onFocusPane: noop,
          openFileTab: noop,
          renderView: () => React.createElement('div', null, 'panel'),
        })
      )
    )
  );
  return {
    async cleanup() {
      await act(async () => root.unmount());
      restore();
    },
  };
}

test('bottom mode renders the dock below the chat with a height edge instead of a width edge', async () => {
  const { cleanup } = await renderDockInCell('bottom');
  try {
    const cell = document.querySelector('.pane-cell');
    const dock = document.querySelector('.pane-side-dock');
    assert.equal(cell.dataset.dockPlacement, 'bottom');
    assert.equal(dock.dataset.placement, 'bottom');
    assert.equal(dock.dataset.overlay, 'false');
    assert.equal(dock.style.height, '300px');
    // DOM order: the chat stack first, the dock after it in the cell.
    const following = window.Node.DOCUMENT_POSITION_FOLLOWING;
    assert.equal(document.querySelector('.pane-surface-stack').compareDocumentPosition(dock) & following, following);
    const edge = dock.querySelector('.pane-side-dock-height-resize');
    assert.ok(edge);
    assert.equal(edge.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(dock.querySelector('.workbench-side-panel-resize'), null);
  } finally {
    await cleanup();
  }
  // The stylesheet seats a flagged cell's dock in the row under the chat.
  const css = readFileSync(new URL('./pane-side-dock-bottom.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.pane-cell\[data-dock-placement="bottom"\] > \.pane-side-dock,[^{]*\{\s*grid-column: 1;\s*grid-row: 5;/
  );
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\) auto auto auto;/);
});

test('right mode keeps the side column and its width edge', async () => {
  const { cleanup } = await renderDockInCell('right');
  try {
    const dock = document.querySelector('.pane-side-dock');
    assert.equal(document.querySelector('.pane-cell').dataset.dockPlacement, undefined);
    assert.equal(dock.dataset.placement, 'right');
    assert.equal(dock.style.height, '');
    assert.equal(dock.querySelector('.pane-side-dock-height-resize'), null);
    assert.ok(dock.querySelector('.workbench-side-panel-resize'));
  } finally {
    await cleanup();
  }
});

test('a max drag with the Problems panel open keeps the chat at its floor, and opening Problems re-clamps', async () => {
  const { dom: jsdom, restore } = dom();
  const { window: win } = jsdom;
  // jsdom has no layout: rows report the height their test attribute or
  // inline style names, as the browser would report their border boxes.
  const heightOf = (node) => Number(node.dataset?.testH) || Number.parseFloat(node.style?.height) || 0;
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return heightOf(this);
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return heightOf(this);
    },
  });
  win.HTMLElement.prototype.setPointerCapture = () => {};
  win.HTMLElement.prototype.releasePointerCapture = () => {};
  win.HTMLElement.prototype.hasPointerCapture = () => true;
  win.localStorage.setItem(POSITION_KEY, 'bottom');
  win.localStorage.setItem(HEIGHT_KEY, '300');
  const { BottomPanel } = await import('./BottomPanel.tsx');
  const noop = () => {};
  const Icon = () => React.createElement('span');
  const descriptors = new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]);
  const CELL = 900;
  const STRIP = 40;
  const PROBLEMS = 300;
  const render = (problemsOpen) =>
    React.createElement(
      'div',
      { className: 'pane-cell', 'data-test-h': CELL },
      React.createElement('div', { className: 'workspace-tabs-shell', 'data-test-h': STRIP }),
      React.createElement('div', { className: 'pane-surface-stack' }, 'chat'),
      React.createElement(BottomPanel, {
        open: problemsOpen,
        height: PROBLEMS,
        onHeightChange: noop,
        tabs: [{ id: 'problems', label: 'Problems' }],
        activeTab: 'problems',
        onSelectTab: noop,
        onClose: noop,
        motion: 'instant',
      }),
      React.createElement('div', { className: 'pane-footer-slot' }),
      React.createElement(PaneSideDock, {
        leafId: 'pane-1',
        entry: { open: true, view: 'source-control', surface: '', diff: null },
        groups: [['source-control']],
        descriptors,
        focused: true,
        onSelect: noop,
        onClose: noop,
        onCloseDiff: noop,
        onMoveGroup: noop,
        onMoveView: noop,
        onFocusPane: noop,
        openFileTab: noop,
        renderView: () => React.createElement('div', null, 'panel'),
      })
    );
  const chatHeight = (problemsOpen) =>
    CELL - STRIP - (problemsOpen ? PROBLEMS : 0) - heightOf(document.querySelector('.pane-side-dock'));
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(render(false)));
    // Drag the top edge far past the top of the window.
    const edge = document.querySelector('.pane-side-dock-height-resize');
    await act(async () => {
      edge.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 600 }));
      edge.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientY: -5000 }));
      edge.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientY: -5000 }));
    });
    assert.equal(chatHeight(false), PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR);
    assert.equal(win.localStorage.getItem(HEIGHT_KEY), String(CELL - STRIP - PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR));

    // Problems opens under the chat: the maxed dock yields its height.
    await act(async () => root.render(render(true)));
    assert.ok(document.querySelector('.bottom-panel'));
    assert.equal(chatHeight(true), PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR);

    // A max drag with Problems open stops at the same floor.
    await act(async () => {
      edge.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 600 }));
      edge.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientY: -5000 }));
      edge.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientY: -5000 }));
    });
    assert.ok(chatHeight(true) >= PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR);
    assert.equal(
      win.localStorage.getItem(HEIGHT_KEY),
      String(CELL - STRIP - PROBLEMS - PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR)
    );

    // Closing Problems hands the room back to the stored preference.
    await act(async () => root.render(render(false)));
    assert.equal(chatHeight(false), CELL - STRIP - (CELL - STRIP - PROBLEMS - PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
