import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CDP_SEND_ALLOWED, cdpSendRefusal, registerCdpSend } from './cdp-send.ts';

function harness({ dialog = null } = {}) {
  const handlers = new Map();
  const sent = [];
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const guest = { getURL: () => 'https://a.example/', isDestroyed: () => false };
  const state = {
    pageId: 'p1',
    documentGeneration: 1,
    cdpSessions: new Map([['s1', { type: 'iframe', frameId: 'f1' }]]),
    pendingDialog: dialog,
  };
  const ctx = {
    page: (id) => (id === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp: {
      call: async (_g, method, params, _signal, options = {}) => {
        options.beforeDispatch?.();
        sent.push({ method, params, options });
        return { echoed: method };
      },
    },
    events: { flush: () => {}, facts: (id) => ({ pageId: id, seq: 1 }) },
    redactKnown: (_id, text) => text.replaceAll('hunter2hunter2', '[SECRET]'),
    isEngineMode: () => true,
  };
  registerCdpSend(connection, ctx);
  const call = (params) => handlers.get('host/browser/cdp/send')(params, new AbortController().signal);
  return { call, sent, state };
}

test('a listed method is sent through the fenced executor and its result is answered with the facts', async () => {
  const h = harness();
  const result = await h.call({ pageId: 'p1', method: 'Page.getFrameTree', params: { a: 1 }, timeoutMs: 999_999 });
  assert.deepEqual(result.result, { echoed: 'Page.getFrameTree' });
  assert.equal(result.facts.pageId, 'p1');
  assert.deepEqual(h.sent[0].params, { a: 1 });
  assert.equal(h.sent[0].options.timeoutMs, 60_000);
});

test('every method that is not on the list is -32015 and nothing is sent', async () => {
  const h = harness();
  const refused = [
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.getOuterHTML',
    'Network.getRequestPostData',
    'Network.getResponseBody',
    'Network.getCookies',
    'Network.getAllCookies',
    'Storage.getCookies',
    'Input.dispatchKeyEvent',
    'Page.addScriptToEvaluateOnNewDocument',
    'Fetch.enable',
    'Emulation.setDeviceMetricsOverride',
    'Page.navigate',
    'Browser.close',
    'Target.createTarget',
    'Debugger.enable',
    'Page.captureScreenshot',
    'Mixdog.anything',
    'page.getFrameTree',
    'Page.getFrameTree ',
    '',
  ];
  for (const method of refused) {
    await assert.rejects(
      h.call({ pageId: 'p1', method }),
      (e) => (e.code === -32015 && e.data.reason.includes('not available')) || (method === '' && e.code === -32602),
      method
    );
  }
  assert.equal(h.sent.length, 0);
  assert.equal(cdpSendRefusal('Runtime.evaluate') !== undefined, true);
  assert.equal([...CDP_SEND_ALLOWED].every((method) => cdpSendRefusal(method) === undefined), true);
});

test('the list holds no method that evaluates script, reads a body, a cookie or the markup', () => {
  for (const method of CDP_SEND_ALLOWED) {
    assert.doesNotMatch(method, /^(Runtime\.(evaluate|callFunctionOn|compileScript|runScript)|Input\.|Fetch\.|Target\.|Debugger\.|Browser\.|Emulation\.|Tracing\.|DOMSnapshot\.)/);
    assert.doesNotMatch(method, /(Cookies|getResponseBody|getRequestPostData|getOuterHTML|getAllCookies)/);
  }
});

test('a session that is not attached, a stale expect and a blocking dialog are refused before the send', async () => {
  const h = harness();
  await assert.rejects(h.call({ pageId: 'p1', method: 'Page.getFrameTree', sessionId: 'zz' }), (e) => e.code === -32000);
  await assert.rejects(
    h.call({ pageId: 'p1', method: 'Page.getFrameTree', expect: { documentId: 'p1:0' } }),
    (e) => e.code === -32010
  );
  const blocked = harness({ dialog: { type: 'alert', message: 'm', openedAt: 1 } });
  await assert.rejects(blocked.call({ pageId: 'p1', method: 'Page.getFrameTree' }), (e) => e.code === -32014);
  assert.equal(h.sent.length + blocked.sent.length, 0);
  await h.call({ pageId: 'p1', method: 'DOM.getDocument', sessionId: 's1', expect: { documentId: 'p1:1' } });
  assert.equal(h.sent[0].options.sessionId, 's1');
});
