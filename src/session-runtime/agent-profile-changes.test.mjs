import assert from 'node:assert/strict';
import test from 'node:test';
import { publishStoredAgentRoute, subscribeAgentRouteChanges } from './agent-profile-changes.mjs';

test('a stored route a host failed to take is not recorded as published: the retry reaches the host again', async () => {
  const route = { provider: 'openai', model: 'next' };
  const taken = [];
  let failing = true;
  let attempts = 0;
  const { unsubscribe } = subscribeAgentRouteChanges(async (agentId, next) => {
    attempts += 1;
    if (failing) throw new Error('host busy');
    taken.push([agentId, next.model]);
  });
  try {
    // Two runtimes apply the same change at once: one host attempt, both told it failed.
    const results = await Promise.allSettled([
      publishStoredAgentRoute('writer', route),
      publishStoredAgentRoute('writer', route),
    ]);
    assert.deepEqual(
      results.map((one) => one.status),
      ['rejected', 'rejected']
    );
    assert.equal(attempts, 1);
    failing = false;
    await publishStoredAgentRoute('writer', route);
    assert.deepEqual(taken, [['writer', 'next']], 'the retry delivered it');
    await publishStoredAgentRoute('writer', route);
    assert.deepEqual(taken, [['writer', 'next']], 'taken once, it is not delivered again');
  } finally {
    unsubscribe();
  }
});
