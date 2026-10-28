import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { adoptPrivateProxy, createProxyDispatcher } from './http-agent.mjs';
import {
  adoptSystemProxy,
  HANDOFF_VAR,
  parseProxyServer,
  systemProxyFromRegistry,
  systemProxyHandoffEnv,
  translateProxyOverride,
} from './system-proxy.mjs';

const STATIC = {
  proxyEnable: '0x1',
  proxyServer: '127.0.0.1:7890',
  proxyOverride: null,
  autoConfigUrl: null,
};
const PROXY = { https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890' };
const NO_RULES = { hosts: [], suffixes: [] };
/** What Clash writes by default. */
const CLASH_OVERRIDE = [
  'localhost',
  '127.*',
  '192.168.*',
  '10.*',
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
  '<local>',
].join(';');

function adopt(values, env = {}, options = {}) {
  const logs = [];
  const reads = [];
  const applied = [];
  const result = adoptSystemProxy(env, {
    platform: 'win32',
    reader: () => {
      reads.push(1);
      return values;
    },
    log: (line) => logs.push(line),
    apply: (proxy, bypass) => applied.push({ proxy, bypass }),
    ...options,
  });
  return { result, env, logs, reads: reads.length, applied };
}

test('parseProxyServer reads a plain host:port for every scheme', () => {
  assert.deepEqual(parseProxyServer('127.0.0.1:7890'), {
    https: 'http://127.0.0.1:7890',
    http: 'http://127.0.0.1:7890',
  });
});

test('parseProxyServer reads per-scheme entries and requires an https one', () => {
  assert.deepEqual(parseProxyServer('http=a.test:80;https=b.test:443;socks=c.test:1080'), {
    https: 'http://b.test:443',
    http: 'http://a.test:80',
  });
  assert.deepEqual(parseProxyServer('https=b.test:443'), { https: 'http://b.test:443' });
  assert.ok(parseProxyServer('http=a.test:80').reason);
  assert.ok(parseProxyServer('socks=c.test:1080').reason);
  assert.ok(parseProxyServer('socks5://c.test:1080').reason);
  assert.ok(parseProxyServer('a.test').reason);
  assert.ok(parseProxyServer('a.test:99999').reason);
  assert.ok(parseProxyServer('').reason);
});

test('translateProxyOverride yields exact rules and drops what the local bypass covers', () => {
  assert.deepEqual(
    translateProxyOverride('<local>;Example.com;*.corp.test;203.0.113.7;192.168.*;127.*;169.254.*;10.1.*'),
    { hosts: ['example.com', '203.0.113.7'], suffixes: ['corp.test'] }
  );
  assert.deepEqual(translateProxyOverride(''), NO_RULES);
  assert.deepEqual(translateProxyOverride(null), NO_RULES);
  assert.deepEqual(translateProxyOverride('2001:db8:0:0:0:0:0:1;[2001:db8::2]'), {
    hosts: ['2001:db8::1', '2001:db8::2'],
    suffixes: [],
  });
});

test('translateProxyOverride refuses entries that have no exact rule', () => {
  for (const entry of [
    'a*b.test',
    '*.a.*.test',
    '*example.com',
    '.example.com',
    '172.*',
    '100.*',
    '10.*.1.1',
    '300.1.*',
    'https://x.test',
    'x.test:8080',
    '10.1',
    'ex ample.com',
    'bücher.test',
    '*',
  ]) {
    assert.equal(translateProxyOverride(`ok.test;${entry}`), null, entry);
  }
});

test('Clash’s default bypass list, <local> included, is accepted', () => {
  const found = systemProxyFromRegistry({ ...STATIC, proxyOverride: CLASH_OVERRIDE });
  assert.deepEqual(found.proxy, PROXY);
  assert.deepEqual(found.bypass, { hosts: ['localhost'], suffixes: [] });
});

test('systemProxyFromRegistry declines disabled, PAC and unusable settings but not WPAD', () => {
  assert.equal(systemProxyFromRegistry(null).proxy, undefined);
  assert.equal(systemProxyFromRegistry({ ...STATIC, proxyEnable: '0x0' }).proxy, undefined);
  assert.equal(systemProxyFromRegistry({ ...STATIC, proxyServer: null }).proxy, undefined);
  assert.equal(systemProxyFromRegistry({ ...STATIC, autoConfigUrl: 'http://pac.test/p.pac' }).proxy, undefined);
  assert.deepEqual(systemProxyFromRegistry({ ...STATIC, autoConfigUrl: '' }).proxy, PROXY);
  assert.equal(systemProxyFromRegistry({ ...STATIC, proxyServer: 'socks=127.0.0.1:1080' }).proxy, undefined);
  assert.equal(systemProxyFromRegistry({ ...STATIC, proxyOverride: 'a*b.test' }).proxy, undefined);
  // Auto-detect (WPAD) is not consulted: even a values object carrying its
  // blob is used as a plain static proxy.
  const wpadOn = { ...STATIC, connectionSettings: '46000000010000000d000000' };
  assert.deepEqual(systemProxyFromRegistry(wpadOn).proxy, PROXY);
});

test('the discovered proxy is applied privately: no proxy environment is written', () => {
  const { result, env, applied, logs } = adopt({ ...STATIC, proxyOverride: '*.corp.test;<local>' });
  assert.equal(result, true);
  assert.deepEqual(applied, [{ proxy: PROXY, bypass: { hosts: [], suffixes: ['corp.test'] } }]);
  assert.deepEqual(env, {});
  assert.deepEqual(logs, []);
});

test('the env a spawned shell or tool inherits is left exactly as it was', () => {
  const { env } = adopt(STATIC, { PATH: 'p' });
  assert.deepEqual(env, { PATH: 'p' });
});

test('the CLI hands its decision to the daemon, which applies it and strips it before any child', () => {
  const cli = adopt({ ...STATIC, proxyOverride: '*.corp.test' });
  const handoff = systemProxyHandoffEnv();
  assert.deepEqual(Object.keys(handoff), [HANDOFF_VAR]);
  // The daemon's env: the CLI's (nothing proxy-related) plus the handoff.
  const daemonEnv = { ...cli.env, ...handoff };
  const daemon = adopt(null, daemonEnv);
  assert.equal(daemon.reads, 0, 'the daemon does not discover again');
  assert.deepEqual(daemon.applied, cli.applied);
  assert.deepEqual(daemonEnv, {}, 'nothing a daemon child could inherit');
  // The daemon's own workers still get it, explicitly.
  assert.deepEqual(Object.keys(systemProxyHandoffEnv()), [HANDOFF_VAR]);
});

test('a CLI that found no usable proxy hands the daemon "direct", and the daemon does not rediscover', () => {
  adopt({ ...STATIC, proxyOverride: 'a*b.test' }, {}, { log: () => {} });
  const handoff = systemProxyHandoffEnv();
  assert.deepEqual(JSON.parse(handoff[HANDOFF_VAR]), { proxy: null });
  const daemonEnv = { ...handoff };
  const daemon = adopt(STATIC, daemonEnv);
  assert.equal(daemon.result, false);
  assert.equal(daemon.reads, 0);
  assert.deepEqual(daemon.applied, []);
  assert.deepEqual(daemonEnv, {});
});

test('a stale decision is not handed on by a later process state', () => {
  adopt(STATIC);
  assert.ok(systemProxyHandoffEnv()[HANDOFF_VAR]);
  adopt(STATIC, { HTTPS_PROXY: 'http://mine:1' });
  assert.deepEqual(systemProxyHandoffEnv(), {});
});

test('the user’s own proxy variables win, stay in the env unchanged, and nothing is read or handed on', () => {
  for (const env of [
    { HTTPS_PROXY: 'http://p.test:1' },
    { http_proxy: 'http://p.test:1' },
    { ALL_PROXY: 'socks5://p.test:1' },
    { all_proxy: 'socks5://p.test:1' },
    { NODE_USE_ENV_PROXY: '0' },
    { HTTPS_PROXY: 'http://p.test:1', NO_PROXY: 'corp.test', NODE_USE_ENV_PROXY: '1' },
  ]) {
    const before = { ...env };
    const result = adopt(STATIC, env);
    assert.equal(result.result, false, JSON.stringify(before));
    assert.equal(result.reads, 0, JSON.stringify(before));
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.env, before);
    assert.deepEqual(systemProxyHandoffEnv(), {});
  }
  // A handoff arriving next to the user's variables is removed and ignored.
  const env = { HTTPS_PROXY: 'http://p.test:1', [HANDOFF_VAR]: JSON.stringify({ proxy: PROXY }) };
  const result = adopt(null, env);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(env, { HTTPS_PROXY: 'http://p.test:1' });
});

