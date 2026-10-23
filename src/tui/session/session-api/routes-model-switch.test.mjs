import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRouteApi } from './routes.mjs';
import { createSessionSettingsApi } from './settings.mjs';

function harness({ busy = false, commandBusy = false, delay = 0 } = {}) {
  let selected = { provider: 'openai-oauth', model: 'gpt-x' };
  let state = { ...selected, busy, commandBusy, items: [], stats: {} };
  const calls = [];
  const runtime = {
    sessionProvider: selected.provider,
    sessionModel: selected.model,
    listPresets: () => [{ id: 'opus', name: 'Opus', provider: 'anthropic-oauth', model: 'claude-x' }],
    compact: () => assert.fail('selection must not compact'),
    setRoute: async (next, options) => {
      if (next.model === 'bogus') throw new Error('Invalid model selector "bogus"');
      calls.push({ next, options });
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const preset = runtime.listPresets().find((entry) => entry.id === next.model);
      selected = { ...selected, ...(preset ? { provider: preset.provider, model: preset.model } : next) };
      return selected;
    },
  };
  const bag = {
    runtime,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    flushEmitImmediate() {},
    routeState: () => selected,
    syncContextStats() {},
    resetStats() {},
    resetStatsAndSyncContext() {},
    pushItem: () => assert.fail('selection must not publish a switch divider'),
  };
  const api = { ...createSessionSettingsApi(bag), ...createSessionRouteApi(bag) };
  return {
    api,
    calls,
    runtime,
    state: () => state,
    // Another command (not a route write) takes or drops the lock.
    setCommandBusy: (value) => {
      state = { ...state, commandBusy: value };
    },
  };
}

test('picker saves a deferred selection without compacting or switching the conversation', async () => {
  const h = harness();
  await h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x', applyToCurrentSession: true });
  assert.equal(h.state().model, 'claude-x');
  assert.equal(h.runtime.sessionModel, 'gpt-x');
  assert.deepEqual(h.calls[0].options, {
    applyToCurrentSession: true,
    keepMainModel: true,
    switchEstablished: true,
    deferUntilNextTurn: true,
  });
  assert.equal(h.state().commandBusy, false);
});

test('a session-only selection is forwarded as an option, never as part of the route', async () => {
  const h = harness();
  await h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x', sessionOnly: true });
  assert.equal(h.calls[0].options.sessionOnly, true);
  assert.equal(Object.hasOwn(h.calls[0].next, 'sessionOnly'), false);
  await h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x' });
  assert.equal(Object.hasOwn(h.calls[1].options, 'sessionOnly'), false);
});

test('a session-only effort keeps its option on the way to the runtime', async () => {
  const h = harness();
  const seen = [];
  h.runtime.setEffort = async (value, options) => seen.push([value, options]);
  await h.api.setEffort('max', { sessionOnly: true });
  await h.api.setEffort('low');
  assert.deepEqual(seen, [
    ['max', { sessionOnly: true }],
    ['low', undefined],
  ]);
});

test('repeated selections retain the latest choice, including returning to the original', async () => {
  const h = harness();
  await Promise.all([
    h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x' }),
    h.api.setRoute({ provider: 'openai-oauth', model: 'gpt-x' }),
  ]);
  assert.equal(h.state().model, 'gpt-x');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(({ options }) => options.deferUntilNextTurn));
});

test('/model presets use the same deferred path', async () => {
  const h = harness();
  assert.equal(await h.api.setModel('opus'), true);
  assert.equal(h.state().model, 'claude-x');
  assert.equal(h.runtime.sessionModel, 'gpt-x');
  assert.equal(h.calls[0].options.deferUntilNextTurn, true);
});

test('invalid destinations roll the preview back without changing the conversation', async () => {
  for (const invoke of [(api) => api.setRoute({ model: 'bogus' }), (api) => api.setModel('bogus')]) {
    const h = harness();
    await assert.rejects(invoke(h.api), /Invalid model selector/);
    assert.equal(h.state().model, 'gpt-x');
    assert.equal(h.state().commandBusy, false);
    assert.deepEqual(h.calls, []);
  }
});

