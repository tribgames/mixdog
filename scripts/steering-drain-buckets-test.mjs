import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFlow } from '../src/tui/engine/session-flow.mjs';
import { createRunTurn } from '../src/tui/engine/turn.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal bag: drainPendingSteering only touches pending, the queue helpers,
// and commitSteeringQueueEntries (which no-ops on disk when runtime.id is not
// a valid session key). No provider/runTurn wiring needed.
function makeFlow() {
  let seq = 0;
  let runTurns = 0;
  const state = { queued: [], busy: false };
  const bag = {
    runtime: { id: null },
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    flags: {},
    pending: [],
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    pushItem: () => {},
    replaceItems: () => {},
    pushNotice: () => {},
    pushUserOrSyntheticItem: () => {},
    autoClearState: () => ({ enabled: false }),
    agentStatusState: {},
    routeState: {},
    syncContextStats: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    runTurn: async () => {
      runTurns += 1;
      return 'done';
    },
  };
  return { flow: createSessionFlow(bag), bag, getRunTurns: () => runTurns };
}

test('drainPendingSteering drains prompt/next mid-turn but leaves later notifications', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('steer the turn', { mode: 'prompt' }));
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering();

  assert.equal(out.length, 1, 'next-priority prompt is injected into the active continuation');
  assert.equal(out[0], 'steer the turn');
  assert.equal(bag.pending.length, 1, 'later task notification waits for post-turn or explicit later flush');
  assert.equal(bag.pending[0].content, 'task finished');
});

test('drainPendingSteering can explicitly flush later notifications', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering({ maxPriority: 'later' });

  assert.equal(out.length, 1);
  assert.equal(out[0], 'task finished');
  assert.equal(bag.pending.length, 0);
});

test('drainPendingSteering accepts runtime callback signature', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('task finished', { mode: 'task-notification', key: 'task-1' }));

  const out = flow.drainPendingSteering('session-id', { maxPriority: 'later' });

  assert.deepEqual(out, ['task finished']);
  assert.equal(bag.pending.length, 0);
});

test('drained notification key is released while displayed key is not cleared', () => {
  const { flow, bag } = makeFlow();
  bag.getState().busy = true;
  assert.equal(flow.enqueue('task finished', { mode: 'task-notification', key: 'task-1' }), true);
  bag.displayedExecutionNotificationKeys.add('task-1');

  const out = flow.drainPendingSteering({ maxPriority: 'later' });

  assert.deepEqual(out, ['task finished']);
  assert.equal(flow.enqueue('task duplicate', { mode: 'task-notification', key: 'task-1' }), true);
  assert.equal(bag.displayedExecutionNotificationKeys.has('task-1'), true);
});

test('drainPendingSteering leaves slash commands pending', () => {
  const { flow, bag } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('/clear', { mode: 'prompt' }));
  bag.pending.push(flow.makeQueueEntry('steer text', { mode: 'prompt' }));

  const out = flow.drainPendingSteering();

  assert.equal(out.length, 1, 'non-slash prompt drains');
  assert.equal(out[0], 'steer text');
  assert.equal(bag.pending.length, 1, 'slash command stays queued for post-turn processing');
  assert.equal(bag.pending[0].content, '/clear');
});

test('enqueue while busy does not start a parallel Lead turn', async () => {
  const { flow, bag, getRunTurns } = makeFlow();
  bag.getState().busy = true;

  assert.equal(flow.enqueue('scheduled message', { mode: 'task-notification' }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRunTurns(), 0, 'busy enqueue must wait for active turn boundary');
  assert.equal(bag.pending.length, 1, 'message remains pending for post-turn drain');
});

test('post-turn drain does not send queued slash command to model', async () => {
  const { flow, bag, getRunTurns } = makeFlow();
  bag.pending.push(flow.makeQueueEntry('/clear', { mode: 'prompt' }));

  await flow.drain();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRunTurns(), 0, 'slash command must not be runTurn model text');
  assert.equal(bag.pending.length, 1, 'slash command remains for command dispatcher');
  assert.equal(bag.pending[0].content, '/clear');
});

