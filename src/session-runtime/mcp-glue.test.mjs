import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpGlue } from './mcp-glue.mjs';
import { createMcpConnect } from './mcp-glue/connect.mjs';

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

test('only an explicit sign-in connect is interactive; startup, toggles and reconcile never are', async () => {
  const calls = [];
  const servers = { remote: { url: 'https://example.test/mcp' } };
  const openBrowser = () => {};
  const { connectConfiguredMcp } = createMcpConnect({
    mcpClient: {
      connectMcpServers: async (_servers, options) => calls.push(['all', options.interactive === true]),
      reconnectSingleMcpServer: async (_scope, name, _cfg, options) =>
        calls.push([name, options.interactive === true, options.openBrowser === openBrowser]),
    },
    getMcpScopeId: () => 'test',
    state: { mcpConnectGeneration: 0, mcpFailures: [] },
    resolveEffectiveMcpServers: () => ({ servers }),
    mcpStatus: () => ({}),
  });
  await connectConfiguredMcp();
  await connectConfiguredMcp({ only: 'remote', login: { openBrowser } });
  await connectConfiguredMcp({ only: 'remote' });
  servers.remote = { url: 'https://example.test/changed' };
  await connectConfiguredMcp({ reconcile: true });
  assert.deepEqual(calls, [
    ['all', false],
    ['remote', true, true],
    ['remote', false, false],
    ['remote', false, false],
  ]);
});

test('a connect that needs an OAuth sign-in is reported as sign-in required, not as a failure', async () => {
  const state = { mcpConnectGeneration: 0, mcpFailures: [] };
  const cfg = { type: 'http', url: 'https://example.test/mcp' };
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'http',
      getMcpServerStatus: () => [],
      getMcpServerOAuthState: (server) => (server.url ? { signedIn: false } : null),
      reconnectSingleMcpServer: async () => {
        throw Object.assign(new Error('MCP OAuth reauthenticationRequired: sign in to connect'), {
          authRequired: true,
        });
      },
    },
    getConfig: () => ({ mcpServers: { remote: cfg, broken: { command: 'node' } } }),
    getCurrentCwd: () => process.cwd(),
    getMcpScopeId: () => 'test',
    state,
  });
  const status = await glue.connectConfiguredMcp({ only: 'remote' });
  const remote = status.servers.find((row) => row.name === 'remote');
  assert.equal(remote.status, 'sign-in required');
  assert.equal(remote.authRequired, true);
  assert.equal(remote.connected, false);
  assert.equal(remote.enabled, true);
  assert.equal(remote.error, null);
  assert.deepEqual(remote.oauth, {
    signedIn: false,
    lastError: 'MCP OAuth reauthenticationRequired: sign in to connect',
  });
  assert.equal(status.failedCount, 0);
  const broken = status.servers.find((row) => row.name === 'broken');
  assert.equal(broken.oauth, undefined);
  assert.equal(broken.authRequired, undefined);
});

test('an explicit sign-in that did not complete keeps the server sign-in required, the reason under oauth', async () => {
  for (const reason of ['MCP OAuth login failed, cancelled, or timed out', 'MCP server "remote" connect cancelled']) {
    const state = { mcpConnectGeneration: 0, mcpFailures: [] };
    const glue = createMcpGlue({
      mcpClient: {
        resolveMcpTransportKind: () => 'http',
        getMcpServerStatus: () => [],
        getMcpServerOAuthState: () => ({ signedIn: false }),
        reconnectSingleMcpServer: async (_scope, _name, _cfg, options) => {
          assert.equal(options.interactive, true);
          throw Object.assign(new Error(reason), { authRequired: true });
        },
      },
      getConfig: () => ({ mcpServers: { remote: { type: 'http', url: 'https://example.test/mcp' } } }),
      getCurrentCwd: () => process.cwd(),
      getMcpScopeId: () => 'test',
      state,
    });
    const status = await glue.connectConfiguredMcp({ only: 'remote', login: { openBrowser: () => {} } });
    const [row] = status.servers;
    assert.equal(row.status, 'sign-in required');
    assert.equal(row.authRequired, true);
    assert.equal(row.connected, false);
    assert.equal(row.error, null);
    assert.deepEqual(row.oauth, { signedIn: false, lastError: reason });
    assert.equal(status.failedCount, 0);
  }
});

test('a server waiting for an interactive sign-in reports sign-in required until it connects', () => {
  let pending = true;
  let live = [];
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'http',
      getMcpServerStatus: () => live,
      isMcpLoginPending: (name, scopeId) => pending && name === 'remote' && scopeId === 'test',
      getMcpServerOAuthState: () => ({ signedIn: false }),
    },
    getConfig: () => ({ mcpServers: { remote: { type: 'http', url: 'https://example.test/mcp' } } }),
    getCurrentCwd: () => process.cwd(),
    getMcpScopeId: () => 'test',
    state: { mcpConnectGeneration: 0, mcpFailures: [] },
  });
  const row = () => glue.mcpStatus().servers[0];
  assert.equal(row().status, 'sign-in required');
  assert.equal(row().authRequired, true);
  assert.equal(row().connected, false);
  assert.equal(row().error, null);
  pending = false;
  live = [{ name: 'remote', alive: true, toolCount: 1, tools: [] }];
  assert.equal(row().status, 'connected');
  assert.equal(row().authRequired, undefined);
});

