import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerConnection } from './server-connection.mjs';

test('a reconcile retries a server that needed sign-in although its config is unchanged', async () => {
  const servers = { docs: { url: 'https://docs.example.test/mcp' }, files: { command: 'files' } };
  const fingerprint = (cfg) => JSON.stringify(cfg);
  const known = new Map(Object.entries(servers).map(([name, cfg]) => [name, fingerprint(cfg)]));
  const state = { mcpFailures: [{ name: 'docs', msg: 'sign-in required', authRequired: true }] };
  const reconnected = [];
  const { reconcileServers } = createServerConnection({
    mcpClient: {
      reconnectSingleMcpServer: async (_scope, name) => {
        reconnected.push(name);
      },
      disconnectMcpServer: async () => {},
    },
    state,
    resolveEffectiveMcpServers: () => ({ servers }),
    getMcpScopeId: () => 'scope',
    scopeOptions: () => ({}),
    applied: () => known,
    fingerprint,
    syncScopeRoot: () => {},
  });
  await reconcileServers();
  assert.deepEqual(reconnected, ['docs'], 'the signed-in-elsewhere server reconnects; the healthy one is left alone');
  assert.deepEqual(state.mcpFailures, [], 'its sign-in failure is cleared once it connects');
  await reconcileServers();
  assert.deepEqual(reconnected, ['docs'], 'a connected server is not retried again');
});

test('a server whose connect failed is reported and connected again by the next reconcile, its config unchanged', async () => {
  const servers = { files: { command: 'files' } };
  const known = new Map();
  const state = { mcpFailures: [] };
  let down = true;
  const attempts = [];
  const { reconcileServers } = createServerConnection({
    mcpClient: {
      reconnectSingleMcpServer: async (_scope, name) => {
        attempts.push(name);
        if (down) throw new Error('spawn ENOENT');
      },
      disconnectMcpServer: async () => {},
    },
    state,
    resolveEffectiveMcpServers: () => ({ servers }),
    getMcpScopeId: () => 'scope',
    scopeOptions: () => ({}),
    applied: () => known,
    fingerprint: (cfg) => JSON.stringify(cfg),
    syncScopeRoot: () => {},
  });
  assert.deepEqual(await reconcileServers(), [{ name: 'files', msg: 'spawn ENOENT' }]);
  assert.equal(known.has('files'), false, 'a failed connect is not recorded as applied');
  down = false;
  assert.deepEqual(await reconcileServers(), []);
  assert.deepEqual(state.mcpFailures, []);
  await reconcileServers();
  assert.deepEqual(attempts, ['files', 'files'], 'retried once failed, left alone once connected');
});