// Minimal store bag for createRunTurn: only the surface the streaming/steering
// finalize path touches. runtime.ask is a caller-supplied mock that drives the
// text-delta / steer-message callbacks.
function makeTurnBag(ask, {
  timeoutMs = 300000,
  getTurnLiveness,
  abort,
} = {}) {
  let seq = 0;
  const state = {
    items: [],
    stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
    busy: false,
    spinner: null,
    thinking: null,
  };
  const itemIndexById = new Map();
  const findIndexById = (id) => state.items.findIndex((it) => it.id === id);
  const runtime = { id: null, toolMode: 'auto', ask, abort: abort || (() => {}) };
  if (typeof getTurnLiveness === 'function') runtime.getTurnLiveness = getTurnLiveness;
  const bag = {
    runtime,
    nextId: () => `id_${++seq}`,
    tuiDebug: () => {},
    LEAD_TURN_TIMEOUT_MS: timeoutMs,
    flags: { leadTurnEpoch: 0 },
    pending: [],
    itemIndexById,
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    pushItem: (spec) => {
      state.items = [...state.items, spec];
      if (spec?.id != null) itemIndexById.set(spec.id, state.items.length - 1);
    },
    patchItem: (id, patch) => {
      const idx = findIndexById(id);
      if (idx < 0) return;
      const items = state.items.slice();
      items[idx] = { ...items[idx], ...patch };
      state.items = items;
    },
    pushNotice: () => {},
    pushUserOrSyntheticItem: (text) => {
      state.items = [...state.items, { kind: 'user', id: `u_${++seq}`, text }];
    },
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
  };
  return { bag, getState: () => state };
}

test('watchdog accepts fresh runtime liveness without tripping', async () => {
  let aborts = 0;
  const ask = async () => {
    await wait(45);
    return { result: { content: '' }, session: { messages: [] } };
  };
  const { bag } = makeTurnBag(ask, {
    timeoutMs: 15,
    abort: () => { aborts += 1; },
    getTurnLiveness: () => ({
      stage: 'tool_running',
      lastProgressAt: Date.now(),
      toolStartedAt: Date.now(),
      toolSelfDeadlineMs: 0,
    }),
  });

  assert.equal(await createRunTurn(bag)('do a thing'), 'done');
  assert.equal(aborts, 0, 'fresh orchestrator heartbeats defer the watchdog');
});

test('watchdog trips at the tool ceiling despite fresh liveness', async () => {
  const previousMax = process.env.MIXDOG_LEAD_TOOL_MAX_MS;
  const timeoutMs = 30;
  const ceilingMs = 95;
  process.env.MIXDOG_LEAD_TOOL_MAX_MS = String(ceilingMs);
  let rejectAsk;
  let heartbeatTimer = null;
  let heartbeatStartTimer = null;
  let aborts = 0;
  let abortAt = 0;
  let livenessCalls = 0;
  const toolStartedAt = Date.now();
  const ask = (_userText, options) => new Promise((_resolve, reject) => {
    rejectAsk = reject;
    // Let the first watchdog probe defer from orchestrator liveness, then keep
    // the TUI's local progress fresh so the ceiling-bounded re-arm is exercised.
    heartbeatStartTimer = setTimeout(() => {
      heartbeatTimer = setInterval(() => options.onStreamDelta(), 5);
    }, 40);
  });
  const { bag } = makeTurnBag(ask, {
    timeoutMs,
    abort: () => {
      aborts += 1;
      abortAt = Date.now();
      clearTimeout(heartbeatStartTimer);
      clearInterval(heartbeatTimer);
      const error = new Error('interrupted');
      error.name = 'SessionClosedError';
      rejectAsk(error);
    },
    getTurnLiveness: () => {
      livenessCalls += 1;
      return {
        stage: 'tool_running',
        lastProgressAt: Date.now(),
        toolStartedAt,
        toolSelfDeadlineMs: 0,
      };
    },
  });

  try {
    const result = await Promise.race([
      createRunTurn(bag)('do a thing'),
      wait(180).then(() => 'watchdog did not trip at the ceiling'),
    ]);
    assert.equal(result, 'cancelled');
    assert.equal(aborts, 1);
    assert.ok(livenessCalls >= 2, 'first probe deferred, then the ceiling probe rechecked liveness');
    assert.ok(abortAt - toolStartedAt < ceilingMs + timeoutMs, 'ceiling trips before an unbounded watchdog interval');
  } finally {
    clearTimeout(heartbeatStartTimer);
    clearInterval(heartbeatTimer);
    if (previousMax === undefined) delete process.env.MIXDOG_LEAD_TOOL_MAX_MS;
    else process.env.MIXDOG_LEAD_TOOL_MAX_MS = previousMax;
  }
});

