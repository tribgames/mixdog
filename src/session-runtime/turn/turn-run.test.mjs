// Characterization of one user turn end to end through createTurnRunner:
// first-turn session creation + MCP fold, hook context merge, the askSession
// callback bridge (transcript, first-visible timing, warmup arming), the
// settlement that always runs, blocked/failed turns, and remote-attached
// forwarding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTurnRunner } from './turn-run.mjs';
import { runHeadlessExec } from '../../headless-exec.mjs';
import { createNativeWebSearch } from '../native-web-search.mjs';
import { reportNativeWebSearchUsage } from '../native-web-search-usage.mjs';
import { dispatchWebSearchRuntimeTool } from '../runtime-tool-routing.mjs';
import { setInternalToolsProvider } from '../../runtime/agent/orchestrator/internal-tools.mjs';
import { executeTool } from '../../runtime/agent/orchestrator/session/loop/tool-exec.mjs';

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
  assert.deepEqual(
    h.named('snapshot.begin'),
    [['snapshot.begin', 'sess_new', 'req-1']],
    'the review baseline begins once the session and its workspace are final'
  );
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

test("an agent session's first turn waits for the initial MCP connect instead of the TTFT grace", async () => {
  const h = makeHarness({
    createCurrentSession: async () => {
      const session = { id: 'sess_agent', owner: 'agent', deferredInitialRefreshPending: true };
      h.sessions.set(session.id, session);
      h.state.session = session;
      return session;
    },
  });
  await h.runner.ask('use the MCP tools', {});
  assert.deepEqual(
    h.named('mcpGrace'),
    [['mcpGrace', undefined]],
    'an undefined cap bounds the wait by the server startup budget only'
  );
  assert.equal(h.state.session.deferredInitialRefreshPending, false);

  const later = await h.runner.ask('again', {});
  assert.equal(later.session.id, 'sess_agent');
  assert.deepEqual(
    h.named('mcpGrace')[1],
    ['mcpGrace', 250],
    'later agent turns keep the late-tool path with the normal grace'
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

test('workspace provisioning runs after session creation and before the user row, snapshot and hooks', async () => {
  const h = makeHarness({
    prepareTurnWorkspace: async ({ submissionId, signal, confirmLarge }) => {
      h.calls.push(['workspace.prepare', submissionId, signal instanceof AbortSignal, confirmLarge]);
      h.state.cwd = '/data/worktrees-v1/abc/fix';
    },
  });
  await h.runner.ask('build it', { id: 'sub-7', confirmLarge: true });
  const order = h.calls.map((entry) => entry[0]);
  const at = (name) => order.indexOf(name);
  assert.deepEqual(h.named('workspace.prepare'), [['workspace.prepare', 'sub-7', true, true]]);
  assert.ok(at('createSession') < at('workspace.prepare'), 'the session exists before provisioning');
  assert.ok(at('workspace.prepare') < at('transcript.user'), 'provisioning precedes the user row');
  assert.ok(at('workspace.prepare') < at('snapshot.begin'), 'the review baseline begins after provisioning');
  assert.ok(at('snapshot.begin') < at('dispatch'), 'hooks run after the baseline');
  assert.equal(h.named('askSession')[0][1].cwd, '/data/worktrees-v1/abc/fix', 'the provider turn runs in the worktree');
  assert.equal(h.named('emit')[0][2].cwd, '/data/worktrees-v1/abc/fix');
});

test('turn admission precedes the workspace gate and is released only when the turn settles', async () => {
  const h = makeHarness({
    admitTurnWorkspace: async ({ signal }) => {
      h.calls.push(['workspace.admit', signal instanceof AbortSignal]);
      return () => h.calls.push(['workspace.release']);
    },
    prepareTurnWorkspace: async () => {
      h.calls.push(['workspace.prepare']);
    },
  });
  await h.runner.ask('build it', { id: 'sub-9' });
  const order = h.calls.map((entry) => entry[0]);
  const at = (name) => order.indexOf(name);
  assert.deepEqual(h.named('workspace.admit'), [['workspace.admit', true]]);
  assert.ok(at('createSession') < at('workspace.admit'));
  assert.ok(at('workspace.admit') < at('workspace.prepare'), 'admitted before any provisioning');
  assert.ok(at('askSession') < at('workspace.release'), 'held for the whole turn');
  assert.ok(at('snapshot.complete') < at('workspace.release'), 'the review snapshot completes first');
  assert.equal(h.named('workspace.release').length, 1);

  // A refused turn releases its admission too.
  const refused = makeHarness({
    admitTurnWorkspace: async () => () => refused.calls.push(['workspace.release']),
    prepareTurnWorkspace: async () => {
      throw Object.assign(new Error('missing'), { code: 'WORKTREE_MISSING' });
    },
  });
  await assert.rejects(refused.runner.ask('build it', { id: 'sub-10' }), { code: 'WORKTREE_MISSING' });
  assert.equal(refused.named('workspace.release').length, 1);
});

test('a refused workspace (recovery, large-repo confirm) never runs the turn and keeps the typed error', async () => {
  const h = makeHarness({
    prepareTurnWorkspace: async () => {
      throw Object.assign(new Error('confirm'), { code: 'WORKTREE_LARGE_REPO_CONFIRM' });
    },
  });
  await assert.rejects(h.runner.ask('build it', { id: 'sub-8' }), { code: 'WORKTREE_LARGE_REPO_CONFIRM' });
  assert.deepEqual(h.named('askSession'), []);
  assert.deepEqual(h.named('transcript.user'), [], 'no user row for a turn that never started');
  assert.deepEqual(h.named('snapshot.begin'), []);
  assert.deepEqual(h.named('snapshot.complete'), [], 'no review is sealed for a turn without a baseline');
  assert.deepEqual(
    h.named('dispatch').map((entry) => entry[1]),
    ['StopFailure']
  );
  assert.equal(h.state.activeTurns, 0);
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
    extra: 1,
  });
});

test('headless usage totals include a native web search run through ask and the tool executor', async (t) => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), 'mixdog-web-search-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const usageLogPath = join(root, 'usage.json');
  const route = { provider: 'grok-oauth', model: 'search-model' };
  const config = { providers: {}, webSearchRoute: route };
  const { runNativeWebSearch } = createNativeWebSearch({
    getRoute: () => route,
    getWebSearchRoute: () => route,
    setWebSearchRoute: () => {},
    getConfig: () => config,
    getSession: () => h.state.session,
    getReg: () => ({
      getProvider: () => ({
        send: async () => ({
          content: 'found it',
          model: 'search-model-resolved',
          usage: { inputTokens: 80449, cachedTokens: 1000, cacheWriteTokens: 50, outputTokens: 2923 },
        }),
      }),
    }),
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    ensureProviderEnabled: (cfg) => cfg.providers,
    normalizeWebSearchProviderId: (value) => value,
    webSearchProviderFamily: () => 'xai',
    normalizeWebSearchRouteConfig: (value) => value,
    isDefaultWebSearchRouteConfig: () => false,
    isWebSearchCapableProvider: () => true,
    webSearchCapableFor: () => true,
  });
  const toolSession = { id: 'sess_new', mcpScopeId: 'web-search-usage-scope', cwd: process.cwd() };
  t.after(
    setInternalToolsProvider({
      scopeId: toolSession.mcpScopeId,
      tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }],
      executor: (name, args, callerCtx) =>
        dispatchWebSearchRuntimeTool(name, args, callerCtx, {
          getWebSearchModule: async () => ({
            handleToolCall: (_name, input, options) => options.nativeWebSearch(input),
          }),
          getCurrentCwd: () => toolSession.cwd,
          getSession: () => h.state.session,
          notifyFnForSession: () => () => {},
          runNativeWebSearch,
        }),
    })
  );
  h.askResult = async (callbacks) => {
    callbacks.onProviderSendStarted();
    callbacks.onUsageDelta({ model: 'gpt-test', deltaInput: 100, deltaCachedRead: 20, deltaCacheWrite: 5, deltaOutput: 10 });
    // Run the tool from a context detached from this ask, as a pooled
    // transport's stream callback would.
    await new Promise((resolve) => setImmediate(resolve));
    await executeTool('web_search', { prompt: 'q' }, toolSession.cwd, toolSession.id, toolSession);
    callbacks.onUsageDelta({ model: 'gpt-test', deltaInput: 30, deltaCachedRead: 0, deltaCacheWrite: 0, deltaOutput: 4 });
    return { content: 'done' };
  };
  const code = await runHeadlessExec({
    message: 'search it',
    provider: 'openai-oauth',
    model: 'gpt-test',
    webSearch: true,
    usageLogPath,
    write: () => {},
    writeErr: () => {},
    boundaryFactory: () => ({
      loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
      cleanup() {},
    }),
    runtimeFactory: async () => ({
      id: 'sess_new',
      model: 'gpt-test',
      ask: (prompt, options) => h.runner.ask(prompt, options),
      async close() {},
    }),
    hasActiveTasks: () => false,
    installSignalCleanupFn: () => ({ uninstall() {} }),
  });
  assert.equal(code, 0);
  const usage = JSON.parse(readFileSync(usageLogPath, 'utf8'));
  assert.deepEqual(usage.totals, {
    inputTokens: 100 + 30 + 80449,
    cacheTokens: 20 + 1000,
    cacheWriteTokens: 5 + 50,
    outputTokens: 10 + 4 + 2923,
    toolCallCountApprox: 0,
  });
  assert.deepEqual(usage.sessions[0].models, ['gpt-test', 'search-model-resolved']);
});

