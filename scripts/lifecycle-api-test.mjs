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
    setBackendAsync: async () => {},
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
