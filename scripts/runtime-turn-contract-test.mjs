import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAbortable } from '../src/runtime/shared/abort-race.mjs';
import { SessionClosedError } from '../src/runtime/agent/orchestrator/session/manager/session-errors.mjs';
import { acquireSessionLock } from '../src/runtime/agent/orchestrator/session/manager/session-lock.mjs';
import { settleAskCleanup } from '../src/runtime/agent/orchestrator/session/manager/ask-session.mjs';
import { deriveToolCardModel } from '../src/runtime/shared/tool-card-model.mjs';
import {
  parseBackgroundTaskEnvelope,
  parseModelVisibleCompletionWrapper,
} from '../src/tui/session/agent-envelope.mjs';
import { resolveTuiRuntimeNotificationDelivery } from '../src/tui/session/notification-plan.mjs';
import { shouldRecreateEmptySessionForRouteChange } from '../src/session-runtime/model-route-api.mjs';
import { createSessionTurnApi } from '../src/session-runtime/session-turn-api.mjs';
import { createTagRegistry } from '../src/standalone/agent-tool/tag-registry.mjs';
import { WORKER_INDEX_FILE } from '../src/standalone/agent-tool/tool-def.mjs';
import { presentErrorText, isCancelLikeError } from '../src/runtime/shared/err-text.mjs';
import { finalizeTurnInterruptionSnapshot } from '../src/runtime/agent/orchestrator/session/manager/turn-interruption.mjs';
import { toolErrorDisplay as frameToolError } from '../src/tui/session/tool-result-text.mjs';

const advisoryTest = process.env.MIXDOG_TEST_ADVISORY === '1' ? test : test.skip;

const failAfter = (ms, message) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(message)), ms);
});

