import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-hook-identity-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
const { startHookTunnel } = await import('./relay-tunnel.mjs');

test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('a NUL-filled tunnel identity is kept aside and a fresh identity is persisted', () => {
  const file = join(dataDir, 'relay-hook-device.json');
  writeFileSync(file, Buffer.alloc(80));
  const tunnel = startHookTunnel({ relayUrl: 'ws://127.0.0.1:9', getLocalPort: () => 0 });
  tunnel.close();
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.deviceId, tunnel.deviceId);
  assert.ok(readdirSync(dataDir).some((name) => name.startsWith('relay-hook-device.json.corrupt-')));
  const again = startHookTunnel({ relayUrl: 'ws://127.0.0.1:9', getLocalPort: () => 0 });
  again.close();
  assert.equal(again.deviceId, tunnel.deviceId, 'the repaired identity is stable');
});
