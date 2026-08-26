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
  const writer = resourceApi({
    getConfig: () => writerConfig,
    saveConfigAndAdopt: (next) => {
      writerConfig = structuredClone(next);
      persisted = structuredClone(next);
    },
    mcpStatus: () => ({ servers: [{ name: 'demo', source: 'config' }] }),
  });
  const peer = resourceApi({
    getConfig: () => peerConfig,
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
  } finally {
    writer.disposeGlobalExtensionSubscription();
    peer.disposeGlobalExtensionSubscription();
  }
});
