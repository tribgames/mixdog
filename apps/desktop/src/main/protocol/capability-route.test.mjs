// The renderer's session capabilities as core requests (capability-route.ts): the exact op name and params each
// converted capability sends, the capabilities that have no op and so never leave the process, and the lane's wiring
// into a connection. Expectations come from the spec map and the Rust schema (protocol.md section 12.4,
// `operations_map.json`, `client_methods.json`), not from the router.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ACTION_OVERRIDES } from '../../../../../src/standalone/protocol-session/action-overrides.mjs';
import { METHOD_ARGS } from '../../../../../src/standalone/protocol-session/method-args.generated.mjs';
import { DESKTOP_CAPABILITIES } from '../../shared/contract-capabilities.ts';
import { createDesktopConnection } from '../connections/desktop-connection.ts';
import { DesktopServiceClient } from '../desktop-service-client.ts';
import { createCapabilityLane, routeCapability } from './capability-route.ts';

const schemaDir = new URL('../../../../../native/core/crates/mixdog-app-protocol/schema/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8'));
const specActions = new Map(
  json('operations_map.json').inventory.filter((row) => row.list === 'actions').map((row) => [row.name, row.target])
);
const methodTable = new Map(json('method_table.json').clientMethods.map((row) => [row.method, row]));
const clientMethods = json('client_methods.json');
const paramsSchema = (method) =>
  clientMethods.definitions[clientMethods.methods[method].params.$ref.split('/').pop()];

/** Capabilities with no request op: the spec map points them at a pushed section or deletes them, or the op exists
 *  and the spec gives no params for the call's arguments (review reads, queue edits, setModel), or the target is a
 *  client notification (noteUserInput). They fail before anything is sent. */
const NOT_ROUTED = [
  'prioritizeQueued',
  'restoreQueued',
  'noteUserInput',
  'taskControl',
  'selectTools',
  'getSessionReviewDiff',
  'getSessionReviewFilePatch',
  'getTurnReviewDiff',
  'getTurnReviewFilePatch',
  'getTurnChanges',
  'listPresets',
  'setModel',
  'getWebSearchRoute',
  'listAgents',
  'listWorkflows',
  'listThemes',
  'listConnectors',
  'listProviders',
  'getProviderSetup',
  'getProviderAccounts',
  'getOnboardingStatus',
];

function recordingLane(answer = async () => ({ ok: true })) {
  const calls = [];
  const protocol = {
    call: async (method, params) => {
      calls.push({ method, params });
      return answer(method, params);
    },
  };
  const held = { held: 'shell snapshot' };
  return { calls, lane: createCapabilityLane({ protocol, snapshot: () => held }), held };
}

// The 14 `mcp/*` actions: `[capability, positional args, params without threadId]`. The names are the fields of the
// Rust `Mcp*Params` structs in declared order (`v2/params.rs`), which is the order of Node's `resource-mcp-api.mjs`.
const SERVER = { name: 'x', url: 'http://127.0.0.1:9/mcp' };
const CONFIG = { type: 'http', url: 'http://127.0.0.1:9/mcp' };
const LOGIN = { openBrowser: false };
const CALLBACK = 'http://127.0.0.1:9/cb?code=c';
const MCP = [
  ['getMcpServerConfig', ['fixture'], 'mcp/getMcpServerConfig', { name: 'fixture' }],
  ['getMcpOAuthLoginStatus', ['flow-1'], 'mcp/getMcpOAuthLoginStatus', { flowId: 'flow-1' }],
  ['mcpStatus', [], 'mcp/mcpStatus', {}],
  ['addMcpServer', [SERVER], 'mcp/addMcpServer', { input: SERVER }],
  ['saveMcpServer', [{ name: 'x', enabled: false }], 'mcp/saveMcpServer', { input: { name: 'x', enabled: false } }],
  ['removeMcpServer', ['fixture'], 'mcp/removeMcpServer', { name: 'fixture' }],
  ['setMcpServerEnabled', ['fixture', true], 'mcp/setMcpServerEnabled', { name: 'fixture', enabled: true }],
  ['reconnectMcp', ['fixture'], 'mcp/reconnectMcp', { name: 'fixture' }],
  ['beginMcpOAuthLogin', ['fixture', LOGIN], 'mcp/beginMcpOAuthLogin', { name: 'fixture', options: LOGIN }],
  ['cancelMcpOAuthLogin', ['flow-1'], 'mcp/cancelMcpOAuthLogin', { flowId: 'flow-1' }],
  [
    'completeMcpOAuthLogin',
    ['flow-1', CALLBACK],
    'mcp/completeMcpOAuthLogin',
    { flowId: 'flow-1', callbackUrl: CALLBACK },
  ],
  ['signOutMcpServer', ['fixture'], 'mcp/signOutMcpServer', { name: 'fixture' }],
  ['probeMcpServerAuth', [CONFIG], 'mcp/probeMcpServerAuth', { cfg: CONFIG }],
  ['enablePluginMcp', [{ id: 'p', name: 'p' }], 'mcp/enablePluginMcp', { plugin: { id: 'p', name: 'p' } }],
];

