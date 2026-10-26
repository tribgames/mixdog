import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  onBrowserPageRevealRequested,
  onBrowserPageAddressRequested,
  onBrowserPaneRevealed,
} from './browser-page-request.ts';
import { BrowserPeekLine, browserOpenedPage, lastBrowserRoundOfTurn, savedSignInSites } from './browser-peek-line.tsx';
import { borrowedBrowserTab, borrowedStripTabs, clearBorrowedBrowserTab } from './browser-pane-borrowed-tab.ts';
import { BrowserTabStrip } from './BrowserTabStrip.tsx';
import { ToolActivityGroup } from './TranscriptView.tsx';

const call = (id, name, args) => ({ kind: 'tool', id, name, args, result: 'ok', completedAt: 1 });
const round = (turnKey, items) => ({ _tag: 'ToolActivity', key: `${turnKey}:${items[0].id}`, turnKey, items });

test('a saved-login sign-in leaves one faint line naming the site, nothing else', () => {
  const signedIn = {
    ...call('s', 'browser', { action: 'navigate', input: { url: 'https://shop.example.com/' } }),
    result:
      'Saved sign-in: signed in to shop.example.com with its saved login (the password never left the host).\n\nURL: https://shop.example.com/account',
  };
  const notBrowser = { ...call('x', 'read', { path: 'a' }), result: signedIn.result };
  assert.deepEqual(savedSignInSites([signedIn, notBrowser]), ['shop.example.com']);
  assert.deepEqual(savedSignInSites([call('c', 'browser', { action: 'click' })]), []);
});

const SHOWN = 'Shown in the browser panel: page p4 — Quarterly (report) (https://dart.example/main.do).';
const PENDING =
  "Not on screen yet: page p6 — (untitled) (https://dart.example/list) is kept in this conversation's browser panel, which is not visible now; it appears when the user opens that panel. Do not tell the user it is on screen.";
const opened = (id, text, extra = {}) => ({
  ...call(id, 'browser', { action: 'open', input: {} }),
  result: text,
  ...extra,
});

test('only a successful open leaves a page: shown or pending, with its tab id', () => {
  assert.deepEqual(browserOpenedPage([opened('o', SHOWN)]), {
    tabId: 'p4',
    title: 'Quarterly (report)',
    url: 'https://dart.example/main.do',
  });
  assert.deepEqual(browserOpenedPage([opened('o', { content: [{ type: 'text', text: PENDING }] })]), {
    tabId: 'p6',
    title: '',
    url: 'https://dart.example/list',
  });
  // A failed open, a refused URL, and browser work that opened nothing leave none.
  assert.equal(
    browserOpenedPage([
      opened('f', 'Error: Could not show the page in the browser panel: desktop window is unavailable', {
        isError: true,
      }),
    ]),
    null
  );
  assert.equal(browserOpenedPage([opened('f2', SHOWN, { isError: true })]), null);
  assert.equal(browserOpenedPage([call('c', 'browser', { action: 'click', input: { ref: 'e1' } })]), null);
  assert.equal(
    browserOpenedPage([{ ...call('n', 'browser', { action: 'navigate', input: {} }), result: SHOWN }]),
    null
  );
  // A row from another session names its owner.
  assert.deepEqual(browserOpenedPage([opened('o', SHOWN, { ownerSessionId: 'task-1', ownerName: '예측' })]), {
    tabId: 'p4',
    title: 'Quarterly (report)',
    url: 'https://dart.example/main.do',
    ownerSessionId: 'task-1',
    ownerName: '예측',
  });
});

test('one "보기" line per turn, at its last round that opened a page', () => {
  const open = opened('o', SHOWN);
  const click = call('c', 'browser', { action: 'click', input: { ref: 'e1' } });
  const failed = opened('f', 'Error: no page', { isError: true });
  const rows = [
    round('t1', [open]),
    round('t1', [click]),
    round('t1', [{ ...open, id: 'o2' }]),
    { _tag: 'AssistantPart', key: 'a', item: { kind: 'assistant', text: 'done' } },
    round('t2', [failed]),
    round('t3', [{ ...open, id: 'o3' }]),
  ];
  assert.deepEqual(
    rows.map((_, index) => lastBrowserRoundOfTurn(rows, index)),
    [false, false, true, false, false, true]
  );
});