test('MIXDOG_SYSTEM_PROXY=0 is the user’s opt-out for discovery and handoff alike', () => {
  const env = { MIXDOG_SYSTEM_PROXY: '0', [HANDOFF_VAR]: JSON.stringify({ proxy: PROXY }) };
  const result = adopt(STATIC, env);
  assert.equal(result.reads, 0);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(env, { MIXDOG_SYSTEM_PROXY: '0' });
  assert.deepEqual(systemProxyHandoffEnv(), {});
});

test('no handoff and no Windows means no discovery', () => {
  for (const platform of ['darwin', 'linux']) {
    const result = adopt(STATIC, {}, { platform });
    assert.equal(result.result, false);
    assert.equal(result.reads, 0);
    assert.deepEqual(systemProxyHandoffEnv(), {});
  }
});

test('a handoff is honoured on any platform (the desktop resolves with Chromium)', () => {
  const env = { [HANDOFF_VAR]: JSON.stringify({ proxy: { https: 'http://user:pw@p.test:1' } }) };
  const result = adopt(null, env, { platform: 'darwin' });
  assert.equal(result.result, true);
  assert.deepEqual(result.applied, [{ proxy: { https: 'http://user:pw@p.test:1' }, bypass: NO_RULES }]);
});

test('a malformed handoff is removed, ignored and reported once without its value', () => {
  const bad = [
    '',
    'not json',
    'null',
    '{}',
    JSON.stringify({ proxy: { https: 'ftp://p.test:1' } }),
    JSON.stringify({ proxy: { https: 'http://%:x@localhost:80' } }),
    JSON.stringify({ proxy: { https: 'http://u:%zz@localhost:80' } }),
    JSON.stringify({ proxy: { https: 'http://ok.test:80', http: 'http://%:x@localhost:80' } }),
  ];
  for (const value of bad) {
    const env = { [HANDOFF_VAR]: value };
    const result = adopt(STATIC, env, { platform: 'win32' });
    assert.equal(result.result, false, value);
    assert.equal(result.reads, 0, 'no discovery behind a bad handoff');
    assert.deepEqual(result.applied, []);
    assert.deepEqual(env, {}, value);
    assert.equal(result.logs.length, 1, value);
    assert.doesNotMatch(result.logs[0], /localhost|%|zz|ftp/);
    assert.deepEqual(JSON.parse(systemProxyHandoffEnv()[HANDOFF_VAR]), { proxy: null });
  }
});

