import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionApi } from './session-api.mjs';
import { createFrameBatchedStorePublisher } from './frame-batched-store.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(t, onCall = () => {}) {
  const initial = {
    provider: 'openai',
    model: 'gpt-original',
    effort: 'high',
    fast: true,
  };
  let live = { ...initial };
  let draft = {
    ...initial,
    sessionId: 'model-route-publication',
    busy: true,
    commandBusy: false,
    items: [{ id: 'user-1', kind: 'user', text: 'Keep working.' }],
    stats: { inputTokens: 100 },
  };
  let published = draft;
  const listeners = new Set();
  // Hold the display-frame clock. Both the RPC reply and subscribers must
  // receive route changes without a later frame, token, or runtime pulse.
  const publisher = createFrameBatchedStorePublisher({
    getState: () => draft,
    publishState: (snapshot) => {
      published = snapshot;
    },
    listeners,
    scheduleFrame: () => 1,
    cancelFrame: () => {},
  });
  t.after(() => publisher.dispose());
  const set = (patch) => {
    draft = { ...draft, ...patch };
    publisher.emit();
  };
  const calls = [];
  const change = async (next) => {
    const gate = deferred();
    calls.push({ next, gate });
    onCall(calls.length);
    await gate.promise;
    live = { ...live, ...next };
    return live;
  };
  const api = createSessionApi({
    runtime: {
      setRoute: change,
      setEffort: (effort) => change({ effort }),
      get effort() {
        return live.effort;
      },
    },
    getState: () => draft,
    getPublishedState: () => published,
    set,
    listeners,
    flushEmitImmediate: publisher.flushImmediate,
    routeState: () => ({ ...live }),
    syncContextStats: () => {},
  });
  const frames = [];
  api.subscribe(() => frames.push(api.getState()));
  return { api, calls, frames, initial, set, publisher };
}

const selections = [
  {
    name: 'model picker',
    action: 'setRoute',
    value: { provider: 'openai', model: 'gpt-selected', effort: 'low', fast: false },
    expected: { provider: 'openai', model: 'gpt-selected', effort: 'low', fast: false },
  },
  {
    name: 'effort picker',
    action: 'setEffort',
    value: 'low',
    expected: { effort: 'low' },
  },
  {
    name: 'effort disabling Fast',
    action: 'setRoute',
    value: { provider: 'openai', model: 'gpt-original', effort: 'low', fast: false },
    expected: { effort: 'low', fast: false },
  },
  {
    name: 'model command',
    action: 'setModel',
    value: 'gpt-selected',
    expected: { model: 'gpt-selected' },
  },
];

for (const { name, action, value, expected } of selections) {
  for (const outcome of ['success', 'failure']) {
    test(`${name} publishes ${outcome} before its reply during an active turn`, async (t) => {
      const { api, calls, frames, initial, set, publisher } = fixture(t);
      const before = api.getState();
      const operation = api[action](value);
      const failure = outcome === 'failure' ? assert.rejects(operation, /selection failed/) : null;
      // Streaming may publish while the provider is still applying the change.
      set({ stats: { inputTokens: 120 }, spinner: { text: 'Working' } });
      publisher.flush();
      const pending = api.getState();
      assert.equal(pending.commandBusy, true);
      assert.equal(pending.busy, true);
      if (outcome === 'failure') {
        calls[0].gate.reject(new Error('selection failed'));
        await failure;
      } else {
        calls[0].gate.resolve();
        await operation;
      }
      // No display-frame flush or timer advance after the operation settles.
      const reply = api.getState();
      const selected = outcome === 'success' ? { ...initial, ...expected } : initial;
      for (const [key, value] of Object.entries(selected)) {
        assert.equal(reply[key], value, `the reply must carry the settled ${key}`);
      }
      assert.equal(reply.commandBusy, false);
      assert.equal(reply.busy, true, 'a selection must not finish or restart the turn');
      assert.equal(reply.items, before.items, 'the transcript is not replaced');
      assert.equal(reply.stats.inputTokens, 120);
      assert.equal(reply.spinner.text, 'Working');
      assert.equal(frames.at(-1), reply, 'subscribers and the reply see the same state');
      assert.equal(before.model, initial.model);
      assert.equal(before.effort, initial.effort);
      assert.equal(pending.commandBusy, true, 'published snapshots remain immutable');
    });
  }
}

for (const outcome of ['success', 'failure']) {
  test(`latest model preview survives an earlier reply and publishes its ${outcome}`, async (t) => {
    const secondStarted = deferred();
    const { api, calls, initial } = fixture(t, (count) => {
      if (count === 2) secondStarted.resolve();
    });
    const firstRoute = { provider: 'openai', model: 'gpt-first', effort: 'low', fast: false };
    const lastRoute = { provider: 'openai', model: 'gpt-last', effort: 'high', fast: true };
    const first = api.setRoute(firstRoute);
    await Promise.resolve();
    assert.equal(api.getState().model, firstRoute.model, 'the preview reaches subscribers without a display frame');
    const last = api.setRoute(lastRoute);
    const failure = outcome === 'failure' ? assert.rejects(last, /last selection failed/) : null;
    await Promise.resolve();
    assert.equal(api.getState().model, lastRoute.model);
    assert.equal(calls.length, 1, 'runtime writes remain serialized');
    calls[0].gate.resolve();
    await first;
    await secondStarted.promise;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].next, lastRoute);
    assert.equal(api.getState().model, lastRoute.model, 'the earlier RPC reply cannot rewind the newest preview');
    assert.equal(api.getState().commandBusy, true);
    if (outcome === 'failure') {
      calls[1].gate.reject(new Error('last selection failed'));
      await failure;
    } else {
      calls[1].gate.resolve();
      await last;
    }
    const expected = outcome === 'success' ? lastRoute : firstRoute;
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(api.getState()[key], value);
    }
    assert.notEqual(
      api.getState().model,
      initial.model,
      'rollback uses the last applied route, not the route before both requests'
    );
    assert.equal(api.getState().commandBusy, false);
    assert.equal(api.getState().busy, true);
  });
}

test('another effort choice can follow a reply without waiting for a display frame', async (t) => {
  const { api, calls } = fixture(t);
  for (const [index, effort] of ['low', 'high', 'low'].entries()) {
    const operation = api.setEffort(effort);
    assert.equal(calls.length, index + 1);
    calls[index].gate.resolve();
    assert.equal(await operation, effort);
    assert.equal(api.getState().effort, effort);
    assert.equal(api.getState().commandBusy, false);
    assert.equal(api.getState().busy, true);
  }
});
