import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBrowserGuestCdp } from './cdp.ts';
import { BrowserGuestStateStore } from './guest-state.ts';
import { MAX_CHILD_CDP_SESSIONS } from './command.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(send = async () => ({}), matchInterceptRule = () => undefined, pageGuardScripts = undefined) {
  const state = new BrowserGuestStateStore();
  const calls = [];
  const guest = new EventEmitter();
  let attached = false;
  let destroyed = false;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
      debug.emit('detach', {}, 'test detach');
    },
    sendCommand: (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return send(method, params, sessionId);
    },
  });
  Object.assign(guest, {
    debugger: debug,
    isDestroyed: () => destroyed,
    getURL: () => 'about:blank',
    destroy: () => {
      destroyed = true;
      guest.emit('destroyed');
    },
  });
  const cdp = createBrowserGuestCdp({
    state,
    interceptFetchPatterns: () => [],
    matchInterceptRule,
    pageGuardScripts,
  });
  const attachChild = (id) =>
    debug.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: id,
      targetInfo: { type: 'iframe', targetId: id, url: 'https://frame.test' },
    });
  return { state, guest, debug, cdp, calls, attachChild };
}

test('policy guards reach the root document and every child frame, and stay absent without a policy', async () => {
  const guarded = fixture(
    async () => ({}),
    () => undefined,
    () => ['/* guard */']
  );
  await guarded.cdp.guestDebugger(guarded.guest);
  guarded.attachChild('frame-1');
  await tick();
  const injected = guarded.calls.filter(
    (call) => call.method === 'Page.addScriptToEvaluateOnNewDocument' && call.params.source === '/* guard */'
  );
  // An iframe runs its own realm: a guard only on the root leaves it open.
  assert.deepEqual(
    injected.map((call) => call.sessionId),
    [undefined, 'frame-1']
  );
  assert.equal(
    injected.every((call) => call.params.runImmediately === true),
    true
  );

  const unrestricted = fixture();
  await unrestricted.cdp.guestDebugger(unrestricted.guest);
  await tick();
  const sources = unrestricted.calls
    .filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
    .map((call) => call.params.source);
  assert.equal(sources.length, 1, 'only the dialog bridge is installed without a policy');
  assert.match(sources[0], /__mixdogDialogBridgeInstalled/);
});

test('root observes frames without recursive auto-attach or forced excess-frame detach', async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  for (let i = 0; i <= MAX_CHILD_CDP_SESSIONS; i++) f.attachChild(`child-${i}`);
  await Promise.all([...f.state.for(f.guest).cdpSessions.values()].map((child) => child.ready));
  assert.equal(f.state.for(f.guest).cdpSessions.size, MAX_CHILD_CDP_SESSIONS);
  assert.deepEqual(
    f.calls.filter((call) => call.method === 'Target.setAutoAttach').map((call) => call.sessionId),
    [undefined]
  );
  assert.equal(
    f.calls.some((call) => call.method === 'Target.detachFromTarget'),
    false
  );
  assert.ok(f.calls.some((call) => call.method === 'Fetch.enable' && call.sessionId === 'child-0'));
  await f.cdp.detach(f.guest);
  assert.equal(f.state.for(f.guest).cdpSessions.size, 0);
});

test('intercept types use the Network request identity without conflating XHR or child sessions', async () => {
  const types = [];
  const f = fixture(undefined, (_guest, _url, type) => {
    types.push(type);
  });
  await f.cdp.guestDebugger(f.guest);
  const request = (type, sessionId) =>
    f.debug.emit(
      'message',
      {},
      'Network.requestWillBeSent',
      {
        requestId: 'request-1',
        type,
        request: { url: 'https://example.test/probe' },
      },
      sessionId
    );
  const paused = (networkId, resourceType, sessionId) =>
    f.debug.emit(
      'message',
      {},
      'Fetch.requestPaused',
      {
        requestId: 'pause-1',
        networkId,
        resourceType,
        request: { url: 'https://example.test/probe' },
        responseStatusCode: 200,
      },
      sessionId
    );
  request('Fetch');
  request('XHR', 'child-session');
  paused('request-1', 'XHR');
  paused('request-1', 'XHR', 'child-session');
  paused('unrecorded', 'Document');
  await tick();
  assert.deepEqual(types, ['fetch', 'xhr', 'Document']);
  await f.cdp.detach(f.guest);
});

test('a failing page script reports the position it threw at, not the message alone', async () => {
  const f = fixture(async (method) =>
    method === 'Runtime.evaluate'
      ? {
          exceptionDetails: {
            text: 'Uncaught',
            exception: {
              description: 'TypeError: nope\n    at <anonymous>:3:7\n    at run (<anonymous>:9:1)',
            },
          },
        }
      : {}
  );
  await f.cdp.guestDebugger(f.guest);
  await assert.rejects(f.cdp.evaluate(f.guest, 'null.x'), /^Error: TypeError: nope \(<anonymous>:3:7\)$/);
  await f.cdp.detach(f.guest);
});

