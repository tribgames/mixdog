import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { sendStaticFile, sendDeviceManifest } from './static-http.mjs';

const MANIFEST_BODY = JSON.stringify({ name: 'test', start_url: '/' });
const ORIGINAL = '<p>asset content</p>'.repeat(200);

async function withStaticServer(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-static-validator-'));
  const target = join(dir, 'index.html');
  const manifest = join(dir, 'manifest.webmanifest');
  writeFileSync(target, ORIGINAL);
  writeFileSync(`${target}.gz`, gzipSync(ORIGINAL));
  writeFileSync(`${target}.br`, brotliCompressSync(ORIGINAL));
  writeFileSync(manifest, MANIFEST_BODY);
  const server = createServer((req, res) => {
    if (req.url.startsWith('/manifest/')) {
      sendDeviceManifest(req, res, manifest, req.url.split('/').at(-1));
    } else {
      sendStaticFile(req, res, target, { 'Set-Cookie': 'device=test; HttpOnly' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = (headers = {}, method = 'GET', path = '/') =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    await run({ get, target });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('each representation of an asset has its own validator', () =>
  withStaticServer(async ({ get }) => {
    const raw = await get();
    assert.equal(raw.status, 200);
    assert.equal(raw.body.toString(), ORIGINAL);
    const br = await get({ 'accept-encoding': 'br' });
    const gz = await get({ 'accept-encoding': 'gzip' });
    assert.equal(new Set([raw.headers.etag, br.headers.etag, gz.headers.etag]).size, 3);
  }));

test('a conditional request keeps security headers and cookies on a 304 in every encoding', () =>
  withStaticServer(async ({ get }) => {
    for (const encoding of ['identity', 'br', 'gzip']) {
      const initial = await get({ 'accept-encoding': encoding });
      for (const method of ['GET', 'HEAD']) {
        const cached = await get(
          {
            'accept-encoding': encoding,
            'if-none-match': `"unrelated", ${initial.headers.etag.replace('W/', '')}`,
          },
          method
        );
        assert.equal(cached.status, 304);
        assert.equal(cached.body.length, 0);
        assert.equal(cached.headers['content-length'], undefined);
        assert.equal(cached.headers['cache-control'], 'no-cache');
        assert.equal(cached.headers.vary, 'Accept-Encoding');
        assert.equal(cached.headers['x-content-type-options'], 'nosniff');
        assert.deepEqual(cached.headers['set-cookie'], ['device=test; HttpOnly']);
      }
    }
  }));

test('a wildcard validator matches but another representation validator does not', () =>
  withStaticServer(async ({ get }) => {
    const raw = await get();
    assert.equal((await get({ 'if-none-match': '*' })).status, 304);
    assert.equal((await get({ 'accept-encoding': 'br', 'if-none-match': raw.headers.etag })).status, 200);
  }));

test('an edited asset gets a new validator and body', () =>
  withStaticServer(async ({ get, target }) => {
    const raw = await get();
    writeFileSync(target, `${ORIGINAL}!`);
    const changed = await get({ 'if-none-match': raw.headers.etag });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.toString(), `${ORIGINAL}!`);
    assert.notEqual(changed.headers.etag, raw.headers.etag);
  }));

test('an edited precompressed sibling invalidates its validator', () =>
  withStaticServer(async ({ get, target }) => {
    const br = await get({ 'accept-encoding': 'br' });
    writeFileSync(`${target}.br`, brotliCompressSync(`${ORIGINAL}changed sibling`));
    assert.equal((await get({ 'accept-encoding': 'br', 'if-none-match': br.headers.etag })).status, 200);
  }));

test('the device manifest is conditional per device', () =>
  withStaticServer(async ({ get }) => {
    const a = await get({}, 'GET', '/manifest/a');
    const unchanged = await get({ 'if-none-match': a.headers.etag }, 'GET', '/manifest/a');
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
    const b = await get({ 'if-none-match': a.headers.etag }, 'GET', '/manifest/b');
    assert.equal(b.status, 200);
    assert.equal(JSON.parse(b.body).start_url, '/d/b/');
  }));
