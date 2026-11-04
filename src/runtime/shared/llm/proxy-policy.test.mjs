import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNetworkProxyPatch,
  decideProxyRoute,
  DEFAULT_PROXY_EXCEPTIONS,
  exceptionsCover,
  exceptionsError,
  normalizeNetworkProxy,
  parseProxyUrl,
  ProxyConfigError,
} from './proxy-policy.mjs';

const PROXY = 'http://proxy.corp:8080';
const local = (host) => host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
const decide = (target, { setting = {}, env = {}, system = null } = {}) =>
  decideProxyRoute(target, {
    setting: { mode: 'system', url: '', exceptions: DEFAULT_PROXY_EXCEPTIONS, ...setting },
    env,
    system,
    isLocalHost: local,
  });

test('a proxy address needs its scheme and host, and only http, https and socks5 are tunnelled', () => {
  for (const good of [
    'http://proxy.company.com:8080',
    'https://proxy.company.com',
    'socks5://127.0.0.1:1080',
    'http://[::1]:3128',
  ]) {
    assert.ok(parseProxyUrl(good).url, good);
  }
  assert.equal(parseProxyUrl('http://proxy.company.com:8080/').url, 'http://proxy.company.com:8080');
  for (const bad of [
    '',
    'proxy.company.com 8080',
    'proxy.company.com:8080',
    'ftp://proxy.company.com',
    'socks4://proxy.company.com:1080',
    'http://',
    'http://proxy.company.com:8080/path',
    'http://proxy.company.com:99999',
    'http://proxy.company.com?x=1',
  ]) {
    assert.ok(parseProxyUrl(bad).error, bad);
  }
  assert.match(parseProxyUrl('proxy.company.com:8080').error, /http:\/\//);
});

test('a stored manual address never carries a password', () => {
  assert.ok(parseProxyUrl('http://user:pw@proxy.corp:8080').url);
  assert.throws(
    () => applyNetworkProxyPatch(null, { mode: 'manual', url: 'http://user:pw@proxy.corp:8080' }),
    /user name or password/
  );
});

test('exception lists accept names, wildcards, addresses and ranges, and reject anything else', () => {
  assert.equal(exceptionsError('localhost, 127.0.0.1, ::1, *.company.local, .corp, 10.0.0.0/8, [::1]:8080, host:443'), null);
  assert.equal(exceptionsError(''), null);
  assert.match(exceptionsError('local host, http://x'), /not an address/);
  const covers = (list, url) => exceptionsCover(list, new URL(url));
  assert.ok(covers('localhost', 'http://localhost:11434/v1'));
  assert.ok(covers('company.com', 'https://api.company.com'));
  assert.ok(covers('company.com', 'https://company.com'));
  assert.ok(!covers('*.company.com', 'https://company.com'));
  assert.ok(covers('*.company.com', 'https://api.company.com'));
  assert.ok(covers('10.0.0.0/8', 'http://10.4.5.6'));
  assert.ok(!covers('10.0.0.0/8', 'http://11.4.5.6'));
  assert.ok(covers('10.0.0.0-10.255.255.255', 'http://10.4.5.6'));
  assert.ok(covers('::1', 'http://[::1]:8080'));
  assert.ok(covers('host:443', 'https://host'));
  assert.ok(!covers('host:443', 'https://host:444'));
  assert.ok(covers('*', 'https://anything.example'));
  assert.ok(!covers('', 'https://anything.example'));
});

test('a range BlockList would refuse is rejected on entry, and a stored one can never make a decision throw', () => {
  for (const bad of ['10.0.0.9-10.0.0.1', '1.2.3.4/33', '::1/129', '10.0.0.1-::1']) {
    assert.ok(exceptionsError(bad), bad);
    assert.throws(() => applyNetworkProxyPatch(null, { exceptions: bad }), /not an address/, bad);
  }
  assert.equal(exceptionsError('10.0.0.1-10.0.0.9, 10.0.0.1-10.0.0.1'), null);
  // Hand-edited storage and NO_PROXY get no such check: an unusable entry matches nothing.
  const setting = { mode: 'manual', url: PROXY, exceptions: '10.0.0.9-10.0.0.1, 1.2.3.4/33, 192.168.0.0/16' };
  for (const url of ['http://10.0.0.5:80', 'https://8.8.8.8', 'http://[2001:db8::1]', 'https://api.example.com']) {
    assert.equal(decide(url, { setting }).proxy, PROXY, url);
  }
  assert.equal(decide('http://192.168.4.4', { setting }).proxy, null, 'the valid entry still applies');
  const env = { HTTPS_PROXY: PROXY, NO_PROXY: '10.0.0.9-10.0.0.1,example.org' };
  assert.equal(decide('https://8.8.8.8', { env }).proxy, PROXY);
  assert.equal(decide('https://example.org', { env }).proxy, null);
});

test('a stored setting reads as its defaults when a field is invalid, and manual keeps an emptied list', () => {
  assert.deepEqual(normalizeNetworkProxy(undefined), { mode: 'system', url: '', exceptions: DEFAULT_PROXY_EXCEPTIONS });
  assert.deepEqual(normalizeNetworkProxy({ mode: 'bogus', url: 'nope', exceptions: 'a b:::' }), {
    mode: 'system',
    url: '',
    exceptions: DEFAULT_PROXY_EXCEPTIONS,
  });
  assert.equal(normalizeNetworkProxy({ mode: 'manual', url: PROXY, exceptions: '' }).exceptions, '');
});

test('a patch is strict: unknown keys, bad values and a manual mode without an address store nothing', () => {
  assert.deepEqual(applyNetworkProxyPatch(null, { mode: 'off' }), {
    mode: 'off',
    url: '',
    exceptions: DEFAULT_PROXY_EXCEPTIONS,
  });
  const manual = applyNetworkProxyPatch(null, { mode: 'manual', url: PROXY, exceptions: 'Localhost,  *.Corp.local ,localhost' });
  assert.deepEqual(manual, { mode: 'manual', url: PROXY, exceptions: 'localhost, *.corp.local' });
  assert.equal(applyNetworkProxyPatch(manual, { mode: 'system' }).url, PROXY, 'the address is kept for later');
  for (const patch of [
    {},
    { other: 1 },
    { mode: 'auto' },
    { url: 'proxy.company.com 8080' },
    { exceptions: 'bad entry!' },
    { mode: 'manual' },
  ]) {
    assert.throws(() => applyNetworkProxyPatch(null, patch), TypeError, JSON.stringify(patch));
  }
  assert.throws(() => applyNetworkProxyPatch(manual, { url: '' }), /required when mode is manual/);
});

test('system mode: NO_PROXY=* forces direct over the variables and the OS proxy', () => {
  const system = () => ({ proxy: 'http://os.corp:3128' });
  const env = { HTTPS_PROXY: PROXY };
  assert.equal(decide('https://api.example.com', { env, system }).proxy, PROXY);
  for (const noProxy of [{ NO_PROXY: '*' }, { no_proxy: ' * ' }]) {
    assert.deepEqual(decide('https://api.example.com', { env: { ...env, ...noProxy }, system }), {
      proxy: null,
      via: 'direct',
    });
    assert.equal(decide('https://api.example.com', { env: noProxy, system }).proxy, null, 'over the OS proxy too');
  }
});

test('system mode: an ALL_PROXY-only environment is followed for http(s), HTTPS_PROXY first, NO_PROXY honoured', () => {
  const env = { ALL_PROXY: PROXY };
  assert.deepEqual(decide('https://api.example.com', { env }), { proxy: PROXY, via: 'env', envVar: 'ALL_PROXY' });
  assert.equal(decide('http://api.example.com', { env }).proxy, PROXY);
  assert.equal(decide('wss://api.example.com/ws', { env }).proxy, PROXY);
  assert.equal(decide('https://api.example.com', { env: { ...env, HTTPS_PROXY: 'http://specific:1' } }).proxy, 'http://specific:1');
  assert.equal(decide('wss://api.example.com', { env: { ...env, HTTP_PROXY: 'http://plain:2' } }).proxy, 'http://plain:2');
  assert.equal(decide('https://api.example.com', { env: { ...env, NO_PROXY: 'example.com' } }).proxy, null);
  assert.equal(decide('https://api.other.org', { env: { ...env, NO_PROXY: 'example.com' } }).proxy, PROXY);
  // ALL_PROXY is only followed when it is an http(s) address.
  assert.equal(decide('https://api.example.com', { env: { ALL_PROXY: 'socks5://127.0.0.1:1080' } }).proxy, null);
  // Local hosts stay direct.
  assert.equal(decide('http://localhost:11434', { env }).proxy, null);
});

test('system mode falls to the OS proxy only without a proxy variable, awaiting its lookup', async () => {
  const system = (origin) => Promise.resolve({ proxy: origin.includes('direct') ? null : 'http://os.corp:3128' });
  assert.deepEqual(await decide('https://api.example.com', { system }), { proxy: 'http://os.corp:3128', via: 'system' });
  assert.deepEqual(await decide('https://direct.example.com', { system }), { proxy: null, via: 'direct' });
  assert.equal(decide('https://api.example.com', { env: { HTTPS_PROXY: PROXY }, system }).proxy, PROXY);
});

test('off mode is direct whatever the variables and the OS proxy say', () => {
  const system = () => ({ proxy: 'http://os.corp:3128' });
  const env = { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, ALL_PROXY: PROXY };
  for (const url of ['https://api.example.com', 'http://api.example.com', 'wss://api.example.com']) {
    assert.deepEqual(decide(url, { setting: { mode: 'off' }, env, system }), { proxy: null, via: 'off' });
  }
});

test('manual mode: its address for everything but the exceptions, with no other bypass', () => {
  const setting = { mode: 'manual', url: PROXY, exceptions: 'localhost, 127.0.0.1, ::1' };
  const env = { NO_PROXY: '*', HTTPS_PROXY: 'http://other:1' };
  const system = () => ({ proxy: 'http://os.corp:3128' });
  assert.deepEqual(decide('https://api.example.com', { setting, env, system }), { proxy: PROXY, via: 'manual' });
  assert.equal(decide('wss://api.example.com', { setting }).proxy, PROXY);
  assert.equal(decide('http://localhost:11434', { setting }).proxy, null);
  assert.equal(decide('http://127.0.0.1:1234', { setting }).proxy, null);
  assert.equal(decide('http://[::1]:1234', { setting }).proxy, null);
  // A LAN address, a dotless name and *.local are no longer special.
  for (const url of ['http://192.168.1.5:8080', 'http://printer', 'http://nas.local']) {
    assert.equal(decide(url, { setting }).proxy, PROXY, url);
  }
  assert.equal(decide('http://192.168.1.5', { setting: { ...setting, exceptions: '192.168.0.0/16' } }).proxy, null);
});

test('manual mode without an address fails instead of connecting directly', () => {
  assert.throws(() => decide('https://api.example.com', { setting: { mode: 'manual', url: '' } }), ProxyConfigError);
});
