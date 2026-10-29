import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect as netConnect, createServer } from 'node:net';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { Agent, getGlobalDispatcher, request, setGlobalDispatcher } from 'undici';
import { adoptPrivateProxy, createRoutedProxyDispatcher } from './http-agent.mjs';
import {
  adoptSystemProxy,
  attachSystemProxyResolver,
  HANDOFF_VAR,
  parseProxyServer,
  routeFromChromium,
  systemProxyFromRegistry,
  systemProxyHandoffEnv,
  systemProxyRoute,
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
    apply: (route) => applied.push(route),
    ...options,
  });
  return { result, env, logs, reads: reads.length, applied };
}

/** A Chromium stand-in: `answers` maps a hostname to its PAC answer (DIRECT otherwise). */
function chromium(answers) {
  const asked = [];
  const resolve = async (origin) => {
    asked.push(origin);
    return answers[new URL(origin).hostname] ?? 'DIRECT';
  };
  return { asked, resolve };
}

/** A proxy that records each request line and refuses it. */
async function recordingProxy() {
  const requests = [];
  const server = createServer((socket) =>
    socket.once('data', (data) => {
      requests.push(data.toString().split('\r\n')[0]);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    })
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
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
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0]('https://api.example.com'), { proxy: PROXY.https });
  assert.deepEqual(applied[0]('https://svc.corp.test'), { proxy: null });
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
  assert.equal(daemon.applied.length, 1);
  assert.deepEqual(systemProxyRoute('https://api.example.com'), { proxy: PROXY.https });
  assert.deepEqual(systemProxyRoute('https://svc.corp.test'), { proxy: null });
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
  assert.deepEqual(systemProxyRoute('https://a.test'), { proxy: 'http://user:pw@p.test:1' });
  // No http entry: plain-http origins go direct.
  assert.deepEqual(systemProxyRoute('http://a.test'), { proxy: null });
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
  // Nothing routes afterwards, not even through an attached resolver.
  const { resolve, asked } = chromium({});
  attachSystemProxyResolver(resolve);
  assert.deepEqual(systemProxyRoute('https://a.test'), { proxy: null });
  assert.deepEqual(asked, []);
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

