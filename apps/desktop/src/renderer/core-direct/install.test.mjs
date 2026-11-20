// installDirectDesktopApi against a fake host and a fake core connection: every DesktopApi key is on the composed object, a
// preload that already supplies the API is left alone, and a server window's this-PC members refuse with the gate's text.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECT_KEYS, HOST_KEYS } from '../../shared/desktop-api-split.ts';
import { THIS_PC_FEATURE_KEYS, thisPcFeatureRefusal } from '../../shared/this-pc-features.ts';
import { forgetDirectClient, pcCoreClient } from './client.ts';
import { installDirectDesktopApi } from './install.ts';

const connection = () => ({
  call: async () => undefined,
  notify() {},
  attach: () => () => undefined,
  onReopening: () => () => undefined,
  watchFiles: async () => undefined,
  unwatchFiles: async () => undefined,
  snapshot: () => ({ status: 'ready', entries: [], epoch: 0 }),
  whenSynced: async () => undefined,
  onEvent: () => () => undefined,
  onStoreChange: () => () => undefined,
  client: () => ({ store: {} }),
  start: async () => undefined,
  onReplaced: () => () => undefined,
  viewPorts: () => [],
  watchFeed: async () => undefined,
  unwatchFeed: async () => undefined,
  loginFeed: async () => undefined,
  setSender() {},
});

const hostOf = (extra = {}) => {
  const host = {
    enableAllowAllActions: async () => ({}),
    observeSignIn() {},
    invokePcQuotaCapability: async () => ({}),
    readPcQuotaCapabilities: async () => [],
  };
  for (const group of Object.values(HOST_KEYS))
    for (const key of group) host[key] = () => Promise.resolve(`host:${key}`);
  return Object.assign(host, extra);
};

const install = async (extra) => {
  const target = { mixdogDesktopHost: hostOf(extra) };
  await installDirectDesktopApi({ target, connection: connection() });
  return target;
};

test('all_keys_present', async () => {
  const { mixdogDesktop: api } = await install({
    bootContext: { kind: 'x' },
    connection: { id: 'local', kind: 'local', name: 'pc' },
  });
  for (const group of Object.values(DIRECT_KEYS)) for (const key of group) assert.ok(key in api, `direct ${key}`);
  for (const group of Object.values(HOST_KEYS)) for (const key of group) assert.ok(key in api, `host ${key}`);
  assert.equal(api.connection.kind, 'local');
  assert.deepEqual(api.bootContext, { kind: 'x' });
  assert.ok(Object.isFrozen(api));
  assert.equal(await api.computerReadiness(), 'host:computerReadiness');
});

test('legacy_noop', async () => {
  const existing = Object.freeze({ legacy: true });
  const target = { mixdogDesktop: existing };
  await installDirectDesktopApi({ target, connection: connection() });
  assert.equal(target.mixdogDesktop, existing);
});

test('server_gates', async () => {
  const { mixdogDesktop: api } = await install({ connection: { id: 'h1', kind: 'ssh', name: 'srv' } });
  for (const key of THIS_PC_FEATURE_KEYS) {
    if (typeof api[key] !== 'function') continue;
    await assert.rejects(
      () => api[key](),
      (error) => error.message === thisPcFeatureRefusal(key)
    );
  }
  await assert.rejects(
    () => api.openFilePath(),
    /^Error: ssh-unsupported: Opening server files with this PC's apps is not available in a server window\. Use "Download to this PC and open" instead\.$/
  );
  assert.equal(await api.chooseProject(), 'host:chooseProject');
  const local = (await install({ connection: { id: 'local', kind: 'local', name: 'pc' } })).mixdogDesktop;
  assert.equal(await local.openFilePath(), 'host:openFilePath');
});

test('connection_methods_are_the_core_requests_not_the_host_bridge', async () => {
  const { mixdogDesktop: api } = await install({ connection: { id: 'local', kind: 'local', name: 'pc' } });
  // With no core client open the core API refuses as itself; the host bridge would answer 'host:sshListHosts'.
  await assert.rejects(() => api.sshListHosts(), /This window has no connection to the core\./);
  assert.equal(await api.previewProjectFile(), 'host:previewProjectFile', "a streamed preview is the host's");
});

