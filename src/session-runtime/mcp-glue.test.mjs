import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpGlue } from './mcp-glue.mjs';

test('mcpStatus surfaces a live server that reports not alive as failed', () => {
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'stdio',
      getMcpServerStatus: () => [{ name: 'mine', connected: false, error: 'process exited' }],
    },
    getConfig: () => ({ mcpServers: { mine: { command: 'node' } } }),
    getCurrentCwd: () => process.cwd(),
    state: { mcpFailures: [] },
  });
  const row = glue.mcpStatus().servers[0];
  assert.equal(row.connected, false);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'process exited');
});

test('awaitInitialMcpConnect waits for the largest per-server startup budget', async () => {
  const seen = [];
  const state = { mcpFailures: [], mcpConnectGeneration: 0, mcpConnectInFlight: new Promise((r) => setTimeout(r, 60)) };
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'stdio',
      getMcpServerStatus: () => [],
      resolveMcpStartupTimeoutMs: (cfg) => {
        seen.push(cfg.startupTimeoutSec);
        return (cfg.startupTimeoutSec || 0.01) * 1000;
      },
    },
    getConfig: () => ({ mcpServers: { a: { command: 'x' }, b: { command: 'x', startupTimeoutSec: 5 } } }),
    getCurrentCwd: () => process.cwd(),
    state,
  });
  const started = Date.now();
  await glue.awaitInitialMcpConnect();
  assert.ok(Date.now() - started >= 50, 'waited past the short budget for the long one');
  assert.deepEqual(seen.sort(), [5, undefined]);
});

test('mcpStatus marks plugin-owned servers so they list under the plugin, not as loose MCP entries', () => {
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'stdio',
      getMcpServerStatus: () => [],
    },
    getConfig: () => ({
      mcpServers: {
        mine: { command: 'node', args: ['server.mjs'] },
        'plugin-a': { command: 'node', args: ['mcp.mjs'], env: { MIXDOG_PLUGIN_ROOT: 'C:/plugins/a' } },
        'plugin-b': {
          command: 'node',
          args: ['mcp.mjs'],
          env: { MIXDOG_PLUGIN_ROOT: 'C:/plugins/b' },
          _mixdogPluginDisabled: true,
        },
      },
    }),
    getCurrentCwd: () => process.cwd(),
    state: { mcpFailures: [] },
  });
  const byName = Object.fromEntries(glue.mcpStatus().servers.map((server) => [server.name, server]));
  assert.equal(byName.mine.source, 'config');
  assert.equal(byName['plugin-a'].source, 'plugin');
  assert.equal(byName['plugin-a'].enabled, true);
  // The plugin toggle, not an MCP toggle, is what turned this one off.
  assert.equal(byName['plugin-b'].source, 'plugin');
  assert.equal(byName['plugin-b'].enabled, false);
  assert.equal(glue.getMcpServerConfig('plugin-a').source, 'plugin');
});
