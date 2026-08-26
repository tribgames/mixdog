import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneStaleChannelClientHeartbeats } from './channel-worker.mjs';

test('channel heartbeat sweep removes dead and expired rows only', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-channel-heartbeat-test-'));
  const now = 100_000;
  try {
    writeFileSync(join(root, '1.json'), JSON.stringify({ pid: 1, updatedAt: now - 1_000 }));
    writeFileSync(join(root, '2.json'), JSON.stringify({ pid: 2, updatedAt: now - 60_000 }));
    writeFileSync(join(root, '3.json'), JSON.stringify({ pid: 3, updatedAt: now - 1_000 }));

    const removed = pruneStaleChannelClientHeartbeats(root, {
      now,
      maxAgeMs: 30_000,
      pidAlive: (pid) => pid !== 3,
    });

    assert.equal(removed, 2);
    assert.equal(existsSync(join(root, '1.json')), true);
    assert.equal(existsSync(join(root, '2.json')), false);
    assert.equal(existsSync(join(root, '3.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
