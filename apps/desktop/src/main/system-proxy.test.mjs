import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adoptSystemProxy,
  HANDOFF_VAR,
  systemProxyHandoffEnv,
} from '../../../../src/runtime/shared/llm/system-proxy.mjs';
import {
  proxyEnvFromResolution,
  SYSTEM_PROXY_HANDOFF_VAR,
  SYSTEM_PROXY_PROBE_URL,
  systemProxyEnv,
} from './system-proxy.ts';

const HTTP_7890 = { https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890' };
const NO_PROXY_HANDOFF = { [SYSTEM_PROXY_HANDOFF_VAR]: JSON.stringify({ proxy: null }) };

function handedProxy(env) {
  return JSON.parse(env[SYSTEM_PROXY_HANDOFF_VAR]).proxy;
}

test('the desktop and the runtime agree on the handoff variable', () => {
  assert.equal(SYSTEM_PROXY_HANDOFF_VAR, HANDOFF_VAR);
});

test('a Chromium proxy answer becomes a daemon proxy', () => {
  assert.deepEqual(proxyEnvFromResolution('DIRECT', {}), { proxy: null, socksOnly: false });
  assert.deepEqual(proxyEnvFromResolution('PROXY 127.0.0.1:7890', {}), { proxy: HTTP_7890, socksOnly: false });
  assert.deepEqual(proxyEnvFromResolution('HTTPS proxy.corp:443', {}).proxy, {
    https: 'https://proxy.corp:443',
    http: 'https://proxy.corp:443',
  });
  // Fallback order: the first HTTP(S) proxy wins; SOCKS entries are skipped.
  assert.deepEqual(proxyEnvFromResolution('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890; DIRECT', {}), {
    proxy: HTTP_7890,
    socksOnly: false,
  });
  // DIRECT ends the list: a later proxy is only a fallback.
  assert.equal(proxyEnvFromResolution('DIRECT; PROXY 127.0.0.1:7890', {}).proxy, null);
  assert.deepEqual(proxyEnvFromResolution('SOCKS 127.0.0.1:1080;SOCKS5 127.0.0.1:1081', {}), {
    proxy: null,
    socksOnly: true,
  });
});

test('the user’s own proxy variables win over the system proxy', () => {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    assert.equal(proxyEnvFromResolution('PROXY 127.0.0.1:7890', { [name]: 'http://mine:1' }).proxy, null);
  }
});

test('proxy credentials reach the daemon handoff but never a log line', async () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const env = await systemProxyEnv(async () => 'PROXY user:pass@proxy.example:8080', log, { env: {} });
  assert.equal(handedProxy(env).https, 'http://user:pass@proxy.example:8080');
  assert.ok(logs.some((line) => line.includes('http://proxy.example:8080')));
  await systemProxyEnv(
    async () => {
      throw new Error('PAC fetch http://user:pass@pac.example/proxy.pac failed');
    },
    log,
    { env: {} }
  );
  assert.equal(logs.length, 2);
  for (const line of logs) assert.doesNotMatch(line, /user|pass/, line);
});

test('systemProxyEnv asks for the sign-in host and logs a SOCKS-only proxy once', async () => {
  const asked = [];
  const logs = [];
  const resolve = async (url) => {
    asked.push(url);
    return 'PROXY 127.0.0.1:7890';
  };
  assert.deepEqual(await systemProxyEnv(resolve, (line) => logs.push(line), { env: {} }), {
    [SYSTEM_PROXY_HANDOFF_VAR]: JSON.stringify({ proxy: HTTP_7890 }),
  });
  assert.deepEqual(asked, [SYSTEM_PROXY_PROBE_URL]);

  const socks = async () => 'SOCKS5 user:pass@127.0.0.1:7891';
  const socksLogs = [];
  assert.deepEqual(await systemProxyEnv(socks, (line) => socksLogs.push(line), { env: {} }), NO_PROXY_HANDOFF);
  assert.deepEqual(await systemProxyEnv(socks, (line) => socksLogs.push(line), { env: {} }), NO_PROXY_HANDOFF);
  assert.equal(socksLogs.filter((line) => /SOCKS only/.test(line)).length, 1);
  for (const line of socksLogs) assert.doesNotMatch(line, /user|pass/, line);

  // A failed lookup hands over DIRECT.
  const failing = async () => {
    throw new Error('no session');
  };
  assert.deepEqual(await systemProxyEnv(failing, () => {}, { env: {} }), NO_PROXY_HANDOFF);
});

test('the user’s proxy variables and MIXDOG_SYSTEM_PROXY=0 skip the lookup and hand nothing over', async () => {
  const unused = async () => assert.fail('no lookup when the user decided');
  assert.deepEqual(await systemProxyEnv(unused, () => {}, { env: { HTTPS_PROXY: 'http://mine:1' } }), {});
  assert.deepEqual(await systemProxyEnv(unused, () => {}, { env: { MIXDOG_SYSTEM_PROXY: '0' } }), {});
});

test('the desktop never exports the proxy as standard environment variables', async () => {
  const env = await systemProxyEnv(
    async () => 'PROXY 127.0.0.1:7890',
    () => {},
    { env: {} }
  );
  assert.deepEqual(Object.keys(env), [SYSTEM_PROXY_HANDOFF_VAR]);
});

test('a forked daemon applies the desktop proxy and strips the handoff before any child', async () => {
  const forkEnv = {
    ...(await systemProxyEnv(
      async () => 'PROXY 127.0.0.1:7890',
      () => {},
      { env: {} }
    )),
  };
  const applied = [];
  assert.equal(
    adoptSystemProxy(forkEnv, { platform: 'linux', apply: (proxy, bypass) => applied.push({ proxy, bypass }) }),
    true
  );
  assert.deepEqual(applied, [{ proxy: HTTP_7890, bypass: { hosts: [], suffixes: [] } }]);
  assert.deepEqual(forkEnv, {});
  // The daemon's own workers get it explicitly.
  assert.equal(JSON.parse(systemProxyHandoffEnv()[HANDOFF_VAR]).proxy.https, HTTP_7890.https);
});

test('a daemon forked for a DIRECT answer stays direct and never rediscovers the registry proxy', async () => {
  for (const resolve of [async () => 'DIRECT', () => new Promise(() => {})]) {
    const forkEnv = { ...(await systemProxyEnv(resolve, () => {}, { env: {} })) };
    let read = false;
    const applied = adoptSystemProxy(forkEnv, {
      platform: 'win32',
      reader: () => {
        read = true;
        return { proxyEnable: '0x1', proxyServer: '127.0.0.1:7890' };
      },
      apply: () => assert.fail('DIRECT must stay direct'),
    });
    assert.equal(applied, false);
    assert.equal(read, false);
    assert.deepEqual(forkEnv, {});
    assert.deepEqual(systemProxyHandoffEnv(), { [HANDOFF_VAR]: JSON.stringify({ proxy: null }) });
  }
});
