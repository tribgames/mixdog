// Characterization of one user turn end to end through createTurnRunner:
// first-turn session creation + MCP fold, hook context merge, the askSession
// callback bridge (transcript, first-visible timing, warmup arming), the
// settlement that always runs, blocked/failed turns, and remote-attached
// forwarding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnRunner } from './turn-run.mjs';

function makeHarness(overrides = {}) {
  const calls = [];
  const record = (...entry) => calls.push(entry);
  const state = {
    session: null,
    activeTurns: 0,
    firstTurnCompleted: false,
    prewarmDone: false,
    lastAssistant: '',
    cwd: process.cwd(),
  };
  const sessions = new Map();
  const transcript = {
    appendUser: (text) => record('transcript.user', text),
    appendAssistant: (text) => record('transcript.assistant', text),
  };
  const h = {
    calls,
    state,
    sessions,
    named: (name) => calls.filter((entry) => entry[0] === name),
    hookResults: {},
    askCallbacks: null,
    onToolCall: null,
    askResult: async () => ({ content: 'final answer' }),
  };
  const mgr = {
    getSession: (id) => sessions.get(id) || null,
    askSession: async (id, prompt, context, onToolCall, cwd, prefetch, callbacks) => {
      record('askSession', { id, prompt, context, cwd, prefetch });
      h.askCallbacks = callbacks;
      h.onToolCall = onToolCall;
      return h.askResult(callbacks);
    },
    getSessionProgressSnapshot: () => ({
      stage: 'tool',
      lastProgressAt: 5,
      toolStartedAt: 3,
      toolSelfDeadlineMs: 9,
      extra: 1,
    }),
    enqueueRemotePendingMessage: (id, prompt) => {
      record('enqueueRemote', id, prompt);
      return 1;
    },
  };
  h.runner = createTurnRunner({
    getSession: () => state.session,
    setSession: (session) => {
      record('setSession', session?.id);
      state.session = session;
    },
    getCurrentCwd: () => state.cwd,
    getActiveTurnCount: () => state.activeTurns,
    setActiveTurnCount: (n) => {
      state.activeTurns = n;
    },
    isFirstTurnCompleted: () => state.firstTurnCompleted,
    setFirstTurnCompleted: (v) => {
      state.firstTurnCompleted = v;
    },
    getCodeGraphFirstTurnPrewarmDone: () => state.prewarmDone,
    setCodeGraphFirstTurnPrewarmDone: (v) => {
      state.prewarmDone = v;
    },
    getTranscriptWriter: () => transcript,
    getLastAppendedAssistant: () => state.lastAssistant,
    setLastAppendedAssistant: (v) => {
      state.lastAssistant = v;
    },
    scheduleCodeGraphPrewarm: (_delay, reason) => record('prewarm.codeGraph', reason),
    scheduleToolRuntimeWarmup: () => record('warmup.tool'),
    scheduleSearchRuntimeWarmup: () => record('warmup.search'),
    createCurrentSession: async (reason) => {
      record('createSession', reason);
      const session = { id: 'sess_new', deferredInitialRefreshPending: true };
      sessions.set(session.id, session);
      state.session = session;
      return session;
    },
    ensureSessionTranscriptWriter: () => record('ensureWriter'),
    hooks: {
      emit: (name, payload) => record('emit', name, payload),
      dispatch: async (name, payload) => {
        record('dispatch', name, payload);
        return h.hookResults[name] ?? null;
      },
    },
    hookCommonPayload: (payload) => ({ common: true, ...payload }),
    mgr,
    notifyFnForSession: (id) => `notify:${id}`,
    scheduleProviderWarmup: () => record('warmup.provider'),
    scheduleProviderModelWarmup: () => record('warmup.providerModel'),
    agentTool: { upsertLeadSession: (session, patch) => record('lead', session?.id, patch.status) },
    awaitInitialMcpConnect: async (grace) => record('mcpGrace', grace),
    mcpTurnGraceMs: 250,
    awaitRoutePreparation: async () => record('route'),
    getReservedSessionId: () => 'sess_reserved',
    sessionTitles: {
      scheduleFirst: (_session, prompt, { after }) => {
        record('title.first', prompt);
        after.then(() => record('title.released'));
      },
      observeThird: (session) => record('title.third', session?.id),
    },
    registerActiveTurnController: () => {
      record('controller.register');
      return () => record('controller.unregister');
    },
    endComputerExecution: async (id) => record('computer.end', id),
    deferComputerSessionRelease: (id) => record('computer.defer', id),
    beginTurnSnapshotForTurn: (_cwd, id, opts) => record('snapshot.begin', id, opts.checkpointId),
    cancelTurnSnapshotForTurn: (id) => record('snapshot.cancel', id),
    completeTurnSnapshotForTurn: (id) => record('snapshot.complete', id),
    turnCleanupSettleMs: 50,
    ...overrides,
  });
  return h;
}

