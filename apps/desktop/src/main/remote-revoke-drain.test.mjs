import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRemoteClientCache } from './remote-client-cache.ts';
import { createPendingRevokeDrain } from './remote-revoke-drain.ts';

const client = { id: 'abcdef12-0000', name: 'Phone', platform: 'ios', browser: 'Safari', createdAt: 1, lastSeenAt: 2, online: true };

test('a failed revocation stays pending, visible, and is retried on the next connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revoke-drain-'));
  try {
    const cache = await loadRemoteClientCache(dir);
    await cache.remember([client]);
    await cache.queueRevoke(client.id);
    assert.deepEqual(cache.pending(), [client.id]);
    assert.equal(cache.list()[0]?.pendingRemoval, true, 'still listed, flagged as pending removal');

    let failing = true;
    const revoked = [];
    const relay = {
      listClients: async () => [],
      revokeClient: async (id) => {
        if (failing) throw new Error('relay unavailable');
        revoked.push(id);
      },
    };
    const drain = createPendingRevokeDrain({ cache, relay: () => relay, retryDelayMs: 1 });

    await drain(); // first connection: revoke fails
    assert.deepEqual(cache.pending(), [client.id]);
    assert.equal(cache.list().length, 1);

    failing = false;
    await drain(); // later reconnection retries
    assert.deepEqual(revoked, [client.id]);
    assert.deepEqual(cache.pending(), []);
    assert.deepEqual(cache.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
