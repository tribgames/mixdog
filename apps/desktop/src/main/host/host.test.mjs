import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeBrowserCredentialId,
  normalizeBrowserHistoryQuery,
  normalizeBrowserImportRequest,
  normalizeRemoteBrowserTabId,
} from '../../shared/remote-browser.ts';
import { normalizeRemoteTabUrl } from '../remote-browser-methods.ts';
import { createComputerPillSource } from './computer-pill.ts';
import { createDesktopHost } from './index.ts';
import { toBrowserCommand } from './browser-command.ts';
import { encodeMediaFrame } from './media-frame.ts';

function pair() {
  const requests = new Map();
  const notifications = new Map();
  const closers = [];
  const sent = { requests: [], notifications: [], binary: [] };
  const connection = {
    request: async (method, params) => {
      sent.requests.push([method, params]);
      if (params?.key === 'visualize' && sent.failVisualize) throw new Error('core refused the state');
      return {};
    },
    notify: (method, params) => sent.notifications.push([method, params]),
    sendBinary: (frame) => sent.binary.push(frame),
    handleRequest: (method, handler) => requests.set(method, handler),
    handleNotification: (method, handler) => notifications.set(method, handler),
    onClose: (listener) => closers.push(listener),
  };
  return {
    connection,
    sent,
    call: (method, params, signal = new AbortController().signal) => requests.get(method)(params, signal),
    push: (method, params) => notifications.get(method)(params),
    close: () => closers.forEach((listener) => listener()),
  };
}