test('api_installed_before_the_connection_opens_and_an_early_call_waits_for_it', async () => {
  const { createRendererConnection } = await import('./renderer-connection.ts');
  const calls = [];
  const client = {
    status: { state: 'ready' },
    server: { limits: {} },
    store: { sections: () => [], section: () => undefined, appFeed: () => undefined, subscribe: () => () => undefined },
    async call(method, _params) {
      calls.push(method);
      return method === 'thread/list' ? { data: [] } : {};
    },
    notify() {},
    subscribeApp: async () => undefined,
    respond() {},
    pendingServerRequests: () => [],
    on: () => () => undefined,
    close: async () => undefined,
  };
  let release;
  const opening = new Promise((resolve) => (release = resolve));
  let opens = 0;
  const live = createRendererConnection({ open: () => ((opens += 1), opening) });
  const target = { mixdogDesktopHost: hostOf({ connection: { id: 'local', kind: 'local', name: 'pc' } }) };
  // Installed at once, though the open is still pending: the window can paint.
  await installDirectDesktopApi({ target, connection: live });
  const api = target.mixdogDesktop;
  assert.ok(api, 'the API is installed before the first open');
  assert.equal(opens, 1, 'the open was started');
  assert.equal(live.client(), null);
  assert.equal(pcCoreClient(), null, 'local startup does not open a separate PC client');
  assert.deepEqual(
    (await api.sections.snapshot()).entries,
    [],
    'a snapshot read before the open is empty, not a refusal'
  );
  let listed = null;
  const early = api.listSessions().then((rows) => (listed = rows));
  for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r));
  assert.equal(listed, null, 'the early call waits for the first open');
  assert.deepEqual(calls, [], 'nothing is sent before the open');
  release(client);
  await early;
  assert.deepEqual(listed, []);
  assert.ok(calls.includes('thread/list'), 'the call went out once the connection opened');
  assert.equal(opens, 1, 'the early call joined the first open rather than opening another');
  await live.close();
});

test('a reloaded SSH window reads lost status and retries on the PC while its primary port is unavailable', async (t) => {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const previousWindow = globalThis.window;
  const events = new EventTarget();
  const host = { addEventListener: (...args) => events.addEventListener(...args) };
  globalThis.window = host;
  let finishPrimary;
  const primary = new Promise((resolve) => {
    finishPrimary = resolve;
  });
  t.after(async () => {
    finishPrimary();
    await pcCoreClient()?.close();
    forgetDirectClient('pc');
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const lost = { state: { status: 'lost', code: 'unreachable' } };
  const requests = [];
  const opens = [];
  const bridge = {
    async open({ slot }) {
      opens.push(slot);
      const generation = opens.length;
      const port = {
        onmessage: null,
        close() {},
        postMessage(text) {
          if (typeof text !== 'string') return;
          const msg = JSON.parse(text);
          if (msg.id === undefined) return;
          const { method, params } = msg;
          requests.push([method, params]);
          if (method === 'initialize' && generation === 1) {
            // A broken handshake exhausts the ordinary startup budget. PC recovery is independent.
            now = start + 60_000;
            queueMicrotask(() => port.onmessage({ data: { t: 'closed', code: 1006, reason: 'PC core unavailable' } }));
            return;
          }
          const result =
            method === 'initialize'
              ? {
                  serverInstanceId: 'pc',
                  coreState: 'ready',
                  limits: {},
                  capabilities: {},
                  connection: { origin: 'app', device: 'd', window: { role: 'server:h1' } },
                }
              : method === 'connections/link/get'
                ? lost
                : {};
          queueMicrotask(() => port.onmessage({ data: JSON.stringify({ id: msg.id, result }) }));
        },
      };
      const event = Object.assign(new Event('message'), {
        source: host,
        data: { type: 'mixdog-core-port', generation, slot },
        ports: [port],
      });
      queueMicrotask(() => events.dispatchEvent(event));
      return { generation };
    },
  };
  Object.assign(host, {
    mixdogDesktopHost: hostOf({ connection: { id: 'h1', kind: 'ssh', name: 'Box' } }),
    mixdogCorePort: bridge,
  });
  const live = { ...connection(), start: () => primary };
  await installDirectDesktopApi({ target: host, connection: live });
  await installDirectDesktopApi({ target: host, connection: live });

  assert.deepEqual(await host.mixdogDesktop.getConnectionLink(), lost);
  await host.mixdogDesktop.retryConnection();
  assert.deepEqual(
    requests.filter(([method]) => method.startsWith('connections/')),
    [
      ['connections/link/get', { connectionId: 'h1' }],
      ['connections/link/retry', { connectionId: 'h1' }],
    ]
  );
  assert.deepEqual(opens, ['pc', 'pc'], 'one failed dial and one successful management port');
});
