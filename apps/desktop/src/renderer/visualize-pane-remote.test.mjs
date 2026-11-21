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
    assert.equal(frame.getAttribute('allow'), 'fullscreen');
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

async function withRemotePage(tab, run) {
  putTab(tab);
  const root = await mount();
  try {
    await run(await framedDocument());
  } finally {
    await act(async () => root.unmount());
  }
}

const postBlocked = (data, source) =>
  act(async () =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'mixdog-page-blocked', ...data }, source }))
  );

test('a remote page document blocks outside origins like the desktop, with the policy before the page', async () => {
  await withRemotePage({ id: 'r1b', label: 'a.html', revision: 0, panes: [page] }, async ({ html }) => {
    const csp = cspOf(html);
    assert.equal(csp, BLOCKED_NETWORK_CSP);
    assert.doesNotMatch(csp, /https?:|wss?:|\*|\/\//);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('go()'), 'the policy precedes the page');
  });
});

test('a refusal inside a remote frame is filed with the host as a blocked-network problem', async () => {
  commands.length = 0;
  await withRemotePage({ id: 'r1b', label: 'a.html', revision: 0, panes: [page] }, async ({ frame }) => {
    await postBlocked({ url: 'https://cdn.example/x.png', directive: 'img-src' }, frame.contentWindow);
    assert.deepEqual(commands.at(-1), {
      sessionId: 's1',
      tabId: 'r1b',
      action: 'blocked',
      pane: 0,
      url: 'https://cdn.example/x.png',
      resource: 'image',
    });
  });
});

test('a blocked-network message from anywhere else, or about a local address, files nothing', async () => {
  commands.length = 0;
  await withRemotePage({ id: 'r1b', label: 'a.html', revision: 0, panes: [page] }, async ({ frame }) => {
    await postBlocked({ url: 'https://other.example/', directive: 'img-src' }, window);
    await postBlocked({ url: 'inline', directive: 'script-src' }, frame.contentWindow);
    assert.deepEqual(commands, []);
  });
});

test('a remote page loads without the block once the desktop user allowed network for the tab', async () => {
  commands.length = 0;
  await withRemotePage(
    { id: 'r1c', label: 'a.html', revision: 0, panes: [page], networkAllowed: true },
    async ({ frame, html }) => {
      assert.match(html, /<script>go\(\)<\/script>/);
      assert.equal(cspOf(html), undefined);
      assert.match(html, /securitypolicyviolation/);
      await postBlocked({ url: 'wss://live.example/socket', directive: 'connect-src' }, frame.contentWindow);
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
    }
  );
});

test('revoking outside network retires the permissive page at once; allowing it again loads behind the shown page', async () => {
  await withRemotePage(
    { id: 'r1d', label: 'a.html', revision: 0, panes: [page], networkAllowed: true },
    async ({ frame }) => {
      await act(async () => putTab({ id: 'r1d', label: 'a.html', revision: 1, panes: [page], networkAllowed: false }));
      await settle();
      const frames = () => [...document.querySelectorAll('.visualize-pane-content iframe')];
      assert.equal(frame.isConnected, false, 'the page that had outside network is gone');
      assert.equal(frames().length, 1);
      assert.equal(frames()[0].classList.contains('visualize-frame-pending'), false);
      const { html } = await framedDocument();
      assert.equal(cspOf(html), BLOCKED_NETWORK_CSP, 'its replacement runs under the block');

      const blocked = frames()[0];
      await act(async () => putTab({ id: 'r1d', label: 'a.html', revision: 2, panes: [page], networkAllowed: true }));
      await settle();
      assert.equal(frames()[0], blocked, 'a looser policy waits for its page like an edit');
      assert.equal(frames().length, 2);
    }
  );
});

async function mountRevisedPage(nextContent) {
  const original = remote.source;
  const loads = [];
  const fetched = [];
  const pageOf = (contentId, srcdoc) => async () => {
    const load = loads.push(contentId);
    return {
      kind: 'html',
      srcdoc,
      page: 'a.html',
      contentId,
      fetch: async (reference) => {
        fetched.push([load, reference]);
        return { bytes: new Uint8Array([1]), mime: 'text/plain' };
      },
    };
  };
  remote.source = pageOf('live:aaa', '<p>same</p>');
  putTab({ id: 'r6', label: 'a.html', revision: 1, panes: [page] });
  const root = await mount();
  const { frame } = await framedDocument();
  const documents = () => {
    const sent = [];
    frame.contentWindow.postMessage = (message) => sent.push(message);
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'mixdog-preview-ready' }, source: frame.contentWindow })
    );
    return sent.filter((message) => message?.type === 'mixdog-preview-document').length;
  };
  remote.source = nextContent ? pageOf(...nextContent) : remote.source;
  await act(async () => putTab({ id: 'r6', label: 'a.html', revision: 2, panes: [page] }));
  await settle();
  return {
    loads,
    fetched,
    frame,
    documents,
    cleanup: async () => {
      remote.source = original;
      await act(async () => root.unmount());
    },
  };
}

