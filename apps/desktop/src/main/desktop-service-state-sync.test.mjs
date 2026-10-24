import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopServiceStateSync } from './desktop-service-state-sync.ts';

/** A host whose Agents pool read is held until released and, like
 *  SessionHost.listAgentPool, shared by every caller while outstanding. */
function heldPoolHost() {
  const poolListeners = new Set();
  const reads = [];
  let outstanding = null;
  const host = {
    getSnapshot: () => ({ items: [] }),
    subscribe: () => () => {},
    subscribeSessions: () => () => {},
    subscribeSessionStates: () => () => {},
    subscribeAgentPool(listener) {
      poolListeners.add(listener);
      return () => poolListeners.delete(listener);
    },
    setVisibleSessions: async () => true,
    listSessions: async () => [],
    replaySessionStates: async (_ids, deliver) => deliver([]),
    listAgentPool() {
      if (!outstanding) {
        const read = Promise.withResolvers();
        reads.push(read);
        outstanding = read.promise.finally(() => {
          outstanding = null;
        });
      }
      return outstanding;
    },
  };
  const publishPool = (agents) => {
    for (const listener of [...poolListeners]) listener(agents);
  };
  return { host, reads, publishPool };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a resync during a pending pool refresh cannot republish rows older than a later publication', async () => {
  const f = heldPoolHost();
  const messages = [];
  const sync = createDesktopServiceStateSync({ host: f.host, emit: (message) => messages.push(message) });
  try {
    await sync.control({ kind: 'state-resync' });
    assert.equal(f.reads.length, 1);
    // A store event publishes a newer pool while the first refresh still reads.
    f.publishPool([{ sessionId: 'agent', status: 'unknown' }]);
    await sync.control({ kind: 'state-resync' });
    f.reads[0].resolve([{ sessionId: 'agent', status: 'running' }]);
    await settle();
    const pools = messages.filter((message) => message.kind === 'agent-pool');
    assert.equal(pools.at(-1).agents[0].status, 'unknown');
    assert.equal(f.reads.length, 1);
  } finally {
    sync.dispose();
  }
});

test('a resync after the pending refresh settled reads and publishes the pool again', async () => {
  const f = heldPoolHost();
  const messages = [];
  const sync = createDesktopServiceStateSync({ host: f.host, emit: (message) => messages.push(message) });
  try {
    await sync.control({ kind: 'state-resync' });
    f.reads[0].resolve([{ sessionId: 'agent', status: 'running' }]);
    await settle();
    await sync.control({ kind: 'state-resync' });
    assert.equal(f.reads.length, 2);
    f.reads[1].resolve([{ sessionId: 'agent', status: 'completed' }]);
    await settle();
    const pools = messages.filter((message) => message.kind === 'agent-pool');
    assert.deepEqual(
      pools.map((message) => message.agents[0].status),
      ['running', 'completed']
    );
  } finally {
    sync.dispose();
  }
});
