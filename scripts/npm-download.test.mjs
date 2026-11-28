// The download of a runtime archive (bin/download.mjs) against local servers: the route (proxy, NO_PROXY), the trust (npm's
// cafile), redirects, the length, and that no credential reaches the origin.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bypassesProxy, download, proxyFor } from '../bin/download.mjs';

// A test CA and a certificate it signed for 127.0.0.1 and localhost, valid until 2126 (openssl, prime256v1).
const CA = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUGUsqqq4QnvP5nx+1Xn4aG1P8uCcwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwObWl4ZG9nIHRlc3QgQ0EwIBcNMjYxMTI4MDk1NTU0WhgPMjEy
NjExMDQwOTU1NTRaMBkxFzAVBgNVBAMMDm1peGRvZyB0ZXN0IENBMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEo381pzgyZAI1g9euwrf7+yAy1VSt3TvHbUE11BmA
71iCeLZV5g+RizhTY7W9D/G6zcBo3frYOMpZ5VDIDaTO1aNjMGEwHQYDVR0OBBYE
FGzwTifXofcoOnrh4cRyNK0SufJVMB8GA1UdIwQYMBaAFGzwTifXofcoOnrh4cRy
NK0SufJVMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49
BAMCA0gAMEUCIGQ2PUvIte1vovx0ZOgH6JZ1bEmaf6zt28A+Rwt/vjCYAiEA+Zsi
rsumHb/woRTOHPxF9MwfGdv8/goQzXa0UPpoCwk=
-----END CERTIFICATE-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBvjCCAWSgAwIBAgIUeHKYLsa90GzWCYwWyzj/P8dTuRQwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwObWl4ZG9nIHRlc3QgQ0EwIBcNMjYxMTI4MDk1NTU0WhgPMjEy
NjExMDQwOTU1NTRaMBQxEjAQBgNVBAMMCTEyNy4wLjAuMTBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABGZVus4+buk2VyE0SjimxDB4X1IiZf2lXPb+FQPDnooZw8+/
A1W+1oq9va+jBcE56njVsEDKQHrV14ReVkogyDejgYwwgYkwGgYDVR0RBBMwEYcE
fwAAAYIJbG9jYWxob3N0MAkGA1UdEwQCMAAwCwYDVR0PBAQDAgeAMBMGA1UdJQQM
MAoGCCsGAQUFBwMBMB0GA1UdDgQWBBQut4cVpcJgpyOqsA8iPSQ6xej17TAfBgNV
HSMEGDAWgBRs8E4n16H3KDp64eHEcjStErnyVTAKBggqhkjOPQQDAgNIADBFAiAx
MmzWoegqMyAFniqq4uFrDCWeDrI0dBM99J4EuujwBQIhAOs5MMtCRBiz7nf16nZ1
igNdZPoISTOQ8s7C7y1IbCFn
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgS/Z8q+ekPoSEPWIF
CJ8KWx0dfu/qaJAofsZP6A3AVN+hRANCAARmVbrOPm7pNlchNEo4psQweF9SImX9
pVz2/hUDw56KGcPPvwNVvtaKvb2vowXBOep41bBAykB61deEXlZKIMg3
-----END PRIVATE KEY-----
`;

const BODY = Buffer.from('the bytes of an archive'.repeat(1000));

/** An origin whose `/asset` is BODY, with redirects and a missing path; it keeps the headers of every request. */
function origin(seen, secure) {
  const handler = (request, response) => {
    seen.push(request.headers);
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/asset') {
      response.writeHead(200, { 'content-length': BODY.length });
      response.end(BODY);
    } else if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/asset?signature=secret' });
      response.end();
    } else if (url.pathname === '/downgrade') {
      response.writeHead(302, { location: url.searchParams.get('to') });
      response.end();
    } else {
      response.writeHead(404);
      response.end();
    }
  };
  return secure ? https.createServer({ key: KEY, cert: CERT }, handler) : http.createServer(handler);
}

/** A CONNECT proxy that keeps what it was asked and answers `status` (200 opens the tunnel). */
function proxy(asked, status = 200) {
  const server = http.createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  server.upstreams = new Set();
  server.on('connect', (request, client, head) => {
    asked.push({ target: request.url, auth: request.headers['proxy-authorization'] });
    if (status !== 200) {
      client.end(`HTTP/1.1 ${status} No\r\n\r\n`);
      return;
    }
    const [host, port] = request.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      server.upstreams.add(upstream);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return server;
}

/** `server` listening on a free port of 127.0.0.1 until the test ends, when every connection it took is ended with it. */
async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of [...sockets, ...(server.upstreams ?? [])]) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-download-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the proxy is npm\'s https-proxy, then the proxy variables in npm\'s order, then npm\'s proxy; NO_PROXY reaches a host directly', () => {
  const asset = 'https://github.com/o/r/releases/download/v1/a.tar.gz';
  assert.equal(proxyFor(asset, {}), null);
  assert.equal(proxyFor(asset, { npm_config_https_proxy: 'http://npm:1', HTTPS_PROXY: 'http://env:2' }).host, 'npm:1');
  assert.equal(proxyFor(asset, { HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }).host, 'a:1');
  assert.equal(proxyFor(asset, { https_proxy: 'http://lower:3' }).host, 'lower:3');
  assert.equal(proxyFor(asset, { HTTP_PROXY: 'http://b:2', npm_config_proxy: 'http://c:3' }).host, 'b:2');
  assert.equal(proxyFor(asset, { npm_config_proxy: 'http://c:3' }).host, 'c:3');
  assert.equal(proxyFor(asset, { HTTPS_PROXY: 'proxy.corp:8080' }).href, 'http://proxy.corp:8080/', 'a proxy without a scheme is http');
  assert.equal(proxyFor(asset, { HTTPS_PROXY: '' }), null, 'an empty variable is not set');
  assert.equal(proxyFor(asset, { HTTPS_PROXY: 'http://a:1', NO_PROXY: 'github.com' }), null);
  assert.equal(proxyFor(asset, { HTTPS_PROXY: 'http://a:1', npm_config_noproxy: '.github.com', NO_PROXY: 'other' }), null);
  assert.throws(() => proxyFor(asset, { HTTPS_PROXY: 'socks5://a:1' }), /not an http or https proxy/);
});

test('a NO_PROXY entry names a host, a domain it is in, or a host and port', () => {
  const at = (url) => new URL(url);
  assert.equal(bypassesProxy(at('https://github.com/x'), '*'), true);
  assert.equal(bypassesProxy(at('https://objects.githubusercontent.com/x'), 'example.org, githubusercontent.com'), true);
  assert.equal(bypassesProxy(at('https://objects.githubusercontent.com/x'), '*.githubusercontent.com'), true);
  assert.equal(bypassesProxy(at('https://notgithub.com/x'), 'github.com'), false);
  assert.equal(bypassesProxy(at('https://github.com/x'), 'github.com:8443'), false);
  assert.equal(bypassesProxy(at('https://github.com/x'), 'github.com:443'), true);
  assert.equal(bypassesProxy(at('http://127.0.0.1:9/x'), 'localhost 127.0.0.1'), true);
});

test('a download writes exactly the asset, follows redirects, and sends no credential of npm', async (t) => {
  const seen = [];
  const port = await listen(t, origin(seen, false));
  const dir = scratch(t);
  const file = join(dir, 'a');
  const env = { NODE_AUTH_TOKEN: 'npm-secret', npm_config__authToken: 'npm-secret', npm_config_userconfig: join(dir, '.npmrc') };
  await download({ url: `http://127.0.0.1:${port}/redirect`, file, length: BODY.length, env });
  assert.deepEqual(readFileSync(file), BODY);
  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers.authorization, undefined);
    assert.ok(!JSON.stringify(headers).includes('npm-secret'));
    assert.equal(headers['user-agent'], 'mixdog-runtime');
  }
  await assert.rejects(download({ url: `http://127.0.0.1:${port}/missing`, file, length: BODY.length, env: {} }), /\/missing answered HTTP 404/);
  await assert.rejects(download({ url: `http://127.0.0.1:${port}/asset`, file, length: BODY.length + 1, env: {} }), /is \d+ bytes, not the \d+ bytes of the release asset/);
});