for (const [name, getTurnLiveness] of [
  ['throws', () => { throw new Error('liveness unavailable'); }],
  ['returns null', () => null],
]) {
  test(`watchdog ${name} probe falls back to abort`, async () => {
    let rejectAsk;
    let aborts = 0;
    const ask = () => new Promise((_resolve, reject) => { rejectAsk = reject; });
    const { bag } = makeTurnBag(ask, {
      timeoutMs: 15,
      getTurnLiveness,
      abort: () => {
        aborts += 1;
        const error = new Error('interrupted');
        error.name = 'SessionClosedError';
        rejectAsk(error);
      },
    });

    const [result] = await Promise.all([createRunTurn(bag)('do a thing'), wait(40)]);
    assert.equal(result, 'cancelled');
    assert.equal(aborts, 1);
  });
}

test('stream-delta progress keeps the watchdog alive', async () => {
  let aborts = 0;
  let streamDeltas = 0;
  const ask = async (_userText, options) => {
    options.onStreamDelta();
    streamDeltas += 1;
    await wait(12);
    options.onStreamDelta();
    streamDeltas += 1;
    await wait(12);
    return { result: { content: '' }, session: { messages: [] } };
  };
  const { bag } = makeTurnBag(ask, {
    timeoutMs: 20,
    abort: () => { aborts += 1; },
  });

  assert.equal(await createRunTurn(bag)('do a thing'), 'done');
  assert.equal(streamDeltas, 2);
  assert.equal(aborts, 0);
});

test('onSteerMessage commits a streamed no-newline assistant tail into items', async () => {
  // A terminal no-tool response streams a single line WITHOUT a trailing '\n',
  // so no assistant row/currentAssistantId exists yet. A steering injection
  // races finalization and must seal the pending tail instead of dropping it.
  const TAIL = 'partial answer with no trailing newline';
  const ask = async (_userText, opts) => {
    opts.onTextDelta(TAIL);
    opts.onSteerMessage('steer now');
    return { result: { content: '' }, session: { messages: [] } };
  };
  const { bag, getState } = makeTurnBag(ask);
  const runTurn = createRunTurn(bag);

  await runTurn('do a thing');

  const assistant = getState().items.find((it) => it.kind === 'assistant');
  assert.ok(assistant, 'streamed no-newline tail must be committed as an assistant item');
  assert.equal(assistant.text, TAIL);
  assert.equal(assistant.streaming, false);
});

test('finalization does not duplicate a steer-committed tail when result.content repeats it', async () => {
  // Same steer race, but the provider's final content equals the already-
  // committed tail. Finalization must NOT re-emit it as a second item.
  const TAIL = 'partial answer with no trailing newline';
  const ask = async (_userText, opts) => {
    opts.onTextDelta(TAIL);
    opts.onSteerMessage('steer now');
    return { result: { content: TAIL }, session: { messages: [] } };
  };
  const { bag, getState } = makeTurnBag(ask);
  const runTurn = createRunTurn(bag);

  await runTurn('do a thing');

  const assistants = getState().items.filter((it) => it.kind === 'assistant');
  assert.equal(assistants.length, 1, 'the committed tail must not be duplicated at finalize');
  assert.equal(assistants[0].text, TAIL);
  assert.equal(assistants[0].streaming, false);
});

