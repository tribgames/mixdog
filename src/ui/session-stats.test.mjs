import assert from 'node:assert/strict';
import test from 'node:test';

test('the usage delta marks a provider-declared unmeasured prompt', async () => {
  const { usageDeltaEvent } = await import('../runtime/agent/orchestrator/session/loop/usage.mjs');
  const event = (usage) => usageDeltaEvent({ sessionId: 's', iterationIndex: 1, usage });
  assert.equal(event({ inputTokens: 0, outputTokens: 4 }).promptKnown, true);
  assert.equal(event({ inputTokens: null, outputTokens: 4, inputTokensKnown: false }).promptKnown, false);
  assert.equal(event({ inputTokens: 10, cachedTokens: null, cacheTokensKnown: false }).promptKnown, false);
});