test('Lead pool rows never enter the agent-tool closeAll registry', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-lead-pool-'));
  const lead = {
    id: 'sess_lead',
    agentTag: 'lead:sess_lead',
    agent: 'lead',
    status: 'idle',
    closed: false,
  };
  const worker = {
    id: 'sess_worker',
    agentTag: 'worker1',
    agent: 'worker',
    status: 'idle',
    closed: false,
  };
  try {
    writeFileSync(join(dataDir, WORKER_INDEX_FILE), JSON.stringify({
      version: 2,
      workers: {
        [lead.id]: {
          tag: lead.agentTag,
          sessionId: lead.id,
          ownerSessionId: lead.id,
          agent: lead.agent,
          status: lead.status,
        },
        [worker.id]: {
          tag: worker.agentTag,
          sessionId: worker.id,
          ownerSessionId: lead.id,
          agent: worker.agent,
          status: worker.status,
        },
      },
    }));
    const sessions = new Map([[lead.id, lead], [worker.id, worker]]);
    const registry = createTagRegistry({
      dataDir,
      cfgMod: { loadConfig: () => ({}) },
      mgr: {
        getSession: (sessionId) => sessions.get(sessionId) || null,
        listSessions: () => [...sessions.values()],
      },
      emitSubagentEvent: () => {},
    });

    registry.refreshTagsFromSessions();

    assert.equal(registry.tags.has(lead.agentTag), false);
    assert.equal(registry.tags.get(worker.agentTag), worker.id);
    assert.deepEqual(
      registry.agentSessionEntries().map(({ session }) => session.id),
      [worker.id],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

advisoryTest('an explicitly addressed route change preserves an empty session id', () => {
  const empty = { id: 'reserved-session', messages: [], liveTurnMessages: [] };
  assert.equal(shouldRecreateEmptySessionForRouteChange(empty, true), false);
  assert.equal(shouldRecreateEmptySessionForRouteChange(empty, false), true);
  assert.equal(shouldRecreateEmptySessionForRouteChange({
    ...empty,
    messages: [{ role: 'user', content: 'already started' }],
  }, false), false);
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

test('running shell output is progress until the terminal completion arrives', () => {
  const runningText = [
    'background task',
    'task_id: shell-1',
    'surface: shell',
    'status: running',
    '',
    '[stdout preview]',
    'building...',
  ].join('\n');
  const running = parseBackgroundTaskEnvelope(runningText);
  assert.equal(running.args.type, 'progress');
  const runningCard = deriveToolCardModel({
    name: running.name,
    args: running.args,
    result: running.result,
    count: 1,
    completedCount: 1,
  });
  assert.equal(runningCard.labelText, 'Shell progress');
  assert.equal(runningCard.isBackgroundResponse, false);
  const runningDelivery = resolveTuiRuntimeNotificationDelivery({
    content: runningText,
    meta: {
      execution_id: 'shell-1',
      execution_surface: 'shell',
      status: 'running',
    },
  }, runningText);
  assert.equal(runningDelivery.action, 'execution-ui');
  assert.equal(runningDelivery.modelContent, '');

  const completedText = runningText.replace('status: running', 'status: completed');
  const completed = parseBackgroundTaskEnvelope(completedText);
  assert.equal(completed.args.type, 'result');
  const completedCard = deriveToolCardModel({
    name: completed.name,
    args: completed.args,
    result: completed.result,
    count: 1,
    completedCount: 1,
  });
  assert.equal(completedCard.labelText, 'Shell output');
  assert.equal(completedCard.isBackgroundResponse, true);
  const completedDelivery = resolveTuiRuntimeNotificationDelivery({
    content: completedText,
    meta: {
      execution_id: 'shell-1',
      execution_surface: 'shell',
      status: 'completed',
    },
  }, completedText);
  assert.match(completedDelivery.modelContent, /^Async shell shell-1 completed finished\./i);
});

test('fallback shell completion wrapper remains renderable as one UI card', () => {
  const background = [
    'background task',
    'task_id: shell-fallback-1',
    'surface: shell',
    'status: completed',
    '',
    '[exit code: 0]',
    'done',
  ].join('\n');
  const wrapper = [
    'The async shell task shell-fallback-1 has finished (completed, exit 0) - review this result in your next step. Final result follows; do not recheck.',
    '',
    'Result:',
    ...background.split('\n').map((line) => `> ${line}`),
  ].join('\n');
  const parsed = parseModelVisibleCompletionWrapper(wrapper);
  assert.equal(parsed.name, 'shell');
  assert.equal(parsed.args.task_id, 'shell-fallback-1');
  assert.equal(parsed.args.type, 'result');
  assert.equal(parsed.rawResult, background);
  const card = deriveToolCardModel({
    name: parsed.name,
    args: parsed.args,
    result: parsed.result,
    count: 1,
    completedCount: 1,
  });
  assert.equal(card.labelText, 'Shell output');
  assert.equal(card.isBackgroundResponse, true);
});

test('interrupt display: stall/timeout/abort copy and non-user markers', () => {
  const stall = Object.assign(new Error('OpenAI OAuth WS stream timed out after 120000ms of inactivity'), {
    name: 'StreamStalledError',
    code: 'ESTREAMSTALL',
  });
  assert.equal(presentErrorText(stall, { surface: 'turn' }), 'No progress 2m.');
  assert.equal(frameToolError(stall, 'turn'), 'No progress 2m.');

  const firstByte = Object.assign(new Error('Gemini REST first byte timed out after 60000ms'), {
    name: 'ProviderTimeoutError',
    code: 'EPROVIDERTIMEOUT',
  });
  assert.equal(presentErrorText(firstByte, { surface: 'turn' }), 'No first response 1m.');
  assert.equal(frameToolError(firstByte, 'turn'), 'No first response 1m.');

  const abort = new Error('OpenAI OAuth WS aborted by session close');
  assert.equal(isCancelLikeError(abort), true);
  assert.equal(presentErrorText(abort, { surface: 'turn' }), 'Cancelled');
  assert.equal(frameToolError(abort, 'turn'), 'Cancelled');

  const closed = new SessionClosedError('sess_x', 'user-cancel', 'user-cancel');
  assert.equal(isCancelLikeError(closed), true);

  const snapshot = {
    responseStarted: true,
    partialAssistantContent: 'half',
    phase: 'streaming',
  };
  const user = finalizeTurnInterruptionSnapshot({
    turnOutgoing: [{ role: 'user', content: 'hi' }],
    currentUserContent: 'hi',
    snapshot,
    abortReason: 'user-cancel',
  });
  assert.equal(user.messages.at(-1)?.content, '[Request interrupted by user]');

  const idle = finalizeTurnInterruptionSnapshot({
    turnOutgoing: [{ role: 'user', content: 'hi' }],
    currentUserContent: 'hi',
    snapshot,
    abortReason: 'idle-sweep',
  });
  assert.equal(idle.messages.at(-1)?.content, '[Request interrupted]');
});
