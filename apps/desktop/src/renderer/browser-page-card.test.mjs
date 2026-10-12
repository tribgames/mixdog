import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  browserPageRequestsAvailable,
  onBrowserPageAddressRequested,
  onBrowserPageRevealRequested,
  requestBrowserPage,
} from './browser-page-request.ts';
import { desktopToolActivityBrowserPage } from './transcript-tool-core.ts';
import { ToolActivityGroup } from './TranscriptView.tsx';
import { resetBrowserPageIdentityCache } from './browser-page-identity.ts';

const browserCall = (id, args, extra = {}) => ({
  kind: 'tool',
  id,
  name: 'browser',
  args,
  result: 'ok',
  completedAt: 1,
  ...extra,
});

test('the page card names the last page a group navigated to', () => {
  assert.equal(desktopToolActivityBrowserPage([browserCall('a', { action: 'snapshot', input: {} })]), null);
  assert.deepEqual(
    desktopToolActivityBrowserPage([
      browserCall('a', { action: 'navigate', input: { url: 'http://localhost:8080/first' } }),
      browserCall('b', { action: 'click', input: { ref: 'e1' } }),
      browserCall(
        'c',
        JSON.stringify({ action: 'navigate', input: { url: 'http://192.168.0.18:8080/game.html?slug=roblox' } })
      ),
    ]),
    { url: 'http://192.168.0.18:8080/game.html?slug=roblox', host: '192.168.0.18:8080', path: '/game.html?slug=roblox' }
  );
  // A failed navigation and a wait on a URL fragment leave no page.
  assert.equal(
    desktopToolActivityBrowserPage([
      browserCall('a', { action: 'navigate', input: { url: 'https://example.com/' } }, { isError: true }),
      browserCall('b', { action: 'wait', input: { url: '/done' } }),
    ]),
    null
  );
  assert.deepEqual(
    desktopToolActivityBrowserPage([browserCall('a', { action: 'navigate', input: { url: 'https://example.com/' } })]),
    {
      url: 'https://example.com/',
      host: 'example.com',
      path: '',
    }
  );
});

test('a page request reveals the pane and delivers the address, held until a pane takes it', () => {
  const revealed = [];
  const stopReveal = onBrowserPageRevealRequested((request) => revealed.push(request));
  try {
    assert.equal(browserPageRequestsAvailable(), true);
    requestBrowserPage('sess-1', 'http://localhost:3000/');
    assert.deepEqual(revealed, [{ sessionId: 'sess-1', url: 'http://localhost:3000/' }]);
    // No pane was mounted: the address waits and is handed over on subscribe.
    const loaded = [];
    const stopAddress = onBrowserPageAddressRequested('sess-1', (url) => loaded.push(url));
    assert.deepEqual(loaded, ['http://localhost:3000/']);
    requestBrowserPage('sess-1', 'http://localhost:3000/next');
    assert.deepEqual(loaded, ['http://localhost:3000/', 'http://localhost:3000/next']);
    stopAddress();
    // Another session's pane never receives it.
    const other = [];
    const stopOther = onBrowserPageAddressRequested('sess-2', (url) => other.push(url));
    assert.deepEqual(other, []);
    stopOther();
  } finally {
    stopReveal();
  }
  assert.equal(browserPageRequestsAvailable(), false);
});

