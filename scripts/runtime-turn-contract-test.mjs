import test from 'node:test';
import assert from 'node:assert/strict';

import { runAbortable } from '../src/runtime/shared/abort-race.mjs';
import { SessionClosedError } from '../src/runtime/agent/orchestrator/session/manager/session-errors.mjs';
import { acquireSessionLock } from '../src/runtime/agent/orchestrator/session/manager/session-lock.mjs';
import { settleAskCleanup } from '../src/runtime/agent/orchestrator/session/manager/ask-session.mjs';
import { createSessionTurnApi } from '../src/session-runtime/session-turn-api.mjs';

const failAfter = (ms, message) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(message)), ms);
});

function makeTurnHarness({
  sessionId = 'turn-contract',
  awaitRoutePreparation = async () => {},
  hookDispatch = async () => ({}),
  beginTurnSnapshotForTurn = async () => {},
  turnCleanupSettleMs = 20,
  askSession = async () => ({ content: '' }),
  transcriptWriter = null,
  ensureSessionTranscriptWriter = () => {},
} = {}) {
  const session = {
    id: sessionId,
    remoteAttached: false,
    deferredInitialRefreshPending: false,
    messages: [],
  };
  let activeTurnCount = 0;
  let activeController = null;
  let unregistered = false;
  let cancelledSnapshot = false;
  const api = createSessionTurnApi({
    getSession: () => session,
    setSession: () => {},
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'full',
    setMode: () => {},
    getActiveTurnCount: () => activeTurnCount,
    setActiveTurnCount: (value) => { activeTurnCount = value; },
    isFirstTurnCompleted: () => true,
    setFirstTurnCompleted: () => {},
    getCodeGraphFirstTurnPrewarmDone: () => true,
    getRemoteEnabled: () => false,
    getTranscriptWriter: () => transcriptWriter,
    getTwKey: () => '',
    getLastAppendedAssistant: () => '',
    setLastAppendedAssistant: () => {},
    ensureSessionTranscriptWriter,
    ensureRemoteTranscriptWriter: () => {},
    getCloseRequested: () => false,
    getReservedSessionId: () => null,
    registerActiveTurnController: (controller) => {
      activeController = controller;
      return () => { unregistered = true; };
    },
    awaitRoutePreparation,
    refreshSessionForCwdIfNeeded: async () => session,
    beginTurnSnapshotForTurn,
    cancelTurnSnapshotForTurn: () => { cancelledSnapshot = true; },
    completeTurnSnapshotForTurn: async () => {},
    turnCleanupSettleMs,
    hooks: { emit: () => {}, dispatch: hookDispatch },
    hookCommonPayload: (payload) => payload,
    mgr: {
      askSession,
      getSession: () => session,
    },
    notifyFnForSession: () => undefined,
    scheduleProviderWarmup: () => {},
    scheduleProviderModelWarmup: () => {},
    bootProfile: () => {},
  });
  return {
    api,
    getActiveController: () => activeController,
    getActiveTurnCount: () => activeTurnCount,
    wasUnregistered: () => unregistered,
    wasSnapshotCancelled: () => cancelledSnapshot,
  };
}

test('abort-aware waits settle even when the underlying operation never does', async () => {
  const controller = new AbortController();
  const waiting = runAbortable(controller.signal, () => new Promise(() => {}));
  controller.abort(new SessionClosedError('abort-race', 'test abort', 'user-cancel'));
  await Promise.race([
    assert.rejects(waiting, (error) => error?.name === 'SessionClosedError'),
    failAfter(200, 'abort-aware wait remained pending'),
  ]);
});

