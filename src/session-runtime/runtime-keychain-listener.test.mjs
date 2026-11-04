import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The keychain module is process-wide while a runtime is not: a runtime that
// subscribes to keyring recovery must unsubscribe when it closes, or every
// closed session stays reachable from the module's listener Set.
test('closing a session runtime releases its keychain recovery listener', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-keychain-listener-'));
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
    MIXDOG_PATCH_NATIVE_PREWARM: '0',
    MIXDOG_DISABLE_TOOL_PREWARM: '1',
    MIXDOG_DISABLE_PROVIDER_WARMUP: '1',
    MIXDOG_DISABLE_MODEL_CATALOG_WARMUP: '1',
  });

  let drainSessionStore;
  let settleSummaryIndexWrites;
  let settlePendingMessageWrites;
  t.after(async () => {
    try {
      drainSessionStore?.();
      await settlePendingMessageWrites?.({ throwOnTimeout: true });
      await settleSummaryIndexWrites?.();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      rmSync(root, { recursive: true, force: true });
    }
  });

  const recoveryListeners = new Set();
  const keychain = {
    getSecret: () => null,
    hasSecret: () => false,
    setSecret: () => assert.fail('unexpected credential write'),
    deleteSecret: () => assert.fail('unexpected credential deletion'),
    invalidateSecretCache: () => {},
    prewarmSecrets: async () => {},
    onKeychainRecovered(listener) {
      recoveryListeners.add(listener);
      return () => recoveryListeners.delete(listener);
    },
    SERVICE: 'mixdog',
  };
  t.mock.module('../lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });
  const startupCatalogRefresh = Promise.resolve();
  const provider = { name: 'openai', send: () => assert.fail('unexpected provider request') };
  const registry = await import('../runtime/agent/orchestrator/providers/registry.mjs?real=1');
  t.mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
    namedExports: {
      ...registry,
      initProviders: async () => {},
      getProvider: () => provider,
      getAllProviders: () => new Map([['openai', provider]]),
      // Memoized per catalog epoch like the real registry: a fresh promise per
      // call re-runs the startup refresh in an endless microtask cycle.
      refreshProviderCatalogsOnStartup: () => startupCatalogRefresh,
      refreshCatalogs: async () => {},
    },
  });
  // Lets one start fail after the readiness gate subscribed, before any API wiring.
  let failModuleLoad = false;
  const bootstrap = await import('./runtime-bootstrap.mjs?real=1');
  t.mock.module('./runtime-bootstrap.mjs', {
    namedExports: {
      ...bootstrap,
      loadRuntimeModules: async () => {
        if (failModuleLoad) throw new Error('injected module load failure');
        return bootstrap.loadRuntimeModules();
      },
    },
  });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network is forbidden in the keychain listener test');
  });

  const { createMixdogSessionRuntime } = await import('./runtime-core.mjs');
  ({ drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs'));
  ({ settleSummaryIndexWrites } = await import('../runtime/agent/orchestrator/session/store-summary-index.mjs'));
  ({ settlePendingMessageWrites } = await import('../runtime/agent/orchestrator/session/manager/pending-messages.mjs'));

  const start = () =>
    createMixdogSessionRuntime({
      provider: 'openai',
      model: 'gpt-4o-mini',
      cwd: root,
      initialConfig: { providers: { openai: { enabled: true, apiKey: 'keychain-listener-test-only' } } },
    });
  const baseline = recoveryListeners.size;
  const first = await start();
  const second = await start();
  assert.equal(recoveryListeners.size, baseline + 2, 'each live runtime listens for keyring recovery');

  await first.close('keychain-listener-test', { waitForExit: false });
  assert.equal(recoveryListeners.size, baseline + 1, 'a closed runtime no longer listens');
  await second.close('keychain-listener-test', { waitForExit: false });
  assert.equal(recoveryListeners.size, baseline, 'closing every runtime leaves the listener count unchanged');

  // A boot that fails returns no runtime to close, so the factory itself must release it.
  failModuleLoad = true;
  await assert.rejects(start(), /injected module load failure/);
  assert.equal(recoveryListeners.size, baseline, 'a failed boot leaves the listener count unchanged');
});
