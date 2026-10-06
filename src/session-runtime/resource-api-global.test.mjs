import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceApi } from './resource-api.mjs';

function resourceApi(overrides = {}) {
  return createResourceApi({
    getConfig: () => ({}),
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: () => {},
    connectConfiguredMcp: async () => ({ servers: [] }),
    invalidatePreSessionToolSurface: () => {},
    refreshEmptySessionToolPolicy: async () => {},
    recreateCurrentSessionIfReady: async () => {},
    normalizeMcpServerInput: () => {
      throw new Error('not used');
    },
    mcpStatus: () => ({ servers: [] }),
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    getActiveTurnCount: () => 0,
    ...overrides,
  });
}

test('a plugin named only by its name toggles, removes, and scopes its registered MCP entries', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-plugin-name-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const row = { id: 'demo-plugin-1a2b3c4d', name: 'demo-plugin', root: join(dataDir, 'src'), managed: false };
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });
  writeFileSync(join(dataDir, 'plugins', 'registry.json'), JSON.stringify({ version: 1, plugins: [{ ...row }] }));
  let config = {
    mcpServers: {
      'plugin-demo-plugin': { command: 'demo' },
      'plugin-demo-plugin--extra': { command: 'demo' },
      unrelated: { command: 'other' },
    },
  };
  let registered = [row];
  const api = resourceApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = structuredClone(next);
    },
    cfgMod: { getPluginData: () => dataDir },
    pluginsStatus: () => ({ plugins: registered }),
  });
  t.after(() => api.disposeGlobalExtensionSubscription());

  await api.setPluginEnabled('demo-plugin', false);
  assert.equal(config.mcpServers['plugin-demo-plugin']._mixdogPluginDisabled, true);
  assert.equal(config.mcpServers['plugin-demo-plugin--extra']._mixdogPluginDisabled, true);
  assert.equal(config.mcpServers.unrelated._mixdogPluginDisabled, undefined);

  // Scope is stored under the registry id, the key every reader matches.
  await api.setExtensionScope('plugins', 'demo-plugin', [dataDir]);
  assert.deepEqual(Object.keys(config.extensionScopes.plugins), [row.id]);
  await assert.rejects(
    api.setExtensionScope('plugins', 'missing-plugin', [dataDir]),
    /plugin not registered: missing-plugin/
  );

  await api.removePlugin('demo-plugin');
  registered = [];
  assert.deepEqual(Object.keys(config.mcpServers), ['unrelated']);
});

test('a global MCP toggle reloads and reconnects peer session runtimes', async () => {
  let persisted = {
    mcpServers: {
      demo: { type: 'stdio', command: 'demo', enabled: true },
    },
  };
  let writerConfig = structuredClone(persisted);
  let peerConfig = structuredClone(persisted);
  let peerReloads = 0;
  let peerConnects = 0;
  let lifecycleCalls = 0;
  const materializedSession = { id: 'sess_daemon_control', messages: [] };
  const writer = resourceApi({
    getConfig: () => writerConfig,
    getSession: () => materializedSession,
    mgr: {
      closeSession: () => {
        lifecycleCalls += 1;
      },
    },
    recreateCurrentSessionIfReady: async () => {
      lifecycleCalls += 1;
    },
    saveConfigAndAdopt: (next) => {
      writerConfig = structuredClone(next);
      persisted = structuredClone(next);
    },
    mcpStatus: () => ({ servers: [{ name: 'demo', source: 'config' }] }),
  });
  const peer = resourceApi({
    getConfig: () => peerConfig,
    getSession: () => materializedSession,
    mgr: {
      closeSession: () => {
        lifecycleCalls += 1;
      },
    },
    recreateCurrentSessionIfReady: async () => {
      lifecycleCalls += 1;
    },
    reloadFullConfig: () => {
      peerReloads += 1;
      peerConfig = structuredClone(persisted);
    },
    connectConfiguredMcp: async () => {
      peerConnects += 1;
      return { servers: [] };
    },
  });
  try {
    await writer.setMcpServerEnabled('demo', false);
    assert.equal(writerConfig.mcpServers.demo.enabled, false);
    assert.equal(peerConfig.mcpServers.demo.enabled, false);
    assert.equal(peerReloads, 1);
    assert.equal(peerConnects, 1);
    assert.equal(lifecycleCalls, 0);
  } finally {
    writer.disposeGlobalExtensionSubscription();
    peer.disposeGlobalExtensionSubscription();
  }
});