test('running responses save model switches for the next turn', async () => {
  const h = harness({ busy: true });
  await h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x' });
  assert.equal(h.state().model, 'claude-x');
  assert.equal(h.runtime.sessionModel, 'gpt-x');
  assert.equal(h.calls[0].options.deferUntilNextTurn, true);
});

test('a selection is saved for the next turn while another command holds the lock, and never releases it', async () => {
  const h = harness({ busy: true, commandBusy: true, delay: 5 });
  const saved = h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x' });
  const preset = h.api.setModel('opus');
  assert.equal(h.state().commandBusy, true);
  assert.notEqual(await saved, false);
  assert.equal(await preset, true);
  assert.equal(h.calls.length, 2, 'both selections are written, in order');
  assert.ok(h.calls.every(({ options }) => options.deferUntilNextTurn));
  assert.equal(h.state().commandBusy, true, 'the other command still owns its lock');
  assert.equal(h.runtime.sessionModel, 'gpt-x', 'the running turn keeps its model');
  // The other command finishing, then a selection that raises the lock itself.
  h.setCommandBusy(false);
  await h.api.setRoute({ provider: 'openai-oauth', model: 'gpt-x' });
  assert.equal(h.state().commandBusy, false);
});

test('a selection that overlaps a command ending mid-write still releases only its own lock', async () => {
  const h = harness({ commandBusy: true, delay: 5 });
  const first = h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x' });
  h.setCommandBusy(false);
  const second = h.api.setRoute({ provider: 'openai-oauth', model: 'gpt-x' });
  assert.equal(h.state().commandBusy, true, 'the later selection holds the lock while it writes');
  await Promise.all([first, second]);
  assert.equal(h.state().commandBusy, false);
  assert.equal(h.state().model, 'gpt-x');
});

test('session-only tuning is completed against the latest selected route inside the serialized write', async () => {
  const h = harness({ delay: 5 });
  // Sequential: Fast-only after an effort change keeps that effort.
  await h.api.setRoute({ effort: 'low', sessionOnly: true });
  await h.api.setRoute({ fast: true, sessionOnly: true });
  assert.deepEqual(h.calls[1].next, {
    provider: 'openai-oauth',
    model: 'gpt-x',
    effort: 'low',
    fast: true,
    autoEffort: true,
  });
  // Concurrent: the second write is built after the first settles, not from
  // the route both saw when they were requested.
  const c = harness({ delay: 5 });
  await Promise.all([
    c.api.setRoute({ effort: 'high', sessionOnly: true }),
    c.api.setRoute({ fast: true, sessionOnly: true }),
    c.api.setRoute({ autoEffort: false, sessionOnly: true }),
  ]);
  assert.deepEqual(c.calls.at(-1).next, {
    provider: 'openai-oauth',
    model: 'gpt-x',
    effort: 'high',
    fast: true,
    autoEffort: false,
  });
});

test('an unchanged session-only request still publishes the route a failed earlier preview left behind', async () => {
  const h = harness({ delay: 5 });
  const failed = h.api.setRoute({ provider: 'openai-oauth', model: 'bogus' });
  const rejected = assert.rejects(failed, /Invalid model selector/);
  const unchanged = h.api.setRoute({ fast: false, sessionOnly: true });
  assert.equal(h.state().model, 'bogus', 'the failing selection is previewed');
  await rejected;
  await unchanged;
  assert.equal(h.state().model, 'gpt-x');
  assert.equal(h.state().commandBusy, false);
});

test('a session-only request that asks for nothing new writes nothing', async () => {
  const h = harness();
  await h.api.setRoute({ provider: 'openai-oauth', model: 'gpt-x', sessionOnly: true });
  await h.api.setRoute({ fast: false, autoEffort: true, sessionOnly: true });
  assert.deepEqual(h.calls, []);
  assert.equal(h.state().commandBusy, false);
});

test('a session-only model change carries only the tuning it names', async () => {
  const h = harness();
  await h.api.setRoute({ effort: 'low', sessionOnly: true });
  await h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x', fast: true, sessionOnly: true });
  assert.deepEqual(h.calls[1].next, { provider: 'anthropic-oauth', model: 'claude-x', fast: true });
});
