import test from 'node:test';
import assert from 'node:assert/strict';

import { createEngineItemMutators, replaceEngineItemsState } from '../src/tui/engine.mjs';
import { createEngineApiA } from '../src/tui/engine/session-api.mjs';
import { createRunTurn } from '../src/tui/engine/turn.mjs';
import { buildTranscriptRowIndexIncremental } from '../src/tui/app/transcript-window.mjs';
import {
  isCompletedTranscriptTail,
  isCompletedTranscriptTailAppendedThisCommit,
  isLiveSpinnerMetaVisible,
} from '../src/tui/app/live-spinner-visibility.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTurnHarness(ask, stateOverrides = {}, bagOverrides = {}) {
  let seq = 0;
  let state = {
    items: [],
    structureRevision: 0,
    streamingTail: null,
    stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
    busy: false,
    spinner: null,
    thinking: null,
    ...stateOverrides,
  };
  const itemIndexById = new Map();
  const set = (patch) => { state = { ...state, ...patch }; return true; };
  const pushItem = (item) => {
    const items = [...state.items, item];
    if (item?.id != null) itemIndexById.set(item.id, items.length - 1);
    set({ items, structureRevision: state.structureRevision + 1 });
  };
  const updateStreamingTail = (id, patch) => set({
    streamingTail: {
      ...(state.streamingTail?.id === id ? state.streamingTail : {}),
      ...patch,
      kind: 'assistant',
      id,
      streaming: true,
    },
  });
  const { patchItem, settleStreamingTail } = createEngineItemMutators({
    getState: () => state,
    set,
    itemIndexById,
  });
  const clearStreamingTail = (id = null) => {
    if (id == null || state.streamingTail?.id === id) set({ streamingTail: null });
  };
  const replaceItems = (items, options = {}) => {
    state = replaceEngineItemsState({
      state,
      items,
      itemIndexById,
      preserveStreamingTail: options.preserveStreamingTail === true,
    });
    return items;
  };
  const bag = {
    runtime: { id: null, toolMode: 'auto', ask, abort: () => true },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    LEAD_TURN_TIMEOUT_MS: 300_000,
    flags: { leadTurnEpoch: 0, disposed: false },
    pending: [],
    itemIndexById,
    getState: () => state,
    set,
    pushItem,
    patchItem,
    replaceItems,
    updateStreamingTail,
    settleStreamingTail,
    clearStreamingTail,
    pushNotice: () => {},
    pushUserOrSyntheticItem: () => {},
    markToolCallActive: () => {},
    markToolCallDone: () => {},
    clearActiveToolSummary: () => {},
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    requestToolApproval: async () => ({ approved: false }),
    patchToolCardResult: () => {},
    flushToolResults: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    drain: async () => {},
    drainPendingSteering: () => [],
    ...bagOverrides,
  };
  return { runTurn: createRunTurn(bag), getState: () => state };
}

test('successful mid-turn compact trims history but preserves live turn references', async () => {
  let preservedTail = false;
  let compactKeepsSpinnerVisible = false;
  let contextSyncs = 0;
  const harness = makeTurnHarness(async (_text, options) => {
    options.onTextDelta('before compact\n');
    await wait(30);
    options.onCompactEvent({ status: 'compacted', trigger: 'reactive' });
    assert.equal(contextSyncs, 1, 'compact event must refresh context before returning');
    preservedTail = harness.getState().streamingTail?.text === 'before compact\n';
    compactKeepsSpinnerVisible = harness.getState().spinner?.active === true
      && harness.getState().items.at(-1)?.kind === 'statusdone';
    options.onCompactEvent({ status: 'compacted', trigger: 'reactive' });
    assert.equal(contextSyncs, 2, 'each compact event refreshes context immediately');
    options.onTextDelta('after compact\n');
    return { result: { content: 'before compact\nafter compact\n' }, session: { messages: [] } };
  }, {
    items: [
      { id: 'old', kind: 'assistant', text: 'old history' },
      { id: 'current-user', kind: 'user', text: 'go' },
    ],
  }, {
    syncContextStats: () => { contextSyncs += 1; },
  });

  assert.equal(await harness.runTurn('go', { submittedIds: ['current-user'] }), 'done');
  assert.equal(preservedTail, true);
  assert.equal(compactKeepsSpinnerVisible, true, 'a compact status leaves the active turn spinner in place');
  assert.equal(harness.getState().items.some((item) => item.id === 'old'), false);
  assert.equal(harness.getState().items.some((item) => item.id === 'current-user'), true);
  assert.equal(
    harness.getState().items.filter((item) => item.label === 'Compact complete (overflow recovery)').length,
    2,
  );
  assert.equal(
    harness.getState().items.find((item) => item.kind === 'assistant')?.text,
    'before compact\nafter compact\n',
  );
});