test('a proxy that cannot be applied never crashes startup and leaves nothing applied', () => {
  const env = { [HANDOFF_VAR]: JSON.stringify({ proxy: { https: 'http://p.test:1' } }) };
  const result = adopt(null, env, {
    apply: () => {
      throw new URIError('URI malformed');
    },
  });
  assert.equal(result.result, false);
  assert.equal(result.logs.length, 1);
  assert.deepEqual(env, {});
  assert.deepEqual(JSON.parse(systemProxyHandoffEnv()[HANDOFF_VAR]), { proxy: null });
  // The real applier rejects the same input before installing anything.
  const before = getGlobalDispatcher();
  assert.throws(() => adoptPrivateProxy({ https: 'http://%:x@localhost:80' }), URIError);
  assert.equal(getGlobalDispatcher(), before);
});

test('malformed registry values are declined with one reason line and no proxy', () => {
  for (const proxyServer of [
    'user@host.test:80',
    'http://%:x@localhost:80',
    'host.test:80/path',
    'a b:80',
    'https=%:80',
  ]) {
    const result = adopt({ ...STATIC, proxyServer });
    assert.equal(result.result, false, proxyServer);
    assert.deepEqual(result.applied, []);
    assert.equal(result.logs.length, 1, proxyServer);
    assert.doesNotMatch(result.logs[0], /host\.test|localhost|%/);
  }
  assert.equal(adopt({ ...STATIC, proxyEnable: 'banana' }).result, false);
});

