import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLoads } from './session-loads.mjs';

function harness({ exists = true } = {}) {
  const pendingViewers = new Map();
  const retired = Promise.withResolvers();
  const old = { runtime: { isSessionTerminal: () => true }, subscribers: new Set(['pane']) };
  let owner = old;
  let created = 0;
  const loads = createSessionLoads({
    pendingViewers,
    sessionExists: async () => exists,
    log() {},
    assertAvailable() {},
    async createEntry() {
      created++;
      owner = {
        subscribers: new Set(),
        runtime: {
          isSessionTerminal: () => false,
          resume: async () => true,
          getState: () => ({ sessionId: 'saved' }),
          bindSessionAddress: async () => {},
        },
      };
      return owner;
    },
    async destroy(entry) {
      assert.equal(entry, old);
      owner = null;
      await retired.promise;
    },
    bindExternalSessionView: async () => null,
    advance() {},
    sessionOwner: () => owner,
    adoptPendingViewers(entry, id) {
      for (const token of pendingViewers.get(id) || []) entry.subscribers.add(token);
      pendingViewers.delete(id);
    },
    retainUnwatched() {},
  });
  return { loads, old, retired, created: () => created };
}

test('simultaneous follow-ups replace one terminal runtime and preserve its viewers', async () => {
  const h = harness();
  const first = h.loads.entryForSession('saved');
  const second = h.loads.entryForSession('saved');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.created(), 0, 'replacement waits for old runtime disposal');
  h.retired.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.notEqual(a, h.old);
  assert.equal(h.created(), 1);
  assert.deepEqual([...a.subscribers], ['pane']);
});

test('a missing or deleted durable record cannot be reopened from its terminal runtime', async () => {
  const h = harness({ exists: false });
  h.retired.resolve();
  await assert.rejects(h.loads.entryForSession('saved'), /not available/);
  assert.equal(h.created(), 0);
});