test('live spinner remains visible across compact status and follows turn teardown', () => {
  const activeTurnSpinner = { active: true };
  const visible = (liveSpinner, liveSpinnerIsCommand, kind) => isLiveSpinnerMetaVisible({
    inputBoxHidden: false,
    slashPaletteOpen: false,
    liveSpinner,
    liveSpinnerIsCommand,
    latestTranscriptItem: kind ? { kind } : null,
  });

  assert.equal(visible(activeTurnSpinner, false, 'statusdone'), true);
  assert.equal(visible(activeTurnSpinner, false, 'turndone'), false);
  assert.equal(visible(null, false, 'turndone'), false);
  assert.equal(visible({ active: true }, true, 'turndone'), true);
});

test('completed transcript tail masking requires a new done tail', () => {
  assert.equal(isCompletedTranscriptTail({ id: 'turn', kind: 'turndone' }), true);
  assert.equal(isCompletedTranscriptTail({ id: 'status', kind: 'statusdone' }), true);
  assert.equal(isCompletedTranscriptTail({ id: 'assistant', kind: 'assistant' }), false);
  assert.equal(isCompletedTranscriptTail({ id: 'user', kind: 'user' }), false);
  assert.equal(isCompletedTranscriptTail(null), false);
  assert.equal(isCompletedTranscriptTailAppendedThisCommit({ id: 'turn', kind: 'turndone' }, 'turn'), false);
  assert.equal(isCompletedTranscriptTailAppendedThisCommit({ id: 'status', kind: 'statusdone' }, 'status'), false);
  assert.equal(isCompletedTranscriptTailAppendedThisCommit({ id: 'next', kind: 'turndone' }, 'previous'), true);
  assert.equal(isCompletedTranscriptTailAppendedThisCommit({ id: 'next-status', kind: 'statusdone' }, 'previous'), true);
  assert.equal(isCompletedTranscriptTailAppendedThisCommit({ id: 'assistant', kind: 'assistant' }, 'previous'), false);
});

test('failed mid-turn compact leaves prior transcript items untouched', async () => {
  const harness = makeTurnHarness(async (_text, options) => {
    options.onCompactEvent({ status: 'failed' });
    return { result: { content: '' }, session: { messages: [] } };
  }, {
    items: [{ id: 'old', kind: 'assistant', text: 'old history' }],
  });

  assert.equal(await harness.runTurn('go'), 'done');
  assert.equal(harness.getState().items.some((item) => item.id === 'old'), true);
  assert.equal(harness.getState().items.some((item) => item.label === 'Compact failed'), true);
});

test('stream flush keeps settled items identity and finalize appends one assistant', async () => {
  let identityStable = false;
  const harness = makeTurnHarness(async (_text, options) => {
    const before = harness.getState().items;
    options.onTextDelta('settled line\n');
    await wait(30);
    identityStable = harness.getState().items === before;
    assert.match(harness.getState().streamingTail?.text || '', /settled line/);
    return { result: { content: 'settled line\n' }, session: { messages: [] } };
  });

  assert.equal(await harness.runTurn('go'), 'done');
  assert.equal(identityStable, true, 'tail flush must not swap settled items');
  assert.equal(harness.getState().streamingTail, null);
  const assistants = harness.getState().items.filter((item) => item.kind === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].streaming, false);
  assert.equal(assistants[0].text, 'settled line\n');
});

test('abort after stream progress settles the tail and leaves no orphan', async () => {
  const harness = makeTurnHarness(async (_text, options) => {
    options.onTextDelta('partial line\n');
    await wait(30);
    const error = new Error('interrupted');
    error.name = 'SessionClosedError';
    throw error;
  });

  assert.equal(await harness.runTurn('go'), 'cancelled');
  assert.equal(harness.getState().streamingTail, null);
  const assistants = harness.getState().items.filter((item) => item.kind === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].streaming, false);
  assert.match(assistants[0].text, /partial line/);
});

// Codifies pre-existing parity: text had no item/currentAssistantId before its first completed line.
test('abort before a newline has no tail id and preserves prior text-drop parity', async () => {
  const harness = makeTurnHarness(async (_text, options) => {
    options.onTextDelta('partial without newline');
    await wait(30);
    const error = new Error('interrupted');
    error.name = 'SessionClosedError';
    throw error;
  });

  assert.equal(await harness.runTurn('go'), 'cancelled');
  assert.equal(harness.getState().streamingTail, null);
  assert.equal(
    harness.getState().items.filter((item) => item.kind === 'assistant').length,
    0,
    'without a visible tail id, pre-newline text keeps the existing drop-on-abort behavior',
  );
});