/** The updater: `state` and `busy` are what a test sets; installs are recorded. */
function updaterFixture(calls) {
  const updater = {
    state: { status: 'ready', version: '2.0.0' },
    busy: false,
    checkResult: { checked: true },
    check: async () => updater.checkResult,
    getState: () => updater.state,
    confirmBusy: async () => {
      calls.updates.push('confirmBusy');
      if (updater.busy) updater.state = { status: 'ready', version: '2.0.0', busy: true };
      return updater.busy;
    },
    install: async (confirmed) => void calls.updates.push(`install:${confirmed}`),
  };
  calls.updater = updater;
  return updater;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function build(overrides = {}) {
  const wire = pair();
  const calls = { viewFailures: [], installFailures: [], updates: [], publishFailures: [], remote: [], controls: [], stream: [], executed: [], exported: [], lifecycle: [], toasts: [], sounds: 0, activations: 0 };
  const clicks = [];
  const host = createDesktopHost({
    connection: wire.connection,
    hostId: 'host-1',
    browser: () => ({
      runner: {
        execute: async (command, signal) => {
          calls.executed.push(command);
          if (command.action === 'boom') throw new Error('failed at https://u:secret@x.test/');
          if (command.action === 'wait') await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
          return { text: 'ok' };
        },
        begin: () => calls.lifecycle.push('begin'),
        ready: () => calls.lifecycle.push('ready'),
        inactive: () => calls.lifecycle.push('inactive'),
        end: () => calls.lifecycle.push('end'),
      },
      view: {
        remoteBrowserStream: async (id, options) => {
          if (calls.failStream) throw new Error('no page');
          calls.stream.push([id, options]);
        },
        remoteBrowserControl: async (id, control) => {
          calls.controls.push([id, control]);
          if (control.type === 'navigate') throw new Error('refused https://u:secret@x.test/');
        },
      },
      remote: async (method, args) => {
        calls.remote.push([method, args]);
        // `release` answers nothing (BrowserHost.releaseSession returns void).
        return method === 'release' ? undefined : [{ method }];
      },
      tabs: {
        remoteTabsWatch: (on) => {
          calls.lifecycle.push(`watch:${on}`);
          return [{ id: 'main-browser-1', title: 'T', url: 'https://a.test/', loading: false }];
        },
      },
    }),
    onVisualizePublishFailed: (error) => calls.publishFailures.push(error.message),
    onBrowserViewFailed: (error) => calls.viewFailures.push(error.message),
    onUpdaterInstallFailed: (error) => calls.installFailures.push(error.message),
    visualize: () => ({
      execute: async (command) => ({ text: 'ran', command }),
      exportForDevice: async (command) => {
        calls.exported.push(command);
        return { path: '/tmp/mixdog-visualize-export-a/pane.png' };
      },
      snapshot: () => [{ sessionId: 's1', tabs: [], active: null }],
    }),
    files: () => ({
      captureFileSnapshot: async (root, rel, grant) => ({ root, rel, grant }),
      localPageUrl: async (root, rel, scope) => `http://127.0.0.1:1/t/${scope}/${rel}`,
    }),
    resolveProxy: async (url) => (url.includes('bad') ? Promise.reject(new Error('PAC http://u:p@pac/x')) : `PROXY ${url}`),
    notifications: {
      createNotification: (content) => {
        const toast = { content, show() {}, on: (event, fn) => event === 'click' && clicks.push(fn) };
        calls.toasts.push(toast);
        return toast;
      },
      playSound: async () => void calls.sounds++,
      activate: () => void calls.activations++,
      isSupported: () => true,
      idleSeconds: () => 42,
    },
    updater: updaterFixture(calls),
    ...overrides,
  });
  return { wire, host, calls, clicks };
}

test('a browser command runs on the thread as session and answers the tool result', async () => {
  const { wire, calls } = build();
  const result = await wire.call('host/browser/command', { action: 'snapshot', input: { turn_id: 3 }, threadId: 'th1' });
  assert.deepEqual(result, { text: 'ok' });
  assert.deepEqual(calls.executed[0], { turn_id: 3, action: 'snapshot', session_id: 'th1' });
});

test('a failing command is an error with the message redacted', async () => {
  const { wire } = build();
  await assert.rejects(
    wire.call('host/browser/command', { action: 'boom', threadId: 't' }),
    (error) => error.code === -32000 && !error.message.includes('secret')
  );
  assert.throws(() => toBrowserCommand({ input: {} }), (error) => error.code === -32602);
});

test('an abandoned command aborts and a closed claimed connection stops the browser', async () => {
  const { wire, host, calls } = build();
  await host.claim();
  assert.deepEqual(wire.sent.requests[0], ['host/claim', { hostId: 'host-1' }]);
  assert.deepEqual(calls.lifecycle, ['begin', 'ready', 'watch:true']);
  assert.deepEqual(wire.sent.requests[1], [
    'host/state/set',
    { key: 'browserTabs', value: { tabs: [{ id: 'main-browser-1', title: 'T', url: 'https://a.test/', loading: false }] } },
  ]);
  await host.publishRemoteTabs([]);
  assert.equal(wire.sent.requests[2][1].key, 'visualize', 'the visualize state follows the claim');
  assert.deepEqual(wire.sent.requests[3], ['host/state/set', { key: 'browserTabs', value: { tabs: [] } }]);
  const abort = new AbortController();
  const pending = wire.call('host/browser/command', { action: 'wait', threadId: 't' }, abort.signal);
  abort.abort();
  await assert.rejects(pending);
  wire.close();
  assert.deepEqual(calls.lifecycle.slice(3), ['watch:false', 'inactive', 'end']);
});

test('view frames start the lease, send X17 JPEG frames only while viewed, and stop on off', async () => {
  const { wire, host, calls } = build();
  const request = { maxWidth: 800, maxHeight: 600 };
  // A notification in the protocol (server → host): pushed, never answered.
  wire.push('host/browser/viewFrames', { tabId: 's1', streamId: 7, on: true, request });
  await flush();
  assert.deepEqual(calls.stream, [['s1', request]]);
  const frame = (sessionId, extra = {}) => ({
    sessionId,
    width: 640,
    height: 480,
    image: { mimeType: 'image/jpeg', data: Buffer.from([1, 2, 3]).toString('base64') },
    ...extra,
  });
  await host.publishRemoteFrame(frame('other'));
  await host.publishRemoteFrame(frame('s1', { fitSettled: true }));
  assert.equal(wire.sent.binary.length, 1);
  assert.deepEqual(
    [...wire.sent.binary[0]],
    [...encodeMediaFrame({ flags: 1, streamId: 7, width: 640, height: 480 }, Uint8Array.of(1, 2, 3))]
  );
  assert.deepEqual([...wire.sent.binary[0].slice(0, 16)], [1, 1, 0, 0, 0, 7, 2, 128, 1, 224, 1, 0, 0, 0, 0, 0]);
  wire.push('host/browser/viewFrames', { tabId: 's1', streamId: 7, on: false });
  await flush();
  assert.deepEqual(calls.stream.at(-1), ['s1', null]);
  await host.publishRemoteFrame(frame('s1'));
  assert.equal(wire.sent.binary.length, 1);
  // An invalid notification throws at the handler; a stream that cannot start is reported.
  assert.throws(() => wire.push('host/browser/viewFrames', { tabId: 's1', on: true }), (e) => e.code === -32602);
});

test('a live view that cannot start is reported, as nothing answers the notification', async () => {
  const { wire, calls } = build();
  calls.failStream = true;
  wire.push('host/browser/viewFrames', { tabId: 's9', streamId: 1, on: true, request: { maxWidth: 10, maxHeight: 10 } });
  await flush();
  assert.deepEqual(calls.viewFailures, ['no page']);
});

test('system proxy answers rules for http(s) origins and a failure by name only', async () => {
  const { wire } = build();
  assert.deepEqual(await wire.call('host/systemProxy/resolve', { url: 'https://api.test/v1?x=1' }), {
    rules: 'PROXY https://api.test',
  });
  await assert.rejects(wire.call('host/systemProxy/resolve', { url: 'file:///x' }), (error) => error.code === -32602);
  await assert.rejects(
    wire.call('host/systemProxy/resolve', { url: 'https://bad.test' }),
    (error) => error.message === 'Error'
  );
});

test('a shown notification plays its sound and a click reports the thread', () => {
  const { wire, calls, clicks } = build();
  wire.push('host/notification/show', { title: 'T', body: 'B', threadId: 'th9', sound: 'default', volume: 50 });
  assert.deepEqual(calls.toasts[0].content, { title: 'T', body: 'B' });
  assert.equal(calls.sounds, 1);
  clicks.forEach((fn) => fn());
  assert.equal(calls.activations, 1);
  assert.deepEqual(wire.sent.notifications, [['host/notification/clicked', { threadId: 'th9' }]]);
});

test('the core asks whether this PC shows toasts and how long it has been idle, as Node\'s notificationStatus answered', async () => {
  const { wire } = build();
  assert.deepEqual(await wire.call('host/notification/status', {}), { supported: true, idleSeconds: 42 });
});

test('power, update state and remote target reports; state is re-sent after a claim', async () => {
  const { wire, host } = build();
  host.reports.power('suspend');
  host.reports.updateState({ phase: 'idle' });
  await host.reports.setRemoteTarget({ endpoint: 'ws://127.0.0.1:9/rpc', token: 't' });
  assert.deepEqual(wire.sent.notifications, [
    ['host/power', { event: 'suspend' }],
    ['host/update/report', { state: { phase: 'idle' } }],
  ]);
  assert.deepEqual(wire.sent.requests[0], ['host/remoteTarget/set', { endpoint: 'ws://127.0.0.1:9/rpc', token: 't' }]);
  await host.claim();
  assert.equal(wire.sent.notifications.length, 3);
  assert.deepEqual(await wire.call('host/update/command', { action: 'check' }), { checked: true });
});

test('non-tool browser requests get Node\'s argument checks, and a malformed one gets Node\'s message', async () => {
  const { wire, calls } = build();
  const call = (action, input, threadId = 'th1') => wire.call('host/browser/command', { action, input, threadId });
  const nodeMessage = (run) => {
    try {
      run();
    } catch (error) {
      return error.message;
    }
    throw new Error('expected a throw');
  };
  // Malformed values: invalid params carrying exactly the message Node's normalizer throws.
  const bad = [
    ['history', { query: 'x'.repeat(501) }, () => normalizeBrowserHistoryQuery('x'.repeat(501))],
    ['history', { query: 7 }, () => normalizeBrowserHistoryQuery(7)],
    ['release', { id: 'not-main' }, () => normalizeRemoteBrowserTabId('not-main')],
    ['credentialFill', { credentialId: 'zz' }, () => normalizeBrowserCredentialId('zz')],
    ['tabOpen', { url: '' }, () => normalizeRemoteTabUrl('')],
    ['importStart', {}, () => normalizeBrowserImportRequest({})],
  ];
  for (const [action, input, node] of bad) {
    await assert.rejects(call(action, input), (error) => {
      assert.equal(error.code, -32602);
      assert.equal(error.message, nodeMessage(node));
      return true;
    });
  }
  assert.deepEqual(calls.remote, [], 'nothing malformed reaches the window process');
  // Well-formed: the same arguments Node forwards.
  assert.deepEqual(await call('history', { query: 'docs' }), [{ method: 'history' }]);
  await call('tabOpen', { url: 'https://a.test/' });
  await call('release', { id: 'main-browser-1' });
  await call('credentialFill', { credentialId: 'a'.repeat(24) });
  await call('credentialSuggestions');
  assert.deepEqual(calls.remote, [
    ['history', ['docs']],
    ['tabOpen', ['https://a.test/']],
    ['release', ['main-browser-1']],
    ['credentialFill', ['th1', 'a'.repeat(24)]],
    ['credentialSuggestions', ['th1']],
  ]);
  assert.deepEqual(calls.executed, [], 'none of these is a tool action');
});

test('visualize state is sent on a claim and on each change, and its commands and the file methods are served', async () => {
  const { wire, host } = build();
  await host.claim();
  const states = () => wire.sent.requests.filter(([method, params]) => method === 'host/state/set' && params.key === 'visualize');
  // The claim sends the list `hostSnapshot()` returns, `active: null` included.
  assert.deepEqual(states(), [
    ['host/state/set', { key: 'visualize', value: [{ sessionId: 's1', tabs: [], active: null }] }],
  ]);
  await host.publishVisualize({ sessionId: 's1', reveal: true });
  assert.deepEqual(states()[1][1].value, { sessionId: 's1', reveal: true });
  assert.deepEqual(await wire.call('host/visualize/command', { sessionId: 's1', action: 'open' }), {
    text: 'ran',
    command: { sessionId: 's1', action: 'open' },
  });
  assert.deepEqual(await wire.call('host/capture/fileSnapshot', { root: '/p', rel: 'a.html', grant: true }), {
    root: '/p',
    rel: 'a.html',
    grant: true,
  });
  assert.equal(await wire.call('host/localPage/url', { root: '/p', rel: 'a.html', scope: 'file' }), 'http://127.0.0.1:1/t/file/a.html');
  await assert.rejects(wire.call('host/localPage/url', 7), (error) => error.code === -32602);
});

test('a device export draws through the service\'s exportForDevice and answers its path', async () => {
  const { wire, calls } = build();
  const input = { sessionId: 's1', tabId: 'v1', format: 'png', pane: 0, forDevice: true };
  assert.deepEqual(await wire.call('host/visualize/command', { sessionId: 's1', cwd: '/p', action: 'export', input }), {
    path: '/tmp/mixdog-visualize-export-a/pane.png',
  });
  assert.deepEqual(calls.exported, [{ sessionId: 's1', tabId: 'v1', action: 'export', format: 'png', pane: 0 }]);
  // The project export has no device form (remote-visualize.ts: 'export format is invalid.').
  await assert.rejects(
    wire.call('host/visualize/command', { action: 'export', input: { ...input, format: 'project' } }),
    (error) => /export format is invalid\./.test(error.message)
  );
  // An export without the mark is the tool's own export, run by xecute.
  const plain = await wire.call('host/visualize/command', { sessionId: 's1', action: 'export', input: { format: 'png' } });
  assert.equal(plain.text, 'ran');
  assert.equal(calls.exported.length, 1);
});

test('update install answers the state taken before installing, and installs only when ready and not held', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { wire, calls } = build();
  const { updater } = calls;
  // Ready, unconfirmed, nothing running: the ready state is answered, then it installs.
  assert.deepEqual(await wire.call('host/update/command', { action: 'install' }), { status: 'ready', version: '2.0.0' });
  assert.deepEqual(calls.updates, ['confirmBusy'], 'the install waits until the caller is answered');
  await flush();
  assert.deepEqual(calls.updates, ['confirmBusy', 'install:false']);
  // Busy (agent tasks running): the answer is the state saying why, and nothing installs.
  calls.updates.length = 0;
  updater.busy = true;
  assert.deepEqual(await wire.call('host/update/command', { action: 'install' }), {
    status: 'ready',
    version: '2.0.0',
    busy: true,
  });
  await flush();
  assert.deepEqual(calls.updates, ['confirmBusy']);
  // Confirmed: installs past the busy state without asking.
  calls.updates.length = 0;
  updater.state = { status: 'ready', version: '2.0.0' };
  await wire.call('host/update/command', { action: 'install', confirmed: true });
  await flush();
  assert.deepEqual(calls.updates, ['install:true']);
  // Not ready (downloading, idle, disabled): the state is answered and nothing installs.
  calls.updates.length = 0;
  updater.state = { status: 'downloading' };
  assert.deepEqual(await wire.call('host/update/command', { action: 'install', confirmed: true }), { status: 'downloading' });
  await flush();
  assert.deepEqual(calls.updates, []);
});