test('a turn queued behind another on the same session id does not receive the running turn search usage', async () => {
  const h = makeHarness();
  const first = [];
  const second = [];
  const report = (usage) =>
    reportNativeWebSearchUsage({ ownerSessionId: 'sess_new', sessionId: 'sess_new:ws', model: 'm', usage });
  let releaseLock;
  const lock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  let turns = 0;
  let resolveFirstDone;
  const firstDone = new Promise((resolve) => {
    resolveFirstDone = resolve;
  });
  let firstOwnsSession;
  const firstOwned = new Promise((resolve) => {
    firstOwnsSession = resolve;
  });
  h.askResult = async (callbacks) => {
    turns += 1;
    if (turns === 1) {
      callbacks.onProviderSendStarted();
      firstOwnsSession();
      await lock;
      report({ inputTokens: 7, outputTokens: 1 });
      return { content: 'first' };
    }
    // The real askSession waits on the session lock here.
    await firstDone;
    callbacks.onProviderSendStarted();
    report({ inputTokens: 3, outputTokens: 2 });
    return { content: 'second' };
  };
  const firstTurn = h.runner
    .ask('one', { id: 'a', onNativeWebSearchUsage: (d) => first.push(d.deltaInput) })
    .finally(() => resolveFirstDone());
  await firstOwned;
  // Queued behind the first: registers nothing until its own lock is held.
  const secondTurn = h.runner.ask('two', { id: 'b', onNativeWebSearchUsage: (d) => second.push(d.deltaInput) });
  await new Promise((resolve) => setImmediate(resolve));
  report({ inputTokens: 5, outputTokens: 1 });
  releaseLock();
  await firstTurn;
  await secondTurn;
  assert.deepEqual(first, [5, 7]);
  assert.deepEqual(second, [3]);
});
