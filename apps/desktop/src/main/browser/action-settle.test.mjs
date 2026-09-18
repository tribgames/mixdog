import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserSettle } from './settle.ts';
import { BrowserNetworkLedger } from './network.ts';
import { browserRenderCheckpoint } from './render-checkpoint.ts';

function fixture(t) {
  const dom = new JSDOM('<main>Initial</main>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let loading = false;
  let url = 'https://example.test/app';
  const guest = Object.assign(new EventEmitter(), {
    isLoading: () => loading,
    isDestroyed: () => false,
    stop: () => {},
    getURL: () => url,
  });
  const network = new BrowserNetworkLedger();
  const diagnostics = { network, pendingDialog: null };
  const settle = createBrowserSettle({
    diagnostics: () => diagnostics,
    evaluate: async (_guest, expression, signal) => {
      signal?.throwIfAborted();
      return dom.window.eval(expression);
    },
    renderCheckpoint: async (_guest, background, signal) => {
      signal?.throwIfAborted();
      await dom.window.eval(browserRenderCheckpoint(background));
    },
    pageText: async () => dom.window.document.body.textContent,
    quietMs: 20,
    domTimeoutMs: 200,
    loadTimeoutMs: 200,
  });
  return {
    dom,
    guest,
    network,
    diagnostics,
    settle,
    setLoading(value) {
      loading = value;
      if (!value) guest.emit('did-stop-loading');
    },
    setUrl(value) {
      url = value;
    },
  };
}

test('a route swapped without a load waits for the new view, and a url condition cannot cut it short', async (t) => {
  const f = fixture(t);
  // history.pushState moved the address at once; the app renders the new
  // screen a moment later, and a url postcondition is already satisfied.
  f.setUrl('https://example.test/app/learn');
  f.dom.window.setTimeout(() => {
    f.dom.window.document.querySelector('main').textContent = 'Learn';
  }, 30);
  await f.settle.settleAfterAction(f.guest, undefined, Promise.resolve(), {
    background: true,
    previousUrl: 'https://example.test/app',
  });
  assert.equal(f.dom.window.document.body.textContent, 'Learn');

  // An address that did not move keeps the early exit, so ordinary gestures
  // are not slowed down by this.
  const quick = fixture(t);
  quick.dom.window.setTimeout(() => {
    quick.dom.window.document.querySelector('main').textContent = 'Late';
  }, 30);
  await quick.settle.settleAfterAction(quick.guest, undefined, Promise.resolve(), {
    background: true,
    previousUrl: 'https://example.test/app',
  });
  assert.equal(quick.dom.window.document.body.textContent, 'Initial');
});

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
  await assert.rejects(
    f.settle.settleAfterAction(f.guest, controller.signal, undefined, { background: true }),
    /cancelled/
  );
  const broken = createBrowserSettle({
    diagnostics: () => f.diagnostics,
    renderCheckpoint: async () => {
      throw new Error('renderer unavailable');
    },
    pageText: async () => '',
    quietMs: 20,
    domTimeoutMs: 200,
    loadTimeoutMs: 200,
  });
  await assert.rejects(
    broken.settleAfterAction(f.guest, undefined, undefined, { background: true }),
    /checkpoint failed/
  );
});

test('a step whose reading fails reports the cause and where to go next', async (t) => {
  const f = fixture(t);
  const broken = createBrowserSettle({
    diagnostics: () => f.diagnostics,
    renderCheckpoint: async () => {
      throw new Error('frame topology changed during observation');
    },
    pageText: async () => '',
    quietMs: 20,
    domTimeoutMs: 200,
    loadTimeoutMs: 200,
  });
  const result = await broken.stepSettleResult(f.guest, undefined, true);
  assert.equal(result.outcome, 'inconclusive');
  assert.match(result.text, /input was not replayed/);
  assert.match(result.text, /observe it again instead of repeating the action/);
  assert.match(result.text, /frame topology changed during observation/);
});

test('reload settlement waits for replacement frames before its rendering checkpoint', async () => {
  let loading = true;
  let checkpoints = 0;
  const guest = Object.assign(new EventEmitter(), {
    isLoading: () => loading,
    isDestroyed: () => false,
    stop: () => {},
  });
  const settle = createBrowserSettle({
    diagnostics: () => ({ pendingDialog: null, network: new BrowserNetworkLedger() }),
    renderCheckpoint: async () => {
      assert.equal(loading, false, 'do not inspect contexts that reload is replacing');
      checkpoints++;
    },
    quietMs: 20,
    domTimeoutMs: 200,
    loadTimeoutMs: 200,
  });
  const pending = settle.settleAfterAction(guest, undefined, undefined, { background: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkpoints, 0);
  loading = false;
  guest.emit('did-stop-loading');
  await pending;
  assert.equal(checkpoints, 1);
  assert.equal(guest.listenerCount('did-stop-loading'), 0);
});

test('cancellation during reload settling removes the load listener without inspecting replaced frames', async () => {
  const controller = new AbortController();
  let checkpoints = 0;
  let stopped = 0;
  const guest = Object.assign(new EventEmitter(), {
    isLoading: () => true,
    isDestroyed: () => false,
    stop: () => {
      stopped++;
    },
  });
  const settle = createBrowserSettle({
    diagnostics: () => ({ pendingDialog: null, network: new BrowserNetworkLedger() }),
    renderCheckpoint: async () => {
      checkpoints++;
    },
    quietMs: 20,
    domTimeoutMs: 200,
    loadTimeoutMs: 200,
  });
  const pending = settle.settleAfterAction(guest, controller.signal);
  controller.abort(new Error('reload cancelled'));
  await assert.rejects(pending, /reload cancelled/);
  assert.equal(checkpoints, 0);
  assert.equal(stopped, 1);
  assert.equal(guest.listenerCount('did-stop-loading'), 0);
});
