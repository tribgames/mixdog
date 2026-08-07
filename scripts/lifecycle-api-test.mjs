import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConfigLifecycle } from '../src/session-runtime/config-lifecycle.mjs';
import { createLifecycleApi } from '../src/session-runtime/lifecycle-api.mjs';
import {
  _clearWebSocketPoolForTest,
  _seedWebSocketEntryForTest,
  closeOpenaiWsPoolForSession,
} from '../src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs';
import {
  cancelBackgroundTasks,
  getBackgroundTask,
  registerBackgroundTask,
} from '../src/runtime/shared/background-tasks.mjs';

function socket() {
  return {
    closed: [],
    close(_code, reason) {
      this.closed.push(reason);
    },
  };
}

function lifecycleFor(session, overrides = {}) {
  let current = session;
  return createLifecycleApi({
    getSession: () => current,
    setSession: (value) => { current = value; },
    getRoute: () => ({}),
    setRoute: () => {},
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => '/test',
    setCloseRequested: () => {},
    getMemoryModPromise: () => null,
    setMemoryModPromise: () => {},
    setSessionNeedsCwdRefresh: () => {},
    hooks: { dispatch: () => {}, flushRules: () => {} },
    hookCommonPayload: (payload) => payload,
    mgr: {
      closeSession: (id, reason) => {
        closeOpenaiWsPoolForSession(id, `session-close:${reason}`);
        return true;
      },
    },
    statusRoutes: { clearGatewaySessionRoute: () => {} },
    channels: { stop: () => null },
    agentTool: { closeAll: () => {} },
    mcpClient: { disconnectAll: () => null },
    warmupTimers: {},
    prewarmTimers: {},
    flushAllConfigSavesAsync: async () => {},
    withTeardownDeadline: (promise) => promise,
    closePatchRuntimeIfLoaded: () => null,
    stopSelfUpdateBootCheck: () => {},
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    notificationListeners: { clear: () => {} },
    remoteStateListeners: { clear: () => {} },
    ...overrides,
  });
}

test('lifecycle drains the OpenAI WS pool only for process exit', async () => {
  _clearWebSocketPoolForTest();
  globalThis.__mixdogOpenaiWsRuntimeLoaded = true;
  const replacementSocket = socket();
  const retainedSocket = socket();
  _seedWebSocketEntryForTest({ poolKey: 'replacement', auth: {}, cacheKey: '', entry: { socket: replacementSocket } });
  _seedWebSocketEntryForTest({ poolKey: 'retained', auth: {}, cacheKey: '', entry: { socket: retainedSocket } });

  await lifecycleFor({ id: 'replacement', messages: [], liveTurnMessages: [] }).close('engine-replace');

  assert.deepEqual(replacementSocket.closed, ['session-close:engine-replace']);
  assert.deepEqual(retainedSocket.closed, []);

  await lifecycleFor({ id: 'exit-session', messages: [], liveTurnMessages: [] }).close('cli-exit');

  assert.deepEqual(retainedSocket.closed, ['cli-exit']);
});

test('closing an attached viewer does not close the live owner session', async () => {
  let closeCalls = 0;
  const lifecycle = lifecycleFor({
    id: 'live-owner-session',
    remoteAttached: true,
    messages: [{ role: 'user', content: 'owned elsewhere' }],
    liveTurnMessages: [],
  }, {
    mgr: {
      closeSession: () => {
        closeCalls += 1;
        return true;
      },
    },
  });

  assert.equal(await lifecycle.close('desktop-dispose'), true);
  assert.equal(closeCalls, 0);
});

test('abort settles the outer turn before a manager session exists', () => {
  let outerReason = null;
  const lifecycle = lifecycleFor(null, {
    getReservedSessionId: () => 'reserved-turn',
    abortActiveTurns: (reason) => {
      outerReason = reason;
      return true;
    },
    mgr: { abortSessionTurn: () => false },
  });

  assert.equal(lifecycle.abort('user-cancel'), true);
  assert.equal(outerReason?.name, 'SessionClosedError');
  assert.equal(outerReason?.sessionId, 'reserved-turn');
  assert.equal(outerReason?.reason, 'user-cancel');
});

test('lifecycle cancels the pending self-update boot check before yielding', async () => {
  const events = [];
  await lifecycleFor(null, {
    setCloseRequested: () => { events.push('close-requested'); },
    stopSelfUpdateBootCheck: () => { events.push('update-check-stopped'); },
    flushAllConfigSavesAsync: async () => { events.push('first-await'); },
  }).close('test-dispose');
  assert.deepEqual(events.slice(0, 3), [
    'close-requested',
    'update-check-stopped',
    'first-await',
  ]);
});

