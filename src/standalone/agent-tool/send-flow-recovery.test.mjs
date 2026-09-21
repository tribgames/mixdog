import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendFlow } from './send-flow.mjs';

test('busy canonical sends enqueue a message without starting an admission job', async () => {
  const messages = [];
  const api = createSendFlow({
    mgr: {},
    canUseSessionSurface: () => true,
    sessionSurface: {
      enqueueTurn: async (message) => {
        messages.push(message);
        return { queueDepth: 1 };
      },
    },
    registry: { tagForSession: () => 'worker' },
    views: { isSessionBusy: () => true },
    spawnFlow: { startJob: () => assert.fail('busy send must not acquire an execution slot') },
  });
  const session = { id: 'child', agent: 'worker' };
  const result = await api.dispatchToExistingSession({
    session,
    sessionId: 'child',
    prompt: 'additional instruction',
    args: { context: 'context' },
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { session, prompt: 'additional instruction', context: 'context' });
  assert.match(result, /queued/i);
});

test('a worker that became idle before enqueue uses the normal admitted continuation', async () => {
  let started = 0;
  const api = createSendFlow({
    mgr: {},
    canUseSessionSurface: () => true,
    sessionSurface: { enqueueTurn: async () => null },
    registry: { tagForSession: () => 'worker' },
    views: { isSessionBusy: () => true, renderJob: () => ({ status: 'running' }) },
    spawnFlow: {
      startJob: () => {
        started += 1;
        return {};
      },
    },
  });
  await api.dispatchToExistingSession({
    session: { id: 'child', agent: 'worker' },
    sessionId: 'child',
    prompt: 'continue',
    args: {},
  });
  assert.equal(started, 1);
});
