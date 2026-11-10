import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-connect-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { startHookTunnel } = await import('./relay-tunnel.mjs');
after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('a dial that rejects is handled and retried, never an unhandled rejection', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  // A plain-http relay URL passes URL parsing but fails the wss-only dial check
  // inside the async connect.
  const tunnel = startHookTunnel({ relayUrl: 'http://relay.invalid', getLocalPort: () => null });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(unhandled, []);
  } finally {
    tunnel.close();
    process.off('unhandledRejection', record);
  }
});
