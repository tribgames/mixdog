import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { _resetProxySettingForTest } from '../runtime/shared/llm/proxy-policy.mjs';
import { createSetupToolExecutor } from './setup-tool/executor.mjs';
import { createNetworkProxySettings } from './settings-network-proxy-api.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-api-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  _resetProxySettingForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The settings API over an in-memory config whose saves also reach the config file, as a flush does. */
function fixture() {
  let config = { profile: { title: 'unchanged' } };
  const writes = [];
  const api = createNetworkProxySettings({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    flushConfigSaves: async () => {
      const file = join(dataDir, 'mixdog-config.json');
      writeFileSync(`${file}.next`, JSON.stringify({ agent: { networkProxy: config.networkProxy } }));
      renameSync(`${file}.next`, file);
      writes.push(config.networkProxy);
    },
  });
  return { api, config: () => config, writes };
}

const LEAD = { id: 'lead', owner: 'user' };
const setup = (api, args) =>
  createSetupToolExecutor({ getApi: () => api, getCallerSession: () => LEAD }).execute(args, { callerSessionId: 'lead' });

test('an invalid address is refused and nothing is stored; a valid one is stored after the flush', async () => {
  const { api, config, writes } = fixture();
  for (const patch of [{ mode: 'manual', url: 'proxy.company.com 8080' }, { mode: 'manual' }, { exceptions: 'bad entry!' }, {}]) {
    await assert.rejects(api.setNetworkProxy(patch), TypeError, JSON.stringify(patch));
  }
  assert.equal(config().networkProxy, undefined);
  assert.deepEqual(writes, []);
  const saved = await api.setNetworkProxy({ mode: 'manual', url: 'http://proxy.company.com:8080' });
  assert.deepEqual([saved.mode, saved.url, saved.exceptions], ['manual', 'http://proxy.company.com:8080', 'localhost, 127.0.0.1, ::1']);
  assert.equal(saved.origin, 'https://api.openai.com');
  assert.equal(saved.route.via, 'manual');
  assert.equal(saved.route.proxy, 'proxy.company.com:8080');
  assert.equal(writes.length, 1);
  assert.deepEqual(config().profile, { title: 'unchanged' });
});

test('the view names the main provider endpoint, and off lists what it ignores', async () => {
  const { api } = fixture();
  const saved = await api.setNetworkProxy({ mode: 'off' }, { provider: 'anthropic-oauth' });
  assert.equal(saved.origin, 'https://api.anthropic.com');
  const env = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://env.corp:3128';
  try {
    assert.deepEqual((await api.getNetworkProxy()).route.ignored.env, ['HTTPS_PROXY']);
  } finally {
    if (env === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = env;
  }
});

test('the connection check goes through the manual proxy and reports a dead one without a direct retry', async () => {
  const previous = getGlobalDispatcher();
  const hits = { service: 0 };
  const service = createServer((_req, res) => {
    hits.service += 1;
    res.end('ok');
  }).listen(0, '127.0.0.1');
  await once(service, 'listening');
  const dead = net.createServer().listen(0, '127.0.0.1');
  await once(dead, 'listening');
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  dead.close();
  await once(dead, 'close');
  try {
    const { api } = fixture();
    // The main provider is a custom endpoint on the local service; the manual list does not cover it.
    const config = { providers: { 'custom-x': { baseURL: `http://127.0.0.2:${service.address().port}/v1` } } };
    const checked = createNetworkProxySettings({
      getConfig: () => ({ ...config, networkProxy: { mode: 'manual', url: deadUrl, exceptions: 'localhost' } }),
      saveConfigAndAdopt() {},
    });
    await api.setNetworkProxy({ mode: 'manual', url: deadUrl, exceptions: 'localhost' });
    const result = await checked.testNetworkProxy({ provider: 'custom-x' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ECONNREFUSED');
    assert.equal(result.route.via, 'manual');
    assert.equal(hits.service, 0, 'the endpoint was never contacted directly');
  } finally {
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    await owned.close();
    service.close();
  }
});

test('set_network_proxy and status network-proxy go through the setup tool', async () => {
  const { api, config } = fixture();
  const done = JSON.parse(await setup(api, { action: 'set_network_proxy', networkProxy: { mode: 'off' } }));
  assert.equal(done.mode, 'off');
  assert.equal(config().networkProxy.mode, 'off');
  const status = JSON.parse(await setup(api, { action: 'status', domain: 'network-proxy' }));
  assert.equal(status.mode, 'off');
  await assert.rejects(setup(api, { action: 'set_network_proxy', networkProxy: {} }), /at least one/);
  await assert.rejects(setup(api, { action: 'set_network_proxy', networkProxy: { mode: 'manual', url: 'nope' } }));
});