test('finalization appends only the uncommitted remainder past a steer-committed tail', async () => {
  // Provider content extends past the committed tail: only the new remainder
  // becomes a fresh item, ordered after the committed segment (+ steering row).
  const TAIL = 'partial answer with no trailing newline';
  const REMAINDER = '\nmore text arriving after the steer';
  const ask = async (_userText, opts) => {
    opts.onTextDelta(TAIL);
    opts.onSteerMessage('steer now');
    return { result: { content: TAIL + REMAINDER }, session: { messages: [] } };
  };
  const { bag, getState } = makeTurnBag(ask);
  const runTurn = createRunTurn(bag);

  await runTurn('do a thing');

  const assistants = getState().items.filter((it) => it.kind === 'assistant');
  assert.equal(assistants.length, 2, 'committed tail + remainder are two distinct items');
  assert.equal(assistants[0].text, TAIL, 'committed tail stays first, unchanged');
  assert.equal(assistants[1].text, REMAINDER, 'only the uncommitted remainder is appended');
  assert.equal(assistants[1].streaming, false);
  const steerIdx = getState().items.findIndex((it) => it.kind === 'user' && it.text === 'steer now');
  const remainderIdx = getState().items.findIndex((it) => it.kind === 'assistant' && it.text === REMAINDER);
  assert.ok(steerIdx >= 0 && remainderIdx > steerIdx, 'remainder appends after the injected steering row');
});

// Two committed segments this turn: a prior preamble P, then a no-newline TAIL
// sealed by the steer race. The provider's final content may OMIT P — the
// per-segment strip must still peel BOTH out (a single concatenated 'P+TAIL'
// prefix would fail to match and duplicate TAIL after the steering row).
const P = 'preamble sealed before the tail';
const TAIL2 = 'terminal tail with no trailing newline';
function makeTwoSegmentAsk(finalContent) {
  return async (_userText, opts) => {
    opts.onTextDelta(P);
    opts.onSteerMessage('steer one'); // seals P as its own item
    opts.onTextDelta(TAIL2);
    opts.onSteerMessage('steer two'); // seals TAIL2 as its own item
    return { result: { content: finalContent }, session: { messages: [] } };
  };
}

test('per-segment strip: final content = TAIL only (P omitted) → no new item', async () => {
  const { bag, getState } = makeTurnBag(makeTwoSegmentAsk(TAIL2));
  await createRunTurn(bag)('do a thing');
  const assistants = getState().items.filter((it) => it.kind === 'assistant');
  assert.deepEqual(assistants.map((it) => it.text), [P, TAIL2], 'only the two committed segments exist');
});

test('per-segment strip: final content = P + newline + TAIL → no new item', async () => {
  const { bag, getState } = makeTurnBag(makeTwoSegmentAsk(`${P}\n${TAIL2}`));
  await createRunTurn(bag)('do a thing');
  const assistants = getState().items.filter((it) => it.kind === 'assistant');
  assert.deepEqual(assistants.map((it) => it.text), [P, TAIL2], 'both segments stripped; nothing re-emitted');
});

test('per-segment strip: final content extends past both committed segments → only remainder', async () => {
  const { bag, getState } = makeTurnBag(makeTwoSegmentAsk(`${P}\n${TAIL2}\nmore`));
  await createRunTurn(bag)('do a thing');
  const assistants = getState().items.filter((it) => it.kind === 'assistant');
  assert.equal(assistants.length, 3, 'committed P + TAIL + the new remainder');
  assert.equal(assistants[2].text, '\nmore', 'only the uncommitted remainder is appended');
  assert.equal(assistants[2].streaming, false);
});

test('per-segment strip: segment sealed WITH a leading newline still peels', async () => {
  // The committed segment carries its own leading '\n' ('\nTAIL'); the provider
  // returns the trimmed 'TAIL'. Trimming the segment before the compare lets it
  // peel so it is not duplicated after the steering row.
  const LEAD_TAIL = '\nterminal tail sealed with a leading newline';
  const ask = async (_userText, opts) => {
    opts.onTextDelta(LEAD_TAIL);
    opts.onSteerMessage('steer now');
    return { result: { content: LEAD_TAIL.replace(/^\s+/, '') }, session: { messages: [] } };
  };
  const { bag, getState } = makeTurnBag(ask);
  await createRunTurn(bag)('do a thing');
  const assistants = getState().items.filter((it) => it.kind === 'assistant');
  assert.equal(assistants.length, 1, 'leading-newline segment must not be duplicated at finalize');
  assert.equal(assistants[0].text, LEAD_TAIL);
});
