import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  DIALOG_BRIDGE_PATH,
  DIALOG_BRIDGE_PATTERN,
  DIALOG_BRIDGE_SCRIPT,
  dialogBridgeFulfillParams,
  parseDialogBridgeRequest,
} from './dialog-bridge.ts';

test('dialog bridge uses a same-origin reserved path and parses any HTTP origin', () => {
  assert.equal(DIALOG_BRIDGE_PATTERN, `*://*${DIALOG_BRIDGE_PATH}*`);
  assert.match(DIALOG_BRIDGE_SCRIPT, /location\.href/);
  assert.deepEqual(
    parseDialogBridgeRequest(
      `http://127.0.0.1:8137${DIALOG_BRIDGE_PATH}?type=prompt&message=Hello&defaultPrompt=Default`,
    ),
    { type: 'prompt', message: 'Hello', defaultPrompt: 'Default' },
  );
  assert.equal(parseDialogBridgeRequest('http://127.0.0.1:8137/api/data'), null);
  const bounded = parseDialogBridgeRequest(
    `https://example.test${DIALOG_BRIDGE_PATH}?type=forged&message=${'x'.repeat(5_000)}&defaultPrompt=${'y'.repeat(3_000)}`,
  );
  assert.equal(bounded.type, 'dialog');
  assert.equal(bounded.message.length, 4_000);
  assert.equal(bounded.defaultPrompt.length, 2_000);
});

test('dialog bridge fulfills prompt responses as complete JSON bodies', () => {
  const fulfilled = dialogBridgeFulfillParams('request-1', true, 'Accepted');
  const body = Buffer.from(String(fulfilled.body), 'base64');
  assert.deepEqual(JSON.parse(body.toString('utf8')), {
    accept: true,
    promptText: 'Accepted',
  });
  assert.ok(fulfilled.responseHeaders.some(
    (header) => header.name === 'Content-Length' && header.value === String(body.length),
  ));
});

test('dialog bridge consumes a fulfilled JSON body when synchronous XHR reports status zero', () => {
  class FulfilledRequest {
    status = 0;
    responseText = JSON.stringify({ accept: true, promptText: 'Accepted' });

    open() {}
    send() {}
  }
  const context = {
    URL,
    URLSearchParams,
    XMLHttpRequest: FulfilledRequest,
    location: { href: 'http://127.0.0.1:8137/' },
    window: {
      alert() {},
      confirm() { return false; },
      prompt() { return null; },
    },
  };

  runInNewContext(DIALOG_BRIDGE_SCRIPT, context);

  assert.equal(context.window.prompt('Harness prompt', 'default'), 'Accepted');
});
