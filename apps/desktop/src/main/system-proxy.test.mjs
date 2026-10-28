import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proxyEnvFromResolution, SYSTEM_PROXY_PROBE_URL, systemProxyEnv } from './system-proxy.ts';

const HTTP_7890 = { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890' };

test('a Chromium proxy answer becomes daemon proxy variables', () => {
  assert.deepEqual(proxyEnvFromResolution('DIRECT', {}), { env: {}, socksOnly: false });
  assert.deepEqual(proxyEnvFromResolution('PROXY 127.0.0.1:7890', {}), { env: HTTP_7890, socksOnly: false });
  assert.deepEqual(proxyEnvFromResolution('HTTPS proxy.corp:443', {}).env, {
    HTTPS_PROXY: 'https://proxy.corp:443',
    HTTP_PROXY: 'https://proxy.corp:443',
  });
  // Fallback order: the first HTTP(S) proxy wins; SOCKS entries are skipped.
  assert.deepEqual(proxyEnvFromResolution('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890; DIRECT', {}), {
    env: HTTP_7890,
    socksOnly: false,
  });
  // DIRECT ends the list: a later proxy is only a fallback.
  assert.deepEqual(proxyEnvFromResolution('DIRECT; PROXY 127.0.0.1:7890', {}).env, {});
  assert.deepEqual(proxyEnvFromResolution('SOCKS 127.0.0.1:1080;SOCKS5 127.0.0.1:1081', {}), {
    env: {},
    socksOnly: true,
  });
});

test('the user’s own proxy variables win over the system proxy', () => {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    assert.deepEqual(proxyEnvFromResolution('PROXY 127.0.0.1:7890', { [name]: 'http://mine:1' }).env, {});
  }
});

test('proxy credentials reach the daemon env but never a log line', async () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const env = await systemProxyEnv(async () => 'PROXY user:pass@proxy.example:8080', log, { env: {} });
  assert.equal(env.HTTPS_PROXY, 'http://user:pass@proxy.example:8080');
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
  assert.deepEqual(await systemProxyEnv(resolve, (line) => logs.push(line), { env: {} }), HTTP_7890);
  assert.deepEqual(asked, [SYSTEM_PROXY_PROBE_URL]);

  const socks = async () => 'SOCKS5 user:pass@127.0.0.1:7891';
  const socksLogs = [];
  assert.deepEqual(await systemProxyEnv(socks, (line) => socksLogs.push(line), { env: {} }), {});
  assert.deepEqual(await systemProxyEnv(socks, (line) => socksLogs.push(line), { env: {} }), {});
  assert.equal(socksLogs.filter((line) => /SOCKS only/.test(line)).length, 1);
  for (const line of socksLogs) assert.doesNotMatch(line, /user|pass/, line);

  // A user proxy variable skips the lookup; a failed lookup stays direct.
  const unused = async () => assert.fail('no lookup when the user set a proxy');
  assert.deepEqual(await systemProxyEnv(unused, () => {}, { env: { HTTPS_PROXY: 'http://mine:1' } }), {});
  const failing = async () => {
    throw new Error('no session');
  };
  assert.deepEqual(await systemProxyEnv(failing, () => {}, { env: {} }), {});
});
