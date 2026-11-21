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

async function withCardDom(run) {
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
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await run({ dom, doc: dom.window.document, root });
  } finally {
    await act(async () => root.unmount());
    resetBrowserPageIdentityCache();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
}

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

function withIdentityCard(url, run) {
  return withCardDom(async ({ dom, root }) => {
    const asked = [];
    dom.window.mixdogDesktop = {
      browserPageIdentity: async (asking) => {
        asked.push(asking);
        return identities[asking] ? { url: asking, ...identities[asking] } : null;
      },
    };
    resetBrowserPageIdentityCache();
    const stopReveal = onBrowserPageRevealRequested(() => {});
    try {
      await act(async () =>
        root.render(
          React.createElement(ToolActivityGroup, {
            items: [browserCall(`nav-${url}`, { action: 'navigate', input: { url } })],
            disclosureScope: 'sess-1',
          })
        )
      );
      await act(async () => {});
      await run({ dom, card: dom.window.document.querySelector('.transcript-browser-page') });
      assert.deepEqual(asked, [url]);
    } finally {
      stopReveal();
    }
  });
}

test('the card with a screenshot shows the thumbnail, site icon and host, title and path', () =>
  withIdentityCard('https://github.com/mixdog/mixdog/pull/412', async ({ card }) => {
    assert.equal(card.querySelector('.transcript-browser-page-thumb img')?.getAttribute('src'), SHOT);
    assert.equal(card.querySelector('.transcript-browser-page-site img')?.getAttribute('src'), FAVICON);
    assert.equal(card.querySelector('.transcript-browser-page-site').textContent, 'github.com');
    assert.equal(card.querySelector('b').textContent, 'Composer island · Pull Request #412');
    assert.equal(card.querySelector('small').textContent, '/mixdog/mixdog/pull/412');
    assert.equal(card.querySelector('button').textContent, 'Open');
  }));

test('without a screenshot the slot stays a placeholder, the site icon replaces the globe and the title leads', () =>
  withIdentityCard('https://docs.example.com/guide', async ({ dom, card }) => {
    assert.ok(card.querySelector('.transcript-browser-page-thumb'));
    assert.equal(card.querySelector('.transcript-browser-page-thumb img'), null);
    assert.ok(card.querySelector('.transcript-browser-page-thumb svg.lucide-globe'));
    assert.equal(card.querySelector('.transcript-browser-page-site img')?.getAttribute('src'), FAVICON);
    assert.equal(card.querySelector('b').textContent, 'Guide');
    assert.equal(card.querySelector('small').textContent, '/guide');
    // An icon that fails to decode gives the slot back to the globe.
    await act(async () =>
      card.querySelector('.transcript-browser-page-site img').dispatchEvent(new dom.window.Event('error'))
    );
    assert.equal(card.querySelector('.transcript-browser-page-site img'), null);
    assert.ok(card.querySelector('.transcript-browser-page-site svg.lucide-globe'));
    assert.equal(card.querySelector('b').textContent, 'Guide');
  }));

test('a page with nothing recorded shows the placeholder, globe, host and path', () =>
  withIdentityCard('https://unknown.example.org/a', async ({ card }) => {
    assert.equal(card.querySelector('img'), null);
    assert.ok(card.querySelector('.transcript-browser-page-site svg.lucide-globe'));
    assert.equal(card.querySelector('b').textContent, 'unknown.example.org');
    assert.equal(card.querySelector('small').textContent, '/a');
  }));

const PAGE_URL = 'http://localhost:8080/mockups/v3/game.html';

// A fresh item per render: the group is memoized on item identity.
const renderPageGroup = (root, scope) =>
  act(async () =>
    root.render(
      React.createElement(ToolActivityGroup, {
        items: [browserCall('nav', { action: 'navigate', input: { url: PAGE_URL } })],
        disclosureScope: scope,
      })
    )
  );