test('a first turn creates the session, folds MCP once, bridges the callbacks and settles the runtime state', async () => {
  const h = makeHarness();
  h.hookResults.UserPromptSubmit = { additionalContext: ['ctx A', 'ctx B'] };
  h.askResult = async (callbacks) => {
    assert.equal(callbacks.notifyFn, 'notify:sess_new');
    assert.ok(callbacks.signal instanceof AbortSignal);
    await callbacks.beforeToolExecution();
    callbacks.onStreamDelta('text');
    callbacks.onStreamDelta('text');
    callbacks.onAssistantText('hello');
    callbacks.onProviderSendStarted();
    return { content: 'final answer' };
  };
  const timings = [];
  const onTiming = (row) => timings.push(row);
  process.on('mixdog:turn-timing', onTiming);
  try {
    const outcome = await h.runner.ask('do it', { id: 'req-1', context: 'user ctx', submittedAt: Date.now() - 5 });
    assert.deepEqual(outcome, { result: { content: 'final answer' }, session: h.state.session });
  } finally {
    process.off('mixdog:turn-timing', onTiming);
  }
  assert.deepEqual(h.named('createSession'), [['createSession', 'turn']]);
  assert.deepEqual(h.named('snapshot.begin'), [
    ['snapshot.begin', 'sess_reserved', 'req-1'],
    ['snapshot.begin', 'sess_new', 'req-1'],
  ]);
  assert.deepEqual(h.named('snapshot.complete'), [['snapshot.complete', 'sess_new']]);
  assert.deepEqual(h.named('mcpGrace'), [['mcpGrace', 250]], 'the fresh session takes the first-turn MCP fold once');
  assert.equal(h.state.session.deferredInitialRefreshPending, false);
  assert.deepEqual(h.named('askSession')[0][1], {
    id: 'sess_new',
    prompt: 'do it',
    context: 'user ctx\n\nctx A\n\nctx B',
    cwd: h.state.cwd,
    prefetch: null,
  });
  assert.deepEqual(h.named('transcript.user'), [['transcript.user', 'do it']]);
  assert.deepEqual(h.named('transcript.assistant'), [
    ['transcript.assistant', 'hello'],
    ['transcript.assistant', 'final answer'],
  ]);
  assert.deepEqual(
    h.named('emit').map((entry) => entry[1]),
    ['turn:start', 'turn:end']
  );
  assert.deepEqual(h.named('emit')[0][2], { sessionId: 'sess_new', prompt: 'do it', cwd: h.state.cwd });
  assert.deepEqual(
    h.named('dispatch').map((entry) => entry[1]),
    ['UserPromptSubmit', 'Stop']
  );
  assert.deepEqual(h.named('dispatch')[0][2], { common: true, session_id: 'sess_new', prompt: 'do it' });
  assert.deepEqual(h.named('lead'), [
    ['lead', 'sess_new', 'running'],
    ['lead', 'sess_new', 'idle'],
  ]);
  assert.deepEqual(h.named('title.first'), [['title.first', 'do it']]);
  assert.equal(h.named('title.released').length, 1, 'first visible progress releases the title');
  assert.deepEqual(h.named('title.third'), [['title.third', 'sess_new']]);
  assert.equal(h.named('warmup.search').length, 1);
  assert.deepEqual(h.named('warmup.tool'), [['warmup.tool']]);
  assert.deepEqual(h.named('prewarm.codeGraph'), [['prewarm.codeGraph', 'first-visible']]);
  assert.equal(h.state.prewarmDone, true);
  assert.equal(h.state.firstTurnCompleted, true);
  assert.deepEqual(h.named('warmup.provider'), [['warmup.provider']]);
  assert.deepEqual(h.named('warmup.providerModel'), [['warmup.providerModel']]);
  assert.equal(h.state.activeTurns, 0);
  assert.deepEqual(h.named('computer.end'), [['computer.end', 'sess_new']]);
  assert.deepEqual(h.named('controller.unregister'), [['controller.unregister']]);
  assert.equal(timings.length, 1, 'timing is emitted once, at first visible progress');
  assert.equal(timings[0].status, 'first-visible');
  assert.equal(timings[0].sessionId, 'sess_new');
  assert.equal(timings[0].requestId, 'req-1');
  assert.ok(timings[0].providerMs >= 0);
  assert.ok(timings[0].queueMs >= 0);

  h.calls.length = 0;
  assert.equal(await h.onToolCall(1, [{ name: 'read', id: 'c1' }, {}]), undefined);
  assert.deepEqual(
    h.named('emit').map((entry) => entry[2]),
    [
      { sessionId: 'sess_new', name: 'read', callId: 'c1' },
      { sessionId: 'sess_new', name: 'tool', callId: null },
    ]
  );
});

