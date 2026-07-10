// Production-path regression: runtime completion notification -> feed enqueue
// -> session drain -> real runTurn -> Esc. This deliberately uses the real
// feed, queue, API, and turn implementations rather than fabricating restore
// state, so ownership survives the same path used by the TUI.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentJobFeed } from '../src/tui/engine/agent-job-feed.mjs';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';
import { createRunTurn } from '../src/tui/engine/turn.mjs';
import { createEngineApiA } from '../src/tui/engine/session-api.mjs';
import { _clearDeliveredCompletions } from '../src/runtime/agent/orchestrator/session/manager/delivered-completions.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function completion(executionId, body) {
  return {
    content: `Async agent task ${executionId} completed finished.\n\nResult:\n> ${body}`,
    meta: { type: 'agent_task_result', execution_id: executionId, status: 'completed' },
  };
}

function makeHarness() {
  let seq = 0;
  let notify = null;
  let activeAsk = null;
  let feed = null;
  const asks = [];
  const pending = [];
  const itemIndexById = new Map();
  const state = {
    items: [],
    queued: [],
    busy: false,
    commandBusy: false,
    spinner: null,
    thinking: null,
    lastTurn: null,
    stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
  const runtime = {
    id: null,
    toolMode: 'auto',
    onNotification: (fn) => { notify = fn; return () => {}; },
    consumePendingSessionReset: () => null,
    ask: async (text, options) => new Promise((resolve, reject) => {
      activeAsk = { text, options, reject };
      asks.push(activeAsk);
    }),
    abort: () => {
      const error = new Error('interrupted');
      error.name = 'SessionClosedError';
      activeAsk?.reject(error);
      return true;
    },
  };
  const bag = {
    runtime,
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    LEAD_TURN_TIMEOUT_MS: 300_000,
    flags: { leadTurnEpoch: 0, drainEpoch: 0, disposed: false, draining: false, activePromptRestore: null },
    pending,
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    listeners: new Set(),
    itemIndexById,
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    pushItem: (item) => {
      state.items = [...state.items, item];
      if (item?.id != null) itemIndexById.set(item.id, state.items.length - 1);
    },
    patchItem: (id, patch) => {
      const index = state.items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      state.items = state.items.map((item, i) => i === index ? { ...item, ...patch } : item);
      return true;
    },
    replaceItems: (items) => items,
    pushNotice: () => {},
    pushUserOrSyntheticItem: (text, id) => {
      state.items = [...state.items, { kind: 'injected', id, text }];
    },
    autoClearState: () => ({ enabled: false }),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    requestToolApproval: async () => ({ approved: false }),
    markToolCallActive: () => {},
    markToolCallDone: () => {},
    clearActiveToolSummary: () => {},
    patchToolCardResult: () => {},
    flushToolResults: () => {},
    // session-flow captures this dependency before the feed is constructed;
    // keep that production ordering while forwarding to the live feed.
    flushDeferredExecutionPendingResumeKick: () => feed?.flushDeferredExecutionPendingResumeKick(),
  };

  Object.assign(bag, createSessionFlow(bag));
  feed = createAgentJobFeed({
    runtime,
    getState: bag.getState,
    set: bag.set,
    nextId: bag.nextId,
    getDisposed: () => bag.flags.disposed,
    patchItem: bag.patchItem,
    enqueue: (...args) => bag.enqueue(...args),
    drain: (...args) => bag.drain(...args),
    pushUserOrSyntheticItem: bag.pushUserOrSyntheticItem,
    makeQueueEntry: (...args) => bag.makeQueueEntry(...args),
    getPending: () => pending,
    agentStatusState: bag.agentStatusState,
    displayedExecutionNotificationKeys: bag.displayedExecutionNotificationKeys,
    pushNotice: bag.pushNotice,
  });
  Object.assign(bag, feed);
  bag.runTurn = createRunTurn(bag);
  const api = createEngineApiA(bag);
  feed.subscribeRuntimeNotifications();

  return {
    api,
    state,
    asks,
    deliver: (event) => notify(event),
    activeAsk: () => activeAsk,
  };
}

for (const phase of ['before first delta', 'after response progress']) {
  test(`runtime completion Esc ${phase} does not restart it, while a new completion wakes`, async () => {
    _clearDeliveredCompletions();
    const harness = makeHarness();

    const first = completion('execution_A', 'first result');
    harness.deliver(first);
    await tick();
    assert.equal(harness.asks.length, 1, 'runtime notification drained into a real turn');
    assert.match(harness.activeAsk().text, /first result/, 'completion body reached runtime.ask');
    assert.equal(first.modelVisibleDelivered, true, 'notification was acknowledged on the TUI path');

    if (phase === 'after response progress') {
      harness.activeAsk().options.onTextDelta('partial response\n');
      await wait(40);
      assert.equal(
        harness.state.items.some((item) => item.kind === 'assistant' && /partial response/.test(item.text)),
        true,
        'response progress reached the live turn',
      );
    }

    assert.equal(harness.api.abort().aborted, true, 'Esc aborts the active runTurn');
    await tick();
    assert.equal(harness.state.busy, false, 'busy clears after the real abort unwind');
    assert.equal(harness.state.spinner, null, 'spinner clears after Esc');
    assert.equal(harness.state.thinking, null, 'thinking clears after Esc');

    harness.deliver(completion('execution_A', 'duplicate retry'));
    await tick();
    assert.equal(harness.asks.length, 1, 'duplicate execution delivery cannot restart the aborted completion');

    harness.deliver(completion('execution_B', 'later result'));
    await tick();
    assert.equal(harness.asks.length, 2, 'a genuinely new execution still wakes a turn');
    assert.match(harness.activeAsk().text, /later result/);

    // Finish the second intentionally-open mocked provider request.
    harness.api.abort();
    await tick();
  });
}