test('an install that fails after the answer is reported, not discarded', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { wire, calls } = build();
  calls.updater.install = async () => {
    throw new Error('installer could not start');
  };
  assert.deepEqual(await wire.call('host/update/command', { action: 'install' }), { status: 'ready', version: '2.0.0' });
  assert.deepEqual(calls.installFailures, [], 'the caller is answered before the install runs');
  await flush();
  await flush();
  assert.deepEqual(calls.installFailures, ['installer could not start']);
  // A synchronous throw is reported the same way.
  calls.updater.install = () => {
    throw new Error('no controller');
  };
  await wire.call('host/update/command', { action: 'install' });
  await flush();
  await flush();
  assert.deepEqual(calls.installFailures, ['installer could not start', 'no controller']);
});

test('update check falls back to the current state, as the updater does with no controller', async () => {
  const { wire, calls } = build();
  calls.updater.checkResult = undefined;
  calls.updater.state = { status: 'disabled' };
  assert.deepEqual(await wire.call('host/update/command', { action: 'check' }), { status: 'disabled' });
  await assert.rejects(wire.call('host/update/command', { action: 'zap' }), (error) => error.code === -32602);
});

test('a request that answers nothing answers null, as the window-process request path does', async () => {
  const { wire } = build();
  assert.equal(await wire.call('host/browser/command', { action: 'release', input: { id: 'main-browser-1' } }), null);
  // The pointer-event path answers the same way: `remoteBrowserControl`'s void is null.
  const gesture = { type: 'back', documentId: 'p1:2' };
  assert.equal(await wire.call('host/browser/command', { action: 'input', input: gesture, threadId: 'th1' }), null);
});