test('a later turn on an existing session skips creation, the first-turn fold and the one-shot warmups', async () => {
  const h = makeHarness();
  const existing = { id: 'sess_old', deferredInitialRefreshPending: false };
  h.sessions.set(existing.id, existing);
  h.state.session = existing;
  h.state.firstTurnCompleted = true;
  h.state.prewarmDone = true;
  h.state.lastAssistant = 'final answer';
  const outcome = await h.runner.ask('again', {});
  assert.deepEqual(outcome, { result: { content: 'final answer' }, session: existing });
  assert.deepEqual(h.named('createSession'), []);
  assert.deepEqual(h.named('snapshot.begin'), [['snapshot.begin', 'sess_old', '']]);
  assert.deepEqual(h.named('mcpGrace'), [['mcpGrace', 250]], 'the late path still grants the reconnect grace');
  assert.deepEqual(h.named('askSession')[0][1].context, null);
  assert.deepEqual(
    h.named('transcript.assistant'),
    [['transcript.assistant', 'final answer']],
    'each turn resets the last-appended marker, so its final text is appended once'
  );
  assert.deepEqual(h.named('warmup.provider'), []);
  assert.deepEqual(h.named('warmup.tool'), []);
  assert.deepEqual(h.named('prewarm.codeGraph'), []);
  assert.equal(h.named('title.released').length, 1, 'settlement releases a title that never saw visible progress');
});

test('a hook-blocked prompt throws before askSession, reports the failure hooks and still settles', async () => {
  const h = makeHarness();
  h.hookResults.UserPromptSubmit = { blocked: true, reason: 'policy' };
  await assert.rejects(h.runner.ask('blocked', { id: 'req-2' }), /prompt blocked by hook: policy/);
  assert.deepEqual(h.named('askSession'), []);
  assert.deepEqual(
    h.named('emit').map((entry) => entry[1]),
    ['turn:start', 'turn:error']
  );
  assert.equal(h.named('emit')[1][2].error, 'prompt blocked by hook: policy');
  const stopFailure = h.named('dispatch').find((entry) => entry[1] === 'StopFailure');
  assert.deepEqual(stopFailure[2], { common: true, session_id: 'sess_new', error_type: 'unknown' });
  assert.equal(h.state.activeTurns, 0);
  assert.deepEqual(h.named('snapshot.complete'), [['snapshot.complete', 'sess_new']]);
  assert.deepEqual(h.named('lead').at(-1), ['lead', 'sess_new', 'idle']);
  assert.equal(h.state.firstTurnCompleted, true, 'even a failed first turn completes the first-turn gate');
});

test('an askSession failure classifies the StopFailure error type and rethrows', async () => {
  const h = makeHarness();
  h.askResult = async () => {
    throw new Error('HTTP 429 Too Many Requests');
  };
  await assert.rejects(h.runner.ask('rate', {}), /429/);
  const stopFailure = h.named('dispatch').find((entry) => entry[1] === 'StopFailure');
  assert.equal(stopFailure[2].error_type, 'rate_limit');
  assert.deepEqual(
    h
      .named('dispatch')
      .map((entry) => entry[1])
      .includes('Stop'),
    false
  );
});

test('a remote-attached session forwards the prompt into the owner spool instead of running a turn', async () => {
  const h = makeHarness();
  const attached = { id: 'sess_remote', remoteAttached: true };
  h.state.session = attached;
  const outcome = await h.runner.ask('forward me', { id: 'sub-1' });
  assert.deepEqual(outcome, { result: { content: '', remoteAttached: true, delivered: true }, session: attached });
  assert.deepEqual(h.named('enqueueRemote'), [
    ['enqueueRemote', 'sess_remote', { content: 'forward me', id: 'sub-1' }],
  ]);
  assert.deepEqual(h.named('askSession'), []);
  assert.deepEqual(h.named('emit'), []);
  assert.equal(h.runner.enqueueRemoteAttachedPrompt('plain'), true);
  h.state.session = { id: 'sess_local' };
  assert.equal(h.runner.enqueueRemoteAttachedPrompt('plain'), false);
});

test('getTurnLiveness projects the manager progress snapshot for the current session', () => {
  const h = makeHarness();
  assert.equal(h.runner.getTurnLiveness(), null);
  h.state.session = { id: 'sess_live' };
  assert.deepEqual(h.runner.getTurnLiveness(), {
    stage: 'tool',
    lastProgressAt: 5,
    toolStartedAt: 3,
    toolSelfDeadlineMs: 9,
  });
});
