// Run with --experimental-test-module-mocks.
// A worker's status follows every turn it runs, whoever queued it (#319): a
// follow-up queued behind a send, the next one a same-tag rerun queues behind
// that, a steered message, and the in-process route's follow-ups. The agent
// tool, the session service and the worker's session runtime are real; only
// the provider and the boot warmups are stand-ins.
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { makeTempDirSync } from '../../scripts/lib/scoped-temp.mjs';

const root = makeTempDirSync('worker-turn-status');
const cwd = join(root, 'work');
mkdirSync(cwd);
mkdirSync(join(root, 'data'), { recursive: true });
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
  // A turn with no first output stalls out within the test.
  MIXDOG_AGENT_FIRST_RESPONSE_TIMEOUT_MS: '2500',
  MIXDOG_AGENT_FIRST_VISIBLE_TIMEOUT_MS: '2500',
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await tick(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Each prompt names its marker; the provider answers a request by the marker
// of its last user message. A held request waits for the test (or its abort).
const behaviors = new Map();
const userText = (message) =>
  typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');

function hold(marker) {
  const gate = deferred();
  const started = deferred();
  behaviors.set(marker, async (opts = {}) => {
    // As a provider does once its request is admitted.
    opts.onStageChange?.('requesting');
    started.resolve(Date.now());
    const signal = opts.signal;
    if (signal?.aborted) throw signal.reason;
    return await new Promise((resolve, reject) => {
      signal?.addEventListener?.('abort', () => reject(signal.reason), { once: true });
      gate.promise.then(resolve, reject);
    });
  });
  return {
    started: started.promise,
    release: (response = { content: `answer ${marker}` }) =>
      gate.resolve({ usage: { inputTokens: 10, outputTokens: 5 }, ...response }),
    fail: () => gate.reject(Object.assign(new Error(`invalid_request_error: ${marker} rejected`), { status: 400 })),
  };
}

const provider = {
  name: 'openai',
  contextWindow: 128000,
  async send(messages, _model, _tools, opts = {}) {
    const text = userText(messages.filter((message) => message.role === 'user').at(-1));
    for (const [marker, behavior] of behaviors) {
      if (text.includes(marker)) return await behavior(opts, messages);
    }
    return { content: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
  },
};

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
mock.module('../lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });
// The next Computer Use release at a turn's settlement (its post-ask cleanup)
// waits for the test.
let cleanupHold = null;
function holdCleanup() {
  cleanupHold = { entered: deferred(), gate: deferred() };
  return { entered: cleanupHold.entered.promise, release: cleanupHold.gate.resolve };
}
const realComputer = await import('../runtime/computer-bridge/client.mjs?real=1');
mock.module('../runtime/computer-bridge/client.mjs', {
  namedExports: {
    ...realComputer,
    endComputerExecution: async (sessionId) => {
      const held = cleanupHold;
      if (held) {
        cleanupHold = null;
        held.entered.resolve();
        await held.gate.promise;
      }
      return realComputer.endComputerExecution(sessionId);
    },
  },
});
const startupRefresh = Promise.resolve();
const realRegistry = await import('../runtime/agent/orchestrator/providers/registry.mjs?real=1');
const registry = {
  ...realRegistry,
  initProviders: async () => {},
  getProvider: () => provider,
  getAllProviders: () => new Map([['openai', provider]]),
  refreshProviderCatalogsOnStartup: () => startupRefresh,
  refreshCatalogs: async () => {},
};
mock.module('../runtime/agent/orchestrator/providers/registry.mjs', { namedExports: registry });
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
        refreshStatuslineUsageAfterTurn: noop,
        wakeDeferredWarmups: noop,
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
        wakeDeferredPrewarms: noop,
      }),
    },
  ],
  [
    '../session-runtime/self-update.mjs',
    { createSelfUpdateController: () => ({ startBootCheck: noop, stopBootCheck: noop }) },
  ],
]) {
  mock.module(path, { namedExports: exports });
}
mock.method(globalThis, 'fetch', () => {
  throw new Error('network is forbidden in the worker turn status test');
});
const initialConfig = {
  providers: { openai: { enabled: true, apiKey: 'status-test-only', baseUrl: 'http://127.0.0.1:1/v1' } },
};
const { createMixdogSessionRuntime } = await import('../session-runtime/runtime-core.mjs');
mock.module('../mixdog-session-runtime.mjs', {
  namedExports: {
    createMixdogSessionRuntime: (options) => createMixdogSessionRuntime({ ...options, initialConfig }),
  },
});