test('global skill and plugin refreshes update empty surfaces without replacing sessions', async () => {
  let lifecycleCalls = 0;
  let writerRefreshes = 0;
  let peerRefreshes = 0;
  const lifecycleOverrides = {
    getSession: () => ({ id: 'sess_daemon_control', messages: [] }),
    mgr: {
      closeSession: () => {
        lifecycleCalls += 1;
      },
    },
    recreateCurrentSessionIfReady: async () => {
      lifecycleCalls += 1;
    },
  };
  const writer = resourceApi({
    ...lifecycleOverrides,
    setDisabledSkills: (names) => ({ disabled: names }),
    refreshEmptySessionToolPolicy: async () => {
      writerRefreshes += 1;
    },
  });
  const peer = resourceApi({
    ...lifecycleOverrides,
    refreshEmptySessionToolPolicy: async () => {
      peerRefreshes += 1;
    },
  });
  try {
    await writer.setDisabledSkills(['demo']);
    await writer.reloadPlugins();
    assert.equal(writerRefreshes, 2);
    assert.equal(peerRefreshes, 2);
    assert.equal(lifecycleCalls, 0);
  } finally {
    writer.disposeGlobalExtensionSubscription();
    peer.disposeGlobalExtensionSubscription();
  }
});

for (const method of ['setDisabledSkills', 'saveSkill']) {
  test(`${method} waits for persistence before publishing skills to peer sessions`, async () => {
    let finishSave;
    const save = new Promise((resolve) => {
      finishSave = resolve;
    });
    let peerReloads = 0;
    const writer = resourceApi({
      setDisabledSkills: (names) => ({ disabled: names }),
      getDisabledSkills: () => ({ disabled: ['old'] }),
      saveSkillDocument: () => ({ originalName: 'old', name: 'new' }),
      flushSkillsSave: () => save,
    });
    const peer = resourceApi({
      reloadFullConfig: () => {
        peerReloads += 1;
      },
    });
    try {
      const pending = method === 'saveSkill' ? writer.saveSkill({}) : writer.setDisabledSkills(['demo']);
      await setImmediate();
      assert.equal(peerReloads, 0);
      finishSave();
      await pending;
      assert.equal(peerReloads, 1);
    } finally {
      finishSave();
      writer.disposeGlobalExtensionSubscription();
      peer.disposeGlobalExtensionSubscription();
    }
  });
}

test('recall reads the live session through the injected getter before asking the memory runtime', async () => {
  const calls = [];
  const api = resourceApi({
    getSession: () => ({ id: 'sess_live', messages: [{ role: 'user', content: 'hello' }] }),
    getMemoryModule: async () => ({
      handleToolCall: async (name, args) => {
        calls.push({ name, action: args.action, sessionId: args.sessionId });
        return name === 'recall' ? 'remembered: hello' : 'ok';
      },
    }),
  });
  try {
    const text = await api.recall('what did I say', { limit: 1 });
    assert.equal(text, 'remembered: hello');
    assert.deepEqual(calls[0], { name: 'memory', action: 'ingest_session', sessionId: 'sess_live' });
    assert.equal(calls[1].name, 'recall');
    assert.equal(calls[1].sessionId, 'sess_live');
  } finally {
    api.disposeGlobalExtensionSubscription();
  }
});
