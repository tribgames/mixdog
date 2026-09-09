import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useBrowserPageInput } from './use-browser-page-input.ts';
import { createBrowserPageClient } from './browser-page-client.ts';

test('composition stays bound to its starting document even after a round trip through another tab', async () => {
  for (const route of [['p1:1'], ['p2:1'], ['p2:1', 'p1:1']]) {
    let current = { documentId: 'p1:1', frameId: 'f1' };
    const sent = [], errors = [];
    const client = createBrowserPageClient({
      sessionId: 'owner', update() {}, failure: error => errors.push(error),
      api: { browserPageFrame: async () => current, browserPageControl: async (_session, input) => sent.push(input) },
    });
    let handlers;
    function Harness() { handlers = useBrowserPageInput(client, { current: null }, { current: null }); return null; }
    renderToString(createElement(Harness));
    await client.poll();
    handlers.onCompositionStart();
    for (const documentId of route) { current = { ...current, documentId }; await client.poll(); }
    const element = { value: '한글' };
    handlers.onCompositionEnd({ currentTarget: element });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(element.value, '');
    assert.equal(sent.length, route.length === 1 && route[0] === 'p1:1' ? 1 : 0);
    if (!sent.length) assert.match(errors[0], /page changed/);
    client.dispose();
  }
});

test('browser shortcuts use pane controls rather than sending invalid key strings to Chromium', () => {
  let handlers;
  const actions = [], shortcuts = [];
  function Harness() {
    handlers = useBrowserPageInput({ fire: action => actions.push(action), shortcut: name => shortcuts.push(name) },
      { current: null }, { current: null });
    return null;
  }
  renderToString(createElement(Harness));
  for (const key of ['F5', 'r', '+', '-', '0', 'l']) {
    handlers.onKeyDown({ key, ctrlKey: key !== 'F5', nativeEvent: {},
      stopPropagation() {}, preventDefault() {} });
  }
  assert.deepEqual(actions, [{ type: 'reload' }, { type: 'reload' }]);
  assert.deepEqual(shortcuts, ['zoom-in', 'zoom-out', 'zoom-reset', 'address']);
});
