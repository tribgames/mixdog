import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpGlue } from './mcp-glue.mjs';

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
        'plugin-b': { command: 'node', args: ['mcp.mjs'], env: { MIXDOG_PLUGIN_ROOT: 'C:/plugins/b' }, _mixdogPluginDisabled: true },
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
