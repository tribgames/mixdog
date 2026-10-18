// The Visualize panel on a paired remote device: agent pages that run at once
// under the desktop's network block, PDF / Office panes as page images (with
// the blob fallback), the remote PNG/PDF export entries and the render report
// a remote inline pane files.
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
const { BLOCKED_NETWORK_CSP } = await import('../shared/visualize-network-policy.ts');

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

/** The document the pane hands its frame once the relay's /preview-frame page says it is ready. */
async function framedDocument() {
  const frame = document.querySelector('.visualize-pane-content iframe');
  const sent = [];
  frame.contentWindow.postMessage = (message) => sent.push(message);
  await act(async () =>
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'mixdog-preview-ready' }, source: frame.contentWindow })
    )
  );
  return { frame, html: sent[0]?.html ?? '' };
}
const cspOf = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];

test('a remote agent page runs scripts at once, with no Run gate or run-pages menu item', async () => {
  putTab({ id: 'r1', label: 'a.html', revision: 0, panes: [page] });
  const root = await mount();
  try {
    const { frame, html } = await framedDocument();
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-modals');
    assert.equal(document.querySelector('.visualize-script-gate'), null);
    assert.match(html, /<script>go\(\)<\/script>/);
    const labels = (await openMenu()).map((button) => button.textContent);
    assert.equal(
      labels.some((text) => /Run agent pages/.test(text)),
      false
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('a remote page document blocks outside origins like the desktop, until the tab allows network', async () => {
  commands.length = 0;
  putTab({ id: 'r1b', label: 'a.html', revision: 0, panes: [page] });
  let root = await mount();
  try {
    const { frame, html } = await framedDocument();
    const csp = cspOf(html);
    assert.equal(csp, BLOCKED_NETWORK_CSP);
    // Nothing of the outside network (http, https, ws, wss, or any host) is a source.
    assert.doesNotMatch(csp, /https?:|wss?:|\*|\/\//);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('go()'), 'the policy precedes the page');
    // A refusal inside the frame is filed with the host as the desktop's blocked-network problem.
    await act(async () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { type: 'mixdog-page-blocked', url: 'https://cdn.example/x.png', directive: 'img-src' },
          source: frame.contentWindow,
        })
      )
    );
    assert.deepEqual(commands.at(-1), {
      sessionId: 's1',
      tabId: 'r1b',
      action: 'blocked',
      pane: 0,
      url: 'https://cdn.example/x.png',
      resource: 'image',
    });
    // A message from anywhere else, or about a local address, files nothing.
    const filed = commands.length;
    await act(async () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { type: 'mixdog-page-blocked', url: 'https://other.example/', directive: 'img-src' },
          source: window,
        })
      )
    );
    await act(async () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { type: 'mixdog-page-blocked', url: 'inline', directive: 'script-src' },
          source: frame.contentWindow,
        })
      )
    );
    assert.equal(commands.length, filed);
  } finally {
    await act(async () => root.unmount());
  }
  // The desktop user allowed network for the tab: the page loads without the block.
  putTab({ id: 'r1c', label: 'a.html', revision: 0, panes: [page], networkAllowed: true });
  root = await mount();
  try {
    const { frame, html } = await framedDocument();
    assert.match(html, /<script>go\(\)<\/script>/);
    assert.equal(cspOf(html), undefined);
    // The reporter stays: the frame's own CSP (the relay's preview frame) still refuses e.g. wss:.
    assert.match(html, /securitypolicyviolation/);
    commands.length = 0;
    await act(async () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { type: 'mixdog-page-blocked', url: 'wss://live.example/socket', directive: 'connect-src' },
          source: frame.contentWindow,
        })
      )
    );
    assert.deepEqual(commands, [
      {
        sessionId: 's1',
        tabId: 'r1c',
        action: 'blocked',
        pane: 0,
        url: 'wss://live.example/socket',
        resource: 'webSocket',
      },
    ]);
  } finally {
    await act(async () => root.unmount());
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
