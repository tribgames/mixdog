import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCommandsApi } from './commands.mjs';
import { createSessionRouteApi } from './routes.mjs';
import { createSessionSettingsApi } from './settings.mjs';

const chatRoute = { provider: 'openai-oauth', model: 'gpt-x' };
const pick = { provider: 'anthropic-oauth', model: 'claude-x', applyToCurrentSession: true };
const conversation = () => [
  { kind: 'user', id: 'u1', text: 'hi' },
  { kind: 'assistant', id: 'a1', text: 'hello' },
  { kind: 'turndone', id: 'd1', status: 'done' },
];

/** A session surface over a fake runtime: the route API and the compaction
 *  command share one bag, as in the composed session. */
function harness({ items = conversation(), busy = false, commandBusy = false, onModelChange, compact } = {}) {
  const calls = [];
  const validations = [];
  const statuses = [];
  let state = { sessionId: 's1', ...chatRoute, busy, commandBusy, items, stats: {} };
  let sequence = 0;
  const runtime = {
    sessionProvider: chatRoute.provider,
    sessionModel: chatRoute.model,
    getCompactionSettings: () => (onModelChange === undefined ? { auto: true } : { auto: true, onModelChange }),
    compact: async (options) => {
      calls.push(['compact', runtime.sessionModel, options]);
      return compact ? compact() : { changed: false, skipped: true, reason: 'no_token_reduction' };
    },
    listPresets: () => [{ id: 'opus', name: 'Opus', provider: 'anthropic-oauth', model: 'claude-x' }],
    setRoute: async (next, options) => {
      if (options.validateOnly) {
        validations.push(next);
        if (next.model === 'bogus') throw new Error('Invalid model selector "bogus"');
        return { ...next };
      }
      calls.push(['setRoute', next, options]);
      const preset = runtime.listPresets().find((entry) => entry.id === next.model);
      const target = preset ? { provider: preset.provider, model: preset.model } : next;
      const switched =
        (options.applyToCurrentSession || options.switchEstablished) && target.model !== runtime.sessionModel;
      if (switched) {
        runtime.sessionProvider = target.provider;
        runtime.sessionModel = target.model;
      }
      return switched
        ? { ...target, modelSwitch: { provider: target.provider, modelId: target.model, at: 42 } }
        : { ...target };
    },
  };
  const bag = {
    runtime,
    nextId: () => `id${++sequence}`,
    getState: () => state,
    set(patch) {
      if (Object.hasOwn(patch, 'commandStatus')) statuses.push(patch.commandStatus?.mode ?? null);
      state = { ...state, ...patch };
    },
    flushEmitImmediate() {},
    pushItem(item) {
      state = { ...state, items: [...state.items, item] };
    },
    pushNotice() {},
    routeState: () => ({ provider: runtime.sessionProvider, model: runtime.sessionModel }),
    syncContextStats() {},
    replaceItems: (next) => next,
    resetStats() {},
    resetStatsAndSyncContext() {},
  };
  createSessionCommandsApi(bag);
  const api = { ...createSessionSettingsApi(bag), ...createSessionRouteApi(bag) };
  return { api, calls, validations, statuses, runtime, state: () => state };
}

const rows = (h) => h.state().items.slice(3).map((item) => [item.status || item.label, item.modelId ?? null]);

test('with auto-compact on model change (default), the chat compacts on its current model, then switches', async () => {
  const h = harness({
    compact: () => ({ changed: true, beforeTokens: 9000, afterTokens: 900, beforeMessages: 4, afterMessages: 2 }),
  });
  await h.api.setRoute(pick);
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['compact', 'setRoute']
  );
  assert.equal(h.calls[0][1], 'gpt-x', 'compacted while the chat still runs on its current model');
  assert.equal(h.calls[0][2].requireReduction, true, 'nothing worth compacting is skipped by the compactor');
  assert.deepEqual(h.calls[1][2], { applyToCurrentSession: true, keepMainModel: false, switchEstablished: true });
  assert.deepEqual(h.statuses, ['compacting', null], 'the existing compacting status shows meanwhile');
  // The compaction divider, then the switch divider naming the new model.
  const tail = h.state().items.filter((item) => item.kind === 'statusdone');
  assert.deepEqual(
    tail.map((item) => item.label),
    ['Conversation compacted', 'Model switched']
  );
  assert.equal(tail.at(-1).status, 'model-switched');
  assert.equal(tail.at(-1).modelId, 'claude-x');
  assert.equal(h.state().commandBusy, false);
});

