import assert from 'node:assert/strict';
import test from 'node:test';

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
    mgr: { closeSession: () => { lifecycleCalls += 1; } },
    recreateCurrentSessionIfReady: async () => { lifecycleCalls += 1; },
    saveConfigAndAdopt: (next) => {
      writerConfig = structuredClone(next);
      persisted = structuredClone(next);
    },
    mcpStatus: () => ({ servers: [{ name: 'demo', source: 'config' }] }),
  });
  const peer = resourceApi({
    getConfig: () => peerConfig,
    getSession: () => materializedSession,
    mgr: { closeSession: () => { lifecycleCalls += 1; } },
    recreateCurrentSessionIfReady: async () => { lifecycleCalls += 1; },
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
    mgr: { closeSession: () => { lifecycleCalls += 1; } },
    recreateCurrentSessionIfReady: async () => { lifecycleCalls += 1; },
  };
  const writer = resourceApi({
    ...lifecycleOverrides,
    setDisabledSkills: (names) => ({ disabled: names }),
    refreshEmptySessionToolPolicy: async () => { writerRefreshes += 1; },
  });
  const peer = resourceApi({
    ...lifecycleOverrides,
    refreshEmptySessionToolPolicy: async () => { peerRefreshes += 1; },
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
