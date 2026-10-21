import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  DIALOG_BRIDGE_PATH,
  DIALOG_BRIDGE_PATTERN,
  DIALOG_BRIDGE_SCRIPT,
  dialogBridgeFulfillParams,
  parseDialogBridgeNotice,
  parseDialogBridgeRequest,
} from './dialog-bridge.ts';

test('dialog bridge uses a same-origin reserved path and parses any HTTP origin', () => {
  assert.equal(DIALOG_BRIDGE_PATTERN, `*://*${DIALOG_BRIDGE_PATH}*`);
  assert.match(DIALOG_BRIDGE_SCRIPT, /location\.href/);
  assert.deepEqual(
    parseDialogBridgeRequest(
      `http://127.0.0.1:8137${DIALOG_BRIDGE_PATH}?type=prompt&message=Hello&defaultPrompt=Default`
    ),
    { type: 'prompt', message: 'Hello', defaultPrompt: 'Default' }
  );
  assert.equal(parseDialogBridgeRequest('http://127.0.0.1:8137/api/data'), null);
  const bounded = parseDialogBridgeRequest(
    `https://example.test${DIALOG_BRIDGE_PATH}?type=forged&message=${'x'.repeat(5_000)}&defaultPrompt=${'y'.repeat(3_000)}`
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
  assert.ok(
    fulfilled.responseHeaders.some((header) => header.name === 'Content-Length' && header.value === String(body.length))
  );
});

/** A page whose bridge request behaves as `send` says, with its own dialogs
 *  and the bridge's console notices recorded. */
function bridgedPage(send, responseText = '') {
  const native = [];
  const notices = [];
  class Request {
    status = 0;
    responseText = responseText;
    open() {}
    send() {
      send();
    }
  }
  const context = {
    URL,
    URLSearchParams,
    XMLHttpRequest: Request,
    console: {
      debug: (...args) => notices.push(args),
    },
    location: { href: 'https://example.test/' },
    window: {
      alert: (message) => native.push(['alert', message]),
      confirm: (message) => native.push(['confirm', message]) > 0,
      prompt: () => {
        throw new Error('prompt() is not supported.');
      },
    },
  };
  runInNewContext(DIALOG_BRIDGE_SCRIPT, context);
  // A page replacing console.debug afterwards must not silence the notice.
  context.console.debug = () => {};
  return { window: context.window, native, notices };
}

/** The `Runtime.consoleAPICalled` event a console call raises. */
const consoleEvent = (type, args) => ({ type, args: args.map((value) => ({ type: 'string', value })) });

test("a bridge request the page refuses (CSP) is dismissed and reported, never handed to the page's own (OS) dialog", () => {
  const page = bridgedPage(() => {
    throw new Error('Refused to connect: Content Security Policy');
  });
  page.window.alert('Saved');
  assert.equal(page.window.confirm('Continue?'), false);
  assert.equal(page.window.prompt('Name?', 'x'), null);
  assert.deepEqual(page.native, [], 'no OS dialog box');
  assert.deepEqual(
    page.notices.map((args) => parseDialogBridgeNotice(consoleEvent('debug', args))),
    [
      { type: 'alert', message: 'Saved' },
      { type: 'confirm', message: 'Continue?' },
      { type: 'prompt', message: 'Name?' },
    ]
  );
});

test('a request that reached the network instead of the host is dismissed and reported; a host answer is not', () => {
  const misrouted = bridgedPage(() => {}, '<!doctype html><title>Not Found</title>');
  assert.equal(misrouted.window.confirm('Continue?'), false);
  assert.equal(misrouted.notices.length, 1);
  const refused = bridgedPage(() => {}, JSON.stringify({ accept: false, promptText: '' }));
  assert.equal(refused.window.confirm('Continue?'), false);
  assert.deepEqual(refused.notices, [], 'the host answered: nothing was dismissed unseen');
});

test('only the bridge notice parses as a dismissed dialog, bounded and typed like a request', () => {
  const page = bridgedPage(() => {
    throw new Error('refused');
  });
  page.window.alert('x'.repeat(5_000));
  const parsed = parseDialogBridgeNotice(consoleEvent('debug', page.notices[0]));
  assert.equal(parsed.type, 'alert');
  assert.equal(parsed.message.length, 4_000);
  assert.equal(parseDialogBridgeNotice(consoleEvent('log', page.notices[0])), null, 'another console level');
  assert.equal(parseDialogBridgeNotice(consoleEvent('debug', ['page text', 'alert', 'x'])), null);
  assert.equal(parseDialogBridgeNotice({ type: 'debug' }), null);
  assert.deepEqual(parseDialogBridgeNotice(consoleEvent('debug', [page.notices[0][0], 'forged', 'm'])), {
    type: 'dialog',
    message: 'm',
  });
});

test('the bridge leaves no trace a page can read: no global, native names, arity and source', () => {
  const page = bridgedPage(() => {}, JSON.stringify({ accept: true, promptText: '' }));
  assert.deepEqual(Object.keys(page.window).sort(), ['alert', 'confirm', 'prompt']);
  for (const name of ['alert', 'confirm', 'prompt']) {
    const fn = page.window[name];
    assert.equal(fn.name, name);
    assert.equal(Function.prototype.toString.call(fn), 'function () { [native code] }', name);
  }
  assert.equal(page.window.alert.length, 1, "the arity is the page's own function's");
  assert.doesNotMatch(DIALOG_BRIDGE_SCRIPT, /(?:window|globalThis)\.__/);
});

test('a page replacing XMLHttpRequest afterwards never sees a bridge request', () => {
  class Request {
    responseText = JSON.stringify({ accept: true, promptText: '' });
    open() {}
    send() {}
  }
  const context = {
    URL,
    URLSearchParams,
    XMLHttpRequest: Request,
    console: { debug() {} },
    location: { href: 'https://example.test/' },
    window: { confirm: () => false },
  };
  runInNewContext(DIALOG_BRIDGE_SCRIPT, context);
  const seen = [];
  Request.prototype.open = (...args) => seen.push(args);
  Request.prototype.send = (...args) => seen.push(args);
  assert.equal(context.window.confirm('Continue?'), true);
  assert.deepEqual(seen, []);
});

test("a popup's first document, which reuses its about:blank window, asks its own origin", () => {
  const opened = [];
  class Request {
    responseText = JSON.stringify({ accept: true, promptText: '' });
    open(_method, url) {
      opened.push(url);
    }
    send() {}
  }
  const context = {
    URL,
    URLSearchParams,
    XMLHttpRequest: Request,
    console: { debug() {} },
    // window.open's initial document, where the bridge is first installed.
    location: { href: 'about:blank' },
    window: { alert() {} },
  };
  runInNewContext(DIALOG_BRIDGE_SCRIPT, context);
  // The popup's page commits into the same window, closure and all.
  context.location.href = 'https://filing.example.test/easy/apply';
  context.window.alert('Proceed to payment');
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0]).origin, 'https://filing.example.test');
  assert.equal(new URL(opened[0]).pathname, DIALOG_BRIDGE_PATH);
});

test('accepting a prompt default unchanged keeps the full default, past the shown copy', () => {
  const long = 'y'.repeat(3_000);
  const kept = bridgedPage(
    () => {},
    JSON.stringify({ accept: true, promptText: 'y'.repeat(2_000), keepDefault: true })
  );
  assert.equal(kept.window.prompt('Value?', long), long);
  const edited = bridgedPage(() => {}, JSON.stringify({ accept: true, promptText: 'edited' }));
  assert.equal(edited.window.prompt('Value?', long), 'edited');
  const body = (params) => JSON.parse(Buffer.from(String(params.body), 'base64').toString('utf8'));
  assert.equal(body(dialogBridgeFulfillParams('r', true, 'a', true)).keepDefault, true);
  assert.equal(body(dialogBridgeFulfillParams('r', true, 'a')).keepDefault, undefined);
});
