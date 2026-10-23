// A turn whose only output is a reaction on the user's message (react tool)
// completes normally: no reply row, no notice, and a turndone row marked
// `reacted` that readers of the final answer take as done with nothing to say.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionFlow } from './session-flow.mjs';
import { createRunTurn } from './turn.mjs';
import { createSessionApi } from './session-api.mjs';
import { createSessionItemMutators } from './transcript-spill.mjs';
import { runReactionTurn } from '../../runtime/agent/orchestrator/session/message-reactions.test-support.mjs';

function boot(sessionId, answer) {
  // Busy until runOne drains: enqueue alone must not start the turn.
  const state = {
    busy: true,
    commandBusy: false,
    queued: [],
    items: [],
    toasts: [],
    promptHistoryList: [],
    stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
  const notices = [];
  let sequence = 0;
  const runtime = {
    id: sessionId,
    session: { id: sessionId, messages: [] },
    toolMode: 'auto',
    async ask(_content, options) {
      const run = await answer(options);
      return { result: { content: run?.result?.content || '' }, session: runtime.session };
    },
    abort: () => false,
  };
  const bag = {
    runtime,
    flags: { leadTurnEpoch: 0 },
    pending: [],
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `${sessionId}-item-${++sequence}`,
    appendItems: (items, extra) => Object.assign(state, { items: [...state.items, ...items] }, extra),
    pushItem: (item) => state.items.push(item),
    pushUserOrSyntheticItem: (text, id, _kind, extra) => state.items.push({ text, id, kind: 'user', ...extra }),
    patchItem: (id, patch) => Object.assign(state.items.find((item) => item.id === id) || {}, patch),
    replaceItems: (items) => items,
    tuiDebug() {},
    pushNotice: (...args) => notices.push(args),
    syncContextStats() {},
    routeState: () => ({}),
    agentStatusState: () => ({}),
    denyAllToolApprovals() {},
    clearActiveToolSummary() {},
    flushDeferredExecutionPendingResumeKick() {},
    flushToolResults() {},
  };
  Object.assign(bag, createSessionFlow(bag));
  bag.runTurn = createRunTurn(bag);
  return { state, notices, bag };
}

async function runOne(sessionId, answer) {
  const f = boot(sessionId, answer);
  assert.equal(await f.bag.enqueue('고마워', { id: `${sessionId}-prompt`, awaitPersistence: true }), true);
  f.state.busy = false;
  await f.bag.drain();
  return f;
}

// The turn's model call is a real agent loop whose react call runs through
// the real tool batch and react handler (message-reactions.test-support.mjs).
const reactingTurn = (args) => (options) =>
  runReactionTurn(args, { onToolCall: options.onToolCall, onToolResult: options.onToolResult });

test('a turn that only reacted ends with a reacted turndone: no reply row, no notice, a counted turn', async () => {
  const f = await runOne('react-only', reactingTurn({ emoji: '👍' }));
  const kinds = f.state.items.map((item) => item.kind);
  assert.deepEqual(kinds, ['user', 'turndone']);
  const done = f.state.items.at(-1);
  assert.equal(done.status, 'done');
  assert.equal(done.reacted, true);
  assert.equal(Object.hasOwn(done, 'finalAssistantId'), false, 'no reply row to point at');
  assert.deepEqual(f.notices, []);
  assert.equal(f.state.stats.turns, 1);
  assert.equal(f.state.busy, false);
});

test('a reaction reaches the live user row by its message id, so the open chat shows it without a reload', () => {
  let state = {
    items: [
      { kind: 'user', id: 'row-1', messageId: 'msg_1', text: '고마워' },
      { kind: 'assistant', id: 'row-2', messageId: 'msg_2', text: 'ok' },
    ],
  };
  const { patchItem } = createSessionItemMutators({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    itemIndexById: new Map(),
  });
  const fixed = { getState: () => state, patchItem, runtime: {}, flags: {}, listeners: new Set(), pending: [] };
  const bag = new Proxy(fixed, { get: (target, key) => (key in target ? target[key] : () => ({})), has: () => true });
  const api = createSessionApi(bag);
  const before = state.items[0];
  const reactions = [{ agentId: 'reviewer', emoji: '🙏', at: 1 }];
  assert.equal(api.setMessageReactions('msg_1', reactions), true);
  assert.notEqual(state.items[0], before, 'a new row object: views re-render it');
  assert.deepEqual(state.items[0].reactions, reactions);
  assert.equal(api.setMessageReactions('msg_2', reactions), false, 'only a user row takes reactions');
  assert.equal(api.setMessageReactions('msg_gone', reactions), false);
  assert.equal(api.setMessageReactions('msg_1', []), true);
  assert.deepEqual(state.items[0].reactions, []);
});

test('a rejected or failed react call is no reaction: the turn is not marked reacted', async () => {
  for (const args of [{ emoji: 'hello' }, { emoji: '👍', messages_back: 5 }]) {
    const f = await runOne(`react-failed-${args.emoji}`, reactingTurn(args));
    const done = f.state.items.at(-1);
    assert.equal(done.kind, 'turndone', JSON.stringify(args));
    assert.equal(Object.hasOwn(done, 'reacted'), false, JSON.stringify(args));
  }
});

test('a react call counts only through its successful result', async () => {
  const call = { id: 'call-1', name: 'react', arguments: { emoji: '👍' } };
  const result = (toolKind) => ({ role: 'tool', toolCallId: 'call-1', toolKind, content: 'r' });
  const landed = await runOne('react-landed', async (options) => {
    await options.onToolCall?.(1, [call]);
    options.onToolResult?.(result('normal'));
  });
  assert.equal(landed.state.items.at(-1).reacted, true);
  const refused = await runOne('react-refused', async (options) => {
    await options.onToolCall?.(1, [call]);
    options.onToolResult?.(result('error'));
  });
  assert.equal(Object.hasOwn(refused.state.items.at(-1), 'reacted'), false);
  const silent = await runOne('silent', async () => {});
  assert.deepEqual(
    silent.state.items.map((item) => item.kind),
    ['user'],
    'a pending-resume style no-op adds no turndone'
  );
});
