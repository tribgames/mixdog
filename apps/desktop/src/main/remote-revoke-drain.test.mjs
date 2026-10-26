import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRemoteClientCache } from './remote-client-cache.ts';
import { createPendingRevokeDrain } from './remote-revoke-drain.ts';

const client = { id: 'abcdef12-0000', name: 'Phone', platform: 'ios', browser: 'Safari', createdAt: 1, lastSeenAt: 2, online: true };

/** A relay whose revokes wait until the test lets each one answer. */
function heldRelay() {
  const sent = [];
  const answers = [];
  return {
    sent,
    answer: () => answers.shift()?.(),
    relay: {
      listClients: async () => [],
      revokeClient: (id) => {
        sent.push(id);
        return new Promise((resolve) => answers.push(resolve));
      },
    },
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function withCache(run) {
  const dir = await mkdtemp(join(tmpdir(), 'revoke-drain-'));
  try {
    await run(await loadRemoteClientCache(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('regression: a device re-paired while the drain is busy with another is never sent', () =>
  withCache(async (cache) => {
    await cache.queueRevoke('aaaaaaaa');
    await cache.queueRevoke('bbbbbbbb');
    const h = heldRelay();
    const drain = createPendingRevokeDrain({ cache, relay: () => h.relay, retryDelayMs: 1 });
    const draining = drain();
    await turn();
    assert.deepEqual(h.sent, ['aaaaaaaa'], 'A in flight');
    await cache.repaired('bbbbbbbb');
    h.answer();
    await draining;
    assert.deepEqual(h.sent, ['aaaaaaaa'], 'B was withdrawn before its turn: no revoke sent');
    assert.deepEqual(cache.pending(), []);
  }));

test('regression: a stale acknowledgement never clears a newer removal request for the same device', () =>
  withCache(async (cache) => {
    await cache.queueRevoke('aaaaaaaa');
    const h = heldRelay();
    const drain = createPendingRevokeDrain({ cache, relay: () => h.relay, retryDelayMs: 1 });
    const draining = drain();
    await turn();
    assert.deepEqual(h.sent, ['aaaaaaaa']);
    // Re-paired, then removed again while the old revoke awaits its answer.
    await cache.repaired('aaaaaaaa');
    await cache.queueRevoke('aaaaaaaa');
    h.answer();
    await draining;
    assert.deepEqual(cache.pending(), ['aaaaaaaa'], 'the newer request stays queued');
    // The next connection sends it, and its own answer clears it.
    const next = drain();
    await turn();
    assert.deepEqual(h.sent, ['aaaaaaaa', 'aaaaaaaa']);
    h.answer();
    await next;
    assert.deepEqual(cache.pending(), []);
  }));

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