const { createLocalSessionRuntime } = await import('./local-session-runtime.mjs');
const { createSessionService } = await import('./session-service.mjs');
const { createStandaloneAgent } = await import('../session-runtime/services/agent-tool.mjs');
const { flushAllIndexWrites } = await import('../session-runtime/services/agent-tool/index-write-queue.mjs');
const { cleanupBackgroundTasks } = await import('../runtime/shared/background-tasks.mjs');
const { createTagRegistry } = await import('../session-runtime/services/agent-tool/tag-registry.mjs');
const manager = await import('../runtime/agent/orchestrator/session/manager.mjs');
const { drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs');

const config = {
  default: 'main',
  providers: initialConfig.providers,
  presets: [{ id: 'main', name: 'Main', provider: 'openai', model: 'gpt-4o-mini', tools: 'full' }],
};
const cfgMod = {
  loadConfig: () => config,
  getPluginData: () => process.env.MIXDOG_DATA_DIR,
  resolveRuntimeSpec: (_preset, { lane, agentId }) => ({ lane, scopeKey: `${lane}:${agentId}` }),
};

const service = createSessionService({
  createSessionRuntime: (options) => createLocalSessionRuntime({ ...options, cwd }),
  sessionExists: async () => false,
  readStoredSession: async () => null,
  listSessions: async () => [],
});
const agentOptions = {
  cfgMod,
  reg: registry,
  dataDir: process.env.MIXDOG_DATA_DIR,
  cwd,
  awaitKeychainPrewarm: async () => {},
  isKeychainPrewarmReady: () => true,
  notifySessionCompletion: () => true,
};
// Every progress-watchdog stop the canonical route's turns receive, by session.
const watchdogStops = [];
const canonicalManager = {
  ...service.agentManager,
  linkParentSignalToSession(sessionId, signal) {
    signal.addEventListener('abort', () => watchdogStops.push(sessionId), { once: true });
    return service.agentManager.linkParentSignalToSession(sessionId, signal);
  },
};
const canonical = createStandaloneAgent({
  ...agentOptions,
  mgr: canonicalManager,
  sessionSurface: service.agentSurface,
});
const inProcess = createStandaloneAgent({ ...agentOptions, mgr: manager });

test.after(async () => {
  try {
    cleanupBackgroundTasks({ surface: 'agent', force: true });
    canonical.dispose?.();
    inProcess.dispose?.();
    await service.stop('test complete');
    await flushAllIndexWrites();
    drainSessionStore?.();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const context = {
  callerSessionId: 'sess_status_root',
  ownerSessionId: 'sess_status_root',
  callerCwd: cwd,
  clientHostPid: process.pid,
};
const taskIdOf = (output) => /^agent task:\s*(\S+)/m.exec(output)?.[1] || null;
// The worker rows as stored, settled ones included (the status pulse lists only active ones).
const rows = createTagRegistry({ dataDir: process.env.MIXDOG_DATA_DIR, cfgMod, mgr: manager });
const row = (_agent, tag) => rows.readWorkerRows({}).find((worker) => worker.tag === tag) || null;
const startedAtOf = (worker) => Date.parse(worker?.turnStartedAt || '') || 0;

async function taskStatus(agent, taskId) {
  const output = await agent.execute({ type: 'read', task_id: taskId }, context);
  return /^status:\s*(\S+)/m.exec(output)?.[1] || '';
}

async function untilTask(agent, taskId, pattern) {
  return until(async () => pattern.test(await taskStatus(agent, taskId)), `task ${taskId} ${pattern}`);
}

/** Spawns `tag` on a held first turn and queues `next` behind it. */
async function spawnBusy(agent, tag, first, next) {
  const firstHold = hold(first);
  const spawned = await agent.execute({ type: 'spawn', tag, agent: 'worker', prompt: `do ${first}` }, context);
  const taskId = taskIdOf(spawned);
  assert.ok(taskId, spawned);
  await firstHold.started;
  const queued = await agent.execute({ type: 'send', tag, message: `then ${next}` }, context);
  assert.match(queued, /queued/);
  return { firstHold, taskId };
}

/** The worker row reads running, stamped by a turn that started inside [after, before]. */
function assertRunningFrom(worker, after, before, label) {
  assert.equal(worker?.status, 'running', `${label}: ${JSON.stringify(worker)}`);
  const startedAt = startedAtOf(worker);
  assert.ok(startedAt >= after && startedAt <= before, `${label}: started at ${worker?.turnStartedAt}`);
}

/** The first turn fails; the follow-up queued behind it then runs as its own
 *  turn (the failed turn's queued input runs next) and is held there. */
async function followUpAfterFailure(agent, tag, n) {
  const followUp = hold(`FOLLOW-${n}`);
  const { firstHold, taskId } = await spawnBusy(agent, tag, `FIRST-${n}`, `FOLLOW-${n}`);
  const failedAt = Date.now();
  firstHold.fail();
  const followStart = await followUp.started;
  // The failed send settles its task after the follow-up started.
  await untilTask(agent, taskId, /failed/);
  await tick(50);
  return { followUp, failedAt, followStart };
}

test('a follow-up queued behind a failed send reads running from its own start, with no output yet', async () => {
  const { followUp, failedAt, followStart } = await followUpAfterFailure(canonical, 'w-rerun', 1);
  assertRunningFrom(row(canonical, 'w-rerun'), failedAt, followStart, 'queued follow-up');

  // A same-tag rerun queues behind it: admission leaves the running turn as it is,
  // and steered into it at its end it continues that turn on the same clock.
  const before = row(canonical, 'w-rerun');
  const rerun = hold('RERUN-1');
  const queued = await canonical.execute({ type: 'send', tag: 'w-rerun', message: 'again RERUN-1' }, context);
  assert.match(queued, /queued/);
  assert.deepEqual(
    { status: row(canonical, 'w-rerun').status, turnStartedAt: row(canonical, 'w-rerun').turnStartedAt },
    { status: 'running', turnStartedAt: before.turnStartedAt }
  );
  followUp.release();
  await rerun.started;
  await tick(50);
  assert.deepEqual(
    { status: row(canonical, 'w-rerun').status, turnStartedAt: row(canonical, 'w-rerun').turnStartedAt },
    { status: 'running', turnStartedAt: before.turnStartedAt },
    'the steered rerun did not restart the clock'
  );
  rerun.release();
  await until(() => row(canonical, 'w-rerun')?.status === 'idle', 'the follow-up settles idle');
});

test('a queued follow-up that fails before any output settles the worker as error', async () => {
  const { followUp, failedAt, followStart } = await followUpAfterFailure(canonical, 'w-fail', 2);
  assertRunningFrom(row(canonical, 'w-fail'), failedAt, followStart, 'queued follow-up');
  followUp.fail();
  await until(() => row(canonical, 'w-fail')?.status === 'error', 'the follow-up settles error');
});

test('a queued follow-up stopped from its pane settles the worker as error, as a stopped send does', async () => {
  const { failedAt, followStart } = await followUpAfterFailure(canonical, 'w-cancel', 3);
  const worker = row(canonical, 'w-cancel');
  assertRunningFrom(worker, failedAt, followStart, 'queued follow-up');
  await service.abortSession({ sessionId: worker.sessionId });
  await until(() => row(canonical, 'w-cancel')?.status === 'error', 'the follow-up settles error');
});

test('a queued follow-up with no first output is stopped by the watchdog and reads failed/stalled', async () => {
  const { failedAt, followStart } = await followUpAfterFailure(canonical, 'w-stall', 4);
  assertRunningFrom(row(canonical, 'w-stall'), failedAt, followStart, 'queued follow-up');
  const stalled = await until(() => {
    const worker = row(canonical, 'w-stall');
    return worker?.status === 'failed' ? worker : null;
  }, 'the watchdog stops the follow-up');
  assert.equal(stalled.failureReason, 'stalled');
});

test('a turn still in its cleanup after its ask, past the idle budget, settles idle and is never stopped as stale', async () => {
  const model = hold('CLEANUP-6');
  const spawned = await canonical.execute(
    { type: 'spawn', tag: 'w-cleanup', agent: 'worker', prompt: 'do CLEANUP-6' },
    context
  );
  const taskId = taskIdOf(spawned);
  await model.started;
  const cleanup = holdCleanup();
  model.release();
  await cleanup.entered;
  // The ask is over: its runtime entry is gone, the settlement is not reported yet.
  const { sessionId } = row(canonical, 'w-cleanup');
  assert.equal(manager.getSessionProgressSnapshot(sessionId), null);
  assert.equal(row(canonical, 'w-cleanup').status, 'running');
  // Sweeps during the cleanup see a clock an hour past the turn's start.
  const realNow = Date.now.bind(Date);
  const shifted = mock.method(Date, 'now', () => realNow() + 60 * 60_000);
  try {
    await tick(3_500);
  } finally {
    shifted.mock.restore();
  }
  assert.deepEqual(
    watchdogStops.filter((id) => id === sessionId),
    [],
    'no watchdog stop reached the finished turn'
  );
  cleanup.release();
  await untilTask(canonical, taskId, /completed|failed|cancelled/);
  assert.equal(await taskStatus(canonical, taskId), 'completed');
  const settled = await until(() => {
    const worker = row(canonical, 'w-cleanup');
    return worker?.status !== 'running' ? worker : null;
  }, 'the turn settles');
  assert.deepEqual(
    { status: settled.status, failureReason: settled.failureReason ?? null },
    {
      status: 'idle',
      failureReason: null,
    }
  );
});

test('a turn whose model work never ends is still stopped by the watchdog and reads failed/stalled', async () => {
  const model = hold('ENDLESS-7');
  await canonical.execute({ type: 'spawn', tag: 'w-endless', agent: 'worker', prompt: 'do ENDLESS-7' }, context);
  await model.started;
  const stalled = await until(() => {
    const worker = row(canonical, 'w-endless');
    return worker?.status === 'failed' ? worker : null;
  }, 'the watchdog stops the turn');
  assert.equal(stalled.failureReason, 'stalled');
});

test('in-process route: a message queued behind a send continues its turn on its clock, to its own outcome', async () => {
  const followUp = hold('FOLLOW-5');
  const spawnedAt = Date.now();
  const { firstHold, taskId } = await spawnBusy(inProcess, 'w-local', 'FIRST-5', 'FOLLOW-5');
  await tick(20);
  const before = row(inProcess, 'w-local');
  assertRunningFrom(before, spawnedAt, Date.now(), 'the send');
  firstHold.release();
  // The queued message steers into the running turn: one turn, one clock.
  await followUp.started;
  await tick(20);
  const worker = row(inProcess, 'w-local');
  assert.deepEqual(
    { status: worker.status, turnStartedAt: worker.turnStartedAt },
    { status: 'running', turnStartedAt: before.turnStartedAt }
  );
  manager.abortSessionTurn(worker.sessionId, 'pane-stop');
  await untilTask(inProcess, taskId, /completed|failed|cancelled/);
  await until(() => row(inProcess, 'w-local')?.status === 'error', 'the pane-stopped turn settles error');
});