function withRevealedPageCard(run, scope = 'sess-9') {
  return withCardDom(async ({ dom, root }) => {
    const revealed = [];
    const stopReveal = onBrowserPageRevealRequested(({ sessionId }) => revealed.push(sessionId));
    try {
      await renderPageGroup(root, scope);
      await run({ dom, revealed, card: dom.window.document.querySelector('.transcript-browser-page') });
    } finally {
      stopReveal();
    }
  });
}

test('without a shell that can reveal a pane the page card is not drawn', () =>
  withCardDom(async ({ doc, root }) => {
    await renderPageGroup(root, 'sess-9');
    assert.equal(doc.querySelector('.transcript-browser-page'), null);
  }));

test('a draft has no session to open a pane for, so it draws no page card', () =>
  withRevealedPageCard(({ card }) => {
    assert.equal(card, null);
  }, 'new-task'));

test('the page card names the page and its button reveals the pane and delivers the address', () =>
  withRevealedPageCard(async ({ dom, revealed, card }) => {
    assert.equal(card?.querySelector('b')?.textContent, 'localhost:8080');
    assert.equal(card?.querySelector('small')?.textContent, '/mockups/v3/game.html');
    await act(async () =>
      card.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    assert.deepEqual(revealed, ['sess-9']);
    const loaded = [];
    onBrowserPageAddressRequested('sess-9', (url) => loaded.push(url))();
    assert.deepEqual(loaded, ['http://localhost:8080/mockups/v3/game.html']);
  }));

test('Ctrl/Cmd-click and middle-click on the page card go to the system browser, not the pane', () =>
  withRevealedPageCard(async ({ dom, revealed }) => {
    const external = [];
    dom.window.mixdogDesktop = { openExternal: async (url) => void external.push(url) };
    const openButton = () => dom.window.document.querySelector('.transcript-browser-page button');
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      await act(async () => openButton().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...init })));
    }
    await act(async () =>
      openButton().dispatchEvent(new dom.window.MouseEvent('auxclick', { bubbles: true, button: 1 }))
    );
    assert.deepEqual(external, Array(3).fill('http://localhost:8080/mockups/v3/game.html'));
    assert.deepEqual(revealed, []);
  }));

test('right-click on the page card shows the web link menu with its visible heading', () =>
  withRevealedPageCard(async ({ dom }) => {
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
  }));

test('the thumbnail slot is the same box before the picture, once it arrives late, and if it fails', () =>
  withCardDom(async ({ dom, doc, root }) => {
    const url = 'https://late.example.com/shot';
    const SHOT = 'data:image/jpeg;base64,CCCC';
    let deliver;
    dom.window.mixdogDesktop = {
      browserPageIdentity: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    };
    resetBrowserPageIdentityCache();
    const stopReveal = onBrowserPageRevealRequested(() => {});
    try {
      await act(async () =>
        root.render(
          React.createElement(ToolActivityGroup, {
            items: [browserCall('late', { action: 'navigate', input: { url } })],
            disclosureScope: 'sess-late',
          })
        )
      );
      const card = doc.querySelector('.transcript-browser-page');
      const slot = card.querySelector('.transcript-browser-page-thumb');
      const layout = () => [...card.children].map((el) => el.className);
      // Before the picture: the slot exists (a placeholder, no image), same layout.
      assert.ok(slot);
      assert.equal(slot.querySelector('img'), null);
      assert.ok(slot.querySelector('svg'));
      const before = layout();

      // The picture arrives late: it fills the same slot, nothing else moves.
      await act(async () => deliver({ url, title: 'Late', thumbnail: SHOT }));
      assert.equal(card.querySelector('.transcript-browser-page-thumb'), slot);
      assert.equal(slot.querySelector('img')?.getAttribute('src'), SHOT);
      assert.deepEqual(layout(), before);

      // It fails to decode: the placeholder returns in the same slot.
      await act(async () => slot.querySelector('img').dispatchEvent(new dom.window.Event('error')));
      assert.equal(card.querySelector('.transcript-browser-page-thumb'), slot);
      assert.equal(slot.querySelector('img'), null);
      assert.ok(slot.querySelector('svg'));
      assert.deepEqual(layout(), before);
    } finally {
      stopReveal();
    }
  }));
