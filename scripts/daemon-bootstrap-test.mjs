import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a client waits for the live singleton winner to publish discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-bootstrap-'));
  const runtimeRoot = join(root, 'runtime');
  const dataDir = join(root, 'data');
  const previousRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  process.env.MIXDOG_DATA_DIR = dataDir;
  let server = null;
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'daemon-owner.json'), JSON.stringify({
      kind: 'mixdog-daemon',
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    }));
    const wire = await import('../src/standalone/session-wire.mjs');
    const client = await import(`../src/standalone/session-client.mjs?bootstrap=${Date.now()}`);
    const publish = new Promise((resolve, reject) => {
      setTimeout(() => {
        server = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            pid: process.pid,
            protocol: wire.SESSION_PROTOCOL,
            revision: wire.SESSION_REVISION,
            version: wire.runtimeVersion(),
            capabilityFingerprint: wire.SESSION_CAPABILITY_FINGERPRINT,
          }));
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          writeFileSync(join(runtimeRoot, 'daemon.json'), JSON.stringify({
            pid: process.pid,
            endpoints: {
              session: { port: address.port, token: 'bootstrap-test-token' },
            },
          }));
          resolve();
        });
      }, 120);
    });
    const startedAt = Date.now();
    const discovery = await client.ensureDaemon({
      attempts: 0,
      readyTimeoutMs: 2_000,
    });
    await publish;
    assert.equal(discovery.pid, process.pid);
    assert.ok(Date.now() - startedAt >= 100, 'the owner publication gap was exercised');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRuntimeRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
