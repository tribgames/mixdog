// The phone's browser and Web Push calls through their adapters: each Node call becomes the one core request the core's relay table
// serves (browser/command for page input and the parity actions, browser/stream, browser/webrtcSignal, browser/screenDisplays,
// remoteAccess/*Push*), and the core's pushes reach the page's listeners as Node's did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter as browser } from './remote-protocol-browser.ts';
import { adapter as notifications } from './remote-protocol-notifications.ts';

function rig() {
  const requests = [];
  const notes = [];
  const sections = new Map();
  const storeListeners = new Set();
  const eventListeners = new Set();
  let live = true;
  const client = {
    call: async (method, params) => (requests.push([method, params]), { ok: method }),
    notify: (method, params) => notes.push([method, params]),
    on: (listener) => (eventListeners.add(listener), () => eventListeners.delete(listener)),
    store: {
      appFeed: () => ({ id: 'app', epoch: 'e1', seq: 1 }),
      section: (section, key) =>
        sections.has(`${section}:${key}`) ? { value: sections.get(`${section}:${key}`) } : undefined,
      subscribe: (listener) => (storeListeners.add(listener), () => storeListeners.delete(listener)),
      appLive: () => live,
    },
  };
  const fanned = [];
  const listeners = (name) => ({ name });
  const ctx = {
    remoteBrowserFrameListeners: listeners('frame'),
    remoteBrowserWebrtcListeners: listeners('webrtc'),
    remoteBrowserTabListeners: listeners('tabs'),
    browserImportProgressListeners: listeners('import'),
    browserOpenListeners: listeners('open'),
    browserApprovalSessionIds: [],
    desktopNoticeListeners: listeners('notice'),
    fanOut: (set, value) => fanned.push([set.name, value]),
    phone: { start: () => Promise.resolve() },
  };
  const host = {
    ctx,
    client: () => client,
    declareLane() {},
    onClient: (listener) => (listener(client), () => undefined),
  };
  const setSection = (key, value) => {
    sections.set(`hostState:${key}`, value);
    for (const listener of storeListeners) listener({ type: 'section', section: 'hostState', key });
  };
  const emit = (method, params) => {
    for (const listener of eventListeners) listener({ type: 'notification', notification: { method, params } });
  };
  return { host, requests, notes, fanned, setSection, emit, setLive: (value) => (live = value) };
}

test('the page input and the parity actions are browser/command requests with the fields the core checks', async () => {
  const { host, requests } = rig();
  const c = browser.calls;
  await c.browserRemoteControl(['s1', { type: 'reload' }, 4], host);
  await c.browserRemoteTabOpen(['https://example.com'], host);
  await c.browserRemoteTabClose(['main-browser-a'], host);
  await c.browserHistorySearch(['docs'], host);
  await c.browserCredentialSuggestions(['s1'], host);
  await c.browserCredentialFill(['s1', 'a'.repeat(24)], host);
  await c.browserProfileImportSources([], host);
  await c.browserProfileImportStart([{ jobId: 'job-12345', sourceId: 'x', profileId: 'p', items: ['history'] }], host);
  assert.equal(await c.browserReleasePage(['main-browser-a'], host), undefined, 'Node answered nothing');
  assert.deepEqual(requests, [
    ['browser/command', { action: 'input', input: { type: 'reload', session_id: 's1' } }],
    ['browser/command', { action: 'tabOpen', input: { url: 'https://example.com' } }],
    ['browser/command', { action: 'release', input: { id: 'main-browser-a' } }],
    ['browser/command', { action: 'history', input: { query: 'docs' } }],
    ['browser/command', { action: 'credentialSuggestions', input: { session_id: 's1' } }],
    ['browser/command', { action: 'credentialFill', input: { session_id: 's1', credentialId: 'a'.repeat(24) } }],
    ['browser/command', { action: 'importSources' }],
    [
      'browser/command',
      { action: 'importStart', input: { jobId: 'job-12345', sourceId: 'x', profileId: 'p', items: ['history'] } },
    ],
    ['browser/command', { action: 'release', input: { id: 'main-browser-a' } }],
  ]);
});