// Codifies pre-existing parity: the old in-items completed-line snapshot survived starved recovery.
test('starved Esc recovery settles a non-empty tail exactly once', async () => {
  let state = {
    items: [],
    structureRevision: 0,
    streamingTail: { id: 'tail_abort', kind: 'assistant', text: 'visible partial\n', streaming: true },
    queued: [],
    busy: true,
    commandBusy: false,
    spinner: { active: true },
    thinking: null,
    lastTurn: null,
  };
  const itemIndexById = new Map();
  const set = (patch) => { state = { ...state, ...patch }; return true; };
  const { patchItem, settleStreamingTail } = createEngineItemMutators({
    getState: () => state,
    set,
    itemIndexById,
  });
  const bag = {
    runtime: { abort: () => true },
    nextId: () => 'notice',
    flags: { leadTurnEpoch: 1, disposed: false, draining: false, manualAbortRecoveryMs: 10 },
    pending: [],
    listeners: new Set(),
    getState: () => state,
    set,
    pushItem: () => {},
    patchItem,
    replaceItems: (items) => items,
    settleStreamingTail,
    clearStreamingTail: () => set({ streamingTail: null }),
    pushNotice: () => {},
    autoClearState: () => ({}),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    denyAllToolApprovals: () => {},
    updateAgentJobCard: () => {},
    requeueEntriesFront: () => {},
    enqueue: () => {},
    autoClearBeforeSubmit: async () => {},
    restoreQueued: () => {},
    resetStatsAndSyncContext: () => {},
    drain: async () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    discardExecutionPendingResume: () => {},
  };

  createEngineApiA(bag).abort();
  await wait(30);
  assert.equal(state.streamingTail, null);
  const assistants = state.items.filter((item) => item.kind === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].id, 'tail_abort');
  assert.equal(assistants[0].streaming, false);
});

test('removeNotice-style replacement preserves the live tail and later settles once', () => {
  let state = {
    items: [{ id: 'notice', kind: 'notice', text: 'temporary' }],
    structureRevision: 4,
    streamingTail: { id: 'tail_notice', kind: 'assistant', text: 'visible\n', streaming: true },
  };
  const itemIndexById = new Map([['notice', 0]]);
  const set = (patch) => { state = { ...state, ...patch }; return true; };
  const { settleStreamingTail } = createEngineItemMutators({
    getState: () => state,
    set,
    itemIndexById,
  });
  state = replaceEngineItemsState({
    state,
    items: state.items.filter((item) => item.id !== 'notice'),
    itemIndexById,
    preserveStreamingTail: true,
  });

  assert.equal(state.streamingTail?.id, 'tail_notice');
  assert.equal(settleStreamingTail('tail_notice', { text: 'complete final text' }), true);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, 'complete final text');
  assert.equal(state.items[0].streaming, false);
  assert.equal(settleStreamingTail('tail_notice', { text: 'duplicate' }), false);
  assert.equal(state.items.length, 1);
});

test('bulk replacement clears the tail and stale settle cannot append into reset transcript', () => {
  let state = {
    items: [{ id: 'old', kind: 'user', text: 'old prompt' }],
    structureRevision: 8,
    streamingTail: { id: 'stale_tail', kind: 'assistant', text: 'old response\n', streaming: true },
  };
  const itemIndexById = new Map([['old', 0]]);
  const set = (patch) => { state = { ...state, ...patch }; return true; };
  const { settleStreamingTail } = createEngineItemMutators({
    getState: () => state,
    set,
    itemIndexById,
  });
  state = replaceEngineItemsState({ state, items: [], itemIndexById });

  assert.equal(state.streamingTail, null);
  assert.equal(settleStreamingTail('stale_tail', { text: 'must not reappear' }), false);
  assert.deepEqual(state.items, []);
});

test('tool-card revision invalidates the incremental prefix cache', () => {
  const cacheRef = { current: null };
  const tail = { id: 'tail', kind: 'assistant', text: 'live\n', streaming: true };
  let state = {
    items: [{ id: 'tool', kind: 'tool', name: 'shell', text: 'ok', result: 'ok' }],
    structureRevision: 1,
    streamingTail: tail,
  };
  const itemIndexById = new Map([['tool', 0]]);
  const set = (patch) => { state = { ...state, ...patch }; return true; };
  const { patchItem } = createEngineItemMutators({
    getState: () => state,
    set,
    itemIndexById,
  });
  const before = buildTranscriptRowIndexIncremental([...state.items, state.streamingTail], {
    columns: 24,
    cacheRef,
    prefixRevision: state.structureRevision,
  });
  const cachedBeforePatch = cacheRef.current;
  assert.equal(patchItem('tool', {
    text: 'a much longer tool result '.repeat(20),
    result: 'a much longer tool result '.repeat(20),
  }), true);
  assert.equal(state.structureRevision, 2, 'real engine patchItem bumps revision');
  const after = buildTranscriptRowIndexIncremental([...state.items, state.streamingTail], {
    columns: 24,
    cacheRef,
    prefixRevision: state.structureRevision,
  });

  assert.notEqual(cacheRef.current, cachedBeforePatch, 'revision bump rebuilds the prefix cache');
  assert.equal(after.rows.length, before.rows.length);
  assert.equal(cacheRef.current.prefixRevision, 2);
});
