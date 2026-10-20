import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { onBrowserPageRevealRequested, onBrowserPageAddressRequested } from './browser-page-request.ts';
import {
  BrowserPeekLine,
  lastBrowserRoundOfTurn,
  savedSignInSites,
  toolActivityUsesBrowser,
} from './browser-peek-line.tsx';
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

test('one "보기" line per turn, at its last browser round', () => {
  const click = call('c', 'browser', { action: 'click', input: { ref: 'e1' } });
  const read = call('r', 'read', { path: 'a.txt' });
  assert.equal(toolActivityUsesBrowser([click]), true);
  assert.equal(toolActivityUsesBrowser([read]), false);
  const rows = [
    round('t1', [click]),
    round('t1', [read]),
    round('t1', [{ ...click, id: 'c2' }]),
    { _tag: 'AssistantPart', key: 'a', item: { kind: 'assistant', text: 'done' } },
    round('t2', [{ ...click, id: 'c3' }]),
  ];
  assert.deepEqual(
    rows.map((_, index) => lastBrowserRoundOfTurn(rows, index)),
    [false, false, true, false, true]
  );
});

test('the line and a URL-less browser group open the pane on its current page, loading nothing', async () => {
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
    await act(async () =>
      root.render(
        React.createElement(ToolActivityGroup, {
          items: [call('c', 'browser', { action: 'click', input: { ref: 'e1' } })],
          disclosureScope: 'sess-1',
        })
      )
    );
    const line = dom.window.document.querySelector('.transcript-browser-peek');
    assert.ok(line, 'a browser group without a page card still offers the view');
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