test('through a proxy the download is a CONNECT tunnel that carries the proxy\'s own user, and NO_PROXY skips it', async (t) => {
  const seen = [];
  const asked = [];
  const port = await listen(t, origin(seen, false));
  const proxyPort = await listen(t, proxy(asked));
  const file = join(scratch(t), 'a');
  await download({ url: `http://127.0.0.1:${port}/asset`, file, length: BODY.length, env: { HTTP_PROXY: `http://user:pa%20ss@127.0.0.1:${proxyPort}` } });
  assert.deepEqual(readFileSync(file), BODY);
  assert.deepEqual(asked, [{ target: `127.0.0.1:${port}`, auth: `Basic ${Buffer.from('user:pa ss').toString('base64')}` }]);
  assert.equal(seen[0]['proxy-authorization'], undefined, 'the proxy\'s user stays with the proxy');
  // A proxy that is not there is never tried for a host NO_PROXY names.
  const closed = net.createServer();
  const closedPort = await listen(t, closed);
  await new Promise((resolve) => closed.close(resolve));
  await download({ url: `http://127.0.0.1:${port}/asset`, file, length: BODY.length, env: { HTTP_PROXY: `http://127.0.0.1:${closedPort}`, NO_PROXY: '127.0.0.1' } });
  assert.equal(asked.length, 1);
  const refusing = await listen(t, proxy([], 407));
  await assert.rejects(
    download({ url: `http://127.0.0.1:${port}/asset`, file, length: BODY.length, env: { HTTP_PROXY: `http://127.0.0.1:${refusing}` } }),
    /refused the tunnel to 127\.0\.0\.1:\d+: HTTP\/1\.1 407 No/
  );
});

test('an https origin is trusted with npm\'s cafile, directly and through the proxy; never downgraded to http by a redirect', async (t) => {
  const seen = [];
  const asked = [];
  const port = await listen(t, origin(seen, true));
  const proxyPort = await listen(t, proxy(asked));
  const dir = scratch(t);
  const cafile = join(dir, 'ca.pem');
  writeFileSync(cafile, CA);
  const file = join(dir, 'a');
  const url = `https://127.0.0.1:${port}/redirect`;
  await assert.rejects(download({ url, file, length: BODY.length, env: {} }), (error) => error.code !== undefined && /certificate/i.test(error.message));
  await download({ url, file, length: BODY.length, env: { npm_config_cafile: cafile } });
  assert.deepEqual(readFileSync(file), BODY);
  rmSync(file);
  await download({ url, file, length: BODY.length, env: { npm_config_cafile: cafile, npm_config_https_proxy: `http://127.0.0.1:${proxyPort}` } });
  assert.deepEqual(readFileSync(file), BODY);
  assert.deepEqual(asked.map(({ target }) => target), [`127.0.0.1:${port}`, `127.0.0.1:${port}`], 'the redirect is tunnelled too');
  await assert.rejects(
    download({ url: `https://127.0.0.1:${port}/downgrade?to=http://127.0.0.1:1/asset`, file, length: BODY.length, env: { npm_config_ca: CA } }),
    /redirects to http: 127\.0\.0\.1:1, which is not https/
  );
});