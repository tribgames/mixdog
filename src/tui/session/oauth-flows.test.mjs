import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionOAuthFlowRegistry } from './oauth-flows.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('OAuth flow records null completion and rejection as terminal failures', async () => {
  const registry = createSessionOAuthFlowRegistry();
  const empty = deferred();
  const first = registry.register({ provider: 'openai-oauth', waitForCallback: empty.promise });
  empty.resolve(null);
  await settle();
  assert.deepEqual(
    { state: registry.status(first.flowId).state, error: registry.status(first.flowId).error },
    { state: 'failed', error: 'OAuth login did not complete.' },
  );

  const rejected = deferred();
  const second = registry.register({ provider: 'grok-oauth', waitForCallback: rejected.promise });
  rejected.reject(new Error('token exchange rejected'));
  await settle();
  assert.deepEqual(
    { state: registry.status(second.flowId).state, error: registry.status(second.flowId).error },
    { state: 'failed', error: 'token exchange rejected' },
  );
  registry.cancelAll();
});

test('OAuth flow cancellation remains queryable and duplicate provider login supersedes only the active flow', async () => {
  const registry = createSessionOAuthFlowRegistry();
  let cancelled = 0;
  const firstWait = deferred();
  const first = registry.register({
    provider: 'anthropic-oauth',
    waitForCallback: firstWait.promise,
    cancel: () => { cancelled += 1; firstWait.resolve(null); },
  });
  const secondWait = deferred();
  const second = registry.register({
    provider: 'anthropic-oauth',
    waitForCallback: secondWait.promise,
    cancel: () => { cancelled += 1; secondWait.resolve(null); },
  });
  await settle();
  assert.equal(registry.status(first.flowId).state, 'cancelled');
  assert.equal(registry.status(second.flowId).state, 'pending');
  assert.equal(cancelled, 1);

  await registry.cancel(second.flowId);
  await settle();
  assert.equal(registry.status(second.flowId).state, 'cancelled');
  assert.equal(cancelled, 2);
  registry.cancelAll();
});

test('OAuth flow expiry remains queryable and cancels provider work', async () => {
  const registry = createSessionOAuthFlowRegistry({ ttlMs: 5 });
  let cancelled = false;
  const waiting = deferred();
  const flow = registry.register({
    provider: 'cursor-oauth',
    waitForCallback: waiting.promise,
    cancel: () => { cancelled = true; waiting.resolve(null); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = registry.status(flow.flowId);
  assert.equal(status.state, 'expired');
  assert.equal(status.error, 'OAuth login expired.');
  assert.equal(cancelled, true);
  registry.cancelAll();
});

test('manual OAuth completion is single-use and preserves its terminal result', async () => {
  const registry = createSessionOAuthFlowRegistry();
  const waiting = deferred();
  const flow = registry.register({
    provider: 'anthropic-oauth',
    waitForCallback: waiting.promise,
    completeCode: async (code) => {
      assert.equal(code, 'authorization-code');
      waiting.resolve({ access_token: 'saved' });
      return { access_token: 'saved' };
    },
  });
  const completed = await registry.complete(flow.flowId, 'authorization-code');
  assert.equal(completed.state, 'complete');
  await assert.rejects(
    registry.complete(flow.flowId, 'authorization-code'),
    /no longer pending/,
  );
  assert.equal(registry.status(flow.flowId).state, 'complete');
  registry.cancelAll();
});

test('manual OAuth completion cannot run twice or lose to its callback settling empty', async () => {
  const registry = createSessionOAuthFlowRegistry();
  const callback = deferred();
  const exchange = deferred();
  let exchanges = 0;
  const flow = registry.register({
    provider: 'anthropic-oauth',
    waitForCallback: callback.promise,
    completeCode: async () => {
      exchanges += 1;
      return exchange.promise;
    },
  });

  const first = registry.complete(flow.flowId, 'authorization-code');
  await assert.rejects(
    registry.complete(flow.flowId, 'authorization-code'),
    /already being completed/,
  );
  callback.resolve(null);
  await settle();
  assert.equal(registry.status(flow.flowId).state, 'pending');
  exchange.resolve(true);
  assert.equal((await first).state, 'complete');
  assert.equal(exchanges, 1);
  registry.cancelAll();
});
