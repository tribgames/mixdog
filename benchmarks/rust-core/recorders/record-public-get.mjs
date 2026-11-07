#!/usr/bin/env node
// Golden twin of the guard behind the media downloads' GET (`pinnedFetch(url, { headers, redirect: 'manual' })`
// after `assertPublicUrl(url)`; `src/runtime/media/download.mjs`, `src/runtime/web-search/lib/ssrf-guard.mjs`).
// Node's real functions answer:
//   urls            `assertPublicUrl` for every address form (the verdict's message and code)
//   lookups         `resolveAndValidate` over a stubbed `dns.promises.lookup` (every address of the answer is checked)
//   lookup_failures `pinnedFetch` when the lookup itself fails or finds nothing
//   wire            undici through the same `fetchThroughAgent` pinnedFetch uses (no connect pin, so a loopback server
//                   can answer): a redirect that is returned and not followed, the headers a request carries, the
//                   statuses without a body, a body cut short, a refused connection
//   node tools::web::PublicGet and media::public_fetch::RoutedPublicFetch must give the same verdicts and wording.
//
//   node benchmarks/rust-core/recorders/record-public-get.mjs [--tree <dir>]
//
// Output: native/core/fixtures/public-get/golden.json.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing of the real user's state: every directory Mixdog code could read or write is a fresh temp one.
const isolated = mkdtempSync(join(tmpdir(), 'mixdog-public-get-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = join(isolated, name);
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[name];

const dns = (await import('node:dns')).default;
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'public-get');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-public-get.mjs';
const guard = await importFrom(tree, 'src/runtime/web-search/lib/ssrf-guard.mjs');

const error = (e) => ({ name: e.name, message: e.message, code: e.code ?? null });

// ---- urls: assertPublicUrl
const urls = [
  // public
  'https://example.com/a.png', 'http://example.com:8080/x?y=1#z', 'https://EXAMPLE.com/', 'https://sub.example.co.uk/a/b',
  'https://oaidalleapiprodscus.blob.core.windows.net/private/img.png?sig=abc', 'https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media',
  'http://8.8.8.8/', 'https://1.1.1.1/dns-query', 'http://[2606:4700:4700::1111]/', 'http://[2001:4860:4860::8888]:443/',
  // not http
  'ftp://example.com/file', 'file:///etc/passwd', 'data:text/plain,hello', 'javascript:alert(1)', 'ws://example.com/', 'wss://example.com/', 'gopher://example.com/', 'blob:https://example.com/uuid',
  // credentials
  'http://user:pass@example.com/', 'https://user@example.com/', 'http://:pw@example.com/', 'http://user:pass@127.0.0.1/', 'http://user@localhost/',
  // localhost
  'http://localhost/', 'http://LOCALHOST:8080/x', 'https://localhost:3000', 'http://localhost./', 'http://foo.localhost/', 'http://localhost.localdomain/', 'http://notlocalhost/',
  // IPv4 private and reserved
  'http://127.0.0.1/', 'http://127.255.255.254/', 'http://10.0.0.1/', 'http://10.255.255.255/', 'http://0.0.0.0/', 'http://0.1.2.3/',
  'http://172.16.0.1/', 'http://172.31.255.255/', 'http://172.15.255.255/', 'http://172.32.0.1/',
  'http://192.168.0.1/', 'http://192.168.255.255/', 'http://192.167.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://169.254.0.1/', 'http://169.253.0.1/',
  'http://100.64.0.1/', 'http://100.127.255.255/', 'http://100.63.255.255/', 'http://100.128.0.1/',
  'http://198.18.0.1/', 'http://198.19.255.255/', 'http://198.17.255.255/', 'http://198.20.0.1/',
  'http://192.0.0.1/', 'http://192.0.2.1/', 'http://192.0.1.1/', 'http://192.88.99.1/', 'http://192.88.98.1/',
  'http://198.51.100.1/', 'http://198.51.101.1/', 'http://203.0.113.1/', 'http://203.0.114.1/',
  'http://224.0.0.1/', 'http://239.255.255.255/', 'http://223.255.255.255/', 'http://240.0.0.1/', 'http://255.255.255.255/',
  // IPv4 written other ways (the URL parser normalizes them)
  'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0x7f000001/', 'http://127.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://3232235521/', 'http://134744072/',
  // IPv6 literals refused for the address itself
  'http://[::1]/', 'http://[::]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://[fe8::1]/', 'http://[fe9::1]/', 'http://[fea::1]/', 'http://[feb::1]/', 'http://[fec0::1]/',
  'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fc::1]/', 'http://[fd::1]/', 'http://[fc0::1]/', 'http://[fdff::1]/', 'http://[ff02::1]/', 'http://[ff::1]/', 'http://[ffff::1]/', 'http://[ff00::]/',
  'http://[2001:db8::1]/', 'http://[2001:db8:ffff::1]/', 'http://[3fff::1]/', 'http://[3fff:fff::1]/', 'http://[100::1]/', 'http://[100::ffff]/', 'http://[64:ff9b:1::1]/',
  // IPv6 literals that are public
  'http://[fe::1]/', 'http://[fed::1]/', 'http://[fb00::1]/', 'http://[fe7f::1]/', 'http://[3fff:1000::1]/', 'http://[2001:db9::1]/', 'http://[100:0:0:1::1]/', 'http://[2606:4700::1111]/', 'http://[::2:0:0:1]/',
  // IPv6 forms that carry an IPv4 address (the message names that address)
  'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:10.1.2.3]/', 'http://[::ffff:a01:203]/', 'http://[::ffff:192.168.1.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:8.8.8.8]/', 'http://[::ffff:808:808]/',
  'http://[::127.0.0.1]/', 'http://[::7f00:1]/', 'http://[::10.0.0.1]/', 'http://[::8.8.8.8]/', 'http://[::0.0.0.2]/',
  'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::127.0.0.1]/', 'http://[64:ff9b::a00:1]/', 'http://[64:ff9b::808:808]/', 'http://[64:ff9b::1]/',
  'http://[2002:7f00:1::]/', 'http://[2002:7f00:1::1]/', 'http://[2002:a00:1::]/', 'http://[2002:c0a8:1::]/', 'http://[2002:808:808::]/', 'http://[2002:a9fe:a9fe::]/',
  // not an address
  'not a url', '', '//example.com', 'example.com', 'http://', 'http:///x', 'http://exa mple.com/', 'http://[::1', 'http://[::1]x/', 'https://%zz/', 'http://example.com:99999/', 'http://256.256.256.256/', 'http://1.2.3/',
];
const urlCases = urls.map((url) => {
  try {
    guard.assertPublicUrl(url);
    return { url };
  } catch (e) {
    return { url, error: error(e) };
  }
});

// ---- lookups: resolveAndValidate over a stubbed dns.promises.lookup
const realLookup = dns.promises.lookup;
const answerWith = (addresses) => {
  dns.promises.lookup = async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const answers = [
  ['media.example.com', ['8.8.8.8']],
  ['media.example.com', ['8.8.8.8', '1.1.1.1']],
  ['media.example.com', ['2606:4700::1111']],
  ['media.example.com', ['8.8.8.8', '2606:4700::1111']],
  ['rebind.example.com', ['8.8.8.8', '10.0.0.5']],
  ['rebind.example.com', ['10.0.0.5', '8.8.8.8']],
  ['rebind.example.com', ['127.0.0.1']],
  ['rebind.example.com', ['169.254.169.254']],
  ['rebind.example.com', ['100.64.0.1']],
  ['rebind.example.com', ['192.0.2.1']],
  ['rebind.example.com', ['0.0.0.0']],
  ['rebind.example.com', ['224.0.0.1']],
  ['rebind.example.com', ['8.8.8.8', '::1']],
  ['rebind.example.com', ['::1']],
  ['rebind.example.com', ['::']],
  ['rebind.example.com', ['fe80::1']],
  ['rebind.example.com', ['fd00::1']],
  ['rebind.example.com', ['fc::1']],
  ['rebind.example.com', ['ff02::1']],
  ['rebind.example.com', ['fec0::1']],
  ['rebind.example.com', ['2001:db8::1']],
  ['rebind.example.com', ['3fff::1']],
  ['rebind.example.com', ['100::1']],
  ['rebind.example.com', ['64:ff9b:1::1']],
  ['rebind.example.com', ['::ffff:127.0.0.1']],
  ['rebind.example.com', ['::ffff:7f00:1']],
  ['rebind.example.com', ['::ffff:10.0.0.1']],
  ['rebind.example.com', ['::ffff:8.8.8.8']],
  ['rebind.example.com', ['::7f00:1']],
  ['rebind.example.com', ['64:ff9b::7f00:1']],
  ['rebind.example.com', ['64:ff9b::808:808']],
  ['rebind.example.com', ['2002:7f00:1::']],
  ['rebind.example.com', ['2002:808:808::']],
  ['rebind.example.com', ['2606:4700::1111', '10.0.0.1']],
  ['localhost.', ['127.0.0.1']],
  ['localhost.', ['::1']],
  ['empty.example.com', []],
];
const lookups = [];
for (const [host, addresses] of answers) {
  answerWith(addresses);
  const entry = { host, addresses };
  try {
    const got = await guard.resolveAndValidate(host);
    // A name with no addresses is refused by pinnedFetch itself, before it connects.
    if (got.length === 0) await guard.pinnedFetch(`https://${host}/`);
  } catch (e) {
    entry.error = e.message;
  }
  lookups.push(entry);
}

// ---- lookup_failures: the lookup itself fails
const lookupFailures = [];
for (const code of ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN']) {
  const host = 'unreachable.example.com';
  dns.promises.lookup = async () => {
    throw Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
  };
  try {
    await guard.pinnedFetch(`https://${host}/`);
    throw new Error('expected a refusal');
  } catch (e) {
    lookupFailures.push({ host, code, message: e.message });
  }
}
dns.promises.lookup = realLookup;

// ---- wire: undici through fetchThroughAgent
const serve = async (handler) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
};
const get = (url, options = {}) => guard.fetchThroughAgent(url, { redirect: 'manual', ...options }, {});

const wire = {};
{
  const { server, seen, base } = await serve((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/next', 'content-length': 5 });
      res.end('moved');
    } else {
      res.writeHead(200);
      res.end('next');
    }
  });
  const response = await get(`${base}/start`);
  const body = await response.text();
  wire.redirect = { status: response.status, location: response.headers.get('location'), body, hasBody: response.body !== null, requests: seen.length, paths: seen.map((r) => r.url) };
  server.close();
}
{
  const { server, seen, base } = await serve((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const response = await get(`${base}/media`, { headers: { 'x-goog-api-key': 'k' } });
  await response.text();
  const names = ['user-agent', 'accept', 'accept-language', 'sec-fetch-mode', 'x-goog-api-key'];
  wire.request = {
    method: seen[0].method,
    // What a media download relies on; the connection, host and encoding headers are the transport's.
    compared: Object.fromEntries(names.map((name) => [name, seen[0].headers[name] ?? null])),
    all: Object.keys(seen[0].headers).filter((name) => name !== 'host'),
  };
  server.close();
}
{
  wire.bodies = [];
  for (const status of [200, 204, 205, 304, 302]) {
    const { server, base } = await serve((_req, res) => {
      if (status === 200) {
        res.writeHead(200);
        res.end('x');
      } else if (status === 302) {
        res.writeHead(302, { location: '/n', 'content-length': 0 });
        res.end();
      } else {
        res.writeHead(status);
        res.end();
      }
    });
    const response = await get(`${base}/`);
    wire.bodies.push({ status: response.status, hasBody: response.body !== null });
    await response.arrayBuffer().catch(() => {});
    server.close();
  }
}
{
  const cutter = createTcpServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc'));
  });
  await new Promise((resolve) => cutter.listen(0, '127.0.0.1', resolve));
  const response = await get(`http://127.0.0.1:${cutter.address().port}/`);
  try {
    await response.arrayBuffer();
    throw new Error('expected the body to be cut short');
  } catch (e) {
    wire.cut = { status: response.status, name: e.name, message: e.message };
  }
  cutter.close();
}
{
  const probe = createTcpServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  try {
    await get(`http://127.0.0.1:${port}/`);
    throw new Error('expected a refused connection');
  } catch (e) {
    wire.refused = { name: e.name, message: e.message };
  }
}

writeJson(join(stage, 'golden.json'), { node: process.version, urls: urlCases, lookups, lookup_failures: lookupFailures, wire });
writeSetManifest(stage, { set: 'public-get', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