for (const [capability, args, method, params] of MCP) {
  test(`${capability} on a pane is ${method} for that thread`, async () => {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, args, 'pane-1');
    assert.deepEqual(calls, [{ method, params: { threadId: 'pane-1', ...params } }]);
  });
  test(`${capability} from the control session is ${method} with no thread`, async () => {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, args, undefined);
    assert.deepEqual(calls, [{ method, params }]);
  });
}

test('the 14 mcp actions are the whole mcp namespace of the method table', () => {
  assert.deepEqual(
    MCP.map(([, , method]) => method).sort(),
    [...methodTable.keys()].filter((method) => method.startsWith('mcp/')).sort()
  );
});

test('a result carries the core value and the held shell snapshot', async () => {
  const { lane, held } = recordingLane(async () => ({ servers: [] }));
  assert.deepEqual(await lane.invoke('mcpStatus', [], 'pane-1'), { value: { servers: [] }, snapshot: held });
});

test('the desktop-only overrides send the ops the spec maps them to', () => {
  assert.deepEqual(routeCapability('getBotOrder', [], undefined), { method: 'config/getBotOrder', params: {} });
  assert.deepEqual(routeCapability('getBotOrder', [], 's1'), {
    method: 'config/getBotOrder',
    params: { threadId: 's1' },
  });
  assert.deepEqual(routeCapability('setBotOrder', [['a', 'b']], undefined), {
    method: 'config/setBotOrder',
    params: { order: ['a', 'b'] },
  });
  const route = { provider: 'openai', model: 'm', onlyIfEmpty: true };
  assert.deepEqual(routeCapability('setAgentRoute', ['bot', route], undefined), {
    method: 'route/set',
    params: { agentId: 'bot', route },
  });
});

test('the actions the TUI routes by override keep their ops on the desktop', () => {
  assert.deepEqual(routeCapability('setFast', [true], 's1'), {
    method: 'fast/set',
    params: { threadId: 's1', on: true },
  });
  assert.deepEqual(routeCapability('setRoute', [{ provider: 'p', model: 'm' }], 's1'), {
    method: 'route/set',
    params: { threadId: 's1', route: { provider: 'p', model: 'm' } },
  });
  assert.deepEqual(routeCapability('listProviderModels', [{ quick: false }], undefined), {
    method: 'model/list',
    params: { quick: false },
  });
});

test('every capability the desktop declares is in the spec map', () => {
  assert.deepEqual([...DESKTOP_CAPABILITIES].filter((capability) => !specActions.has(capability)), []);
});

test('every routed capability sends the op the spec map names, with params the Rust schema declares', () => {
  const routed = DESKTOP_CAPABILITIES.filter((capability) => !NOT_ROUTED.includes(capability));
  assert.equal(routed.length + NOT_ROUTED.length, DESKTOP_CAPABILITIES.length);
  for (const capability of routed) {
    const target = specActions.get(capability);
    const wanted = target.kind === 'method' ? [target.target] : target.kind === 'methods' ? target.target : [];
    const { method } = routeCapability(capability, [], 'pane-1');
    assert.ok(wanted.includes(method), `${capability} -> ${method}, spec ${JSON.stringify(target)}`);
    assert.ok(methodTable.has(method), `${method} is a client method`);
    const schema = paramsSchema(method);
    const verbatim = !Object.hasOwn(ACTION_OVERRIDES, capability) && Object.hasOwn(METHOD_ARGS, method);
    // A verbatim action is given a value for every position it has; an override only its thread.
    const given = verbatim ? ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'].slice(0, METHOD_ARGS[method].args.length) : [];
    const { params } = routeCapability(capability, given, 'pane-1');
    for (const name of Object.keys(params)) {
      assert.ok(name in schema.properties, `${capability}: ${name} is a param of ${method}`);
    }
    assert.equal('threadId' in params, 'threadId' in schema.properties, `${capability}: threadId follows the schema`);
    if (verbatim) {
      for (const name of (schema.required ?? []).filter((required) => required !== 'opId')) {
        assert.ok(name in params, `${capability}: ${method} requires ${name}`);
      }
    }
  }
});