test('without a resolver the fallback sends excepted hosts, dotless names and local addresses direct', () => {
  const calls = [];
  const recorder = (name) => ({
    dispatch: (opts) => calls.push(`${name} ${new URL(opts.origin).hostname}`),
    close: async () => {},
    destroy: async () => {},
  });
  adopt({ ...STATIC, proxyOverride: '<local>;exact.test;*.corp.test;203.0.113.7;2001:db8::9' });
  const direct = recorder('direct');
  const dispatcher = createRoutedProxyDispatcher({
    route: systemProxyRoute,
    direct: () => direct,
    proxied: () => recorder('proxy'),
  });
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
    const { result } = adopt(
      { ...STATIC, proxyServer: url.slice('http://'.length), proxyOverride: '<local>;*.corp.test' },
      {},
      { apply: adoptPrivateProxy }
    );
    assert.equal(result, true);
    assert.equal(adoptPrivateProxy(systemProxyRoute), false, 'adopted once per process');
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

test('a Chromium answer is read in fallback order, keeping no SOCKS entry or credentials', () => {
  assert.deepEqual(routeFromChromium('DIRECT'), { proxy: null, socks: false });
  assert.deepEqual(routeFromChromium('PROXY 127.0.0.1:7890'), { proxy: 'http://127.0.0.1:7890', socks: false });
  assert.deepEqual(routeFromChromium('HTTPS proxy.corp:443'), { proxy: 'https://proxy.corp:443', socks: false });
  assert.equal(routeFromChromium('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890; DIRECT').proxy, 'http://127.0.0.1:7890');
  // DIRECT ends the list: a later proxy is only a fallback.
  assert.equal(routeFromChromium('DIRECT; PROXY 127.0.0.1:7890').proxy, null);
  assert.deepEqual(routeFromChromium('SOCKS 127.0.0.1:1080;SOCKS5 127.0.0.1:1081'), { proxy: null, socks: true });
  assert.equal(routeFromChromium('PROXY user:pass@p.test:1').proxy, null);
  assert.equal(routeFromChromium('').proxy, null);
});

test('each origin follows its own Chromium answer: a PAC that differs by host, and its exceptions', async () => {
  const { logs, applied } = adopt(null, {}, { platform: 'linux' });
  assert.deepEqual(applied, [], 'nothing to route before an app attaches');
  const pac = chromium({
    'api.openai.com': 'PROXY proxy.corp:8080; DIRECT',
    'gateway.example': 'HTTPS gw.corp:443',
    'chat.example': 'SOCKS5 user:pass@127.0.0.1:1080',
    'other.example': 'SOCKS5 127.0.0.1:1080; PROXY other.corp:3128',
  });
  attachSystemProxyResolver(pac.resolve);
  assert.equal(applied.length, 1, 'the router is installed once an app attaches');
  const proxyOf = async (origin) => (await systemProxyRoute(origin)).proxy;
  assert.equal(await proxyOf('https://api.openai.com'), 'http://proxy.corp:8080');
  // An OS exception or a PAC DIRECT answer: this host connects directly.
  assert.equal(await proxyOf('https://intranet.corp.example'), null);
  assert.equal(await proxyOf('https://gateway.example'), 'https://gw.corp:443');
  assert.equal(await proxyOf('https://chat.example'), null);
  assert.equal(await proxyOf('https://other.example'), 'http://other.corp:3128');
  assert.deepEqual(pac.asked, [
    'https://api.openai.com',
    'https://intranet.corp.example',
    'https://gateway.example',
    'https://chat.example',
    'https://other.example',
  ]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /SOCKS only/);
  assert.doesNotMatch(logs[0], /user|pass|127\.0\.0\.1|chat/);
});

test('the router asks once per origin, never for a local host, and gives each request its route', async () => {
  adopt(null, {}, { platform: 'linux' });
  const pac = chromium({ 'a.example': 'PROXY a.corp:1', 'b.example': 'PROXY b.corp:2' });
  attachSystemProxyResolver(pac.resolve);
  const calls = [];
  const built = [];
  const leg = (name) => ({
    dispatch: (opts) => calls.push(`${name} ${new URL(opts.origin).host}`),
    close: async () => {},
    destroy: async () => {},
  });
  const direct = leg('direct');
  const dispatcher = createRoutedProxyDispatcher({
    route: systemProxyRoute,
    direct: () => direct,
    proxied: (uri) => {
      built.push(uri);
      return leg(uri);
    },
  });
  for (const origin of [
    'https://a.example',
    'https://b.example',
    'https://c.example',
    'https://a.example:443',
    'http://192.168.1.5:8080',
    'http://printer',
  ]) {
    dispatcher.dispatch({ origin, path: '/' }, {});
  }
  // Local hosts went at once, without a lookup.
  assert.deepEqual(calls, ['direct 192.168.1.5:8080', 'direct printer']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(2).sort(), [
    'direct c.example',
    'http://a.corp:1 a.example',
    'http://a.corp:1 a.example',
    'http://b.corp:2 b.example',
  ]);
  assert.deepEqual(pac.asked, ['https://a.example', 'https://b.example', 'https://c.example']);
  assert.deepEqual(built, ['http://a.corp:1', 'http://b.corp:2']);
  // A cached origin is routed synchronously.
  dispatcher.dispatch({ origin: 'https://b.example', path: '/' }, {});
  assert.equal(calls.at(-1), 'http://b.corp:2 b.example');
});

test('an abort while the lookup is held settles the request at once, and it is never dispatched', async () => {
  const gate = Promise.withResolvers();
  const dispatched = [];
  const leg = {
    dispatch: (opts) => dispatched.push(new URL(opts.origin).host),
    close: async () => {},
    destroy: async () => {},
  };
  const dispatcher = createRoutedProxyDispatcher({
    route: () => gate.promise,
    direct: () => leg,
    proxied: () => leg,
  });
  const abort = new AbortController();
  const pending = request('https://held.example/v1', { dispatcher, signal: abort.signal });
  const outcome = pending.then(
    () => 'resolved',
    (error) => error.name
  );
  abort.abort();
  const settled = await Promise.race([outcome, new Promise((resolve) => setTimeout(resolve, 100, 'pending'))]);
  assert.equal(settled, 'AbortError');
  gate.resolve({ proxy: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatched, []);
});

test('answers are cached per origin for their lifetime and concurrent lookups share one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  adopt(null, {}, { platform: 'linux' });
  const gate = Promise.withResolvers();
  const asked = [];
  attachSystemProxyResolver(async (origin) => {
    asked.push(origin);
    await gate.promise;
    return 'PROXY p.corp:1';
  });
  const first = systemProxyRoute('https://a.example');
  assert.equal(systemProxyRoute('https://a.example'), first);
  const other = systemProxyRoute('https://b.example');
  gate.resolve();
  assert.deepEqual(await first, { proxy: 'http://p.corp:1' });
  await other;
  assert.deepEqual(systemProxyRoute('https://a.example'), { proxy: 'http://p.corp:1' });
  assert.deepEqual(asked, ['https://a.example', 'https://b.example']);
  t.mock.timers.tick(5 * 60_000 + 1);
  const again = systemProxyRoute('https://a.example');
  assert.equal(typeof again.then, 'function', 'an expired answer is asked again');
  await again;
  assert.deepEqual(asked, ['https://a.example', 'https://b.example', 'https://a.example']);
});

test('a slow or failing lookup goes DIRECT after the bound and is asked again a little later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { logs } = adopt(null, {}, { platform: 'linux' });
  let asked = 0;
  attachSystemProxyResolver(() => {
    asked += 1;
    return new Promise(() => {});
  });
  const slow = systemProxyRoute('https://slow.example');
  t.mock.timers.tick(3_000);
  assert.deepEqual(await slow, { proxy: null });
  assert.deepEqual(systemProxyRoute('https://slow.example'), { proxy: null }, 'not asked on every request');
  t.mock.timers.tick(30_001);
  const retried = systemProxyRoute('https://slow.example');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 2);
  t.mock.timers.tick(3_000);
  await retried;

  attachSystemProxyResolver(async () => {
    throw new Error('PAC http://user:pass@pac.corp/p.pac failed');
  });
  assert.deepEqual(await systemProxyRoute('https://x.example'), { proxy: null });
  assert.equal(logs.length, 2);
  for (const line of logs) assert.doesNotMatch(line, /user|pass|pac\.corp|example/, line);
});

