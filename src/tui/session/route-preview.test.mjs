import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionApiB } from './session-api-ext.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The runtime write behind setRoute awaits provider readiness, model metadata,
// the config save and (on an empty session) a session rebuild. The surface must
// never wait for that chain to show the route the user just chose.
function createRouteHarness(setRoute, extra = {}) {
  let live = { provider: 'openai-oauth', model: 'gpt-5', effort: 'high', fast: true };
  let state = { ...live, commandBusy: false, stats: { inputTokens: 0 }, ...extra };
  const api = createSessionApiB({
    runtime: { setRoute },
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    flushEmitImmediate: () => {},
    routeState: () => ({ ...live }),
    syncContextStats: () => {},
    pushNotice: () => {},
  });
  return {
    api,
    state: () => state,
    publishLiveRoute: (next) => {
      live = { ...next };
    },
  };
}

test('a chosen model reaches the surface before the runtime write settles', async () => {
  const gate = deferred();
  const harness = createRouteHarness(() => gate.promise);

  const pending = harness.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-opus-5' });

  assert.equal(harness.state().provider, 'anthropic-oauth');
  assert.equal(harness.state().model, 'claude-opus-5');
  // A different model carries none of the previous model's tuning.
  assert.equal(harness.state().effort, null);
  assert.equal(harness.state().fast, false);

  harness.publishLiveRoute({
    provider: 'anthropic-oauth',
    model: 'claude-opus-5',
    effort: 'xhigh',
    fast: false,
  });
  gate.resolve({ provider: 'anthropic-oauth', model: 'claude-opus-5' });
  await pending;

  assert.equal(harness.state().effort, 'xhigh');
  assert.equal(harness.state().commandBusy, false);
});

test('same-model tuning previews only what the request carries', async () => {
  const gate = deferred();
  const harness = createRouteHarness(() => gate.promise);

  const pending = harness.api.setRoute({ provider: 'openai-oauth', model: 'gpt-5', effort: 'low' });

  assert.equal(harness.state().effort, 'low');
  assert.equal(harness.state().fast, true, 'an unrelated control keeps its value');

  gate.resolve({ provider: 'openai-oauth', model: 'gpt-5' });
  await pending;
});

test('a failed model change restores the route that was live before it', async () => {
  const gate = deferred();
  const harness = createRouteHarness(() => gate.promise);

  const pending = harness.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-opus-5', effort: 'low' });
  assert.equal(harness.state().model, 'claude-opus-5');

  gate.reject(new Error('provider unavailable'));
  await assert.rejects(pending, /provider unavailable/);

  assert.equal(harness.state().provider, 'openai-oauth');
  assert.equal(harness.state().model, 'gpt-5');
  assert.equal(harness.state().effort, 'high');
  assert.equal(harness.state().fast, true);
  assert.equal(harness.state().commandBusy, false);
});

test('rapid model choices stay immediate while every write is serialized during a turn', async () => {
  const calls = [];
  const secondStarted = deferred();
  const harness = createRouteHarness(
    (next) => {
      const gate = deferred();
      calls.push({ next, gate });
      if (calls.length === 2) secondStarted.resolve();
      return gate.promise;
    },
    { busy: true }
  );
  const firstRoute = { provider: 'openai-oauth', model: 'gpt-first' };
  const lastRoute = { provider: 'anthropic-oauth', model: 'claude-last' };
  const first = harness.api.setRoute(firstRoute);
  const last = harness.api.setRoute(lastRoute);
  assert.equal(harness.state().model, lastRoute.model);
  assert.equal(calls.length, 1, 'persistence must not run concurrently');
  harness.publishLiveRoute(firstRoute);
  calls[0].gate.resolve(firstRoute);
  await first;
  await secondStarted.promise;
  assert.equal(calls.length, 2, 'the later choice is queued, not rejected');
  assert.deepEqual(calls[1].next, lastRoute);
  assert.equal(harness.state().model, lastRoute.model, 'the earlier reply cannot rewind the preview');
  assert.equal(harness.state().commandBusy, true);
  harness.publishLiveRoute(lastRoute);
  calls[1].gate.resolve(lastRoute);
  await last;
  assert.equal(harness.state().model, lastRoute.model);
  assert.equal(harness.state().commandBusy, false);
  assert.equal(harness.state().busy, true, 'model persistence must not end or restart the running turn');
});

test('a model choice does not bypass an unrelated session command', async () => {
  const harness = createRouteHarness(
    () => {
      assert.fail('the runtime must not be called while another command owns the session');
    },
    { commandBusy: true }
  );
  assert.equal(await harness.api.setRoute({ provider: 'openai-oauth', model: 'gpt-blocked' }), false);
  assert.equal(harness.state().model, 'gpt-5');
  assert.equal(harness.state().commandBusy, true);
});

test('a queued route survives an earlier failure and its own failure restores the last applied route', async () => {
  const calls = [];
  const started = [deferred(), deferred(), deferred()];
  const harness = createRouteHarness((next) => {
    const gate = deferred();
    calls.push({ next, gate });
    started[calls.length - 1].resolve();
    return gate.promise;
  });
  const first = harness.api.setRoute({ provider: 'openai-oauth', model: 'gpt-failed' });
  const firstFailure = assert.rejects(first, /first failed/);
  const secondRoute = { provider: 'openai-oauth', model: 'gpt-applied' };
  const second = harness.api.setRoute(secondRoute);
  calls[0].gate.reject(new Error('first failed'));
  await firstFailure;
  await started[1].promise;
  assert.equal(calls.length, 2);
  assert.equal(harness.state().model, secondRoute.model);
  const third = harness.api.setRoute({ provider: 'openai-oauth', model: 'gpt-last-failed' });
  const thirdFailure = assert.rejects(third, /last failed/);
  harness.publishLiveRoute(secondRoute);
  calls[1].gate.resolve(secondRoute);
  await second;
  await started[2].promise;
  assert.equal(calls.length, 3);
  calls[2].gate.reject(new Error('last failed'));
  await thirdFailure;
  assert.equal(harness.state().model, secondRoute.model);
  assert.equal(harness.state().commandBusy, false);
});
