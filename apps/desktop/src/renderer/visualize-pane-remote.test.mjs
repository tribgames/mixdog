// The Visualize panel on a paired remote device: the Run gate and the
// device's "run agent pages immediately" setting, PDF / Office panes as page
// images (with the blob fallback), the remote PNG/PDF export entries and the
// render report a remote inline pane files.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main id="root"></main></body></html>',
  jsdom: { url: 'https://relay.test/' },
  expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window', 'KeyboardEvent', 'WheelEvent', 'MouseEvent'],
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
URL.createObjectURL = () => 'blob:test/pane';
URL.revokeObjectURL = () => {};

const commands = [];
const pageCalls = [];
const remote = {
  pages: async () => ({
    format: 'pdf',
    mtimeMs: 1,
    size: 9,
    pageCount: 1,
    pages: [{ page: 1, width: 10, height: 14, mime: 'image/png', base64: 'UE5H' }],
  }),
  source: async (_session, _tab, index) =>
    index === 0 ? { kind: 'html', srcdoc: '<p>page</p><script>go()</script>' } : { kind: 'pdf', url: 'blob:test/pane' },
};
window.mixdogDesktop = {
  visualizeCommand: async (command) => {
    commands.push(command);
    return {};
  },
  visualizePaneSource: (...args) => remote.source(...args),
  visualizePanePages: (...args) => {
    pageCalls.push(args);
    return remote.pages(...args);
  },
  visualizeExport: async () => ({ source: { kind: 'export', sessionId: 's1', exportId: 'x' }, name: 'a.png' }),
};

const { VisualizePane } = await import('./VisualizePane.tsx');
const { applyVisualizeEvent } = await import('./visualize-store.ts');
const { setVisualizeRunPages } = await import('./visualize-run-pref.ts');

const putTab = (tab) =>
  applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', tabs: [tab], active: tab.id } });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function mount() {
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(VisualizePane, { sessionId: 's1', active: true, onClose() {} }))
  );
  await settle();
  return root;
}
const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const openMenu = async () => {
  await click(document.querySelector('button[aria-label="More actions"]'));
  return [...document.querySelectorAll('.dock-header-menu button')];
};
const page = { kind: 'html', label: 'a.html', target: 'a.html', url: '' };

test('an agent page waits for Run unless this device runs agent pages immediately', async () => {
  setVisualizeRunPages(false);
  putTab({ id: 'r1', label: 'a.html', revision: 0, panes: [page] });
  const root = await mount();
  try {
    // Gated: no scripts at all, with the Run prompt.
    assert.equal(document.querySelector('.visualize-pane-content iframe').getAttribute('sandbox'), '');
    assert.match(document.querySelector('.visualize-script-gate').textContent, /This page runs scripts/);
    const item = (await openMenu()).find((button) => button.textContent.includes('Run agent pages immediately'));
    assert.equal(item.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(item.getAttribute('aria-checked'), 'false');
    await click(item);
    await settle();
    // Live at once: scripts, forms and dialogs in the opaque frame, no Run prompt.
    const frame = document.querySelector('.visualize-pane-content iframe');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-modals');
    assert.equal(document.querySelector('.visualize-script-gate'), null);
    assert.equal(window.localStorage.getItem('mixdog:visualize-run-agent-pages'), 'true');
  } finally {
    await act(async () => root.unmount());
    setVisualizeRunPages(false);
  }
});

test('a remote PDF pane shows page images; without them it falls back to the blob frame', async () => {
  putTab({
    id: 'r2',
    label: 'r.pdf',
    revision: 0,
    panes: [page, { kind: 'pdf', label: 'r.pdf', target: 'r.pdf', url: '' }],
  });
  let root = await mount();
  try {
    const image = document.querySelector('.visualize-document-pages img');
    assert.equal(image.getAttribute('src'), 'data:image/png;base64,UE5H');
    assert.deepEqual(pageCalls[0].slice(0, 3), ['s1', 'r2', 1]);
    assert.deepEqual(pageCalls[0][3].pages, [1]);
  } finally {
    await act(async () => root.unmount());
  }
  remote.pages = async () => {
    throw new Error('Unknown method visualizePanePages');
  };
  putTab({
    id: 'r3',
    label: 'r.pdf',
    revision: 0,
    panes: [page, { kind: 'pdf', label: 'r.pdf', target: 'r.pdf', url: '' }],
  });
  root = await mount();
  try {
    await settle();
    assert.equal(document.querySelector('.visualize-document-pages'), null);
    assert.equal(document.querySelectorAll('.visualize-pane-content iframe')[1].getAttribute('src'), 'blob:test/pane');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a remote PDF pane still loads its pages after a StrictMode effect replay', async () => {
  remote.pages = async () => ({
    format: 'pdf',
    mtimeMs: 1,
    size: 9,
    pageCount: 1,
    pages: [{ page: 1, width: 10, height: 14, mime: 'image/png', base64: 'UE5H' }],
  });
  putTab({
    id: 'r2s',
    label: 'r.pdf',
    revision: 0,
    panes: [page, { kind: 'pdf', label: 'r.pdf', target: 'r.pdf', url: '' }],
  });
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(VisualizePane, { sessionId: 's1', active: true, onClose() {} })
      )
    )
  );
  await settle();
  try {
    assert.equal(
      document.querySelector('.visualize-document-pages img')?.getAttribute('src'),
      'data:image/png;base64,UE5H'
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('the remote ⋯ menu offers PNG / PDF export next to Download', async () => {
  putTab({ id: 'r4', label: 'a.html', revision: 0, panes: [page] });
  const root = await mount();
  try {
    const labels = (await openMenu()).map((button) => button.textContent);
    for (const label of ['Download', 'Save as PNG', 'Save as PDF']) {
      assert.ok(
        labels.some((text) => text.includes(label)),
        label
      );
    }
  } finally {
    await act(async () => root.unmount());
  }
});

test('a remote inline pane files its render report with the id the host issued it', async () => {
  commands.length = 0;
  putTab({
    id: 'r5',
    label: 'flow',
    revision: 0,
    panes: [
      {
        kind: 'inline',
        label: 'flow',
        target: 'flow',
        url: '',
        inline: { kind: 'svg', source: '<svg/>' },
        renderId: 'remote-id',
      },
    ],
  });
  const root = await mount();
  try {
    await settle();
    const report = commands.find((command) => command.action === 'render');
    assert.deepEqual(report && { ...report, error: undefined }, {
      sessionId: 's1',
      tabId: 'r5',
      action: 'render',
      pane: 0,
      renderId: 'remote-id',
      error: undefined,
    });
  } finally {
    await act(async () => root.unmount());
  }
});