function installDom() {
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
  const restore = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  };
  return { dom, restore };
}

test('a failed open leaves no line; a successful one reveals its tab by id, loading nothing', async () => {
  const { dom, restore } = installDom();
  const controls = [];
  dom.window.mixdogDesktop = {
    browserPageControl: async (sessionId, input) => {
      controls.push([sessionId, input]);
      if (input.tabId !== 'p4') throw new Error('Browser tab is no longer available in this session.');
    },
    browserPageFrame: () => assert.fail('viewing reads no page of its own'),
  };
  const revealed = [];
  const addresses = [];
  const paneReveals = [];
  const stopReveal = onBrowserPageRevealRequested((request) => revealed.push(request));
  const stopAddress = onBrowserPageAddressRequested('sess-1', (url) => addresses.push(url));
  const stopPane = onBrowserPaneRevealed('sess-1', () => paneReveals.push('resume'));
  const root = createRoot(dom.window.document.getElementById('root'));
  const peek = () => dom.window.document.querySelector('.transcript-browser-peek');
  try {
    await act(async () =>
      root.render(
        React.createElement(ToolActivityGroup, {
          items: [opened('f', 'Error: Could not show the page in the browser panel: blocked', { isError: true })],
          disclosureScope: 'sess-1',
        })
      )
    );
    assert.equal(peek(), null, 'a failed open has no "보기"');

    await act(async () =>
      root.render(React.createElement(ToolActivityGroup, { items: [opened('o', SHOWN)], disclosureScope: 'sess-1' }))
    );
    assert.equal(peek().textContent, 'Browser·Quarterly (report)·View');
    await act(async () => peek().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(controls, [['sess-1', { type: 'select-tab', tabId: 'p4', follow: 'view', documentId: 'p4:0' }]]);
    assert.deepEqual(revealed, [{ sessionId: 'sess-1' }]);
    assert.deepEqual(addresses, [], 'the press loads no address');
    assert.deepEqual(paneReveals, [], 'the pane is not sent to the agent page instead');

    // The tab is gone (closed, or lost to a restart): the line says so and opens nothing.
    await act(async () =>
      root.render(
        React.createElement(BrowserPeekLine, { sessionId: 'sess-1', page: { tabId: 'p9', title: 'Old', url: '' } })
      )
    );
    await act(async () => peek().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(peek().classList.contains('is-gone'), true);
    assert.equal(peek().textContent, 'Browser·Old·This tab is no longer open');
    assert.equal(revealed.length, 1, 'no panel opened onto a blank');

    // A draft has no pane to open.
    await act(async () =>
      root.render(
        React.createElement(BrowserPeekLine, { sessionId: 'new-task', page: { tabId: 'p4', title: 'A', url: '' } })
      )
    );
    assert.equal(peek(), null);
  } finally {
    stopReveal();
    stopAddress();
    stopPane();
    await act(async () => root.unmount());
    restore();
  }
});

test("another session's page opens in this conversation's panel under its owner's name, making no page here", async () => {
  const { dom, restore } = installDom();
  const controls = [];
  dom.window.mixdogDesktop = {
    browserPageControl: async (sessionId, input) => void controls.push([sessionId, input.tabId, input.follow]),
  };
  const revealed = [];
  const stopReveal = onBrowserPageRevealRequested((request) => revealed.push(request.sessionId));
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    const page = {
      tabId: 'p4',
      title: 'OpenDART',
      url: 'https://opendart.example/',
      ownerSessionId: 'task-1',
      ownerName: '예측',
    };
    await act(async () => root.render(React.createElement(BrowserPeekLine, { sessionId: 'bot-home', page })));
    const line = dom.window.document.querySelector('.transcript-browser-peek');
    assert.equal(line.textContent, 'Browser·예측·OpenDART·View');
    assert.equal(line.querySelector('.transcript-browser-peek-owner').textContent, '예측');
    await act(async () => line.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    // The owner's tab is picked in the owner's browser; only the viewer's panel opens.
    assert.deepEqual(controls, [['task-1', 'p4', 'view']]);
    assert.deepEqual(revealed, ['bot-home']);
    const borrowed = borrowedBrowserTab('bot-home');
    assert.deepEqual(borrowed, { ownerSessionId: 'task-1', ownerName: '예측', tabId: 'p4' });

    // The viewer's strip: that tab, titled "<owner> · <title>", owner in warning colour.
    const ownerTabs = [
      { id: 'p2', title: 'Other', url: 'https://a.example/', active: true, loading: false, kind: 'page' },
      { id: 'p4', title: 'OpenDART', url: 'https://opendart.example/', active: false, loading: false, kind: 'page' },
    ];
    const tabs = borrowedStripTabs(ownerTabs, borrowed);
    assert.deepEqual(
      tabs.map((tab) => [tab.id, tab.active, tab.owner]),
      [['p4', true, '예측']]
    );
    await act(async () =>
      root.render(React.createElement(BrowserTabStrip, { tabs, onSelect: async () => {}, onClose: async () => {} }))
    );
    const tab = dom.window.document.querySelector('[role="tab"]');
    assert.equal(tab.textContent, '예측 · OpenDART');
    assert.equal(tab.querySelector('.browser-tab-owner').textContent, '예측');
    assert.equal(dom.window.document.querySelector('[aria-label="New tab"]'), null, 'no tab is made for it');
    // The owner closed it: the strip has nothing to show, rather than a blank.
    assert.deepEqual(borrowedStripTabs(ownerTabs.slice(0, 1), borrowed), []);

    // The viewer's own page clears the borrowed one.
    await act(async () =>
      root.render(
        React.createElement(BrowserPeekLine, { sessionId: 'bot-home', page: { tabId: 'p1', title: 'Own', url: '' } })
      )
    );
    await act(async () =>
      dom.window.document
        .querySelector('.transcript-browser-peek')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    assert.equal(borrowedBrowserTab('bot-home'), null);
  } finally {
    stopReveal();
    clearBorrowedBrowserTab('bot-home');
    await act(async () => root.unmount());
    restore();
  }
});

test('a line naming no page still opens the session panel on its current page', async () => {
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
  dom.window.mixdogDesktop = {};
  const revealed = [];
  const addresses = [];
  const stopReveal = onBrowserPageRevealRequested((request) => revealed.push(request));
  const stopAddress = onBrowserPageAddressRequested('sess-1', (url) => addresses.push(url));
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    // Browser work that opened no page leaves no line.
    await act(async () =>
      root.render(
        React.createElement(ToolActivityGroup, {
          items: [call('c', 'browser', { action: 'click', input: { ref: 'e1' } })],
          disclosureScope: 'sess-1',
        })
      )
    );
    assert.equal(dom.window.document.querySelector('.transcript-browser-peek'), null);
    await act(async () => root.render(React.createElement(BrowserPeekLine, { sessionId: 'sess-1' })));
    const line = dom.window.document.querySelector('.transcript-browser-peek');
    assert.equal(line.textContent, 'Browser·View');
    await act(async () => line.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(revealed, [{ sessionId: 'sess-1' }]);
    assert.deepEqual(addresses, [], 'the press loads no address');

    // A draft has no pane to open.
    await act(async () => root.render(React.createElement(BrowserPeekLine, { sessionId: 'new-task' })));
    assert.equal(dom.window.document.querySelector('.transcript-browser-peek'), null);
  } finally {
    stopReveal();
    stopAddress();
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