test("resources the browser's own components load never surface as the page's failures", async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  const started = (requestId, url) =>
    f.debug.emit('message', {}, 'Network.requestWillBeSent', {
      requestId,
      type: 'Stylesheet',
      request: { url, method: 'GET' },
    });
  const componentUrl = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css';
  started('page-1', 'https://example.test/app.css');
  started('component-1', componentUrl);
  for (const requestId of ['page-1', 'component-1']) {
    f.debug.emit('message', {}, 'Network.loadingFailed', { requestId, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
  }
  for (const url of ['https://example.test/app.css', componentUrl]) {
    f.debug.emit('message', {}, 'Log.entryAdded', {
      entry: { level: 'error', text: 'Failed to load resource', url },
    });
  }
  await tick();
  const diagnostics = f.state.for(f.guest);
  assert.equal(diagnostics.networkFailures.length, 1);
  assert.match(diagnostics.networkFailures[0], /app\.css/);
  const errors = diagnostics.console.recentErrors(5);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /app\.css/);
  await f.cdp.detach(f.guest);
});

test('a deadline reached behind an open dialog names the dialog instead of the deadline alone', async () => {
  const f = fixture((method) => (method === 'Runtime.evaluate' ? new Promise(() => undefined) : Promise.resolve({})));
  await f.cdp.guestDebugger(f.guest);
  await assert.rejects(f.cdp.call(f.guest, 'Runtime.evaluate', {}, undefined, { timeoutMs: 10 }), /timed out after/);

  f.debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'saved?' });
  await assert.rejects(
    f.cdp.call(f.guest, 'Runtime.evaluate', {}, undefined, { timeoutMs: 10 }),
    /an open alert dialog is blocking this page: "saved\?"[\s\S]*handle_dialog/
  );
  await f.cdp.detach(f.guest);
});

test('a cancelled request is recorded but never volunteered as a page failure', async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  const started = (requestId, url) =>
    f.debug.emit('message', {}, 'Network.requestWillBeSent', {
      requestId,
      type: 'Document',
      request: { url, method: 'GET' },
    });
  started('download-1', 'https://example.test/report.pdf');
  started('broken-1', 'https://example.test/missing.css');
  // A download aborts its navigation on purpose; a name that does not resolve
  // is the page's own problem.
  f.debug.emit('message', {}, 'Network.loadingFailed', {
    requestId: 'download-1',
    errorText: 'net::ERR_ABORTED',
    canceled: true,
  });
  f.debug.emit('message', {}, 'Network.loadingFailed', {
    requestId: 'broken-1',
    errorText: 'net::ERR_NAME_NOT_RESOLVED',
  });
  await tick();
  const diagnostics = f.state.for(f.guest);
  assert.deepEqual(
    diagnostics.networkFailures.map((entry) => entry.replace(/^GET /, '')),
    ['https://example.test/missing.css — net::ERR_NAME_NOT_RESOLVED']
  );
  assert.equal(diagnostics.network.list({ query: 'report.pdf' }).total, 1, 'the cancelled request is still readable');
  await f.cdp.detach(f.guest);
});

test('detach during initialization prevents late auto-attach and permits a fresh connection', async () => {
  const pending = Promise.withResolvers();
  let hold = true;
  const f = fixture((method) => (method === 'Page.enable' && hold ? pending.promise : Promise.resolve({})));
  const ready = f.cdp.guestDebugger(f.guest);
  const rejected = assert.rejects(ready, /detach/);
  await tick();
  await f.cdp.detach(f.guest);
  hold = false;
  const next = f.cdp.guestDebugger(f.guest);
  pending.resolve({});
  await rejected;
  await next;
  assert.equal(await f.cdp.guestDebugger(f.guest), f.debug);
  assert.equal(f.debug.listenerCount('message'), 1);
  assert.equal(f.calls.filter((call) => call.method === 'Target.setAutoAttach').length, 1);
  await f.cdp.detach(f.guest);
});

test('closing a page before its initial document commits never attaches the debugger', async () => {
  const pending = Promise.withResolvers();
  const f = fixture();
  f.guest.getURL = () => '';
  f.guest.loadURL = () => pending.promise;
  const ready = f.cdp.guestDebugger(f.guest);
  const rejected = assert.rejects(ready, /unavailable/);
  f.guest.destroy();
  pending.resolve();
  await rejected;
  assert.equal(f.debug.isAttached(), false);
  assert.deepEqual(f.calls, []);
});

test('frame removal during initialization does not start late observation domains', async () => {
  const pending = Promise.withResolvers();
  const f = fixture((method, _params, sessionId) =>
    method === 'Page.enable' && sessionId ? pending.promise : Promise.resolve({})
  );
  await f.cdp.guestDebugger(f.guest);
  f.attachChild('removed');
  const ready = f.state.for(f.guest).cdpSessions.get('removed').ready;
  f.debug.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'removed' });
  pending.resolve({});
  await ready;
  assert.equal(
    f.calls.some((call) => call.method === 'Network.enable' && call.sessionId === 'removed'),
    false
  );
  await f.cdp.detach(f.guest);
});

test('bridge uninstall blocks concurrent reattachment until detach finishes', async () => {
  const pending = Promise.withResolvers();
  const f = fixture((method) => (method === 'Runtime.evaluate' ? pending.promise : Promise.resolve({})));
  await f.cdp.guestDebugger(f.guest);
  const closing = f.cdp.detach(f.guest, { uninstallScript: 'void 0' });
  await assert.rejects(f.cdp.guestDebugger(f.guest), /unavailable/);
  pending.resolve({});
  await closing;
  assert.equal(f.debug.isAttached(), false);
});
