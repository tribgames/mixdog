import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMcpGlue } from './mcp-glue.mjs';
import { createResourceApi } from './resource-api.mjs';
import {
  mergeMcpServerConfig,
  readProjectMcpServerConfig,
  saveProjectMcpServer,
} from './plugin-mcp.mjs';

test('project MCP edits preserve document shape and unknown fields', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-mcp-standard-'));
  try {
    const path = join(cwd, '.mcp.json');
    writeFileSync(path, `${JSON.stringify({
      projectMetadata: { owner: 'test' },
      mcpServers: {
        demo: {
          type: 'stdio',
          command: 'old-command',
          args: ['--old'],
          vendorExtension: { keep: true },
        },
        sibling: { url: 'https://example.com/mcp', custom: 7 },
      },
    }, null, 2)}\n`);

    saveProjectMcpServer(cwd, {
      originalName: 'demo',
      name: 'renamed',
      config: {
        type: 'http',
        url: 'https://example.com/new-mcp',
        headers: { Authorization: '${MCP_TOKEN}' },
      },
    });

    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(saved.projectMetadata, { owner: 'test' });
    assert.deepEqual(saved.mcpServers.sibling, {
      url: 'https://example.com/mcp',
      custom: 7,
    });
    assert.equal(saved.mcpServers.demo, undefined);
    assert.deepEqual(saved.mcpServers.renamed, {
      vendorExtension: { keep: true },
      type: 'http',
      url: 'https://example.com/new-mcp',
      headers: { Authorization: '${MCP_TOKEN}' },
    });
    assert.deepEqual(readProjectMcpServerConfig(cwd, 'renamed')?.config, saved.mcpServers.renamed);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP transport edits drop stale transport fields but retain extensions', () => {
  assert.deepEqual(mergeMcpServerConfig({
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'secret' },
    bearer_token_env_var: 'MCP_TOKEN',
    env_http_headers: { 'X-API-Key': 'MCP_API_KEY' },
    env_vars: ['STALE_STDIO_VALUE'],
    startupTimeoutSec: 20,
  }, {
    type: 'stdio',
    command: 'server',
    args: [],
  }), {
    startupTimeoutSec: 20,
    type: 'stdio',
    command: 'server',
    args: [],
  });
});

test('plugin-disabled MCP cannot be re-enabled by a stale project override', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-mcp-plugin-off-'));
  try {
    const config = {
      mcpServers: {
        plugin: {
          command: 'server',
          _mixdogPluginDisabled: true,
        },
      },
      mcpProjectOverrides: {
        [cwd]: {
          plugin: { enabled: true },
        },
      },
    };
    const glue = createMcpGlue({
      mcpClient: {
        resolveMcpTransportKind: () => 'stdio',
        getMcpServerStatus: () => [],
      },
      getConfig: () => config,
      getCurrentCwd: () => cwd,
      state: {
        mcpFailures: [],
        mcpConnectGeneration: 0,
        mcpConnectInFlight: null,
      },
    });
    assert.equal(glue.mcpStatus().servers[0]?.enabled, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP toggle updates the global server and ignores project config and overrides', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-mcp-override-'));
  try {
    const path = join(cwd, '.mcp.json');
    writeFileSync(path, `${JSON.stringify({
      mcpServers: {
        local: { command: 'server', enabled: false, extension: 'kept' },
      },
    }, null, 2)}\n`);
    const before = readFileSync(path, 'utf8');
    let config = {
      mcpServers: {
        local: { command: 'global-server', enabled: false, extension: 'kept' },
      },
      mcpProjectOverrides: {
        [cwd]: {
          local: { enabled: false },
        },
      },
    };
    const api = createResourceApi({
      getConfig: () => config,
      getSession: () => null,
      getCurrentCwd: () => cwd,
      cfgMod: {},
      mgr: {},
      saveConfigAndAdopt: (next) => { config = next; },
      connectConfiguredMcp: async () => ({ servers: [] }),
      invalidatePreSessionToolSurface: () => {},
      recreateCurrentSessionIfReady: async () => {},
      mcpStatus: () => ({ servers: [{ name: 'local', source: 'config' }] }),
      getActiveTurnCount: () => 0,
    });
    await api.setMcpServerEnabled('local', true);
    assert.equal(config.mcpServers.local.enabled, true);
    assert.equal(config.mcpServers.local.extension, 'kept');
    assert.equal(config.mcpProjectOverrides, undefined);

    const glue = createMcpGlue({
      mcpClient: {
        resolveMcpTransportKind: () => 'stdio',
        getMcpServerStatus: () => [],
      },
      getConfig: () => config,
      getCurrentCwd: () => cwd,
      state: {
        mcpFailures: [],
        mcpConnectGeneration: 0,
        mcpConnectInFlight: null,
      },
    });

    const row = glue.mcpStatus().servers.find((server) => server.name === 'local');
    assert.equal(row?.source, 'config');
    assert.equal(row?.enabled, true);
    assert.equal(glue.getMcpServerConfig('local').config.command, 'global-server');
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
