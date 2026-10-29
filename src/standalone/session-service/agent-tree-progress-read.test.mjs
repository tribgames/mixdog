import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTree } from './agent-tree.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a synchronous liveness throw is a failed read: the next sweep reads again and refreshes the snapshot', async () => {
  let reads = 0;
  const runtime = {
    isWireSafe: true,
    getTurnLiveness() {
      reads += 1;
      if (reads === 1) {
        const error = new Error('sync failure at /private/path');
        error.code = 'EWIRE';
        throw error;
      }
      return { stage: 'streaming', lastProgressAt: 4242 };
    },
  };
  const { agentManager } = createAgentTree({ sessionOwner: () => ({ runtime }) });

  assert.equal(agentManager.getSessionProgressSnapshot('worker'), null);
  await settle();
  const failed = agentManager.getSessionProgressObservation('worker');
  assert.equal(failed.lastReadError, 'EWIRE');
  assert.equal(failed.readPendingSince, null);

  // Next sweep starts a new read; the one after it sees the refreshed snapshot.
  agentManager.getSessionProgressSnapshot('worker');
  await settle();
  assert.equal(reads, 2);
  assert.equal(agentManager.getSessionProgressSnapshot('worker')?.lastProgressAt, 4242);
  const recovered = agentManager.getSessionProgressObservation('worker');
  assert.equal(recovered.source, 'cache');
  assert.equal(recovered.lastReadError, null);
  assert.ok(recovered.lastReadOkAt > 0);
});