test('an invalid destination is rejected before the conversation is compacted', async () => {
  for (const attempt of [
    (h) => h.api.setRoute({ model: 'bogus' }),
    (h) => h.api.setModel('bogus'),
  ]) {
    const h = harness();
    await assert.rejects(attempt(h), /Invalid model selector/);
    assert.equal(h.validations.length, 1, 'the destination was validated');
    assert.deepEqual(h.calls, [], 'nothing compacted and nothing switched');
    assert.deepEqual(h.statuses, []);
    assert.equal(h.runtime.sessionModel, 'gpt-x');
    assert.equal(h.state().commandBusy, false);
  }
});

test('a compaction with nothing worth compacting adds no row; the switch still lands', async () => {
  const h = harness();
  await h.api.setRoute(pick);
  assert.deepEqual(rows(h), [['model-switched', 'claude-x']]);
});

test('with the setting off the switch does not compact first', async () => {
  const h = harness({ onModelChange: false });
  await h.api.setRoute(pick);
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['setRoute']
  );
  assert.deepEqual(rows(h), [['model-switched', 'claude-x']]);
});

test('a chat stopped on its quota switches without compacting; the next turn auto-compacts on the new model', async () => {
  const h = harness({
    items: [
      ...conversation(),
      { kind: 'user', id: 'u2', text: 'do it' },
      { kind: 'turndone', id: 'd2', status: 'failed', quota: { provider: 'openai-oauth', model: 'gpt-x', resetAt: null } },
    ],
  });
  await h.api.setRoute(pick);
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['setRoute']
  );
  assert.equal(h.runtime.sessionModel, 'claude-x');
});

test('a failed compaction never blocks the switch', async () => {
  const thrown = harness({
    compact: () => {
      throw new Error('summary model unavailable');
    },
  });
  await thrown.api.setRoute(pick);
  assert.equal(thrown.runtime.sessionModel, 'claude-x');
  assert.deepEqual(thrown.statuses, ['compacting', null]);
  assert.deepEqual(rows(thrown), [['model-switched', 'claude-x']]);

  const reported = harness({ compact: () => ({ changed: false, error: 'summary failed' }) });
  await reported.api.setRoute(pick);
  assert.equal(reported.runtime.sessionModel, 'claude-x');
  assert.deepEqual(
    rows(reported).map(([label]) => label),
    ['Compact failed', 'model-switched']
  );
});

test('a running turn keeps its model: the switch is refused with nothing changed', async () => {
  const h = harness({ busy: true });
  await assert.rejects(h.api.setRoute(pick), /cannot change while a response is running/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state().model, 'gpt-x', 'no optimistic preview');
  assert.equal(h.state().commandBusy, false);
  // Effort/Fast of the same model still apply during a turn.
  await h.api.setRoute({ ...chatRoute, effort: 'low', applyToCurrentSession: true });
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['setRoute']
  );
});

test('a same-model selection neither compacts nor switches', async () => {
  for (const request of [
    { ...chatRoute, effort: 'high', applyToCurrentSession: true },
    { ...chatRoute, effort: 'high' },
  ]) {
    const h = harness();
    await h.api.setRoute(request);
    assert.deepEqual(
      h.calls.map(([name]) => name),
      ['setRoute']
    );
    assert.deepEqual(rows(h), []);
  }
});

test('an unaddressed picker selection (TUI) switches the established conversation in place too', async () => {
  const h = harness();
  await h.api.setRoute({ provider: 'anthropic-oauth', model: 'claude-x' });
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['compact', 'setRoute']
  );
  assert.deepEqual(h.calls[1][2], { applyToCurrentSession: false, keepMainModel: false, switchEstablished: true });
  assert.equal(h.runtime.sessionModel, 'claude-x');
  assert.deepEqual(rows(h), [['model-switched', 'claude-x']]);
});

test('/model and preset selections (setModel) take the same in-place path', async () => {
  const h = harness();
  assert.equal(await h.api.setModel('opus'), true);
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['compact', 'setRoute'],
    'pre-compaction on the current model, then the switch'
  );
  assert.equal(h.calls[0][1], 'gpt-x');
  assert.deepEqual(h.calls[1][1], { model: 'opus' }, 'the preset still resolves in the runtime');
  assert.equal(h.calls[1][2].switchEstablished, true);
  assert.equal(h.runtime.sessionModel, 'claude-x');
  assert.deepEqual(rows(h), [['model-switched', 'claude-x']]);

  // A preset naming the chat's own model is no switch.
  assert.equal(await h.api.setModel('Opus'), true);
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['compact', 'setRoute', 'setRoute']
  );

  // A running turn refuses it like any switch.
  const busy = harness({ busy: true });
  await assert.rejects(busy.api.setModel('opus'), /cannot change while a response is running/);
  assert.deepEqual(busy.calls, []);

  // Another command holding the lock answers false.
  const locked = harness({ commandBusy: true });
  assert.equal(await locked.api.setModel('opus'), false);
  assert.deepEqual(locked.calls, []);
});
