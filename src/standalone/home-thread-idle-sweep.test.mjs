// Run with --experimental-test-module-mocks.
// A bot's home thread is reserved before the user's first message and then
// idles, so the store's idle sweep releases its live snapshot while the session
// runtime still holds it. The first turn's preparation (the one-shot first-turn
// MCP fold) and the turn itself must act on one session object: a fresh parse
// of the file beside the runtime's copy let the fold land on one while the turn
// ran on the other, the one-shot flag survived there, and the second turn
// rewrote the prompt the first had already sent ("provider message prefix
// changed outside compaction"). Everything from createLocalSessionRuntime down
// is real; only the provider, the MCP transport and the boot warmups are
// stand-ins (see quota-resume-session.test.mjs).
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("a home thread swept while idle keeps one session: its second turn keeps the first turn's prompt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-home-idle-sweep-'));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const previousEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    MIXDOG_HOME: join(root, 'home'),
    MIXDOG_DATA_DIR: join(root, 'data'),
    MIXDOG_CONFIG_DIR: join(root, 'config'),
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_DISABLE_MCP: '1',
    MIXDOG_AGENT_TRACE_DISABLE: '1',
  });

  const noop = () => {};
  const keychain = {
    getSecret: () => null,
    hasSecret: () => false,
    setSecret: noop,
    deleteSecret: noop,
    invalidateSecretCache: noop,
    prewarmSecrets: async () => {},
    SERVICE: 'mixdog',
  };
  t.mock.module('../lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });

  const requests = [];
  const provider = {
    name: 'anthropic-oauth',
    contextWindow: 200000,
    async send(messages) {
      requests.push(structuredClone(messages));
      return { content: `answer ${requests.length}`, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const startupRefresh = Promise.resolve();
  const realRegistry = await import('../runtime/agent/orchestrator/providers/registry.mjs?real=1');
  t.mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
    namedExports: {
      ...realRegistry,
      initProviders: async () => {},
      getProvider: () => provider,
      getAllProviders: () => new Map([['anthropic-oauth', provider]]),
      refreshProviderCatalogsOnStartup: () => startupRefresh,
      refreshCatalogs: async () => {},
    },
  });
  for (const [path, exports] of [
    [
      '../session-runtime/warmup-schedulers.mjs',
      {
        createWarmupSchedulers: () => ({
          scheduleProviderWarmup: noop,
          scheduleProviderSetupWarmup: noop,
          scheduleProviderModelWarmup: noop,
          scheduleModelCatalogWarmup: noop,
          scheduleStatuslineUsageWarmup: noop,
          scheduleStatuslineUsageRefresh: noop,
        }),
      },
    ],
    [
      '../session-runtime/prewarm.mjs',
      {
        createPrewarmSchedulers: () => ({
          scheduleCodeGraphPrewarm: noop,
          scheduleToolRuntimeWarmup: noop,
          scheduleSearchRuntimeWarmup: noop,
          invokeChannelStart: noop,
          scheduleChannelStart: noop,
          scheduleAutomationAutostart: noop,
        }),
      },
    ],
    [
      '../session-runtime/self-update.mjs',
      { createSelfUpdateController: () => ({ startBootCheck: noop, stopBootCheck: noop }) },
    ],
  ]) {
    t.mock.module(path, { namedExports: exports });
  }
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network is forbidden in the home thread idle sweep test');
  });

  const { createMixdogSessionRuntime } = await import('../session-runtime/runtime-core.mjs');
  const initialConfig = {
    providers: { 'anthropic-oauth': { enabled: true, apiKey: 'idle-sweep-test-only', baseUrl: 'http://127.0.0.1:1' } },
  };
  t.mock.module('../mixdog-session-runtime.mjs', {
    namedExports: {
      createMixdogSessionRuntime: (options) => createMixdogSessionRuntime({ ...options, initialConfig }),
    },
  });
  const { createLocalSessionRuntime } = await import('./local-session-runtime.mjs');
  const { drainSessionStore, evictIdleLiveSessions, loadSession } = await import(
    '../runtime/agent/orchestrator/session/store.mjs'
  );
  const { _registerMcpServerForTest, disconnectAll } = await import('../runtime/agent/orchestrator/mcp/client.mjs');

  let api = null;
  let scopeId = null;
  t.after(async () => {
    try {
      if (scopeId) await disconnectAll({ scopeId });
      await api?.dispose?.().catch?.(() => {});
      drainSessionStore?.();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const S = 'sess_home_lead';
  api = await createLocalSessionRuntime({
    provider: 'anthropic-oauth',
    model: 'claude-haiku-5-5',
    toolMode: 'full',
    cwd,
  });
  // Reserved ahead of the first message: materialized, nothing sent yet.
  assert.equal(api.reserveSession(S), true);
  // The idle sweep (no turn runs, the reservation is saved) releases the
  // snapshot this runtime still holds as its session.
  let swept = 0;
  for (let i = 0; i < 500 && swept === 0; i += 1) {
    await tick(10);
    if (loadSession(S)) swept = evictIdleLiveSessions({ isSessionLive: () => false });
  }
  assert.ok(swept > 0, 'the idle sweep released the reserved home thread');
  // An MCP server finishes connecting before the first message: the first
  // turn folds it into the prompt it sends.
  scopeId = loadSession(S).mcpScopeId;
  _registerMcpServerForTest(scopeId, 'UnityMCP', [{ name: 'manage_scene', description: 'Manage scenes.' }], {
    instructions: 'Unity editor tools.',
  });

  const first = await api.submitAndWait('hi', {});
  assert.equal(first.status, 'done');
  const second = await api.submitAndWait('who are you', {});
  assert.equal(second.status, 'done', second.error || '');

  assert.equal(requests.length, 2);
  const systemPrefix = (messages) => messages.filter((message) => message.role === 'system');
  assert.match(
    systemPrefix(requests[0])
      .map((message) => message.content)
      .join('\n'),
    /- mcp__UnityMCP:/,
    'the first turn sends the prompt its preparation folded'
  );
  assert.deepEqual(systemPrefix(requests[1]), systemPrefix(requests[0]), 'the sent prompt is not rewritten');
});
