// Run with --experimental-test-module-mocks.
// Real-trigger path of quota auto-resume: a provider send fails on exhausted
// quota inside a real local session runtime, the turn settles, the resume is
// queued with the Goal it suspended, and a fire replays the prompt as the
// failed-turn retry on the revived Goal. Everything from
// createLocalSessionRuntime down is real; only the provider and the boot
// warmups are stand-ins (see session-address-regression.test.mjs).
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const RESET_AT = Date.now() + 3_600_000;

// Up to 15 s: a whole Goal turn settles inside one wait, and a loaded arm64
// runner has needed more than 3 s for it.
async function until(predicate, label) {
  for (let i = 0; i < 1500; i += 1) {
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
      sends.push({ model, messages: messages.length, lastUser: users.at(-1)?.content, users: users.length });
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
  const store = await import('../runtime/shared/quota-resume-store.mjs');
  const { drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs');
  const { restoreTranscriptItems } = await import(
    '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs'
  );
  store.reloadQuotaResumeStore();

  let api = null;
  t.after(async () => {
    try {
      await api?.dispose();
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
  assert.equal(turndone.quota.resetAt, RESET_AT);
  assert.equal(entry.turnKey, `attempt:${turndone.attemptId}`);
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

  await api.setRoute({ provider: 'openai', model: 'gpt-4o' });
  assert.equal(store.quotaResumeEntry(S).generation, entry.generation, 'model switching preserves the reservation');
  assert.equal(await api.fireQuotaResume({ generation: entry.generation }), 'fired');
  assert.equal(await api.retryFailedTurn(S, entry.turnKey), false, 'a late manual click cannot enqueue a second retry');
  assert.equal(store.quotaResumeEntry(S), null);
  await until(() => api.getState().quotaResume === null, 'the snapshot field to clear');
  await until(() => sends.length >= sendsBefore + 2, 'the retry request');
  const retry = sends[sendsBefore + 1];
  assert.equal(retry.model, 'gpt-4o', 'the reserved retry uses the newly selected model');
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
  assert.match(goalEntry.turnKey, /^attempt:/);
  assert.equal(store.quotaSuspendedGoal(G, goalEntry.turnKey), lexerGoalId);
  const usersBefore = api.getState().items.filter((item) => item.kind === 'user').length;
  const goalSendsBefore = sends.length;
  assert.equal(await api.retryFailedTurn(G, goalEntry.turnKey), true);
  assert.equal(api.fireQuotaResume({ generation: goalEntry.generation }), 'stale');
  assert.equal(store.quotaResumeEntry(G), null);
  await until(() => sends.length > goalSendsBefore, 'the Goal continuation request');
  // Provider dispatch reads the synchronous draft; getState exposes the
  // frame-batched snapshot, which can still show the suspended Goal here.
  await until(
    () => api.getState().goal?.id === lexerGoalId && api.getState().goal.status === 'active',
    'the revived Goal snapshot'
  );
  assert.equal(api.getState().goal.id, lexerGoalId);
  assert.notEqual(api.getState().goal.status, 'usage_limited');
  assert.equal(
    api.getState().items.filter((item) => item.kind === 'user').length,
    usersBefore,
    'no prompt is replayed for a Goal turn'
  );
  await until(() => !api.getState().busy && api.getState().queued.length === 0, 'the Goal session to go idle');
  await api.dispose();
  api = await createLocalSessionRuntime({ provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd });
  const N = 'sess_quota_resume_notification';
  assert.equal(api.reserveSession(N), true);
  exhausted = true;
  const notification = '<system-reminder>Internal task completed. Summarize the retained result.</system-reminder>';
  const stopped = await api.submitAndWait(notification, { mode: 'task-notification' });
  assert.equal(stopped.status, 'failed');
  const notificationEntry = store.quotaResumeEntry(N);
  assert.ok(notificationEntry, 'notification-only failure is eligible for automatic resume');
  const beforeRetry = sends.at(-1);
  await until(() => !api.getState().busy && api.getState().queued.length === 0, 'notification settlement');
  await tick();
  assert.equal(
    await api.retryFailedTurn(N, notificationEntry.turnKey),
    true,
    JSON.stringify({
      entry: notificationEntry,
      items: api.getState().items,
      messages: (await api.readModelMessages()).messages.slice(-1),
    })
  );
  await until(() => sends.at(-1) !== beforeRetry && !api.getState().busy, 'notification retry');
  assert.equal(sends.at(-1).lastUser, beforeRetry.lastUser, 'retained notification and context are reused verbatim');
  assert.equal(sends.at(-1).users, beforeRetry.users, 'notification is not appended twice');
  assert.equal(store.quotaResumeEntry(N), null);
  const notificationGoal = await api.goalControl({ action: 'create', objective: 'Summarize completed work' });
  await until(() => !api.getState().busy && api.getState().queued.length === 0, 'notification Goal idle');
  exhausted = true;
  const automaticFailure = await api.submitAndWait(notification, { mode: 'task-notification' });
  assert.equal(automaticFailure.status, 'failed');
  await tick();
  const automaticEntry = store.quotaResumeEntry(N);
  assert.ok(automaticEntry);
  await until(
    () => store.quotaSuspendedGoal(N, automaticEntry.turnKey) === notificationGoal.goal.id,
    'notification Goal suspended'
  );
  await api.dispose();
  api = await createLocalSessionRuntime({ provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd });
  assert.equal(await api.resume(N), true);
  assert.equal(store.quotaResumeEntry(N).turnKey, automaticEntry.turnKey);
  const automaticBefore = sends.at(-1);
  const automaticRetryIndex = sends.length;
  assert.equal(await api.fireQuotaResume({ generation: automaticEntry.generation }), 'fired');
  await until(() => sends.length > automaticRetryIndex && !api.getState().busy, 'automatic notification retry');
  // The revived Goal may dispatch another turn before the idle snapshot is
  // observed. Inspect this retry, not whichever provider send happened last.
  const automaticRetry = sends[automaticRetryIndex];
  assert.equal(automaticRetry.lastUser, automaticBefore.lastUser);
  assert.equal(automaticRetry.users, automaticBefore.users);
  assert.equal(store.quotaResumeEntry(N), null);
  const durableMessages = (await api.readModelMessages()).messages;
  const restored = restoreTranscriptItems(durableMessages, { sessionId: N });
  const failures = restored.filter((item) => item.kind === 'turndone' && item.status === 'failed');
  assert.equal(failures.length, 2, 'both failed attempts remain in restored history after successful retries');
  assert.equal(new Set(failures.map((item) => item.attemptId)).size, 2);
  assert.deepEqual(restoreTranscriptItems(durableMessages, { sessionId: N, itemLimit: 2 }), restored.slice(-2));
});