test('the card shows a screenshot, else the site icon and title, else globe and address', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const FAVICON = 'data:image/png;base64,AAAA';
  const SHOT = 'data:image/jpeg;base64,BBBB';
  const identities = {
    'https://github.com/mixdog/mixdog/pull/412': {
      title: 'Composer island · Pull Request #412',
      favicon: FAVICON,
      thumbnail: SHOT,
    },
    'https://docs.example.com/guide': { title: 'Guide', favicon: FAVICON },
  };
  const asked = [];
  dom.window.mixdogDesktop = {
    browserPageIdentity: async (url) => {
      asked.push(url);
      return identities[url] ? { url, ...identities[url] } : null;
    },
  };
  resetBrowserPageIdentityCache();
  const root = createRoot(dom.window.document.getElementById('root'));
  const stopReveal = onBrowserPageRevealRequested(() => {});
  const show = async (url) => {
    await act(async () =>
      root.render(
        React.createElement(ToolActivityGroup, {
          items: [browserCall(`nav-${url}`, { action: 'navigate', input: { url } })],
          disclosureScope: 'sess-1',
        })
      )
    );
    await act(async () => {});
    return dom.window.document.querySelector('.transcript-browser-page');
  };
  try {
    // Screenshot: thumbnail left, site icon + host, title, path.
    let card = await show('https://github.com/mixdog/mixdog/pull/412');
    assert.ok(card.classList.contains('has-thumbnail'));
    assert.equal(card.querySelector('.transcript-browser-page-thumb img')?.getAttribute('src'), SHOT);
    assert.equal(card.querySelector('.transcript-browser-page-site img')?.getAttribute('src'), FAVICON);
    assert.equal(card.querySelector('.transcript-browser-page-site').textContent, 'github.com');
    assert.equal(card.querySelector('b').textContent, 'Composer island · Pull Request #412');
    assert.equal(card.querySelector('small').textContent, '/mixdog/mixdog/pull/412');
    assert.equal(card.querySelector('button').textContent, 'Open');

    // No screenshot: the site icon replaces the globe, the title leads.
    card = await show('https://docs.example.com/guide');
    assert.ok(!card.classList.contains('has-thumbnail'));
    assert.equal(card.querySelector('.transcript-browser-page-thumb'), null);
    assert.equal(card.querySelector('.transcript-browser-page-icon img')?.getAttribute('src'), FAVICON);
    assert.equal(card.querySelector('b').textContent, 'Guide');
    assert.equal(card.querySelector('small').textContent, 'docs.example.com/guide');
    // An icon that fails to decode gives the slot back to the globe.
    await act(async () =>
      card.querySelector('.transcript-browser-page-icon img').dispatchEvent(new dom.window.Event('error'))
    );
    assert.equal(card.querySelector('.transcript-browser-page-icon img'), null);
    assert.ok(card.querySelector('.transcript-browser-page-icon svg.lucide-globe'));
    assert.equal(card.querySelector('b').textContent, 'Guide');

    // Nothing recorded: today's globe, host and path.
    card = await show('https://unknown.example.org/a');
    assert.ok(!card.classList.contains('has-thumbnail'));
    assert.equal(card.querySelector('img'), null);
    assert.ok(card.querySelector('.transcript-browser-page-icon svg'));
    assert.equal(card.querySelector('b').textContent, 'unknown.example.org');
    assert.match(card.querySelector('small').textContent, /^\/a · /);
    assert.deepEqual(asked, [
      'https://github.com/mixdog/mixdog/pull/412',
      'https://docs.example.com/guide',
      'https://unknown.example.org/a',
    ]);
  } finally {
    stopReveal();
    await act(async () => root.unmount());
    resetBrowserPageIdentityCache();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test('the card renders under a browser group and its button requests the page', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // A fresh item per render: the group is memoized on item identity.
  const pageItems = () => [
    browserCall('nav', { action: 'navigate', input: { url: 'http://localhost:8080/mockups/v3/game.html' } }),
  ];
  const root = createRoot(dom.window.document.getElementById('root'));
  const revealed = [];
  try {
    // No shell that can reveal a pane: no card.
    await act(async () =>
      root.render(React.createElement(ToolActivityGroup, { items: pageItems(), disclosureScope: 'sess-9' }))
    );
    assert.equal(dom.window.document.querySelector('.transcript-browser-page'), null);

    const stopReveal = onBrowserPageRevealRequested(({ sessionId }) => revealed.push(sessionId));
    try {
      await act(async () =>
        root.render(React.createElement(ToolActivityGroup, { items: pageItems(), disclosureScope: 'sess-9' }))
      );
      const card = dom.window.document.querySelector('.transcript-browser-page');
      assert.equal(card?.querySelector('b')?.textContent, 'localhost:8080');
      assert.match(card?.querySelector('small')?.textContent ?? '', /^\/mockups\/v3\/game\.html · /);
      await act(async () =>
        card.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      );
      assert.deepEqual(revealed, ['sess-9']);
      const loaded = [];
      onBrowserPageAddressRequested('sess-9', (url) => loaded.push(url))();
      assert.deepEqual(loaded, ['http://localhost:8080/mockups/v3/game.html']);

      // Ctrl/Cmd-click and middle-click go to the system browser, not the pane.
      const external = [];
      dom.window.mixdogDesktop = { openExternal: async (url) => void external.push(url) };
      const openButton = () => dom.window.document.querySelector('.transcript-browser-page button');
      for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
        await act(async () =>
          openButton().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...init }))
        );
      }
      await act(async () =>
        openButton().dispatchEvent(new dom.window.MouseEvent('auxclick', { bubbles: true, button: 1 }))
      );
      assert.deepEqual(external, Array(3).fill('http://localhost:8080/mockups/v3/game.html'));
      assert.deepEqual(revealed, ['sess-9']);

      // Right-click shows the web link menu with its visible heading.
      await act(async () =>
        dom.window.document
          .querySelector('.transcript-browser-page')
          .dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      );
      assert.equal(dom.window.document.querySelector('.dock-scm-context-heading')?.textContent, 'Open in');
      assert.deepEqual(
        [...dom.window.document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent),
        ['Mixdog Browser', 'Mixdog Browser (New Tab)', 'System Browser', 'Copy link', 'Save link as…']
      );
      await act(async () =>
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
      );

      // A draft has no session to open a pane for.
      await act(async () =>
        root.render(React.createElement(ToolActivityGroup, { items: pageItems(), disclosureScope: 'new-task' }))
      );
      assert.equal(dom.window.document.querySelector('.transcript-browser-page'), null);
    } finally {
      stopReveal();
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