test('a new revision of the same page content keeps its frame', async () => {
  const revised = await mountRevisedPage();
  try {
    assert.equal(revised.loads.length, 2, 'the new revision was read');
    assert.equal(document.querySelector('.visualize-pane-content iframe'), revised.frame);
    assert.equal(revised.documents(), 0, 'the frame did not reload');
  } finally {
    await revised.cleanup();
  }
});

test('page fetches go to the newest load of the same page content', async () => {
  const revised = await mountRevisedPage();
  try {
    revised.frame.contentWindow.postMessage = () => {};
    await act(async () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { type: 'mixdog-page-fetch', id: 1, reference: 'data.json' },
          source: revised.frame.contentWindow,
        })
      )
    );
    await settle();
    assert.deepEqual(revised.fetched, [[2, 'data.json']]);
  } finally {
    await revised.cleanup();
  }
});

const fromPage = (frame, data) =>
  act(async () => window.dispatchEvent(new window.MessageEvent('message', { data, source: frame.contentWindow })));

test('a new revision with different page content loads behind the shown page and swaps in at its scroll', async () => {
  const revised = await mountRevisedPage(['live:bbb', '<p>other</p>']);
  try {
    const frames = () => [...document.querySelectorAll('.visualize-pane-content iframe')];
    await fromPage(revised.frame, { type: 'mixdog-preview-painted' });
    assert.equal(revised.documents(), 0, 'the shown frame keeps its page');
    assert.equal(frames().length, 2);
    const [shown, pending] = frames();
    assert.equal(shown, revised.frame);
    assert.ok(pending.classList.contains('visualize-frame-pending'));
    assert.equal(pending.getAttribute('aria-hidden'), 'true');
    assert.equal(shown.style.visibility, '', 'the shown page never hides');
    await fromPage(shown, { __mixdogVisualize: 1, type: 'scrolled', x: 0, y: 900 });
    const sent = [];
    pending.contentWindow.postMessage = (message) => sent.push(message);
    await fromPage(pending, { type: 'mixdog-preview-ready' });
    assert.match(sent[0]?.html ?? '', /<p>other<\/p>/, 'the new content went to the hidden frame');
    await fromPage(pending, { __mixdogVisualize: 1, type: 'ready' });
    await fromPage(pending, { type: 'mixdog-preview-painted' });
    assert.deepEqual(
      sent.filter((message) => message.type === 'scroll-to').map((message) => [message.x, message.y]),
      [[0, 900]],
      'the new page is put where the old one was before it shows'
    );
    await settle();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.deepEqual(frames(), [pending], 'the painted frame itself is shown');
    assert.equal(pending.classList.contains('visualize-frame-pending'), false);
  } finally {
    await revised.cleanup();
  }
});

test('a reload that fails (a relay reconnect mid-read) keeps the shown page', async () => {
  const revised = await mountRevisedPage();
  const original = remote.source;
  try {
    remote.source = async () => {
      throw new Error('The connection to the PC was lost.');
    };
    await act(async () => putTab({ id: 'r6', label: 'a.html', revision: 3, panes: [page] }));
    await settle();
    assert.deepEqual([...document.querySelectorAll('.visualize-pane-content iframe')], [revised.frame]);
    assert.equal(document.querySelector('.visualize-pane-content .visualize-empty'), null);
  } finally {
    remote.source = original;
    await revised.cleanup();
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
