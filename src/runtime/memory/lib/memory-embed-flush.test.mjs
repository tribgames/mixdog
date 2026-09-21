import assert from 'node:assert/strict';
import test from 'node:test';

import { flushEmbeddingDirty } from './memory-embed.mjs';

// Cancellation must survive the transaction teardown: the batch finally block
// runs COMMIT/ROLLBACK while the abort is already in flight, and a failure
// there used to replace the caller's abort reason with a store fault.
test('a cancelled flush reports the abort even when the rollback also fails', async () => {
  const controller = new AbortController();
  const cancelled = new Error('memory flush cancelled');
  const released = [];
  const client = {
    async query(sql) {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [{ id: '1' }] };
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      // The locked batch work is cut short by the caller's cancellation.
      controller.abort(cancelled);
      throw new Error('batch query failed');
    },
    release(error) {
      released.push(error);
    },
  };
  const db = {
    async query() {
      return { rows: [] };
    },
    _pool: { connect: async () => client },
  };

  await assert.rejects(
    () => flushEmbeddingDirty(db, { signal: controller.signal }),
    (error) => error === cancelled
  );
  assert.equal(released.length, 1, 'the connection is still released exactly once');
  assert.match(String(released[0]?.message), /rollback failed/, 'the poisoned connection is released with its error');
});
