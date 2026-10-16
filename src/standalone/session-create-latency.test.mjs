// Session creation latency and event-loop blocking, measured end to end in
// process: createLocalSessionRuntime → reserve → first turn → first durable
// save, plus the skills status listing, on a store seeded with a realistic
// skill set. A 5ms loop-lag sampler runs the whole time; any synchronous
// stretch blocks it. Only the provider, network and background warmups are
// stand-ins (they are scheduled after the reply and would add noise).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupTempDirs, tempDir } from '../runtime/shared/worktrees/test-support.mjs';

const WARM_CREATE_BUDGET_MS = 300;
const LOOP_BLOCK_BUDGET_MS = 200;
const SKILL_COUNT = 120;

/** Fine-grained loop-lag sampler: the largest gap between 5ms ticks. */
function startLagSampler(intervalMs = 5) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    reset() {
      last = performance.now();
      max = 0;
    },
    stop() {
      clearInterval(timer);
      return max;
    },
    get max() {
      return max;
    },
  };
}

test('warm session creation stays under budget without blocking the event loop', async (t) => {
  const root = tempDir('mixdog-create-latency-');
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
  for (let i = 0; i < SKILL_COUNT; i += 1) {
    const dir = join(root, 'data', 'skills', `seeded-skill-${i}`);
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: seeded-skill-${i}\ndescription: Seeded ${i}.\nwhenToUse: When ${i}.\n---\n\n# Body\n${'text '.repeat(200)}\n`
    );
    for (let j = 0; j < 4; j += 1) writeFileSync(join(dir, 'scripts', 'lib', `part-${j}.json`), '{}');
  }

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
  const provider = {
    name: 'openai',
    contextWindow: 128000,
    async send() {
      return { content: 'answer', usage: { inputTokens: 10, outputTokens: 5 } };
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
    throw new Error('network is forbidden in the latency test');
  });

  const { createMixdogSessionRuntime } = await import('../session-runtime/runtime-core.mjs');
  const initialConfig = {
    providers: { openai: { enabled: true, apiKey: 'latency-test-only', baseUrl: 'http://127.0.0.1:1/v1' } },
  };
  t.mock.module('../mixdog-session-runtime.mjs', {
    namedExports: {
      createMixdogSessionRuntime: (options) => createMixdogSessionRuntime({ ...options, initialConfig }),
    },
  });
  const { createLocalSessionRuntime } = await import('./local-session-runtime.mjs');
  const { drainSessionStore, loadSession } = await import('../runtime/agent/orchestrator/session/store.mjs');

  const { settleSessionSummaryIndex } = await import('../runtime/agent/orchestrator/session/store/listing.mjs');
  const { settleSessionPresence } = await import('../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs');
  const { settlePendingMessageWrites } = await import(
    '../runtime/agent/orchestrator/session/manager/pending-messages.mjs'
  );
  const { settleTurnJournalWrites } = await import(
    '../runtime/agent/orchestrator/session/manager/turn-checkpoint-journal.mjs'
  );
  const { settleGatewayUsageWrites } = await import('../vendor/statusline/src/gateway/route-meta.mjs');
  const { stopOwnedPgForShutdown } = await import('../runtime/memory/lib/pg/supervisor.mjs');

  const apis = [];
  const sessionIds = [];
  const lag = startLagSampler();
  t.after(async () => {
    try {
      lag.stop();
      // Every writer into the temp data dir settles while the env still points
      // there: runtime close (sessions, stops), store saves, then the
      // background writers the turns started.
      for (const api of apis) await api.dispose();
      drainSessionStore();
      // Each completed turn's session-search ingest ensures the embedded PG,
      // whose runtime install stages under data/runtime. Stopping latches the
      // process against new starts and awaits the one under way.
      await stopOwnedPgForShutdown();
      for (const id of sessionIds) {
        await settleSessionPresence(id);
        assert.equal(await settleTurnJournalWrites(id), true);
      }
      await settlePendingMessageWrites({ throwOnTimeout: true });
      await settleGatewayUsageWrites();
      await settleSessionSummaryIndex();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      cleanupTempDirs();
    }
    assert.equal(existsSync(root), false, 'the temp root was removed');
  });

  /** One full creation: runtime, reserved address, first turn, first save. */
  async function createOne(index) {
    const startedAt = performance.now();
    const api = await createLocalSessionRuntime({ provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', cwd });
    apis.push(api);
    const id = `sess_latency_${index}`;
    sessionIds.push(id);
    assert.equal(api.reserveSession(id), true);
    const createdMs = performance.now() - startedAt;
    const turn = await api.submitAndWait(`hello ${index}`, {});
    assert.equal(turn.status, 'done', JSON.stringify(turn));
    drainSessionStore();
    assert.ok(loadSession(id)?.messages?.length > 0, 'the first save landed');
    return { createdMs, firstSaveMs: performance.now() - startedAt };
  }

  // Warm state: the first creation does one-time work (cold skill parse, tool
  // runtime probe) whose follow-ups land during the second — the skill root
  // watcher reports the first parse's own file reads and the root is walked
  // once more. Only creations after both are measured as warm.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  for (const warm of ['warm-1', 'warm-2']) {
    await createOne(warm);
    await tick();
  }
  lag.reset();
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    runs.push(await createOne(i));
    await tick();
  }
  const createLag = lag.max;

  // The skills listing a UI polls: cold once, then served from the watched cache.
  const status = apis[0].skillsStatus();
  assert.equal(status.skills.filter((skill) => skill.name.startsWith('seeded-skill-')).length, SKILL_COUNT);
  await tick();
  lag.reset();
  const skillsMs = [];
  for (let i = 0; i < 5; i += 1) {
    const startedAt = performance.now();
    assert.deepEqual(apis[0].skillsStatus(), status);
    skillsMs.push(performance.now() - startedAt);
    await tick();
  }
  const skillsLag = lag.max;

  const report = {
    createMs: runs.map((run) => Math.round(run.createdMs)),
    firstSaveMs: runs.map((run) => Math.round(run.firstSaveMs)),
    createLagMs: Math.round(createLag),
    skillsStatusMs: skillsMs.map((ms) => Math.round(ms)),
    skillsLagMs: Math.round(skillsLag),
  };
  t.diagnostic(JSON.stringify(report));
  for (const run of runs) assert.ok(run.createdMs < WARM_CREATE_BUDGET_MS, JSON.stringify(report));
  assert.ok(createLag < LOOP_BLOCK_BUDGET_MS, JSON.stringify(report));
  assert.ok(skillsLag < LOOP_BLOCK_BUDGET_MS, JSON.stringify(report));
});