test('an aborted mutex waiter settles immediately without opening the lock', async () => {
  const firstUnlock = await acquireSessionLock('abortable-lock');
  const controller = new AbortController();
  const cancelled = acquireSessionLock('abortable-lock', controller.signal);
  let thirdAcquired = false;
  const third = acquireSessionLock('abortable-lock').then((unlock) => {
    thirdAcquired = true;
    return unlock;
  });

  controller.abort(new SessionClosedError('abortable-lock', 'cancel queued ask', 'user-cancel'));
  await Promise.race([
    assert.rejects(cancelled, (error) => error?.name === 'SessionClosedError'),
    failAfter(200, 'cancelled lock waiter remained pending'),
  ]);
  assert.equal(thirdAcquired, false, 'later waiter must remain behind the live owner');

  firstUnlock();
  const thirdUnlock = await Promise.race([third, failAfter(200, 'lock chain did not skip cancelled slot')]);
  assert.equal(thirdAcquired, true);
  thirdUnlock();
});

test('turn cleanup has a finite settlement contract', async () => {
  const startedAt = Date.now();
  const result = await settleAskCleanup(new Promise(() => {}), { timeoutMs: 20 });
  assert.deepEqual(result, { settled: false, value: undefined });
  assert.ok(Date.now() - startedAt < 200, 'cleanup deadline must release the ask promptly');
});

test('runtime ask aborts while route preparation is permanently pending', async () => {
  const harness = makeTurnHarness({
    sessionId: 'route-hang',
    awaitRoutePreparation: () => new Promise(() => {}),
  });

  const asking = harness.api.ask('blocked by route preparation');
  await new Promise((resolve) => setImmediate(resolve));
  const activeController = harness.getActiveController();
  assert.ok(activeController, 'ask must register outer abort ownership before route wait');
  activeController.abort(new SessionClosedError('route-hang', 'route wait aborted', 'user-cancel'));

  await Promise.race([
    assert.rejects(asking, (error) => error?.name === 'SessionClosedError'),
    failAfter(200, 'runtime ask remained pinned by route preparation'),
  ]);
  assert.equal(harness.getActiveTurnCount(), 0);
  assert.equal(harness.wasUnregistered(), true);
  assert.equal(harness.wasSnapshotCancelled(), true);
});

test('runtime ask aborts while a prompt hook ignores cancellation', async () => {
  let enterHook;
  const hookEntered = new Promise((resolve) => { enterHook = resolve; });
  const harness = makeTurnHarness({
    sessionId: 'hook-hang',
    hookDispatch: async (name) => {
      if (name !== 'UserPromptSubmit') return {};
      enterHook();
      return await new Promise(() => {});
    },
  });

  const asking = harness.api.ask('blocked by prompt hook');
  await hookEntered;
  harness.getActiveController().abort(
    new SessionClosedError('hook-hang', 'prompt hook aborted', 'user-cancel'),
  );
  await Promise.race([
    assert.rejects(asking, (error) => error?.name === 'SessionClosedError'),
    failAfter(200, 'runtime ask remained pinned by prompt hook'),
  ]);
});

test('optional turn snapshot cleanup cannot pin a successful ask', async () => {
  const harness = makeTurnHarness({
    sessionId: 'snapshot-hang',
    beginTurnSnapshotForTurn: () => new Promise(() => {}),
    askSession: async () => ({ content: 'done' }),
  });

  const result = await Promise.race([
    harness.api.ask('finish despite snapshot cleanup'),
    failAfter(200, 'runtime ask remained pinned by turn snapshot cleanup'),
  ]);
  assert.equal(result.result.content, 'done');
  assert.equal(harness.getActiveTurnCount(), 0);
  assert.equal(harness.wasUnregistered(), true);
});

test('local main turns persist user and assistant conversation without Remote', async () => {
  const rows = [];
  let ensured = 0;
  const writer = {
    appendUser: (text) => rows.push(['user', text]),
    appendAssistant: (text) => rows.push(['assistant', text]),
  };
  const harness = makeTurnHarness({
    transcriptWriter: writer,
    ensureSessionTranscriptWriter: () => { ensured += 1; },
    askSession: async (...args) => {
      args[7]?.onAssistantText?.('local reply');
      return { content: 'local reply' };
    },
  });
  await harness.api.ask('local prompt');
  assert.equal(ensured, 1);
  assert.deepEqual(rows, [
    ['user', 'local prompt'],
    ['assistant', 'local reply'],
  ]);
});
