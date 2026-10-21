import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkflowHelpers } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { normalizeAgentPermissionOrNone, readMarkdownDocument } from '../runtime/shared/markdown-frontmatter.mjs';

test('a runtime start resolves its own data folder, not the first start of the process', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-data-dir-'));
  const dataA = join(root, 'run-a', 'data');
  const dataB = join(root, 'run-b', 'data');
  const previousEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(key)) delete process.env[key];
  }
  // The first data folder is in place before any runtime module loads, like a
  // pristine boundary that retargets MIXDOG_DATA_DIR before each run.
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    MIXDOG_HOME: join(root, 'home'),
    MIXDOG_DATA_DIR: dataA,
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
  const settleStore = async () => {
    drainSessionStore();
    await settlePendingMessageWrites({ throwOnTimeout: true });
    await settleSummaryIndexWrites();
  };
  t.after(async () => {
    try {
      if (drainSessionStore) await settleStore();
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
    throw new Error('network is forbidden in the data dir test');
  });
  const logged = [];
  const writeStderr = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...rest) => {
    logged.push(String(chunk));
    return writeStderr(chunk, ...rest);
  });

  const { createMixdogSessionRuntime } = await import('./runtime-core.mjs');
  ({ drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs'));
  ({ settleSummaryIndexWrites } = await import('../runtime/agent/orchestrator/session/store-summary-index.mjs'));
  ({ settlePendingMessageWrites } = await import('../runtime/agent/orchestrator/session/manager/pending-messages.mjs'));

  // One runtime start: retarget the data folder, boot, save a session, close.
  async function runInDataDir(dataDir) {
    process.env.MIXDOG_DATA_DIR = dataDir;
    const runtime = await createMixdogSessionRuntime({
      provider: 'openai',
      model: 'gpt-4o-mini',
      cwd: root,
      initialConfig: { providers: { openai: { enabled: true, apiKey: 'data-dir-test-only' } } },
    });
    await runtime.newSession();
    const id = runtime.session.id;
    await runtime.close('data-dir-test', { waitForExit: false });
    await settleStore();
    return id;
  }

  const idA = await runInDataDir(dataA);
  assert.ok(existsSync(join(dataA, 'sessions', `${idA}.json`)), 'the first run saved its session in its own folder');
  // A pristine boundary removes its folder once the run is over.
  rmSync(dataA, { recursive: true, force: true });

  const idB = await runInDataDir(dataB);
  assert.equal(process.env.MIXDOG_DATA_DIR, dataB, 'the runtime start kept the folder it was started with');
  assert.ok(existsSync(join(dataB, 'sessions', `${idB}.json`)), 'the second run saved its session in its own folder');
  assert.equal(existsSync(dataA), false, 'the first run folder was not recreated by the second run');
  assert.deepEqual(
    logged.filter((line) => /ENOENT|durable lifecycle barrier/.test(line)),
    [],
    'no save failed against a stale data folder'
  );
});

test('workflow loaders given a data dir resolver read it on every call', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-workflow-data-dir-'));
  try {
    const dirs = ['one', 'two'].map((name) => join(root, name));
    for (const [index, dir] of dirs.entries()) {
      mkdirSync(join(dir, 'workflows', `pack-${index}`), { recursive: true });
      writeFileSync(join(dir, 'workflows', `pack-${index}`, 'WORKFLOW.md'), `# Pack ${index}\n\nBody ${index}.\n`);
    }
    let current = dirs[0];
    const helpers = createWorkflowHelpers({
      rootDir: join(root, 'no-shipped-root'),
      dataDir: () => current,
      readMarkdownDocument,
      normalizeAgentPermissionOrNone,
    });
    assert.deepEqual(
      helpers.listWorkflowPacks().map((pack) => pack.id),
      ['pack-0']
    );
    current = dirs[1];
    assert.deepEqual(
      helpers.listWorkflowPacks().map((pack) => pack.id),
      ['pack-1']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