test('a capability with no op fails before anything is sent, and does not fall back', async () => {
  const { calls, lane } = recordingLane();
  for (const capability of NOT_ROUTED) {
    await assert.rejects(lane.invoke(capability, [], 'pane-1'), (error) => error.code === 'unknownMethod', capability);
  }
  assert.deepEqual(calls, []);
  const [result] = await lane.read([{ capability: 'listAgents' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /no protocol method/);
  assert.deepEqual(calls, []);
});

test('reads are answered together, in request order, each with its own thread and outcome', async () => {
  const { calls, lane } = recordingLane(async (method) => {
    if (method === 'mcp/mcpStatus') throw new Error('status unavailable');
    return method;
  });
  const results = await lane.read([
    { capability: 'getAutoClear' },
    { capability: 'mcpStatus', sessionId: 'pane-1' },
    { capability: 'skillsStatus', args: [{ cwd: '/w' }], sessionId: 'pane-2' },
  ]);
  assert.deepEqual(results, [
    { ok: true, value: 'config/getAutoClear' },
    { ok: false, error: 'status unavailable' },
    { ok: true, value: 'skills/skillsStatus' },
  ]);
  assert.deepEqual(calls, [
    { method: 'config/getAutoClear', params: {} },
    { method: 'mcp/mcpStatus', params: { threadId: 'pane-1' } },
    { method: 'skills/skillsStatus', params: { threadId: 'pane-2', options: { cwd: '/w' } } },
  ]);
});

test('a domain error of the core reaches the window as the error Node raised', async () => {
  const failure = Object.assign(new Error('rpc'), {
    detail: {
      kind: 'rpc',
      data: {
        reason: 'domainError',
        message: 'Server not found',
        code: 'MCP_SERVER_UNKNOWN',
        detail: { type: 'x', name: 'fixture' },
      },
    },
  });
  const { lane } = recordingLane(async () => {
    throw failure;
  });
  await assert.rejects(lane.invoke('removeMcpServer', ['fixture'], undefined), (error) => {
    assert.equal(error.message, 'Server not found');
    assert.equal(error.code, 'MCP_SERVER_UNKNOWN');
    return true;
  });
});

test('the service client sends capabilities to its lane and never to the Node service', async () => {
  const { calls, lane } = recordingLane();
  const client = new DesktopServiceClient({
    connect() {
      throw new Error('the Node service must not be reached');
    },
    sessionOptions: () => ({}),
    capabilityLane: lane,
  });
  await client.invokeCapability('setMcpServerEnabled', ['fixture', false], 'pane-1');
  await client.readCapabilities([{ capability: 'mcpStatus' }]);
  assert.deepEqual(calls, [
    { method: 'mcp/setMcpServerEnabled', params: { threadId: 'pane-1', name: 'fixture', enabled: false } },
    { method: 'mcp/mcpStatus', params: {} },
  ]);
});

test("a connection with a core endpoint routes its client's capabilities through that core", async () => {
  const calls = [];
  const protocol = {
    call: async (method, params) => {
      calls.push({ method, params });
      return { servers: [] };
    },
    close: async () => {},
  };
  const connection = createDesktopConnection(
    { id: 'local', kind: 'local', name: 'PC' },
    {
      moduleUrl: () => 'file:///unused.mjs',
      environmentReady: () => Promise.resolve(),
      sessionOptions: () => ({
        userDataPath: '',
        packaged: false,
        resourcesPath: '',
        appPath: '',
        appVersion: '0.0.0',
        rendererDir: '',
      }),
      loadModelProxyRuntime: async () => {
        throw new Error('unused');
      },
      appVersion: '0.0.0',
      createProtocol: () => protocol,
    }
  );
  try {
    const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
    assert.deepEqual(result.value, { servers: [] });
    assert.deepEqual(calls, [{ method: 'mcp/mcpStatus', params: { threadId: 'pane-7' } }]);
  } finally {
    await connection.dispose();
  }
});