test('a failed claim-time visualize snapshot is reported, not swallowed', async () => {
  const { wire, host, calls } = build();
  wire.sent.failVisualize = true;
  await host.claim();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.publishFailures, ['core refused the state']);
  // A failing snapshot() is reported the same way.
  const second = build({
    visualize: () => ({
      execute: async () => ({}),
      snapshot: () => {
        throw new Error('snapshot unavailable');
      },
    }),
  });
  await second.host.claim();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(second.calls.publishFailures, ['snapshot unavailable']);
});

test('a phone gesture runs end to end through the host channel, in order, off the tool validator', async () => {
  const { wire, calls } = build();
  const gesture = (phase) => ({
    type: 'pointer',
    documentId: 'p1:2',
    phase,
    x: 10,
    y: 20,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  const sends = ['mousePressed', 'mouseReleased'].map((phase) =>
    wire.call('host/browser/command', { action: 'input', threadId: 'th1', input: gesture(phase) })
  );
  const results = await Promise.all(sends);
  assert.deepEqual(results, [null, null]);
  assert.deepEqual(
    calls.controls.map(([id, control]) => [id, control.type, control.phase]),
    [['th1', 'pointer', 'mousePressed'], ['th1', 'pointer', 'mouseReleased']]
  );
  assert.deepEqual(calls.executed, [], 'input never reaches the tool runner');
  await wire.call('host/browser/command', { action: 'input', threadId: 'th1', input: { type: 'back' } });
  assert.deepEqual(calls.controls.at(-1), ['th1', { type: 'back' }]);
  await assert.rejects(
    wire.call('host/browser/command', { action: 'input', threadId: 'th1', input: { type: 'bogus' } }),
    (error) => error.code === -32602
  );
  await assert.rejects(
    wire.call('host/browser/command', { action: 'input', threadId: 'th1', input: { type: 'navigate', url: 'https://x.test/' } }),
    (error) => error.code === -32000 && !error.message.includes('secret')
  );
});

test('the pill snapshot carries cleanupState, so an idle one neither stops nor sticks', () => {
  const source = createComputerPillSource(() => 5);
  assert.equal(source.snapshot().cleanupState, 'ready');
  source.apply({ active: false, observeOnly: false, controller: null, sessionThreadId: null, sessions: [], cleanupState: 'failed' });
  assert.equal(source.snapshot().cleanupState, 'failed');
  source.apply({ active: false, observeOnly: false, controller: null, sessionThreadId: null, sessions: [] });
  assert.equal(source.snapshot().cleanupState, 'ready');
});

test('the computer pill source turns section values into snapshots', () => {
  const source = createComputerPillSource(() => 5);
  const seen = [];
  const off = source.subscribe((snapshot) => seen.push(snapshot));
  source.apply({ active: true, observeOnly: false, controller: 'agent', sessionThreadId: 'th1', sessions: [{ sessionThreadId: 'th1', observeOnly: false }] });
  source.apply({ active: false, observeOnly: false, controller: null, sessionThreadId: null, sessions: [] });
  off();
  source.apply({ active: true, observeOnly: true, controller: null, sessionThreadId: 'th2', sessions: [{ sessionThreadId: 'th2', observeOnly: true }] });
  assert.deepEqual(seen.map((s) => [s.revision, s.presentSessionIds]), [[1, ['th1']], [2, []]]);
  assert.equal(seen[0].activities[0].sessionId, 'th1');
});

test('the computer pill source keeps every open session, oldest first', () => {
  const source = createComputerPillSource(() => 5);
  source.apply({
    active: true,
    observeOnly: true,
    controller: null,
    sessionThreadId: 'thB',
    sessions: [
      { sessionThreadId: 'thA', observeOnly: false },
      { sessionThreadId: 'thB', observeOnly: true },
    ],
  });
  const snapshot = source.snapshot();
  assert.deepEqual(snapshot.presentSessionIds, ['thA', 'thB']);
  assert.deepEqual(snapshot.activities.map((a) => [a.sessionId, a.action]), [['thA', 'control'], ['thB', 'observe']]);
});
