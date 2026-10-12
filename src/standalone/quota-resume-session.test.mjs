// Run with --experimental-test-module-mocks.
// Real-trigger path of quota auto-resume: a provider send fails on exhausted
// quota inside a real local session runtime, the turn settles, the resume is
// queued with the Goal it suspended, and a fire replays the prompt as the
// failed-turn retry on the revived Goal. Everything from
// createLocalSessionRuntime down is real; only the provider and the boot
// warmups are stand-ins (see session-address-regression.test.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const RESET_AT = Date.now() + 3_600_000;

async function until(predicate, label) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await tick(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('a quota-failed Lead or Goal turn queues its resume and a fire resumes it on the revived Goal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-quota-resume-session-'));
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

  const sends = [];
  let exhausted = false;
  const provider = {
    name: 'openai',
    contextWindow: 128000,
    async send(messages, model) {
      const users = messages.filter((message) => message.role === 'user');
      sends.push({ messages: messages.length, lastUser: users.at(-1)?.content, users: users.length });
      if (exhausted) {
        exhausted = false;
        throw Object.assign(new Error('All connected accounts have exhausted their quota.'), {
          code: 'provider_accounts_exhausted',
          quotaExhausted: { provider: 'openai', model, resetAt: RESET_AT },
        });
      }
      return { content: `answer ${sends.length}`, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const realRegistry = await import('../runtime/agent/orchestrator/providers/registry.mjs?real=1');
  t.mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
    namedExports: {
      ...realRegistry,
      initProviders: async () => {},
      getProvider: () => provider,
      getAllProviders: () => new Map([['openai', provider]]),
      refreshProviderCatalogsOnStartup: async () => {},
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
  const store = await import('../runtime/shared/quota-resume-store.mjs');
  const { drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs');
  store.reloadQuotaResumeStore();

  let api = null;
  t.after(async () => {
    try {
      await api?.dispose?.().catch?.(() => {});
      drainSessionStore?.();
    } finally {
      store.reloadQuotaResumeStore();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const S = 'sess_quota_resume_lead';
  api = await createLocalSessionRuntime({ provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd });
  assert.equal(api.reserveSession(S), true);
  const first = await api.submitAndWait('say hello', {});
  assert.equal(first.status, 'done');
  const created = await api.goalControl({ action: 'create', objective: 'Ship the parser' });
  const goalId = created.goal.id;
  await until(() => !api.getState().busy && api.getState().queued.length === 0, 'the Goal turn to settle');
  await until(() => !api.getState().busy, 'idle');
  const sendsBefore = sends.length;

  // Every publication that first shows the failed turn idle already carries
  // the queued resume: nothing can observe an idle failure without it.
  const failedFrames = [];
  const unsubscribe = api.subscribe(() => {
    const frame = api.getState();
    const last = frame.items.at(-1);
    if (!frame.busy && last?.kind === 'turndone' && last.status === 'failed') failedFrames.push(frame.quotaResume);
  });
  exhausted = true;
  const failed = await api.submitAndWait('build the parser', {});
  assert.equal(failed.status, 'failed');
  assert.ok(store.quotaResumeEntry(S), 'the resume is queued when the failed turn settles');
  unsubscribe();
  assert.ok(failedFrames.length > 0);
  assert.equal(failedFrames[0]?.state, 'waiting', 'the failed turndone and quotaResume publish together');

  const entry = store.quotaResumeEntry(S);
  const state = api.getState();
  const turndone = state.items.findLast((item) => item.kind === 'turndone');
  const user = state.items.findLast((item) => item.kind === 'user');
  assert.equal(turndone.quota.resetAt, RESET_AT);
  assert.equal(entry.turnKey, `turn:${user.id}`);
  assert.equal(entry.resetAt, RESET_AT);
  await until(() => api.getState().quotaResume?.state === 'waiting', 'the snapshot field');
  assert.deepEqual(api.getState().quotaResume, {
    state: 'waiting',
    turnKey: entry.turnKey,
    provider: 'openai',
    model: entry.model,
    resetAt: RESET_AT,
    attempts: 0,
  });
  await until(() => store.quotaSuspendedGoal(S, entry.turnKey) === goalId, 'the suspended Goal note');
  await until(() => api.getState().goal.status === 'usage_limited', 'the Goal to wait on the limit');

  assert.equal(api.fireQuotaResume({ generation: entry.generation }), 'fired');
  assert.equal(store.quotaResumeEntry(S), null);
  await until(() => api.getState().quotaResume === null, 'the snapshot field to clear');
  await until(() => sends.length >= sendsBefore + 2, 'the retry request');
  const retry = sends[sendsBefore + 1];
  const failedRequest = sends[sendsBefore];
  assert.equal(retry.lastUser, failedRequest.lastUser, 'the unanswered prompt is replayed');
  assert.equal(retry.users, failedRequest.users, 'the model sees the prompt once');
  await until(() => api.getState().goal?.id === goalId && api.getState().goal.status !== 'usage_limited', 'Goal');
  assert.equal(api.getState().goal.status, 'active');
  const retryRows = api.getState().items.filter((item) => item.kind === 'user' && item.text === 'build the parser');
  assert.equal(retryRows.length, 1, 'the failed turn rows are rewound for the replay');
  await until(() => !api.getState().busy && api.getState().queued.length === 0, 'the session to go idle');

  // An automatic Goal turn has no user row to replay: the resume revives its
  // Goal and the Goal's own continuation runs the turn.
  const G = 'sess_quota_resume_goal';
  await api.dispose();
  api = await createLocalSessionRuntime({ provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd });
  assert.equal(api.reserveSession(G), true);
  exhausted = true;
  const goalTurn = await api.goalControl({ action: 'create', objective: 'Write the lexer' });
  const lexerGoalId = goalTurn.goal.id;
  await until(() => store.quotaResumeEntry(G) !== null && !api.getState().busy, 'the Goal turn resume');
  await until(() => api.getState().goal?.status === 'usage_limited', 'the Goal to wait on the limit');
  const goalEntry = store.quotaResumeEntry(G);
  assert.match(goalEntry.turnKey, /^segment:/);
  assert.equal(store.quotaSuspendedGoal(G, goalEntry.turnKey), lexerGoalId);
  const usersBefore = api.getState().items.filter((item) => item.kind === 'user').length;
  const goalSendsBefore = sends.length;
  assert.equal(api.fireQuotaResume({ generation: goalEntry.generation }), 'fired');
  assert.equal(store.quotaResumeEntry(G), null);
  await until(() => sends.length > goalSendsBefore, 'the Goal continuation request');
  assert.equal(api.getState().goal.id, lexerGoalId);
  assert.notEqual(api.getState().goal.status, 'usage_limited');
  assert.equal(
    api.getState().items.filter((item) => item.kind === 'user').length,
    usersBefore,
    'no prompt is replayed for a Goal turn'
  );
  await until(() => !api.getState().busy && api.getState().queued.length === 0, 'the Goal session to go idle');
});
