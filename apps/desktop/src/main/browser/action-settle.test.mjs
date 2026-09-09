import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserSettle } from './settle.ts';
import { BrowserNetworkLedger } from './network.ts';

function fixture(t) {
  const dom = new JSDOM('<main>Initial</main>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let loading = false;
  const guest = Object.assign(new EventEmitter(), {
    isLoading: () => loading, isDestroyed: () => false, stop: () => {},
  });
  const network = new BrowserNetworkLedger();
  const diagnostics = { network, pendingDialog: null };
  const settle = createBrowserSettle({
    diagnostics: () => diagnostics,
    evaluate: async (_guest, expression, signal) => {
      signal?.throwIfAborted();
      return dom.window.eval(expression);
    },
    pageText: async () => dom.window.document.body.textContent,
    quietMs: 20, domTimeoutMs: 200, loadTimeoutMs: 200,
  });
  return { dom, guest, network, diagnostics, settle,
    setLoading(value) {
      loading = value;
      if (!value) guest.emit('did-stop-loading');
    },
  };
}

test('action settlement observes scheduled DOM work before returning', async (t) => {
  const f = fixture(t);
  f.dom.window.setTimeout(() => {
    f.dom.window.document.querySelector('main').textContent = 'Rendered';
  }, 0);
  await f.settle.settleAfterAction(f.guest, undefined, undefined, { background: true });
  assert.equal(f.dom.window.document.body.textContent, 'Rendered');
});

test('action settlement still waits for in-flight request and document completion', async (t) => {
  const f = fixture(t);
  f.setLoading(true);
  f.network.requestWillBeSent({ requestId: 'pending', request: { url: 'https://example.test/data' } });
  f.dom.window.setTimeout(() => {
    f.dom.window.document.querySelector('main').textContent = 'Response rendered';
    f.network.loadingFinished({ requestId: 'pending' });
    f.setLoading(false);
  }, 25);
  await f.settle.settleAfterAction(f.guest, undefined, undefined, { background: true });
  assert.equal(f.dom.window.document.body.textContent, 'Response rendered');
  assert.equal(f.guest.isLoading(), false);
  assert.equal(f.network.pendingCount, 0);
});

test('action settlement fails closed on cancellation and failed rendering', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(f.settle.settleAfterAction(f.guest, controller.signal, undefined,
    { background: true }), /cancelled/);
  const broken = createBrowserSettle({
    diagnostics: () => f.diagnostics,
    evaluate: async () => { throw new Error('renderer unavailable'); },
    pageText: async () => '', quietMs: 20, domTimeoutMs: 200, loadTimeoutMs: 200,
  });
  await assert.rejects(broken.settleAfterAction(f.guest, undefined, undefined,
    { background: true }), /checkpoint failed/);
});
