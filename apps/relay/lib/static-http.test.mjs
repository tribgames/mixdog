import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { sendStaticFile, sendDeviceManifest } from './static-http.mjs';

test('conditional assets retain security/cookies and distinguish changed representations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-static-validator-'));
  const target = join(dir, 'index.html');
  const manifest = join(dir, 'manifest.webmanifest');
  const original = '<p>asset content</p>'.repeat(200);
  writeFileSync(target, original);
  writeFileSync(`${target}.gz`, gzipSync(original));
  writeFileSync(`${target}.br`, brotliCompressSync(original));
  writeFileSync(manifest, JSON.stringify({ name: 'test', start_url: '/' }));
  const server = createServer((req, res) => {
    if (req.url.startsWith('/manifest/')) {
      sendDeviceManifest(req, res, manifest, req.url.split('/').at(-1));
    } else {
      sendStaticFile(req, res, target, { 'Set-Cookie': 'device=test; HttpOnly' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = (headers = {}, method = 'GET', path = '/') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const raw = await get();
    assert.equal(raw.status, 200);
    assert.equal(raw.body.toString(), original);
    const br = await get({ 'accept-encoding': 'br' });
    const gz = await get({ 'accept-encoding': 'gzip' });
    assert.equal(new Set([raw.headers.etag, br.headers.etag, gz.headers.etag]).size, 3);
    for (const [encoding, initial] of [['identity', raw], ['br', br], ['gzip', gz]]) {
      for (const method of ['GET', 'HEAD']) {
        const cached = await get({
          'accept-encoding': encoding,
          'if-none-match': `"unrelated", ${initial.headers.etag.replace('W/', '')}`,
        }, method);
        assert.equal(cached.status, 304);
        assert.equal(cached.body.length, 0);
        assert.equal(cached.headers['content-length'], undefined);
        assert.equal(cached.headers['cache-control'], 'no-cache');
        assert.equal(cached.headers.vary, 'Accept-Encoding');
        assert.equal(cached.headers['x-content-type-options'], 'nosniff');
        assert.deepEqual(cached.headers['set-cookie'], ['device=test; HttpOnly']);
      }
    }
    assert.equal((await get({ 'if-none-match': '*' })).status, 304);
    assert.equal((await get({ 'accept-encoding': 'br', 'if-none-match': raw.headers.etag })).status, 200);
    writeFileSync(target, `${original}!`);
    const changed = await get({ 'if-none-match': raw.headers.etag });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.toString(), `${original}!`);
    assert.notEqual(changed.headers.etag, raw.headers.etag);
    writeFileSync(`${target}.br`, brotliCompressSync(`${original}changed sibling`));
    assert.equal((await get({ 'accept-encoding': 'br', 'if-none-match': br.headers.etag })).status, 200);
    const a = await get({}, 'GET', '/manifest/a');
    const unchanged = await get({ 'if-none-match': a.headers.etag }, 'GET', '/manifest/a');
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
    const b = await get({ 'if-none-match': a.headers.etag }, 'GET', '/manifest/b');
    assert.equal(b.status, 200);
    assert.equal(JSON.parse(b.body).start_url, '/d/b/');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
