import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('cwd internal tool stays bound to its caller when another runtime owns the shared executor', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-routing-'));
  const cwdA = join(root, 'a');
  const cwdB = join(root, 'b');
  const cwdNext = join(root, 'next');
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  mkdirSync(cwdNext);
  const previousEnv = { ...process.env };
  // Runtime imports cache paths and can probe credentials. Keep only process
  // plumbing, then install sandbox roots before importing any runtime module.
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(key)) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.APPDATA = join(root, 'appdata');
  process.env.LOCALAPPDATA = join(root, 'localappdata');
  process.env.MIXDOG_HOME = join(root, 'home');
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_CONFIG_DIR = join(root, 'config');
  process.env.MIXDOG_SESSION_CWD = 'process-global-must-not-change';
  process.env.MIXDOG_DISABLE_MCP = '1';

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
  const provider = { name: 'openai', send: () => assert.fail('unexpected provider request') };
  t.mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
    namedExports: {
      initProviders: async () => {},
      getProvider: () => provider,
      getAllProviders: () => new Map([['openai', provider]]),
      providerInputExcludesCache: () => false,
      providerCatalogRevision: () => 0,
      refreshProviderCatalogsOnStartup: async () => {},
      refreshCatalogs: async () => {},
      disableProvider: noop,
    },
  });
  t.mock.module('./warmup-schedulers.mjs', {
    namedExports: {
      createWarmupSchedulers: () => ({
        scheduleProviderWarmup: noop,
        scheduleProviderSetupWarmup: noop,
        scheduleProviderModelWarmup: noop,
        scheduleModelCatalogWarmup: noop,
        scheduleStatuslineUsageWarmup: noop,
        scheduleStatuslineUsageRefresh: noop,
      }),
    },
  });
  t.mock.module('./prewarm.mjs', {
    namedExports: {
      createPrewarmSchedulers: () => ({
        scheduleCodeGraphPrewarm: noop,
        scheduleToolRuntimeWarmup: noop,
        scheduleSearchRuntimeWarmup: noop,
        invokeChannelStart: noop,
        scheduleChannelStart: noop,
        scheduleAutomationAutostart: noop,
      }),
    },
  });
  t.mock.module('./self-update.mjs', {
    namedExports: { createSelfUpdateController: () => ({ startBootCheck: noop, stopBootCheck: noop }) },
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network is forbidden in the cwd routing test');
  });
  let runtimeA;
  let runtimeB;
  let restored;
  let drainSessionStore;
  t.after(async () => {
    try {
      await Promise.all([
        runtimeA?.close('cwd-routing-test', { waitForExit: false }),
        runtimeB?.close('cwd-routing-test', { waitForExit: false }),
        restored?.close('cwd-routing-test', { waitForExit: false }),
      ]);
      drainSessionStore?.();
      assert.equal(fetchMock.mock.callCount(), 0, 'no network requests during runtime creation or teardown');
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true });
    }
  });
  const { createMixdogSessionRuntime } = await import('./runtime-core.mjs');
  const { executeTool } = await import('../runtime/agent/orchestrator/session/loop/tool-exec.mjs');
  ({ drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs'));
  const options = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    toolMode: 'full',
    initialConfig: {
      providers: { openai: { enabled: true, apiKey: 'cwd-test-only', baseUrl: 'http://127.0.0.1:1/v1' } },
    },
  };
  runtimeA = await createMixdogSessionRuntime({
    ...options,
    cwd: cwdA,
    desktopSession: { classification: 'project', projectPath: cwdA },
  });
  runtimeB = await createMixdogSessionRuntime({ ...options, cwd: cwdB });
  await runtimeA.newSession();

  // runtimeB registered the process-global internal-tool executor last. The
  // call still belongs to runtimeA and must neither report nor mutate B.
  const callerSession = runtimeA.session;
  callerSession.messages.push({ role: 'user', content: 'Keep this conversation across reentry.' });
  const getResult = JSON.parse(await executeTool('cwd', {}, cwdA, callerSession.id, callerSession));
  assert.equal(getResult.cwd, cwdA);
  assert.equal(getResult.sessionId, callerSession.id);

  const setResult = JSON.parse(await executeTool('cwd', { path: cwdNext }, cwdA, callerSession.id, callerSession));
  assert.equal(setResult.cwd, cwdNext);
  assert.equal(setResult.sessionId, callerSession.id);
  assert.equal(runtimeA.cwd, cwdNext);
  assert.equal(callerSession.cwd, cwdNext);
  assert.deepEqual(callerSession.desktopSession, { classification: 'project', projectPath: cwdNext });
  assert.equal(runtimeB.cwd, cwdB);
  assert.equal(process.env.MIXDOG_SESSION_CWD, 'process-global-must-not-change');

  drainSessionStore();
  const persisted = JSON.parse(
    readFileSync(join(process.env.MIXDOG_DATA_DIR, 'sessions', `${callerSession.id}.json`), 'utf8')
  );
  assert.equal(persisted.cwd, cwdNext);
  assert.deepEqual(persisted.desktopSession, callerSession.desktopSession);
  assert.ok(persisted.messages.some((message) => message.content === 'Keep this conversation across reentry.'));
  await runtimeA.close('cwd-routing-reentry', { waitForExit: false });
  restored = await createMixdogSessionRuntime({
    ...options,
    cwd: cwdA,
    desktopSession: { classification: 'project', projectPath: cwdA },
  });
  await restored.resume(callerSession.id);
  assert.equal(restored.cwd, cwdNext);
  assert.deepEqual(restored.session.desktopSession, { classification: 'project', projectPath: cwdNext });
  const returned = JSON.parse(await executeTool('cwd', { path: cwdA }, cwdNext, restored.id, restored.session));
  assert.equal(returned.cwd, cwdA);
  assert.equal(restored.cwd, cwdA);
  assert.deepEqual(restored.session.desktopSession, { classification: 'project', projectPath: cwdA });
  assert.equal(runtimeB.cwd, cwdB);
});
