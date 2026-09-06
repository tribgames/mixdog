import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { startRelay } from '../server.mjs';
import { createRendererReadiness, inspectRenderer } from '../lib/renderer-readiness.mjs';
import { verifyRelease } from './verify-release.mjs';

const version = 'a'.repeat(64);
const html = '<!doctype html><head>'
  + `<meta name="mixdog-shell-version" content="${version}">`
  + '<meta name="mixdog-shell-assets" content="assets/main-12345678.js">'
  + '<script type="module" src="./assets/main-12345678.js"></script>'
  + '<link rel="stylesheet" href="./assets/style-12345678.css">'
  + '</head><body></body>';
const expectedIndex = createHash('sha256').update(html).digest('hex');

async function rendererFixture(root) {
  await mkdir(join(root, 'assets'), { recursive: true });
  for (const [name, body] of Object.entries({
    'index.html': html,
    'assets/main-12345678.js': 'export const ready = true;',
    'assets/style-12345678.css': 'body { color: white; }',
    'boot.js': 'void 0;',
    'manifest.webmanifest': JSON.stringify({ start_url: './', icons: [{ src: './icon.svg' }] }),
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'sw.js': 'importScripts("/sw-shell.js");',
    'sw-shell.js': 'void 0;',
  })) await writeFile(join(root, name), body);
}

test('deployed renderer and WebSocket gates verify without registering any device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-release-probe-'));
  let relay;
  try {
    await rendererFixture(join(root, 'renderer'));
    relay = await startRelay({ port: 0, dataDir: join(root, 'data'), rendererDir: join(root, 'renderer') });
    const origin = `http://127.0.0.1:${relay.port}`;
    const result = await verifyRelease({ origin, expectedIndex });
    assert.equal(result.status, 'verified');
    assert.equal(result.websocket, 'gated');
    assert.equal(relay.store.devices.size, 0);
    const before = inspectRenderer(join(root, 'renderer'));
    assert.equal(result.assets, before.assets);
    await assert.rejects(verifyRelease({ origin, expectedIndex: 'b'.repeat(64) }), /identity does not match/);
  } finally {
    await relay?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('readiness notices missing bootstrap, CSS and imported worker files while liveness stays healthy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-release-files-'));
  let relay;
  try {
    await rendererFixture(root);
    let clock = 0;
    const read = createRendererReadiness(root, { cacheMs: 10, now: () => clock });
    assert.equal(read().statusCode, 200);
    for (const asset of ['assets/main-12345678.js', 'assets/style-12345678.css', 'sw-shell.js']) {
      await rm(join(root, asset));
      clock += 11;
      assert.deepEqual(read(), { statusCode: 503, body: { status: 'not-ready' } });
      await writeFile(join(root, asset), 'restored');
      clock += 11;
      assert.equal(read().statusCode, 200);
    }
    await rm(join(root, 'sw-shell.js'));
    relay = await startRelay({ port: 0, dataDir: join(root, 'data'), rendererDir: root });
    const origin = `http://127.0.0.1:${relay.port}`;
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    await assert.rejects(verifyRelease({ origin, expectedIndex }), /readyz returned HTTP 503/);
    assert.equal((await fetch(`${origin}/readyz`, { method: 'POST' })).status, 405);
    const head = await fetch(`${origin}/readyz`, { method: 'HEAD' });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), '');
  } finally {
    await relay?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('renderer traversal and invalid release metadata never pass readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-release-metadata-'));
  try {
    await rendererFixture(root);
    await writeFile(join(root, 'index.html'), html.replace('content="assets/main', 'content="../main'));
    assert.throws(() => inspectRenderer(root), /invalid renderer asset path/);
    await writeFile(join(root, 'index.html'), '<html>unversioned shell</html>');
    assert.throws(() => inspectRenderer(root), /release metadata missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['missing-route', 'foreign-origin-accepted']) {
  test(`healthy HTTP cannot hide a broken WebSocket gate: ${mode}`, async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === '/healthz' ? { status: 'ok' } : {
        status: 'ready', indexSha256: expectedIndex, version, assets: 8,
      }));
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (mode === 'missing-route') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      } else {
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(4005));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await assert.rejects(verifyRelease({
        origin: `http://127.0.0.1:${server.address().port}`, expectedIndex,
      }), mode === 'missing-route' ? /HTTP 404/ : /accepted a foreign origin/);
    } finally {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
