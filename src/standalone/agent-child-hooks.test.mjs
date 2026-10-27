// Run with --experimental-test-module-mocks.
// A spawned agent worker is a full session runtime (standalone/session-service/
// agent-tree/agent-child.mjs): the user's hook rules must gate ITS tool calls
// too. Everything from createLocalSessionRuntime down is real; only the
// provider and the boot warmups are stand-ins (see quota-resume-session.test.mjs).
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from '../../scripts/lib/scoped-temp.mjs';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 1500; i += 1) {
    if (predicate()) return;
    await tick(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('hook rules gate the tool calls of a spawned agent worker runtime', async (t) => {
  const root = makeTempDirSync('worker-hooks');
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

  const hooksFile = join(root, 'data', 'hooks.json');
  const sends = [];
  const provider = {
    name: 'openai',
    contextWindow: 128000,
    async send(messages, _model) {
      sends.push(messages);
      if (!messages.some((message) => message.role === 'tool')) {
        return {
          content: '',
          toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: join(cwd, 'note.txt') } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return { content: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
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
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network is forbidden in the quota resume test');
  });

  const { createMixdogSessionRuntime } = await import('../session-runtime/runtime-core.mjs');
  const initialConfig = {
    providers: { openai: { enabled: true, apiKey: 'quota-test-only', baseUrl: 'http://127.0.0.1:1/v1' } },
  };
  t.mock.module('../mixdog-session-runtime.mjs', {
    namedExports: {
      createMixdogSessionRuntime: (options) => createMixdogSessionRuntime({ ...options, initialConfig }),
    },
  });
  const { createLocalSessionRuntime } = await import('./local-session-runtime.mjs');
  const { drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs');
  writeFileSync(join(cwd, 'note.txt'), 'NOTE-CANARY');
  mkdirSync(join(root, 'data'), { recursive: true });

  let api = null;
  t.after(async () => {
    try {
      await api?.dispose?.().catch?.(() => {});
      drainSessionStore?.();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  // One worker runtime per scenario: its tool result is what the model sees next.
  // `decide(api)` answers the approval card an ask rule raises.
  async function workerRead(sessionId, rules, decide = null) {
    writeFileSync(hooksFile, JSON.stringify({ toolBefore: rules }));
    const before = sends.length;
    api = await createLocalSessionRuntime({
      provider: 'openai',
      model: 'gpt-4o-mini',
      toolMode: 'full',
      cwd,
      sessionProfile: {
        owner: 'agent',
        agent: 'worker',
        parentSessionId: 'sess_parent_lead',
        ownerSessionId: 'sess_parent_lead',
        sourceType: 'agent',
      },
    });
    assert.equal(api.reserveSession(sessionId), true);
    const asked = [];
    const turnDone = api.submitAndWait('read the note', {});
    if (decide) {
      await until(() => api.getState().toolApproval, 'the approval card');
      const card = api.getState().toolApproval;
      asked.push({ name: card.name, reason: card.reason });
      api.resolveToolApproval(card.id, decide);
    }
    assert.equal((await turnDone).status, 'done');
    const toolMessage = sends[before + 1].findLast((message) => message.role === 'tool');
    const text = String(
      typeof toolMessage?.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage?.content)
    );
    await api.dispose();
    api = null;
    return { text, asked };
  }

  const denied = await workerRead('sess_worker_deny', [
    { tool: 'read', action: 'deny', reason: 'no reading in workers' },
  ]);
  assert.match(denied.text, /denied by hook: no reading in workers/);
  assert.doesNotMatch(denied.text, /NOTE-CANARY/);

  // An ask rule puts the call to the user: refused when they say no ...
  const ask = [{ tool: 'read', action: 'ask', reason: 'confirm reads' }];
  const refused = await workerRead('sess_worker_no', ask, { approved: false, reason: 'not now' });
  assert.deepEqual(refused.asked, [{ name: 'read', reason: 'confirm reads' }]);
  assert.doesNotMatch(refused.text, /NOTE-CANARY/);
  // ... and run only once they say yes.
  const allowed = await workerRead('sess_worker_yes', ask, { approved: true });
  assert.deepEqual(allowed.asked, [{ name: 'read', reason: 'confirm reads' }]);
  assert.match(allowed.text, /NOTE-CANARY/);

  const unaffected = await workerRead('sess_worker_free', [{ tool: 'shell', action: 'deny', reason: 'no shell' }]);
  assert.deepEqual(unaffected.asked, []);
  assert.match(unaffected.text, /NOTE-CANARY/);
  assert.doesNotMatch(unaffected.text, /denied by hook/);
});
