// Real-trigger regression for "a session changed its durable address":
// a canonical worker A is cancelled while a turn is in flight, and the shell
// completion the manager close produces is delivered through the real
// notification bus into the real local-session queue. Everything from
// createLocalSessionRuntime down (queue, notification feed, lifecycle api,
// runtime, session manager, durable store) is real; only the provider and the
// shell-cancel hook are stand-ins.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('a cancelled canonical worker never gets a new conversation from its own shell completion', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-address-regression-'));
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
    MIXDOG_DISABLE_MCP: '1',
    MIXDOG_AGENT_TRACE_DISABLE: '1',
  });

  const noop = () => {};
  const keychain = {
    getSecret: () => null,
    hasSecret: () => false,
    setSecret: () => assert.fail('unexpected credential write'),
    deleteSecret: () => assert.fail('unexpected credential deletion'),
    invalidateSecretCache: noop,
    prewarmSecrets: async () => {},
    SERVICE: 'mixdog',
  };
  t.mock.module('../lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });

  // Fake provider: counts every request; a request can be parked on a gate.
  const sends = [];
  let gate = null;
  const provider = {
    name: 'openai',
    contextWindow: 128000,
    async send(messages, model) {
      sends.push({ model, messages: messages.length });
      if (sends.length === 2 && gate) await gate.promise;
      return { content: `answer ${sends.length}`, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const startupRefresh = Promise.resolve();
  const realRegistry = await import('../runtime/agent/orchestrator/providers/registry.mjs?real=1');
  t.mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
    namedExports: {
      ...realRegistry,
      initProviders: async () => {},
      getProvider: () => provider,
      getAllProviders: () => new Map([['openai', provider]]),
      // The real registry memoizes the startup refresh per catalog epoch; a fresh promise per call
      // would make the readiness gate re-observe it forever.
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
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network is forbidden in the address regression test');
  });

  // The manager close cancels the session's shells. The hook below is that
  // cancellation: it fires the shell completion at the exact moment the real
  // close reaches cancelNativeTasks (after the durable tombstone, before the
  // runtime entry is cleared).
  let onShellCancel = () => {};
  const realSpawnClient = await import('../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs?real=1');
  t.mock.module('../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs', {
    namedExports: {
      ...realSpawnClient,
      cancelNativeTasks: (...args) => {
        onShellCancel(...args);
        return { confirmed: true };
      },
    },
  });

  const { createMixdogSessionRuntime } = await import('../session-runtime/runtime-core.mjs');
  const initialConfig = {
    providers: { openai: { enabled: true, apiKey: 'address-test-only', baseUrl: 'http://127.0.0.1:1/v1' } },
  };
  t.mock.module('../mixdog-session-runtime.mjs', {
    namedExports: {
      createMixdogSessionRuntime: (options) => createMixdogSessionRuntime({ ...options, initialConfig }),
    },
  });
  const { createLocalSessionRuntime } = await import('./local-session-runtime.mjs');
  const store = await import('../runtime/agent/orchestrator/session/store.mjs');
  const { loadSession, drainSessionStore } = store;

  const apis = [];
  t.after(async () => {
    try {
      for (const api of apis) await api.dispose?.().catch?.(() => {});
      drainSessionStore?.();
      // The memory runtime may try to fetch its own bundle (blocked above); the provider endpoint must never be hit.
      const urls = fetchMock.mock.calls.map((c) => String(c.arguments[0]?.url || c.arguments[0]));
      assert.deepEqual(
        urls.filter((url) => url.includes('127.0.0.1')),
        [],
        'no provider network request'
      );
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true });
    }
  });
  const open = async () => {
    const api = await createLocalSessionRuntime({ provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd });
    apis.push(api);
    return api;
  };
  const sessionFiles = () =>
    readdirSync(join(process.env.MIXDOG_DATA_DIR, 'sessions'))
      .filter((f) => f.endsWith('.json'))
      .sort();

  const A = 'sess_worker_address_A';

  // 1. canonical worker A runs a turn, then is idle-evicted.
  const first = await open();
  assert.equal(first.reserveSession(A), true);
  const firstTurn = await first.submitAndWait('hello worker', {});
  assert.equal(firstTurn.status !== 'rejected', true, JSON.stringify(firstTurn));
  assert.equal(sends.length, 1);
  await first.dispose();
  drainSessionStore();

  // 2. same-id reload (the service's load-on-demand) binds the durable address.
  const api = await open();
  assert.equal(await api.resume(A), true);
  assert.equal(api.bindSessionAddress(A), true);
  assert.equal(api.getState().sessionId, A);
  const afterReload = loadSession(A);
  assert.equal(afterReload.closed, undefined === afterReload.closed ? undefined : false);

  // 3. an old turn is in flight when the worker is cancelled.
  gate = Promise.withResolvers();
  const settled = [];
  assert.equal(api.submit('long running work', { id: 'turn-2' }), true);
  for (let i = 0; i < 200 && sends.length < 2; i += 1) await tick(10);
  assert.equal(sends.length, 2, 'the second turn reached the provider');
  assert.equal(
    api.submit('queued behind the turn', { id: 'queued-1', onSettled: (d) => settled.push(d.status) }),
    true
  );

  const shellDone = (id) => ({
    text: `<task-notification><task-id>${id}</task-id><status>cancelled</status><summary>bash cancelled</summary></task-notification>`,
    meta: { execution_id: id, status: 'cancelled', execution_surface: 'shell', caller_session_id: A },
  });
  const deliveries = [];
  const deliver = (id) => {
    const { text, meta } = shellDone(id);
    deliveries.push(api.deliverToolCompletion(A, text, meta));
  };
  onShellCancel = () => deliver('shell-during-close');

  // 4. cancel: fence → durable close → shell cancellation → completion delivered.
  const filesBefore = sessionFiles();
  assert.equal(api.closeCanonicalSession('agent cancel'), true);
  const closed = loadSession(A);
  assert.equal(closed.closed, false, 'runtime close preserves the stored conversation');
  const closedGeneration = closed.generation;
  const closedMessages = JSON.stringify(closed.messages);
  deliver('shell-after-close');

  // 5. the old turn settles and the queue drains.
  gate.resolve();
  for (let i = 0; i < 30; i += 1) await tick(10);
  await api.flushPendingWork?.();
  drainSessionStore();

  assert.equal(sends.length, 2, 'no provider request after the close');
  assert.equal(api.getState().sessionId, A, 'the entry still reports its own address');
  assert.deepEqual(sessionFiles(), filesBefore, 'no new conversation record (no ordinary Lead record)');
  const finalRecord = loadSession(A);
  assert.equal(finalRecord.closed, false);
  assert.equal(finalRecord.generation, closedGeneration, 'same generation');
  assert.equal(JSON.stringify(finalRecord.messages), closedMessages, 'same transcript');
  assert.deepEqual(settled, ['rejected'], 'the queued submission is settled explicitly');
  assert.equal(api.submit('too late'), false);
  assert.equal(api.getState().queued.length, 0);
  assert.deepEqual(
    deliveries,
    [true, true],
    'both completions reached the live listener (UI/history) and were handled'
  );
  assert.equal(api.getState().sessionId, A);
});
