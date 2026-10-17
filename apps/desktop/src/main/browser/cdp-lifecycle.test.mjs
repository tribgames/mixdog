import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createBrowserGuestCdp } from './cdp.ts';
import { rememberBrowserIdentity } from './browser-identity.ts';
import { CHROME_LIKENESS_SCRIPT } from './chrome-likeness.ts';
import { DIALOG_BRIDGE_SCRIPT } from './dialog-bridge.ts';
import { BrowserGuestStateStore } from './guest-state.ts';
import { MAX_CHILD_CDP_SESSIONS } from './command.ts';
import { formatPageReport } from './snapshot-format.ts';
import { waitUntil } from '../../../../../src/runtime/shared/wait-until.test-support.mjs';

function fixture(
  send = async () => ({}),
  matchInterceptRule = () => undefined,
  pageGuardScripts = undefined,
  rendererPeers = undefined,
  lingerMs = undefined
) {
  const state = new BrowserGuestStateStore(rendererPeers);
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
    getUserAgent: () => 'Fixture/1.0',
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
    lingerMs,
  });
  const attachChild = (id) =>
    debug.emit('message', {}, 'Target.attachedToTarget', {
      sessionId: id,
      targetInfo: { type: 'iframe', targetId: id, url: 'https://frame.test' },
    });
  return { state, guest, debug, cdp, calls, attachChild };
}

