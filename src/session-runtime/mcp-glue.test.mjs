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

test('a root marker alone never makes a configured server plugin-owned', () => {
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
  const status = glue.mcpStatus();
  const byName = Object.fromEntries(status.servers.map((server) => [server.name, server]));
  assert.equal(byName.mine.source, 'config');
  // No registered plugin owns these roots: they stay configured servers,
  // flagged, and an old plugin-disabled marker keeps them off.
  assert.equal(byName['plugin-a'].source, 'config');
  assert.equal(byName['plugin-a'].owner, undefined);
  assert.match(byName['plugin-a'].warnings[0], /no registered plugin has root/);
  assert.equal(byName['plugin-b'].enabled, false);
  assert.equal(glue.getMcpServerConfig('plugin-a').source, 'config');
  assert.equal(status.warnings.length, 2);
});
