import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime creation preserves the route Auto effort choice in the agent session', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-auto-effort-'));
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

  const keychain = {
    getSecret: () => null,
    hasSecret: () => false,
    setSecret: () => assert.fail('unexpected credential write'),
    deleteSecret: () => assert.fail('unexpected credential deletion'),
    invalidateSecretCache: () => {},
    prewarmSecrets: async () => {},
    SERVICE: 'mixdog',
  };
  t.mock.module('../lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });
  const provider = { name: 'openai', send: () => assert.fail('unexpected provider request') };
  const registry = await import('../runtime/agent/orchestrator/providers/registry.mjs?real=1');
  t.mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
    namedExports: {
      ...registry,
      initProviders: async () => {},
      getProvider: () => provider,
      getAllProviders: () => new Map([['openai', provider]]),
      refreshProviderCatalogsOnStartup: async () => {},
      refreshCatalogs: async () => {},
    },
  });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network is forbidden in the Auto effort runtime test');
  });

  const { createMixdogSessionRuntime } = await import('./runtime-core.mjs');
  ({ drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs'));
  ({ settleSummaryIndexWrites } = await import('../runtime/agent/orchestrator/session/store-summary-index.mjs'));
  ({ settlePendingMessageWrites } = await import('../runtime/agent/orchestrator/session/manager/pending-messages.mjs'));
  for (const scenario of [
    { name: 'explicit off overrides saved on', autoEffort: false, saved: true, expected: false },
    { name: 'explicit on overrides saved off', autoEffort: true, saved: false, expected: true },
    { name: 'unspecified defaults to on', expected: true },
    { name: 'unspecified preserves saved off', saved: false, expected: false },
  ]) {
    await t.test(scenario.name, async () => {
      const runtime = await createMixdogSessionRuntime({
        provider: 'openai',
        model: 'gpt-6.1-sol',
        effort: 'high',
        ...(scenario.autoEffort === undefined ? {} : { autoEffort: scenario.autoEffort }),
        cwd: root,
        sessionProfile: { owner: 'agent', agent: 'reviewer', visibility: 'agent-only' },
        initialConfig: {
          providers: { openai: { enabled: true, apiKey: 'auto-effort-test-only' } },
          modelSettings:
            scenario.saved === undefined ? {} : { 'openai/gpt-6.1-sol': { autoEffort: scenario.saved } },
        },
      });
      try {
        await runtime.newSession();
        assert.equal(runtime.autoEffort, scenario.expected, 'the public route reflects the requested Auto choice');
        assert.equal(runtime.session.autoEffort !== false, scenario.expected, 'the created session keeps the Auto choice');
        assert.equal(runtime.session.effort, 'high', 'the selected effort stays high');
        assert.equal(runtime.session.agent, 'reviewer');
      } finally {
        await runtime.close('auto-effort-test', { waitForExit: false });
      }
    });
  }
});