test('a disable cancels the pending login of the connect it queues behind before waiting', async () => {
  const calls = [];
  let finishLogin;
  const { connectConfiguredMcp } = createMcpConnect({
    mcpClient: {
      reconnectSingleMcpServer: async (_scope, name) => {
        calls.push(['connect', name]);
        await new Promise((resolve) => {
          finishLogin = resolve;
        });
      },
      cancelMcpLogin: (name, options) => {
        calls.push(['cancel', name, options.scopeId]);
        finishLogin?.();
      },
      disconnectMcpServer: async (name) => calls.push(['disconnect', name]),
    },
    getMcpScopeId: () => 'test',
    state: { mcpConnectGeneration: 0, mcpFailures: [] },
    resolveEffectiveMcpServers: () => ({ servers: { remote: { url: 'https://example.test/mcp' } } }),
    mcpStatus: () => ({}),
  });
  const enable = connectConfiguredMcp({ only: 'remote', login: { openBrowser: () => {} } });
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([enable, connectConfiguredMcp({ only: 'remote', enabled: false })]);
  assert.deepEqual(calls, [
    ['connect', 'remote'],
    ['cancel', 'remote', 'test'],
    ['disconnect', 'remote'],
  ]);
});

test('awaitInitialMcpConnect returns at the caller cap while a slow server is still handshaking', async () => {
  const state = { mcpFailures: [], mcpConnectGeneration: 0, mcpConnectInFlight: new Promise(() => {}) };
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'http',
      getMcpServerStatus: () => [],
      resolveMcpStartupTimeoutMs: () => 30000,
    },
    getConfig: () => ({ mcpServers: { slow: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }),
    getCurrentCwd: () => process.cwd(),
    state,
  });
  const started = Date.now();
  await glue.awaitInitialMcpConnect(40);
  const waited = Date.now() - started;
  assert.ok(waited >= 30 && waited < 1000, `capped wait, got ${waited}ms`);
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

function makeReconnectGate({ startupMs, connectMs }) {
  const live = [];
  const state = { mcpFailures: [], mcpConnectGeneration: 0, mcpConnectInFlight: null };
  let releaseInitial;
  state.mcpConnectInFlight = new Promise((r) => {
    releaseInitial = r;
  });
  const glue = createMcpGlue({
    mcpClient: {
      resolveMcpTransportKind: () => 'stdio',
      getMcpServerStatus: () => [],
      resolveMcpStartupTimeoutMs: () => startupMs,
      disconnectAll: async () => {},
      connectMcpServers: async () => {
        if (connectMs === Infinity) return new Promise(() => {});
        await new Promise((r) => setTimeout(r, connectMs));
        live.push('mcp__srv__tool');
      },
    },
    getConfig: () => ({ mcpServers: { srv: { command: 'x' } } }),
    getCurrentCwd: () => process.cwd(),
    state,
  });
  return { glue, live, state, releaseInitial };
}

test('awaitInitialMcpConnect follows a reconnect that replaces the in-flight promise, so its tools fold on the first turn', async () => {
  const { glue, live, releaseInitial } = makeReconnectGate({ startupMs: 2000, connectMs: 60 });
  const gate = glue.awaitInitialMcpConnect();
  const reconnect = glue.connectConfiguredMcp({ reset: true });
  releaseInitial();
  await gate;
  assert.deepEqual(live, ['mcp__srv__tool'], 'gate returned only after the replacement connect registered its tools');
  await reconnect;
});

test('awaitInitialMcpConnect keeps ONE fixed deadline across replacement connects', async () => {
  const { glue, releaseInitial } = makeReconnectGate({ startupMs: 150, connectMs: Infinity });
  const started = Date.now();
  const gate = glue.awaitInitialMcpConnect();
  glue.connectConfiguredMcp({ reset: true });
  await new Promise((r) => setTimeout(r, 100));
  releaseInitial();
  await gate;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 140 && elapsed < 400, `released at the original deadline, got ${elapsed}ms`);
});

test('awaitInitialMcpConnect skips waiting with no connect in flight or a disabled startup budget', async () => {
  const idle = makeReconnectGate({ startupMs: 2000, connectMs: 0 });
  idle.state.mcpConnectInFlight = null;
  const t0 = Date.now();
  await idle.glue.awaitInitialMcpConnect();
  const off = makeReconnectGate({ startupMs: 0, connectMs: 0 });
  await off.glue.awaitInitialMcpConnect();
  assert.ok(Date.now() - t0 < 100);
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