for (const bridged of [false, true]) {
  test(`a ${bridged ? 'bridged' : 'native'} startup dialog can be answered before blocked initialization`, {
    timeout: 3000,
  }, async (t) => {
    const initialization = Promise.withResolvers();
    const answerMethod = bridged ? 'Fetch.fulfillRequest' : 'Page.handleJavaScriptDialog';
    const f = fixture(async (method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return initialization.promise;
      if (method === answerMethod) initialization.resolve({});
      return {};
    });
    t.after(async () => {
      initialization.resolve({});
      await f.cdp.detach(f.guest);
    });
    let ready = false;
    const normal = f.cdp.guestDebugger(f.guest).then(() => {
      ready = true;
    });
    await waitUntil(() => f.calls.some((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument'));
    f.state.for(f.guest).pendingDialog = {
      type: 'alert',
      message: 'onload',
      openedAt: Date.now(),
      ...(bridged ? { bridgeRequestId: 'dialog-request' } : {}),
    };
    assert.equal(ready, false);
    await f.cdp.call(
      f.guest,
      answerMethod,
      bridged ? { requestId: 'dialog-request', responseCode: 200 } : { accept: true }
    );
    await normal;
    assert.equal(ready, true);
    assert.equal(f.calls.filter((call) => call.method === answerMethod).length, 1);
  });
}

test('policy guards reach the root document and every child frame, and stay absent without a policy', async () => {
  const guarded = fixture(
    async () => ({}),
    () => undefined,
    () => ['/* guard */']
  );
  await guarded.cdp.guestDebugger(guarded.guest);
  guarded.attachChild('frame-1');
  const guardInjections = () =>
    guarded.calls.filter(
      (call) => call.method === 'Page.addScriptToEvaluateOnNewDocument' && call.params.source === '/* guard */'
    );
  await waitUntil(() => guardInjections().length >= 2, { message: 'guard injected into root and child frame' });
  const injected = guardInjections();
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
  await waitUntil(() => unrestricted.calls.some((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument'), {
    message: 'dialog bridge installed',
  });
  const sources = unrestricted.calls
    .filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
    .map((call) => call.params.source);
  assert.deepEqual(
    sources,
    [DIALOG_BRIDGE_SCRIPT, CHROME_LIKENESS_SCRIPT],
    'only the dialog bridge and the browser identity are installed without a policy'
  );
});

test('a page only browsed shows no script, log or accessibility observation; driving brings them up and back down', async () => {
  const f = fixture(undefined, undefined, undefined, undefined, 30);
  await f.cdp.guestDebugger(f.guest);
  f.attachChild('frame-1');
  await f.state.for(f.guest).cdpSessions.get('frame-1').ready;
  await waitUntil(() => f.calls.some((call) => call.method === 'Network.enable' && call.sessionId === 'frame-1'));
  const driven = ['Runtime.enable', 'Log.enable', 'Accessibility.enable'];
  const calls = (methods, sessionId) =>
    f.calls.filter((call) => methods.includes(call.method) && call.sessionId === sessionId).map((call) => call.method);
  assert.deepEqual(calls(driven, undefined), [], 'nothing a page could notice while a person browses');
  assert.ok(f.calls.some((call) => call.method === 'Network.setUserAgentOverride' && call.sessionId === undefined));
  assert.ok(f.calls.some((call) => call.method === 'Network.setUserAgentOverride' && call.sessionId === 'frame-1'));

  const release = f.cdp.drive(f.guest);
  await waitUntil(() => calls(driven, 'frame-1').length === 3, { message: 'child frame driven' });
  assert.deepEqual(calls(driven, undefined).sort(), [...driven].sort());
  f.attachChild('frame-2');
  await waitUntil(() => calls(driven, 'frame-2').length === 3, { message: 'a frame attached while driving is driven' });
  release();
  const stopped = ['Runtime.disable', 'Log.disable', 'Accessibility.disable'];
  await waitUntil(() => calls(stopped, undefined).length === 3 && calls(stopped, 'frame-1').length === 3, {
    message: 'driving domains go down after the linger',
  });
  await f.cdp.detach(f.guest);
});

test('console entries a re-enabled domain replays are recorded once', async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  const log = (text, timestamp) =>
    f.debug.emit('message', {}, 'Runtime.consoleAPICalled', {
      type: 'log',
      timestamp,
      args: [{ type: 'string', value: text }],
    });
  log('first', 100);
  const record = f.state.for(f.guest);
  // Switching the domain back on replays what the page logged so far.
  record.consoleReplay.floor.set('|runtime', record.consoleReplay.seen.get('|runtime'));
  log('first', 100);
  log('while idle', 200);
  record.consoleReplay.floor.delete('|runtime');
  log('first', 100);
  const logged = record.console.format('all', '', 10);
  assert.equal(logged.match(/log: first/g).length, 2, 'only the replay is skipped, never a live entry');
  assert.match(logged, /while idle/);
  await f.cdp.detach(f.guest);
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
  await waitUntil(() => types.length >= 3, { message: 'three intercept decisions' });
  assert.deepEqual(types, ['fetch', 'xhr', 'Document']);
  await f.cdp.detach(f.guest);
});

test("a mocked body is fulfilled under the server's own status line", async () => {
  const rule = { id: 'i1', pattern: '*/api*', matcher: /api/, resourceTypes: [], abort: false, body: 'mock', hits: 0 };
  const f = fixture(undefined, () => rule);
  await f.cdp.guestDebugger(f.guest);
  f.debug.emit('message', {}, 'Fetch.requestPaused', {
    requestId: 'pause-404',
    resourceType: 'Fetch',
    request: { url: 'https://example.test/api' },
    responseStatusCode: 404,
    responseStatusText: 'Not Found',
  });
  const fulfilled = await waitUntil(() => f.calls.find((call) => call.method === 'Fetch.fulfillRequest'), {
    message: 'mocked body fulfilled',
  });
  // Chromium applies whatever status the fulfilment names, so the server's has
  // to be handed back or a 404 would reach the page as a mocked 200.
  assert.equal(fulfilled.params.responseCode, 404);
  assert.equal(fulfilled.params.responsePhrase, 'Not Found');
  assert.equal(Buffer.from(fulfilled.params.body, 'base64').toString('utf8'), 'mock');
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
  const refusal = 'navigation to example.test resolved to blocked private or internal address 0.0.0.0';
  f.state.for(f.guest);
  f.state.recordRefusedRequest(f.guest, 'https://example.test/app.css', refusal);
  started('page-1', 'https://example.test/app.css');
  started('component-1', componentUrl);
  for (const requestId of ['page-1', 'component-1']) {
    f.debug.emit('message', {}, 'Network.loadingFailed', { requestId, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
  }
  for (const url of ['https://example.test/app.css', componentUrl]) {
    f.debug.emit('message', {}, 'Log.entryAdded', {
      entry: { level: 'error', text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', url },
    });
  }
  const diagnostics = f.state.for(f.guest);
  await waitUntil(() => diagnostics.networkFailures.length >= 1 && diagnostics.console.recentErrors(5).length >= 1, {
    message: 'page failure and console error recorded',
  });
  assert.equal(diagnostics.networkFailures.length, 1);
  assert.match(diagnostics.networkFailures[0], /app\.css/);
  // The host's own request policy is the only client that blocks here, so
  // the refusal says so, with the rule's reason, instead of a bare code.
  const explained = `ERR_BLOCKED_BY_CLIENT (Browser Use network policy: ${refusal})`;
  assert.ok(diagnostics.networkFailures[0].endsWith(explained), diagnostics.networkFailures[0]);
  const errors = diagnostics.console.recentErrors(5);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /app\.css/);
  assert.ok(errors[0].includes(explained), errors[0]);
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
  const diagnostics = f.state.for(f.guest);
  await waitUntil(() => diagnostics.networkFailures.length >= 1, { message: 'broken request recorded' });
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
  await waitUntil(() => f.calls.some((call) => call.method === 'Page.enable'), {
    message: 'initialization reached Page.enable',
  });
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

test("a call against a page held by a renderer peer's dialog names that page, not its dialog's text", async () => {
  const peer = {};
  const f = fixture(
    (method) => {
      if (method === 'Runtime.evaluate') return new Promise(() => undefined);
      // Held well past the input poll, as a blocked renderer holds it.
      if (method.startsWith('Input.')) return new Promise((resolve) => setTimeout(() => resolve({}), 300));
      return Promise.resolve({});
    },
    undefined,
    undefined,
    () => [peer]
  );
  await f.cdp.guestDebugger(f.guest);
  f.state.for(peer).pendingDialog = { type: 'confirm', message: 'Delete everything?', openedAt: 0 };
  const error = await f.cdp.call(f.guest, 'Runtime.evaluate', {}, undefined, { timeoutMs: 10 }).catch((e) => e);
  assert.match(
    error.message,
    new RegExp(
      `an open confirm dialog on page ${f.state.pageId(peer)}, which shares this page's renderer[\\s\\S]*handle_dialog on that page`
    )
  );
  assert.doesNotMatch(error.message, /Delete everything/, "the other page's text stays with it");
  const input = await Promise.race([
    f.cdp.sendCdpInput(f.guest, f.debug, 'Input.dispatchMouseEvent', { type: 'mousePressed' }),
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 1_000)),
  ]);
  assert.equal(input, 'dialog', 'input returns as soon as the blocking dialog is known');
  await f.cdp.detach(f.guest);
});

test('a native dialog that closes by itself is reported once; a close never clears a bridged dialog', async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  const record = f.state.for(f.guest);
  f.debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'too early' });
  assert.equal(record.pendingDialog.type, 'alert');
  f.debug.emit('message', {}, 'Page.javascriptDialogClosed', { result: false, userInput: '' });
  assert.equal(record.pendingDialog, null);
  assert.equal(record.dismissedDialog.reason, 'early');
  const report = formatPageReport(record);
  assert.match(report, /Dismissed alert dialog "too early": it opened before the browser was intercepting dialogs/);
  assert.doesNotMatch(formatPageReport(record), /Dismissed/, 'said once');

  const bridged = { type: 'confirm', message: 'held', openedAt: 0, bridgeRequestId: 'r1' };
  record.pendingDialog = bridged;
  f.debug.emit('message', {}, 'Page.javascriptDialogClosed', { result: false, userInput: '' });
  assert.equal(record.pendingDialog, bridged);
  await f.cdp.detach(f.guest);
});

test("a bridge request the page's policy refused becomes a dismissed notice, not a page log", async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  // The bridge script's own console call, as the page's renderer makes it.
  const calls = [];
  class Refused {
    open() {}
    send() {
      throw new Error('Refused to connect: Content Security Policy');
    }
  }
  const page = {
    URL,
    URLSearchParams,
    XMLHttpRequest: Refused,
    location: { href: 'https://csp.test/' },
    console: { debug: (...args) => calls.push(args) },
    window: {},
  };
  runInNewContext(DIALOG_BRIDGE_SCRIPT, page);
  page.window.confirm('Proceed?');
  const toEvent = (type, args) => ({ type, args: args.map((value) => ({ type: 'string', value })) });
  f.debug.emit('message', {}, 'Runtime.consoleAPICalled', toEvent('debug', calls[0]));
  f.debug.emit('message', {}, 'Runtime.consoleAPICalled', toEvent('debug', ['page says hi']));
  const record = f.state.for(f.guest);
  assert.deepEqual(record.dismissedDialog, { type: 'confirm', message: 'Proceed?', reason: 'unreachable' });
  const logged = record.console.format('all', '', 10);
  assert.match(logged, /page says hi/, 'ordinary console calls are still recorded');
  assert.doesNotMatch(logged, /Proceed\?/, 'the notice is the host’s, not the page’s log');
  assert.match(formatPageReport(record), /Dismissed confirm dialog "Proceed\?": its request never reached the browser/);
  await f.cdp.detach(f.guest);
});

// Last in this file: the engine's facts are process-wide once learned.
test("a blank first page keeps the engine's identity; the first secure document brings Chrome's to every session", async () => {
  rememberBrowserIdentity({ userAgent: 'Fixture/1.0' });
  let secure = false;
  const f = fixture(async (method) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') {
      return {
        result: {
          value: secure
            ? { platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', model: '', mobile: false }
            : null,
        },
      };
    }
    return {};
  });
  await f.cdp.guestDebugger(f.guest);
  f.attachChild('frame-1');
  await f.state.for(f.guest).cdpSessions.get('frame-1').ready;
  const overrides = () => f.calls.filter((call) => call.method === 'Network.setUserAgentOverride');
  assert.deepEqual(
    overrides().map((call) => call.params),
    [{ userAgent: '' }, { userAgent: '' }],
    'an override without metadata would empty the brand list'
  );
  const probe = f.calls.find((call) => call.method === 'Runtime.evaluate');
  assert.equal(probe.params.contextId, 7, 'read in a world no page script shares');
  secure = true;
  f.debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://site.test/' } });
  await waitUntil(() => overrides().length === 4, { message: 'root and child re-identified' });
  for (const call of overrides().slice(2)) {
    assert.equal(call.params.userAgent, 'Fixture/1.0');
    assert.ok(call.params.userAgentMetadata.brands.some((entry) => entry.brand === 'Google Chrome'));
  }
  assert.deepEqual(
    overrides()
      .slice(2)
      .map((call) => call.sessionId),
    [undefined, 'frame-1']
  );
  await f.cdp.detach(f.guest);
});

test('an unexpected debugger detach settles the prompts it held instead of leaving them pending', async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  const record = f.state.for(f.guest);
  record.pendingDialog = { type: 'prompt', message: 'held', openedAt: 0, bridgeRequestId: 'r1' };
  record.pendingFileChooser = { mode: 'selectSingle', openedAt: 0 };
  f.debug.emit('detach', {}, 'replaced_with_devtools');
  assert.equal(record.pendingDialog, null);
  assert.equal(record.pendingFileChooser, null);
  assert.match(record.fault, /CDP detached: replaced_with_devtools/);
});
