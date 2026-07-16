import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import {
  TRANSCRIPT_LIVE_ITEM_CAP,
  createEngineItemMutators,
  createTranscriptSpillBuffer,
  refillTranscriptViewOverlap,
  replaceEngineItemsState,
} from '../src/tui/engine.mjs';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';
import { createEngineApiA } from '../src/tui/engine/session-api.mjs';
import { createRunTurn } from '../src/tui/engine/turn.mjs';
import {
  buildTranscriptRowIndexIncremental,
  transcriptItemsWithStableTail,
  transcriptStructureSignature,
} from '../src/tui/app/transcript-window.mjs';
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

test('abort before a newline settles the accumulated partial response', async () => {
  const harness = makeTurnHarness(async (_text, options) => {
    options.onTextDelta('partial without newline');
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
  assert.equal(assistants[0].text, 'partial without newline');
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

test('Esc reclaim preserves spill pages while removing the submitted live item', () => {
  const spill = createTranscriptSpillBuffer();
  const original = Array.from({ length: TRANSCRIPT_LIVE_ITEM_CAP + 20 }, (_, index) => ({
    id: index === TRANSCRIPT_LIVE_ITEM_CAP + 19 ? 'submitted-live' : `esc-${index}`,
    kind: 'user',
    text: `${index}`,
  }));
  let state = {
    items: spill.capLive(original),
    busy: true,
    queued: [],
    streamingTail: null,
    spinner: { active: true },
  };
  let preserveSpill = false;
  const set = (patch) => { state = { ...state, ...patch }; return true; };
  const bag = {
    runtime: { abort: () => true },
    flags: {
      leadTurnEpoch: 1,
      disposed: false,
      activePromptRestore: {
        restorable: true,
        text: 'restore me',
        submittedIds: ['submitted-live'],
        discardExecutionPendingResumeKeys: [],
        requeueEntries: [],
      },
    },
    pending: [],
    listeners: new Set(),
    getState: () => state,
    set,
    replaceItems: (items, options = {}) => {
      preserveSpill = options.preserveSpill === true;
      if (!preserveSpill) spill.reset();
      state = { ...state, items };
      return items;
    },
    denyAllToolApprovals: () => {},
    discardExecutionPendingResume: () => {},
    requeueEntriesFront: () => {},
    clearStreamingTail: () => true,
    settleStreamingTail: () => true,
  };

  createEngineApiA(bag).abort();
  state = { ...state, busy: false };
  assert.equal(preserveSpill, true);
  assert.equal(state.items.some((item) => item.id === 'submitted-live'), false);
  const older = spill.restoreOlder(state.items);
  assert.ok(older.some((item) => item.id === 'esc-0'), 'older spill history remains reachable');
  spill.dispose();
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

test('signature and streaming row-index fast paths retain O(1) prefix storage', () => {
  const items = Array.from({ length: 200 }, (_, index) => ({
    id: `fixed-${index}`, kind: 'notice', text: `row ${index}`,
  }));
  let tail = { id: 'tail-fast', kind: 'assistant', text: 'one', streaming: true };
  const cacheRef = { current: null };
  const firstIndex = buildTranscriptRowIndexIncremental([...items, tail], {
    cacheRef, prefixRevision: 9,
  });
  const firstTotal = firstIndex.totalRows;
  const prefixRowsArr = cacheRef.current.prefixRowsArr;
  const prefixPrefixRows = cacheRef.current.prefixPrefixRows;
  const beforeSig = transcriptStructureSignature([...items, tail], 80, false, 9);
  tail = { ...tail, text: 'one two three' };
  const secondIndex = buildTranscriptRowIndexIncremental([...items, tail], {
    cacheRef, prefixRevision: 9,
  });
  assert.equal(cacheRef.current.prefixRowsArr, prefixRowsArr);
  assert.equal(cacheRef.current.prefixPrefixRows, prefixPrefixRows);
  assert.equal(firstIndex.totalRows, firstTotal);
  assert.notEqual(firstIndex.prefixRows, secondIndex.prefixRows);
  assert.equal(
    transcriptStructureSignature([...items, tail], 80, false, 10)
      .startsWith('10|'),
    true,
  );
  assert.equal(beforeSig.startsWith('9|'), true);
});

test('tail height changes reuse the settled transcript container', () => {
  const settled = Array.from({ length: 200 }, (_, index) => ({
    id: `settled-${index}`, kind: 'notice', text: `${index}`,
  }));
  const cacheRef = { current: null };
  const before = transcriptItemsWithStableTail(
    settled,
    { id: 'stable-tail', kind: 'assistant', streaming: true, text: 'short' },
    cacheRef,
  );
  const after = transcriptItemsWithStableTail(
    settled,
    { id: 'stable-tail', kind: 'assistant', streaming: true, text: 'much longer text '.repeat(20) },
    cacheRef,
  );
  assert.equal(after, before, 'tail growth must not spread/copy the settled prefix');
});

test('transcript spill caps the live window and restores every item in order', () => {
  const spill = createTranscriptSpillBuffer();
  const original = Array.from({ length: TRANSCRIPT_LIVE_ITEM_CAP + 300 }, (_, index) => ({
    id: `history-${index}`, kind: 'notice', text: `history ${index}`,
  }));
  let live = spill.capLive(original);
  const canonicalLive = live;
  const seen = new Set(live.map((item) => item.id));
  assert.ok(live.length <= TRANSCRIPT_LIVE_ITEM_CAP);
  assert.equal(spill.hasOlder, true);
  while (spill.hasOlder) {
    live = spill.restoreOlder(live);
    for (const item of live) seen.add(item.id);
    for (let index = 1; index < live.length; index++) {
      assert.ok(Number(live[index - 1].id.slice(8)) < Number(live[index].id.slice(8)));
    }
  }
  assert.equal(seen.size, original.length);
  while (spill.hasNewer) {
    const restored = spill.restoreNewer(canonicalLive);
    live = restored?.atLive ? canonicalLive : restored;
  }
  assert.equal(live, canonicalLive, 'paging must return to the authoritative live array');
  assert.deepEqual(live, original.slice(-live.length));
  assert.ok(live.length <= TRANSCRIPT_LIVE_ITEM_CAP);
  spill.reset();
});

test('spill restore succeeds before its asynchronous worker write completes', () => {
  const spill = createTranscriptSpillBuffer({ cap: 2, chunkSize: 1 });
  const live = spill.capLive([
    { id: 'async-old', kind: 'notice', text: 'old' },
    { id: 'async-mid', kind: 'notice', text: 'mid' },
    { id: 'async-new', kind: 'notice', text: 'new' },
  ]);
  const restored = spill.restoreOlder(live);
  assert.equal(restored[0].id, 'async-old');
  assert.deepEqual(restored.map((item) => item.id), ['async-old', 'async-mid', 'async-new']);
  spill.dispose();
});

test('failed reset restores retained spill pages transactionally', () => {
  const spill = createTranscriptSpillBuffer({ cap: 2, chunkSize: 1 });
  const oldLive = spill.capLive([
    { id: 'rollback-old', kind: 'notice', text: 'old' },
    { id: 'rollback-mid', kind: 'notice', text: 'mid' },
    { id: 'rollback-new', kind: 'notice', text: 'new' },
  ]);
  const snapshot = spill.snapshot();
  spill.reset();
  spill.capLive([
    { id: 'replacement-old', kind: 'notice', text: 'replacement' },
    { id: 'replacement-new', kind: 'notice', text: 'replacement' },
  ]);
  assert.equal(spill.restoreSnapshot(snapshot), true);
  assert.equal(spill.restoreOlder(oldLive)[0].id, 'rollback-old');
  spill.dispose();
});

test('burst spill reuses one worker and serializes all page writes', async () => {
  const workers = [];
  const workerFactory = () => {
    const worker = new EventEmitter();
    worker.unref = () => {};
    worker.terminate = () => {};
    worker.postMessage = ({ id }) => {
      queueMicrotask(() => worker.emit('message', { id, ok: true }));
    };
    workers.push(worker);
    return worker;
  };
  const spill = createTranscriptSpillBuffer({ cap: 2, chunkSize: 1, workerFactory });
  spill.capLive(Array.from({ length: 22 }, (_, index) => ({
    id: `burst-${index}`, kind: 'notice', text: `${index}`,
  })));
  await wait(10);
  assert.equal(workers.length, 1);
  assert.equal(spill.workerCount, 1);
  assert.equal(spill.pendingWriteCount, 0);
  spill.dispose();
});

test('terminal spill write failure pins history and warns once', async () => {
  let warnings = 0;
  const workerFactory = () => {
    const worker = new EventEmitter();
    worker.unref = () => {};
    worker.terminate = () => {};
    worker.postMessage = ({ id }) => {
      queueMicrotask(() => worker.emit('message', { id, ok: false, error: 'disk full' }));
    };
    return worker;
  };
  const spill = createTranscriptSpillBuffer({
    cap: 2,
    chunkSize: 1,
    workerFactory,
    onWarning: () => { warnings += 1; },
  });
  const live = spill.capLive([
    { id: 'pinned-old', kind: 'notice', text: 'old' },
    { id: 'pinned-mid', kind: 'notice', text: 'mid' },
    { id: 'pinned-new', kind: 'notice', text: 'new' },
  ]);
  await wait(10);
  assert.equal(spill.pinnedPageCount, 1);
  assert.equal(warnings, 1);
  assert.equal(spill.restoreOlder(live)[0].id, 'pinned-old');
  const afterFailure = [
    { id: 'disabled-a' },
    { id: 'disabled-b' },
    { id: 'disabled-c' },
    { id: 'disabled-d' },
  ];
  assert.equal(spill.disabled, true);
  assert.equal(spill.capLive(afterFailure), afterFailure);
  assert.equal(spill.workerCount, 1, 'disabled spilling must not create more work');
  spill.dispose();
});

test('spill worker exit retries in-flight history on one replacement worker', async () => {
  let spawn = 0;
  const workerFactory = () => {
    const worker = new EventEmitter();
    const thisSpawn = ++spawn;
    worker.unref = () => {};
    worker.terminate = () => {};
    worker.postMessage = ({ id, targetPath, tempPath, items }) => {
      queueMicrotask(() => {
        if (thisSpawn === 1) worker.emit('exit', 1);
        else {
          writeFileSync(tempPath, JSON.stringify(items), 'utf8');
          renameSync(tempPath, targetPath);
          worker.emit('message', { id, ok: true });
        }
      });
    };
    return worker;
  };
  const spill = createTranscriptSpillBuffer({
    cap: 2,
    chunkSize: 1,
    workerFactory,
    writeTimeoutMs: 100,
  });
  const live = spill.capLive([
    { id: 'exit-old', kind: 'notice', text: 'old' },
    { id: 'exit-mid', kind: 'notice', text: 'mid' },
    { id: 'exit-new', kind: 'notice', text: 'new' },
  ]);
  await wait(10);
  assert.equal(spill.workerCount, 2);
  assert.equal(spill.pendingWriteCount, 0);
  assert.equal(spill.pinnedPageCount, 0);
  assert.equal(spill.restoreOlder(live)[0].id, 'exit-old');
  spill.dispose();
});

test('spill attempt exposes history only after atomic rename commit', async () => {
  let firstTarget = '';
  let firstTemp = '';
  let spawn = 0;
  const workerFactory = () => {
    const worker = new EventEmitter();
    const thisSpawn = ++spawn;
    worker.unref = () => {};
    worker.terminate = () => {};
    worker.postMessage = ({ id, targetPath, tempPath, items }) => {
      if (thisSpawn === 1) {
        firstTarget = targetPath;
        firstTemp = tempPath;
        writeFileSync(tempPath, '{"partial":', 'utf8');
        return; // force timeout; the partial attempt never reaches targetPath
      }
      queueMicrotask(() => {
        writeFileSync(tempPath, JSON.stringify(items), 'utf8');
        renameSync(tempPath, targetPath);
        worker.emit('message', { id, ok: true });
      });
    };
    return worker;
  };
  const spill = createTranscriptSpillBuffer({
    cap: 2,
    chunkSize: 1,
    workerFactory,
    writeTimeoutMs: 5,
  });
  const live = spill.capLive([
    { id: 'atomic-old', kind: 'notice', text: 'old' },
    { id: 'atomic-mid', kind: 'notice', text: 'mid' },
    { id: 'atomic-new', kind: 'notice', text: 'new' },
  ]);
  const beforeCommit = spill.restoreOlder(live);
  assert.equal(beforeCommit[0].id, 'atomic-old', 'pending memory serves restore');
  assert.equal(existsSync(firstTemp), true);
  assert.equal(existsSync(firstTarget), false, 'partial attempt is never the committed page');
  await wait(20);
  assert.equal(JSON.parse(readFileSync(firstTarget, 'utf8'))[0].id, 'atomic-old');
  spill.dispose();
});

test('reclaim refills the nearest historical overlap from updated live items', () => {
  const historical = Array.from({ length: 3 }, (_, index) => ({ id: `old-${index}` }));
  const previousLive = Array.from({ length: 70 }, (_, index) => ({ id: `live-${index}` }));
  const view = [...historical, ...previousLive.slice(0, 64)];
  const nextLive = previousLive.filter((item) => item.id !== 'live-0');
  const refilled = refillTranscriptViewOverlap(view, previousLive, nextLive);
  assert.deepEqual(refilled.slice(0, 3), historical);
  assert.deepEqual(refilled.slice(3), nextLive.slice(0, 64));
  assert.equal(refilled.length, 67);
});

test('failed reset restores the historical transcript view', () => {
  let state = {
    items: [{ id: 'live' }],
    transcriptViewItems: [{ id: 'history' }, { id: 'live' }],
    transcriptViewRevision: 7,
    toasts: [],
    queued: [],
    thinking: null,
    spinner: null,
    lastTurn: null,
    busy: false,
    stats: {},
    sessionId: 'session',
  };
  const set = (patch) => { state = { ...state, ...patch }; };
  const flow = createSessionFlow({
    runtime: { id: 'session' },
    flags: {},
    pending: [],
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    getState: () => state,
    set,
    replaceItems: (items) => items,
    snapshotTranscriptSpill: () => ({ token: 1 }),
    restoreTranscriptSpill: () => true,
    syncContextStats: () => {},
    routeState: () => ({}),
    agentStatusState: () => ({}),
  });
  const snapshot = flow.snapshotTuiBeforeSessionReset();
  state = { ...state, transcriptViewItems: null, transcriptViewRevision: 8 };
  flow.restoreTuiAfterFailedSessionReset(snapshot);
  assert.deepEqual(state.transcriptViewItems, [{ id: 'history' }, { id: 'live' }]);
  assert.equal(state.transcriptViewRevision, 7);
});