test("the live view subscribes, acknowledges frames, and signals over the core's three methods", async () => {
  const { host, requests, notes } = rig();
  const c = browser.calls;
  assert.equal(await c.browserRemoteStream(['s1', { maxWidth: 800, maxHeight: 600 }], host), null);
  assert.equal(await c.browserRemoteStream(['s1', null], host), null, 'null options end the subscription');
  assert.equal(await c.browserRemoteWebrtcSignal([{ type: 'ready' }], host), null);
  await c.browserRemoteScreenDisplays([], host);
  browser.fires.browserRemoteStreamAck(['s1', 7], host);
  assert.deepEqual(requests, [
    ['browser/stream', { sessionId: 's1', on: true, request: { maxWidth: 800, maxHeight: 600 } }],
    ['browser/stream', { sessionId: 's1', on: false }],
    ['browser/webrtcSignal', { signal: { type: 'ready' } }],
    ['browser/screenDisplays', {}],
  ]);
  assert.deepEqual(notes, [['browser/streamAck', { sessionId: 's1', seq: 7 }]]);
});

test('frames, signals, watched tabs and import progress reach the page as Node pushed them', async () => {
  const { host, fanned, setSection, emit, setLive } = rig();
  const stop = browser.install(host);
  emit('browser/frame', { sessionId: 's1', seq: 1 });
  emit('browser/webrtcSignal', { signal: { type: 'answer' } });
  setSection('browserTabs', { tabs: [{ id: 'main-browser-a' }] });
  assert.deepEqual(
    fanned,
    [
      ['frame', { sessionId: 's1', seq: 1 }],
      ['webrtc', { type: 'answer' }],
    ],
    'tabs are not pushed before the phone watches'
  );
  assert.deepEqual(
    await browser.calls.browserRemoteTabs([true], host),
    [{ id: 'main-browser-a' }],
    'starting the watch answers the current list'
  );
  setSection('browserTabs', { tabs: [] });
  setSection('browserImport', { jobId: 'job-12345', state: 'running' });
  setLive(false);
  setSection('browserImport', { jobId: 'stale' });
  assert.deepEqual(
    fanned.slice(2),
    [
      ['tabs', []],
      ['import', { jobId: 'job-12345', state: 'running' }],
    ],
    'a replay of what stood is not a change'
  );
  await browser.calls.browserRemoteTabs([false], host);
  setLive(true);
  setSection('browserTabs', { tabs: [{ id: 'x' }] });
  assert.equal(fanned.length, 4, 'no tab push once the watch ended');
  stop();
});

test("the Web Push fallback calls reach the core's remoteAccess methods", async () => {
  const { host, requests } = rig();
  const c = notifications.calls;
  await c.pushPublicKey([], host);
  await c.registerPushSubscription(
    [{ endpoint: 'https://push.example/x', p256dh: 'k', auth: 'a', clientId: 'b1', label: 'Chrome' }],
    host
  );
  await c.removePushSubscription(['https://push.example/x'], host);
  assert.throws(() => c.removePushSubscription([5], host), { message: 'endpoint must be a string.' });
  assert.deepEqual(requests, [
    ['remoteAccess/pushPublicKey', {}],
    [
      'remoteAccess/registerPushSubscription',
      { input: { endpoint: 'https://push.example/x', p256dh: 'k', auth: 'a', clientId: 'b1', label: 'Chrome' } },
    ],
    ['remoteAccess/removePushSubscription', { endpoint: 'https://push.example/x' }],
  ]);
});

test('only live PC surface requests reach the phone, without a tab watch', () => {
  const { host, fanned, emit, setLive } = rig();
  const stop = browser.install(host);
  emit('ui/openRequested', { kind: 'terminal', sessionId: 's1' });
  setLive(false);
  emit('ui/openRequested', { kind: 'browser', sessionId: 's1', reveal: true });
  emit('ui/openRequested', { kind: 'browser', sessionId: 's1', hide: true });
  setLive(true);
  emit('ui/openRequested', {
    kind: 'browser',
    sessionId: 's1',
    reveal: true,
    handoff: true,
    tabId: 'p1',
    title: 'Page',
  });
  emit('ui/openRequested', { kind: 'browser', sessionId: 's1', hide: true });
  assert.deepEqual(fanned, [
    ['open', { sessionId: 's1', reveal: true, handoff: true, tabId: 'p1', title: 'Page' }],
    ['open', { sessionId: 's1', hide: true }],
  ]);
  stop();
});
