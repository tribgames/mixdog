import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bottomPanelOpenForPane,
  restoreBottomPanelOpenPaneIds,
  setBottomPanelPaneOpen,
} from './bottom-panel-pane-state.ts';

test('the Problems panel follows the PANE that opened it', () => {
  let openPaneIds = new Set();
  openPaneIds = setBottomPanelPaneOpen(openPaneIds, 'pane-a', true);

  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-a'), true);
  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-b'), false);
  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-a'), true);

  openPaneIds = setBottomPanelPaneOpen(openPaneIds, 'pane-b', true);
  openPaneIds = setBottomPanelPaneOpen(openPaneIds, 'pane-a', false);
  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-a'), false);
  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-b'), true);
});

test('legacy global panel state migrates to the active PANE', () => {
  const openPaneIds = restoreBottomPanelOpenPaneIds({ open: true }, 'pane-a');
  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-a'), true);
  assert.equal(bottomPanelOpenForPane(openPaneIds, 'pane-b'), false);
});

test('the bottom panel resize handle is a 6px row-resize band inside the panel and drags the height', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8');
  const handle = css.match(/\n\.bottom-panel-resize \{([^}]*)\}/)[1];
  assert.match(handle, /top: 0;/);
  assert.match(handle, /height: 6px;/);
  assert.match(handle, /cursor: row-resize;/);
  assert.match(handle, /z-index: 4;/);
  const hover = css.match(/\.bottom-panel-resize:hover,\s*\.bottom-panel-resize\.is-dragging \{([^}]*)\}/)[1];
  assert.match(hover, /var\(--mx-focus\)/);
  // The divider is the panel's own 1px border; the sheet framing keeps it and does not clip the band.
  const sheet = css.slice(css.lastIndexOf('@media (min-width: 941px)'));
  assert.match(sheet, /border-top: 1px solid var\(--mx-border\);/);
  assert.doesNotMatch(sheet, /overflow: hidden/);
  assert.match(css.match(/\n\.pane-cell \{([^}]*)\}/)[1], /overflow: hidden;/);

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['Element', 'HTMLElement', 'Node', 'MouseEvent'],
  });
  const proto = dom.window.HTMLElement.prototype;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => true;
  proto.getBoundingClientRect = () => ({ left: 0, top: 500, right: 800, bottom: 800, width: 800, height: 300 });
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  const { BottomPanel } = await import('./BottomPanel.tsx');
  const heights = [];
  const root = createRoot(document.getElementById('root'));
  const move = (y) =>
    document
      .querySelector('.bottom-panel-resize')
      .dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: y }));
  try {
    await act(async () =>
      root.render(
        React.createElement(BottomPanel, {
          open: true,
          height: 300,
          onHeightChange: (h) => heights.push(h),
          tabs: [{ id: 'problems', label: 'Problems' }],
          activeTab: 'problems',
          onSelectTab() {},
          onClose() {},
        })
      )
    );
    const handleNode = document.querySelector('.bottom-panel > .bottom-panel-resize');
    assert.ok(handleNode, "handle is the panel's first child, inside its box");
    await act(async () =>
      handleNode.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 500 }))
    );
    await act(async () => move(560));
    await act(async () => handleNode.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true })));
    // Anchored at the panel's bottom edge (800): dragging to y=560 -> 240px, within [120, 70% viewport].
    assert.deepEqual(heights, [240]);
    await act(async () =>
      handleNode.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 500 }))
    );
    await act(async () => move(795));
    await act(async () => handleNode.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true })));
    assert.equal(heights[1], 120, 'clamped to the existing minimum');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
