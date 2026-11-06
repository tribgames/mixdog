#!/usr/bin/env node
// Node's network proxy policy and the three config methods (proxy-policy.mjs,
// proxy-diagnostics.mjs, settings-network-proxy-api.mjs).
//   node benchmarks/rust-core/recorders/record-network-proxy.mjs [--tree <dir>]
//
// Output: native/core/fixtures/network-proxy/golden.json.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'network-proxy');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-network-proxy.mjs';
const at = (path) => importFrom(tree, path);
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
  delete process.env[name];
}
const policy = await at('src/runtime/shared/llm/proxy-policy.mjs');
const { isLocalHost } = await at('src/runtime/shared/llm/http-agent.mjs');
const { createNetworkProxySettings } = await at('src/session-runtime/settings-network-proxy-api.mjs');

const attempt = (run) => {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const urls = [
  'http://proxy.corp:8080', 'https://proxy.corp', 'socks5://127.0.0.1:1080', 'socks5://[::1]:1080',
  'http://user:pw@proxy:3128', 'http://user@proxy', 'http://us%zzer@proxy', 'http://proxy/path', 'http://proxy/?', 'http://proxy/#',
  'http://proxy?x=1', 'ftp://proxy', 'proxy:8080', 'HTTP://PROXY.CORP:80', 'http://proxy:80', 'https://proxy:443', 'http://proxy:99999',
  '  http://padded:1  ', 'http://a b', '', 'http://', 'socks5://proxy', 'http://[::1]:8080', 'http://ProXy.Corp.:8080', 'http://%75ser:p@h',
];
const parse = urls.flatMap((url) => [false, true].map((credentials) => ({
  url, credentials, ...attempt(() => policy.parseProxyUrl(url, policy.PROXY_SCHEMES, credentials)),
})));
const parseNonString = [5, null, undefined, {}].map((value) => ({
  label: String(value), ...attempt(() => policy.parseProxyUrl(value, policy.PROXY_SCHEMES, false)),
}));

const lists = [
  '', '*', 'localhost, 127.0.0.1, ::1', 'example.com', '.example.com', '*.example.com', 'example.com:8443', '10.0.0.0/8',
  '10.0.0.1/33', 'fc00::/7', 'fc00::/129', '10.0.0.1-10.0.0.9', '10.0.0.9-10.0.0.1', '10.0.0.5-10.0.0.5', '[::1]:8443', '[::1]', '::1',
  '192.168.1.5:8080', 'bad entry!', 'A.B.C;d.e, a.b.c', 'host:99999', '1.2.3.4', '256.1.1.1', 'fe80::1%eth0', '2001:db8::/32',
  'a'.repeat(4097), '-x', '_x.y', '10.0.0.0/08',
];
const targets = [
  'https://example.com', 'https://api.example.com', 'http://example.com:8443', 'https://example.com:8443', 'https://x.y',
  'http://10.1.2.3', 'http://11.0.0.1', 'http://[fc00::1]', 'http://[fd12::1]', 'http://[::1]:8443', 'http://[::1]',
  'http://192.168.1.5:8080', 'http://192.168.1.5', 'http://10.0.0.5', 'http://10.0.0.10', 'http://[2001:db8::5]',
  'https://a.b.c', 'https://d.e', 'http://1.2.3.4', 'http://localhost', 'http://localhost:11434', 'https://EXAMPLE.com.',
  'http://[::ffff:10.0.0.5]', 'http://[::ffff:7f00:1]',
];
const exceptions = lists.map((text) => ({
  text: text.length > 100 ? { repeat: 'a', times: text.length } : text,
  error: policy.exceptionsError(text),
  canonical: attempt(() => policy.canonicalExceptions(text)).ok ?? null,
  covers: targets.map((target) => policy.exceptionsCover(text, new URL(target))),
}));
const exceptionsNonString = [5, null, {}].map((value) => ({ label: JSON.stringify(value), error: policy.exceptionsError(value) }));

const stored = [
  undefined, null, 'x', [], {}, { mode: 'manual' }, { mode: 'off', url: 'http://p:1', exceptions: 'A.com, a.com' },
  { mode: 'bogus', url: 5, exceptions: 5 }, { url: 'http://u:p@h:1' }, { exceptions: 'bad entry!' }, { mode: 'manual', url: 'socks5://h:1' },
  { exceptions: '' },
];
const normalize = stored.map((value, index) => ({ index, stored: value ?? null, result: policy.normalizeNetworkProxy(value) }));

const patches = [
  [undefined, {}], [undefined, null], [undefined, []], [undefined, { mode: 'off' }], [undefined, { mode: 'manual' }],
  [undefined, { mode: 'manual', url: 'http://p:8080' }], [undefined, { url: 'nope' }], [undefined, { url: '' }],
  [{ mode: 'manual', url: 'http://p:1' }, { url: '' }], [{ mode: 'manual', url: 'http://p:1' }, { mode: 'system' }],
  [undefined, { exceptions: 'bad entry!' }], [undefined, { exceptions: 5 }], [undefined, { exceptions: 'B.com, b.com' }],
  [undefined, { color: 'red' }], [undefined, { mode: 'x' }], [undefined, { mode: 5 }], [undefined, { url: 5 }],
  [undefined, { url: 'http://u:p@h' }], [undefined, { '1': 1, mode: 'bad' }], [undefined, { mode: 'bad', '1': 1 }],
  [undefined, { mode: 'off', color: 1 }], [undefined, { color: 1, mode: 'bad' }], [undefined, { url: 'ftp://h' }],
];
const patch = patches.map(([current, change]) => ({ current: current ?? null, patch: change ?? null, ...attempt(() => policy.applyNetworkProxyPatch(current, change)) }));

const settings = [
  { mode: 'off', url: '', exceptions: '' }, { mode: 'manual', url: 'http://p:8080', exceptions: 'localhost, 127.0.0.1, ::1' },
  { mode: 'manual', url: '', exceptions: '' }, { mode: 'system', url: '', exceptions: '' },
];
const envs = [{}, { HTTPS_PROXY: 'http://env:1' }, { HTTP_PROXY: 'http://env:2', ALL_PROXY: 'socks5://x:1' }, { ALL_PROXY: 'socks5://x:1' },
  { ALL_PROXY: 'http://all:3' }, { NO_PROXY: '*', HTTPS_PROXY: 'http://env:1' }, { HTTPS_PROXY: 'http://env:1', NO_PROXY: 'example.com' },
  { https_proxy: 'http://low:1' }, { HTTPS_PROXY: '' , https_proxy: 'http://low:1' }, { HTTPS_PROXY: ' http://pad:1 ' }];
const decideTargets = ['https://api.example.com', 'http://api.example.com', 'wss://api.example.com', 'ws://api.example.com',
  'http://localhost:11434', 'http://192.168.1.5', 'http://printer', 'http://[::1]:1', 'ftp://x.y', 'https://example.com',
  'http://[::ffff:127.0.0.1]', 'http://nas.local'];
const decide = [];
for (const setting of settings) {
  for (const env of envs) {
    for (const target of decideTargets) {
      const result = attempt(() => policy.decideProxyRoute(target, { setting, env, system: null, isLocalHost }));
      decide.push({ setting, env, target, ...result });
    }
  }
}
const decideLocal = [];
for (const host of ['localhost', 'a', 'a.b', 'x.local', 'x.localhost', '127.0.0.1', '10.1.1.1', '172.15.0.1', '172.16.0.1', '172.31.255.255',
  '172.32.0.1', '192.168.0.1', '169.254.1.1', '8.8.8.8', '[::1]', '::1', 'fc00::1', 'fe80::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'A.B.', '[fd00::1]']) {
  decideLocal.push({ host, local: isLocalHost(host) });
}

// The three methods.
const open = (status) =>
  new Promise((resolve) => {
    const server = createServer((_, response) => {
      response.statusCode = status;
      response.end();
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
const server = await open(204);
const live = `http://127.0.0.1:${server.address().port}`;
const refused = createServer();
await new Promise((resolve) => refused.listen(0, '127.0.0.1', resolve));
const closed = `http://127.0.0.1:${refused.address().port}`;
await new Promise((resolve) => refused.close(resolve));
const mask = (value) => JSON.parse(JSON.stringify(value).replaceAll(live, '<live>').replaceAll(closed, '<closed>'));
const methods = [];
const configs = [
  { providers: { main: { baseURL: live }, down: { baseURL: closed } } },
  { networkProxy: { mode: 'off' }, providers: { main: { baseURL: live } } },
  { networkProxy: { mode: 'manual', url: 'http://127.0.0.1:9', exceptions: 'nothing.example' }, providers: { far: { baseURL: 'http://example.invalid' }, down: { baseURL: closed } } },
  { networkProxy: { mode: 'manual', url: '' } },
  { networkProxy: { mode: 'system' }, providers: { anthropic: {}, 'openai-oauth': {}, deepseek: {}, grok: {} } },
];
for (const [index, config] of configs.entries()) {
  let current = JSON.parse(JSON.stringify(config).replaceAll('http://127.0.0.1:' + new URL(live).port, live));
  // The process follows the stored setting, as it does once the config is loaded.
  policy.adoptProxySetting(current.networkProxy);
  const api = createNetworkProxySettings({
    getConfig: () => current,
    saveConfigAndAdopt: (next) => {
      current = next;
    },
    flushConfigSaves: async () => {},
  });
  const providers = ['main', 'down', 'far', 'anthropic', 'openai-oauth', 'deepseek', 'grok', 'unknown', undefined];
  for (const provider of providers) {
    const got = await api.getNetworkProxy({ provider });
    methods.push({ config: index, method: 'getNetworkProxy', provider: provider ?? null, result: mask(got) });
    // Only configured endpoints are connected to, so the run touches no remote host.
    if (config.providers?.[provider]?.baseURL) {
      const tested = await api.testNetworkProxy({ provider });
      const { ms: _ms, ...rest } = tested;
      methods.push({ config: index, method: 'testNetworkProxy', provider, result: mask(rest) });
    }
  }
  for (const change of [{ mode: 'manual', url: 'http://p:1' }, { mode: 'off' }, {}, { mode: 'x' }, { url: 'nope' }]) {
    try {
      const result = await api.setNetworkProxy(change, { provider: 'main' });
      methods.push({ config: index, method: 'setNetworkProxy', patch: change, result: mask(result), stored: mask(current.networkProxy) });
    } catch (error) {
      methods.push({ config: index, method: 'setNetworkProxy', patch: change, error: String(error?.message) });
    }
  }
}
server.close();

// Proxies that refuse: the code a failed check reports. Each proxy is a socket that
// answers the first bytes it reads with a fixed reply; the origin is never reached.
const net = await import('node:net');
const proxy = (reply) =>
  new Promise((resolve) => {
    const listener = net.createServer((socket) => {
      socket.once('data', (first) => {
        const text = typeof reply === 'function' ? reply(first) : reply;
        if (text === null) socket.destroy();
        else socket.write(text, () => socket.end());
      });
      socket.on('error', () => {});
    });
    listener.listen(0, '127.0.0.1', () => resolve(listener));
  });
const refusals = [
  { name: 'CONNECT 403', origin: 'https://example.test', reply: 'HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n' },
  { name: 'CONNECT 407', origin: 'https://example.test', reply: 'HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n' },
  { name: 'CONNECT dropped', origin: 'https://example.test', reply: null },
  { name: 'forward 407', origin: 'http://example.test', reply: 'HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n' },
  { name: 'forward 403', origin: 'http://example.test', reply: 'HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n' },
  { name: 'socks5 general failure', origin: 'https://example.test', socks: true, reply: Buffer.from([5, 0]) , second: Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]) },
  { name: 'socks5 refused', origin: 'https://example.test', socks: true, reply: Buffer.from([5, 0]), second: Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]) },
  { name: 'socks5 no method', origin: 'https://example.test', socks: true, reply: Buffer.from([5, 0xff]) },
];
const failures = [];
for (const spec of refusals) {
  let listener;
  if (spec.socks) {
    listener = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(spec.reply);
        if (spec.second) socket.once('data', () => socket.write(spec.second, () => socket.end()));
        else socket.end();
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  } else {
    listener = await proxy(spec.reply);
  }
  const port = listener.address().port;
  const scheme = spec.socks ? 'socks5' : 'http';
  const config = { networkProxy: { mode: 'manual', url: `${scheme}://127.0.0.1:${port}`, exceptions: 'nothing.example' }, providers: { x: { baseURL: spec.origin } } };
  policy.adoptProxySetting(config.networkProxy);
  const api = createNetworkProxySettings({ getConfig: () => config, saveConfigAndAdopt() {}, flushConfigSaves: async () => {} });
  const result = await api.testNetworkProxy({ provider: 'x' });
  const { ms: _ms, ...rest } = result;
  failures.push({ name: spec.name, origin: spec.origin, scheme, result: JSON.parse(JSON.stringify(rest).replaceAll(String(port), '<port>')) });
  listener.close();
}
writeJson(join(stage, 'golden.json'), { failures, targets, parse, parseNonString, exceptions, exceptionsNonString, normalize, patch, decide, decideLocal, methods });
writeSetManifest(stage, { set: 'network-proxy', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
