// installDirectDesktopApi against a fake host and a fake core connection: every DesktopApi key is on the composed object, a
// preload that already supplies the API is left alone, and a server window's this-PC members refuse with the gate's text.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECT_KEYS, HOST_KEYS } from '../../shared/desktop-api-split.ts';
import { THIS_PC_FEATURE_KEYS, thisPcFeatureRefusal } from '../../shared/this-pc-features.ts';
import { installDirectDesktopApi } from './install.ts';

const connection = () => ({
  call: async () => undefined,
  notify() {},
  attach: () => () => undefined,
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
  const host = { enableAllowAllActions: async () => ({}), observeSignIn() {}, invokePcQuotaCapability: async () => ({}), readPcQuotaCapabilities: async () => [] };
  for (const group of Object.values(HOST_KEYS)) for (const key of group) host[key] = () => Promise.resolve(`host:${key}`);
  return Object.assign(host, extra);
};

const install = async (extra) => {
  const target = { mixdogDesktopHost: hostOf(extra) };
  await installDirectDesktopApi({ target, connection: connection() });
  return target;
};

test('all_keys_present', async () => {
  const { mixdogDesktop: api } = await install({ bootContext: { kind: 'x' }, connection: { id: 'local', kind: 'local', name: 'pc' } });
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
    await assert.rejects(() => api[key](), (error) => error.message === thisPcFeatureRefusal(key));
  }
  await assert.rejects(() => api.openFilePath(), /^Error: ssh-unsupported: Opening server files with this PC's apps is not available in a server window\. Use "Download to this PC and open" instead\.$/);
  assert.equal(await api.chooseProject(), 'host:chooseProject');
  const local = (await install({ connection: { id: 'local', kind: 'local', name: 'pc' } })).mixdogDesktop;
  assert.equal(await local.openFilePath(), 'host:openFilePath');
});