test('background work is reaped per session, and a scoped cancel notifies', async () => {
  // A non-exit dispose (daemon session projection release) must reap
  // only its own session's background work — the process-wide silent sweep
  // killed another session's running job with no completion notification.
  const paneCalls = [];
  await lifecycleFor({ id: 'pane-session', messages: [], liveTurnMessages: [] }, {
    cancelBackgroundTasks: (options) => { paneCalls.push(options); return { cancelled: 0 }; },
  }).close('desktop-engine-dispose');
  assert.deepEqual(paneCalls, [{
    reason: 'desktop-engine-dispose', notify: true, callerSessionId: 'pane-session',
  }]);

  // Real process exit keeps the process-wide sweep (nothing survives it).
  const exitCalls = [];
  await lifecycleFor({ id: 'exit-session', messages: [], liveTurnMessages: [] }, {
    cancelBackgroundTasks: (options) => { exitCalls.push(options); return { cancelled: 0 }; },
  }).close('cli-exit');
  assert.deepEqual(exitCalls, [{ reason: 'cli-exit', notify: false }]);

  // An empty runtime owns no session: it reaps nothing at all.
  const emptyRuntimeCalls = [];
  await lifecycleFor(null, {
    cancelBackgroundTasks: (options) => { emptyRuntimeCalls.push(options); return { cancelled: 0 }; },
  }).close('empty runtime release');
  assert.deepEqual(emptyRuntimeCalls, []);
});

test('a scoped background-task sweep never claims unattributed legacy work', () => {
  const owned = registerBackgroundTask({
    taskId: 'task_lifecycle_owned',
    surface: 'test',
    context: { callerSessionId: 'pane-session' },
  });
  const unattributed = registerBackgroundTask({
    taskId: 'task_lifecycle_unattributed',
    surface: 'test',
  });
  try {
    const result = cancelBackgroundTasks({
      reason: 'desktop-engine-dispose',
      callerSessionId: 'pane-session',
    });
    assert.equal(result.cancelled, 1);
    assert.equal(getBackgroundTask(owned.taskId)?.status, 'cancelled');
    assert.equal(getBackgroundTask(unattributed.taskId)?.status, 'running',
      'ownership-free work must survive a scoped engine dispose');
  } finally {
    cancelBackgroundTasks({ reason: 'test-cleanup', surface: 'test' });
  }
});

test('lifecycle barrier drains a direct updateSectionAsync with no queued lifecycle save', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-config-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousBackupRoot = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dataDir, 'backups');
  const sharedCfgMod = await import(`../src/runtime/shared/config.mjs?lifecycle-tail=${Date.now()}`);
  const configLifecycle = createConfigLifecycle({
    getConfig: () => ({}),
    setConfig: () => {},
    getSearchRoute: () => null,
    setSearchRoute: () => {},
    getConfigHasSecrets: () => false,
    setConfigHasSecrets: () => {},
    getRoute: () => ({}),
    cfgMod: {
      saveConfigAsync: async () => {},
      patchSkillsDisabledAsync: async () => {},
      getPluginData: () => dataDir,
    },
    sharedCfgMod,
    setChannelProviderAsync: async () => {},
    setConfiguredShell: () => {},
    normalizeSystemShellConfig: () => ({ command: '' }),
    normalizeSearchRouteConfig: () => null,
    outputStyleStatus: () => ({}),
    LAZY_SECRET_PROVIDERS: new Set(),
    clean: (value) => String(value || ''),
    resolve: (value) => value,
    STANDALONE_DATA_DIR: dataDir,
  });

  const events = [];
  let directSettled = false;
  try {
    const directWrite = sharedCfgMod.updateSectionAsync('cycle3', () => ({ value: 'direct' }))
      .finally(() => { directSettled = true; events.push('direct:settled'); });
    assert.equal(directSettled, false);

    const lifecycle = lifecycleFor(
      { id: 'tail-drain', messages: [], liveTurnMessages: [] },
      {
        flushAllConfigSavesAsync: configLifecycle.flushAllConfigSavesAsync,
        closePatchRuntimeIfLoaded: async () => { events.push('teardown:continued'); },
      },
    );
    await lifecycle.close('engine-replace');
    await directWrite;
    assert.deepEqual(events, ['direct:settled', 'teardown:continued']);
  } finally {
    if (previousDataDir == null) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousBackupRoot == null) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = previousBackupRoot;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