test('with no resolver attached the fallback routes, and a detached resolver hands it back', async () => {
  adopt({ ...STATIC, proxyOverride: '*.corp.test' });
  assert.deepEqual(systemProxyRoute('https://api.example.com'), { proxy: PROXY.https });
  assert.deepEqual(systemProxyRoute('https://svc.corp.test'), { proxy: null });
  const allDirect = chromium({});
  const detach = attachSystemProxyResolver(allDirect.resolve);
  assert.deepEqual(await systemProxyRoute('https://api.example.com'), { proxy: null });

  // A lookup still running when its resolver leaves answers its caller only.
  const gate = Promise.withResolvers();
  const detachSlow = attachSystemProxyResolver(async () => {
    await gate.promise;
    return 'PROXY late.corp:1';
  });
  const pending = systemProxyRoute('https://late.example');
  detachSlow();
  gate.resolve();
  assert.deepEqual(await pending, { proxy: 'http://late.corp:1' });
  assert.deepEqual(await systemProxyRoute('https://late.example'), { proxy: null });
  // Routes cached under a resolver were dropped with it.
  assert.deepEqual(allDirect.asked, ['https://api.example.com', 'https://late.example']);

  detach();
  detach();
  assert.deepEqual(systemProxyRoute('https://api.example.com'), { proxy: PROXY.https });
});

test('the user’s proxy variables and MIXDOG_SYSTEM_PROXY=0 leave an attached app unasked', () => {
  for (const env of [{ HTTPS_PROXY: 'http://mine.test:1' }, { MIXDOG_SYSTEM_PROXY: '0' }]) {
    const { applied } = adopt(STATIC, env);
    const pac = chromium({ 'a.example': 'PROXY p.corp:1' });
    attachSystemProxyResolver(pac.resolve);
    assert.deepEqual(systemProxyRoute('https://a.example'), { proxy: null });
    assert.deepEqual(pac.asked, []);
    assert.deepEqual(applied, []);
    assert.deepEqual(systemProxyHandoffEnv(), {});
  }
});

test('fetch through the router reaches each origin’s own proxy or goes direct; an abort is not held by a lookup', async () => {
  adopt(null, {}, { platform: 'linux' });
  const proxyA = await recordingProxy();
  const proxyB = await recordingProxy();
  const server = createHttpServer((_req, res) => res.end('direct'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dialed = [];
  const direct = new Agent({
    connect: (options, callback) => {
      dialed.push(options.hostname);
      const socket = netConnect(server.address().port, '127.0.0.1');
      socket.once('connect', () => callback(null, socket));
      socket.once('error', (error) => callback(error, null));
    },
  });
  const slow = Promise.withResolvers();
  const answers = {
    'a.example': `PROXY ${proxyA.url.slice('http://'.length)}`,
    'b.example': `PROXY ${proxyB.url.slice('http://'.length)}`,
  };
  attachSystemProxyResolver(async (origin) => {
    const host = new URL(origin).hostname;
    if (host === 'slow.example') await slow.promise;
    return answers[host] ?? 'DIRECT';
  });
  const router = createRoutedProxyDispatcher({ route: systemProxyRoute, direct: () => direct });
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(router);
  try {
    await assert.rejects(fetch('https://a.example/v1', { signal: AbortSignal.timeout(10_000) }));
    await assert.rejects(fetch('https://b.example/v1', { signal: AbortSignal.timeout(10_000) }));
    const body = await (await fetch('http://direct.example:8080/', { signal: AbortSignal.timeout(10_000) })).text();
    assert.equal(body, 'direct');
    assert.deepEqual(proxyA.requests, ['CONNECT a.example:443 HTTP/1.1']);
    assert.deepEqual(proxyB.requests, ['CONNECT b.example:443 HTTP/1.1']);
    assert.deepEqual(dialed, ['direct.example']);
    const started = Date.now();
    await assert.rejects(fetch('http://slow.example/', { signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' });
    assert.ok(Date.now() - started < 2_000);
  } finally {
    slow.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    setGlobalDispatcher(previous);
    await router.close();
    server.close();
    proxyA.close();
    proxyB.close();
  }
});
