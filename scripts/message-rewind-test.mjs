#!/usr/bin/env node
// Regression: the Esc-Esc message selector (Claude Code's "jump back to a
// previous message"). Selecting a prompt must drop it — and everything after
// it — from BOTH the transcript and the model history, hand the text back for
// editing, and never run while a turn is live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/session/session-flow.mjs';
import { createSessionApiA } from '../src/tui/session/session-api.mjs';
import { selectableUserItems, messageSelectorLabel } from '../src/tui/app/message-selector.mjs';

function makeEngine({ rewindResult = { removed: 4, remaining: 2 } } = {}) {
  let seq = 0;
  const rewindCalls = [];
  let state = {
    items: [
      { kind: 'user', id: 'u1', text: 'first prompt' },
      { kind: 'assistant', id: 'a1', text: 'first answer' },
      { kind: 'user', id: 'u2', text: 'second prompt' },
      { kind: 'tool', id: 't1', name: 'read' },
      { kind: 'assistant', id: 'a2', text: 'second answer' },
    ],
    queued: [],
    busy: false,
    commandBusy: false,
    spinner: null,
    thinking: null,
    lastTurn: null,
    stats: {},
    promptHistoryList: ['second prompt', 'first prompt'],
  };
  const bag = {
    runtime: {
      id: null,
      consumePendingSessionReset: () => null,
      abort: () => true,
      rewindMessages: async (options) => {
        rewindCalls.push(options);
        return rewindResult;
      },
    },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: { leadTurnEpoch: 1, disposed: false, draining: false, activePromptRestore: null },
    pending: [],
    listeners: new Set(),
    getState: () => state,
    set: (patch) => {
      if (!patch || typeof patch !== 'object') return false;
      state = { ...state, ...patch };
      return true;
    },
    pushItem: () => {},
    patchItem: () => {},
    replaceItems: (items) => items,
    pushNotice: () => {},
    pushUserOrSyntheticItem: () => {},
    autoClearState: () => ({ enabled: false }),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    updateAgentJobCard: () => {},
    requeueEntriesFront: () => {},
    resetStatsAndSyncContext: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    discardExecutionPendingResume: () => {},
    drain: async () => {},
    runTurn: async () => 'ok',
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.drain = async () => {};
  const api = createSessionApiA(bag);
  return { api, bag, getState: () => state, getRewindCalls: () => rewindCalls };
}

test('rewindToItem truncates the transcript at the chosen prompt and returns its text', async () => {
  const engine = makeEngine();
  const restored = await engine.api.rewindToItem('u2');
  assert.equal(restored.text, 'second prompt');
  assert.equal(restored.removed, 3);
  assert.deepEqual(engine.getRewindCalls(), [{ text: 'second prompt' }]);
  assert.deepEqual(engine.getState().items.map((item) => item.id), ['u1', 'a1']);
  // The prompt lives in the draft now, so it must leave Up-arrow history.
  assert.deepEqual(engine.getState().promptHistoryList, ['first prompt']);
  assert.equal(engine.getState().commandBusy, false);
});

test('rewindToItem refuses a live turn, unknown ids, and non-user rows', async () => {
  const busy = makeEngine();
  busy.bag.set({ busy: true });
  assert.equal(await busy.api.rewindToItem('u2'), null);
  assert.deepEqual(busy.getRewindCalls(), []);
  assert.equal(busy.getState().items.length, 5);

  const idle = makeEngine();
  assert.equal(await idle.api.rewindToItem('a1'), null);
  assert.equal(await idle.api.rewindToItem('nope'), null);
  assert.equal(await idle.api.rewindToItem(''), null);
  assert.deepEqual(idle.getRewindCalls(), []);
  assert.equal(idle.getState().items.length, 5);
});

test('a runtime that cannot rewind leaves the transcript untouched', async () => {
  const engine = makeEngine({ rewindResult: null });
  assert.equal(await engine.api.rewindToItem('u2'), null);
  assert.equal(engine.getState().items.length, 5);
  assert.equal(engine.getState().commandBusy, false);
});

test('the selector lists rewindable prompts oldest-first with one-line labels', () => {
  const items = [
    { kind: 'user', id: 'u1', text: 'first prompt' },
    { kind: 'assistant', id: 'a1', text: 'reply' },
    { kind: 'user', id: 'u2', text: '   ' },
    { kind: 'user', id: 'u3', text: 'second prompt\nmore detail' },
  ];
  assert.deepEqual(selectableUserItems(items), [
    { id: 'u1', text: 'first prompt' },
    { id: 'u3', text: 'second prompt\nmore detail' },
  ]);
  assert.deepEqual(selectableUserItems(items, 1), [{ id: 'u3', text: 'second prompt\nmore detail' }]);
  assert.deepEqual(selectableUserItems(null), []);
  assert.equal(messageSelectorLabel('second prompt\nmore detail'), 'second prompt');
  assert.equal(messageSelectorLabel('x'.repeat(80), 10), `${'x'.repeat(9)}…`);
});