test('adoptSystemProxy logs one reason without the entries when it declines', () => {
  const { result, logs } = adopt({ ...STATIC, proxyOverride: 'secret*host.test' });
  assert.equal(result, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /exceptions cannot be translated/);
  assert.doesNotMatch(logs[0], /secret|127\.0\.0\.1/);
});

test('a disabled or unreadable registry is quiet and a throwing reader stays direct', () => {
  assert.deepEqual(adopt({ ...STATIC, proxyEnable: '0x0' }).logs, []);
  assert.deepEqual(adopt(null).logs, []);
  const result = adopt(
    null,
    {},
    {
      reader: () => {
        throw new Error('boom');
      },
    }
  );
  assert.equal(result.result, false);
  assert.deepEqual(JSON.parse(systemProxyHandoffEnv()[HANDOFF_VAR]), { proxy: null });
});

test('the dispatcher sends excepted hosts, dotless names and local addresses direct', () => {
  const calls = [];
  const recorder = (name) => ({
    dispatch: (opts) => calls.push(`${name} ${new URL(opts.origin).hostname}`),
    close: async () => {},
    destroy: async () => {},
  });
  const { bypass } = systemProxyFromRegistry({
    ...STATIC,
    proxyOverride: '<local>;exact.test;*.corp.test;203.0.113.7;2001:db8::9',
  });
  const dispatcher = createProxyDispatcher({ direct: recorder('direct'), proxied: recorder('proxy'), bypass });
  for (const origin of [
    'http://intranet',
    'https://exact.test',
    'https://svc.corp.test',
    'https://a.b.corp.test',
    'https://203.0.113.7',
    'https://[2001:db8::9]',
    'https://EXACT.test.',
    'https://192.168.1.5',
    'https://api.example.com',
    'https://sub.exact.test',
    'https://corp.test',
    'https://203.0.113.8',
  ]) {
    dispatcher.dispatch({ origin, path: '/' }, {});
  }
  assert.deepEqual(calls, [
    'direct intranet',
    'direct exact.test',
    'direct svc.corp.test',
    'direct a.b.corp.test',
    'direct 203.0.113.7',
    'direct [2001:db8::9]',
    'direct exact.test.',
    'direct 192.168.1.5',
    'proxy api.example.com',
    'proxy sub.exact.test',
    'proxy corp.test',
    'proxy 203.0.113.8',
  ]);
});

test('adoptPrivateProxy routes fetch through the proxy for ordinary hosts only', async () => {
  const requests = [];
  const server = createServer((socket) =>
    socket.once('data', (data) => {
      requests.push(data.toString().split('\r\n')[0]);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    })
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const previous = getGlobalDispatcher();
  const envBefore = JSON.stringify(process.env);
  try {
    const { bypass } = systemProxyFromRegistry({
      ...STATIC,
      proxyServer: url.slice('http://'.length),
      proxyOverride: '<local>;*.corp.test',
    });
    assert.equal(adoptPrivateProxy({ https: url }, bypass), true);
    assert.equal(adoptPrivateProxy({ https: url }, bypass), false, 'adopted once per process');
    await assert.rejects(fetch('https://auth.example.invalid/token', { signal: AbortSignal.timeout(10_000) }));
    // Excepted and dotless hosts never reach the proxy (their own DNS fails).
    await assert.rejects(fetch('https://svc.corp.test/', { signal: AbortSignal.timeout(10_000) }));
    await assert.rejects(fetch('http://intranet-host/', { signal: AbortSignal.timeout(10_000) }));
    assert.deepEqual(requests, ['CONNECT auth.example.invalid:443 HTTP/1.1']);
    // Not environment: spawned processes see no proxy variable.
    assert.equal(JSON.stringify(process.env), envBefore);
  } finally {
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    await owned.close();
    server.close();
  }
});
