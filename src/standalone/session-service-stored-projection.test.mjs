import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionService } from './session-service.mjs';

function storedService(storedSessions) {
  return createSessionService({
    createSessionRuntime: async () => { throw new Error('cold views never materialize'); },
    sessionExists: async (sessionId) => storedSessions.has(sessionId),
    readStoredSession: async (sessionId) => storedSessions.get(sessionId) || null,
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
}

test('a cold read with the held projection stamp answers without a body', async () => {
  const id = 'sess_cold_stamp';
  const stored = new Map([[id, {
    sessionId: id,
    projectionStamp: '1:abc:7',
    items: [{ id: 'row', kind: 'assistant', text: 'Persisted transcript' }],
    queued: [],
  }]]);
  const service = storedService(stored);
  try {
    const full = await service.readSession({ sessionId: id });
    assert.equal(full.projection, true);
    assert.equal(full.projectionStamp, '1:abc:7');
    assert.equal(full.full.items.length, 1);

    const unchanged = await service.readSession({
      sessionId: id, baseRevision: full.revision, baseProjectionStamp: '1:abc:7',
    });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.projectionStamp, '1:abc:7');
    assert.equal(unchanged.revision, full.revision);
    assert.equal('full' in unchanged, false);

    stored.set(id, { ...stored.get(id), projectionStamp: '1:abc:8' });
    const moved = await service.readSession({
      sessionId: id, baseRevision: full.revision, baseProjectionStamp: '1:abc:7',
    });
    assert.equal(moved.unchanged, undefined);
    assert.equal(moved.projectionStamp, '1:abc:8');
    assert.equal(moved.full.items.length, 1);
    assert.ok(moved.revision > full.revision);

    // A message slice is a different question; the stamp never short-circuits it.
    const sliced = await service.readSession({
      sessionId: id, baseRevision: moved.revision, baseProjectionStamp: '1:abc:8', messageStart: 0,
    });
    assert.equal(sliced.unchanged, undefined);
    assert.ok(sliced.full);

    const unbased = await service.readSession({
      sessionId: id, baseProjectionStamp: '1:abc:8',
    });
    assert.ok(unbased.full, 'a content stamp without a wire baseline safely receives a full body');
  } finally {
    await service.stop('test complete');
  }
});
