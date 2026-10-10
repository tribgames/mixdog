import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DockHeaderRow } from './pane-dock-chrome.tsx';

const RADIUS = 'calc(var(--mx-sheet-radius) - 1px)';

// The cascade result for `element`: the last rule whose selector matches and sets border-radius.
function radiusFor(css, element, marker) {
  let result = null;
  for (const [, selectors, body] of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (!selectors.includes(marker)) continue;
    const radius = body.match(/border-radius:\s*([^;]+);/)?.[1].trim();
    if (!radius) continue;
    if (selectors.split(',').some((selector) => element.matches(selector.trim()))) result = radius;
  }
  return result;
}

for (const kind of ['browser', 'terminal']) {
  test(`expanded ${kind} container owns the header's inner top corners (all four when the sidebar is folded)`, async () => {
    const css = await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8');
    const { restore } = installTestDom(null, {
      html: '<!doctype html><html><body><div class="app-shell"><div class="main-panel"></div></div></body></html>',
      expose: ['Element', 'HTMLElement', 'Node', 'navigator'],
    });
    const container = document.createElement('div');
    container.className = `session-${kind}-surface-container`;
    container.dataset.expanded = 'true';
    document.querySelector('.main-panel').append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(DockHeaderRow, { left: 'x', onToggleExpanded() {} })));
      // The real header-owning structure: the header row lives inside the container, not in a .pane-side-dock-header.
      const header = container.querySelector('.dock-header-row');
      assert.equal(header.closest(`.session-${kind}-surface-container`), container);
      assert.equal(header.closest('.pane-side-dock-header'), null);
      const marker = `session-${kind}-surface-container[data-expanded="true"]`;
      assert.equal(radiusFor(css, container, marker), `0 ${RADIUS} ${RADIUS} 0`);
      document.querySelector('.app-shell').classList.add('sidebar-collapsed');
      assert.equal(radiusFor(css, container, marker), RADIUS);
      // The container clips the header to those corners.
      assert.match(
        css,
        /session-browser-surface-container \{\s*border-radius: calc\(var\(--mx-sheet-radius\) - 1px\);\s*overflow: hidden;/
      );
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });
}
