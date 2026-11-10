import './_env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { SETUP_TOOL_DEFS } from '../../src/session-runtime/setup-tool/tool-defs.mjs';
import { createSetupToolExecutor } from '../../src/session-runtime/setup-tool/executor.mjs';
import { classifyToolFailure } from '../../src/runtime/agent/orchestrator/agent-trace-format.mjs';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });

test('setup refuses malformed or misspelled fields before reaching the settings facade', async () => {
  let facadeReads = 0;
  const executor = createSetupToolExecutor({
    getApi: () => {
      facadeReads++;
      return {};
    },
  });
  for (const args of [
    { action: 'set_route', route: { model: 'model-id', fast: 'true' } },
    { action: 'set_route', route: { model: 'model-id', effrot: 'high' } },
    { action: 'set_route', route: { model: 123 } },
    { action: 'set_route', route: { model: 'model-id' }, extra: true },
    { action: 'set_profile', profile: { title: 'User', experiencelevel: 'advanced' } },
    JSON.parse('{"action":"set_route","route":{"model":"model-id","constructor":"unexpected"}}'),
    JSON.parse('{"action":"set_route","route":{"model":"model-id","__proto__":{"polluted":true}}}'),
  ]) {
    assert.equal(ajv.validate(SETUP_TOOL_DEFS[0].inputSchema, args), false);
    await assert.rejects(executor.execute(args), (error) => {
      assert.match(error.message, /\[tool-input-validation\] setup/);
      assert.equal(classifyToolFailure(error.message, 'setup'), 'schema/args');
      return true;
    });
  }
  assert.equal(facadeReads, 0);
  assert.equal({}.polluted, undefined);
});

test('setup forwards valid false values, inheritance and open MCP configuration unchanged', async () => {
  const calls = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({
      async setRoute(route) {
        calls.push(['route', route]);
        return route;
      },
      async setAgentRoute(agent, route) {
        calls.push(['agent', agent, route]);
        return route;
      },
      async addMcpServer(server) {
        calls.push(['mcp', server]);
        return { name: server.name };
      },
    }),
  });
  await executor.execute({ action: 'set_route', route: { model: 'model-id', fast: false } });
  await executor.execute({ action: 'set_agent_route', agent: 'worker', route: { provider: '' } });
  const server = { name: 'fixture', type: 'stdio', command: 'fixture', args: [], env: { CUSTOM_FIELD: 'value' } };
  await executor.execute({ action: 'add_mcp_server', server });
  assert.deepEqual(calls, [
    ['route', { model: 'model-id', fast: false }],
    ['agent', 'worker', { provider: '' }],
    ['mcp', server],
  ]);
});

test('setup names distinguish built-in toggles from Memory installation and toggling', async () => {
  const calls = [];
  const executor = createSetupToolExecutor({
    getApi: () => ({
      async setMemoryToolsEnabled(enabled) {
        calls.push(['memory', enabled]);
        return {};
      },
      async installBuiltinFeature(name) {
        calls.push(['install', name]);
        return {};
      },
    }),
  });
  await executor.execute({ action: 'set_memory_enabled', enabled: false });
  await executor.execute({ action: 'install_builtin', name: 'memory' });
  await assert.rejects(
    executor.execute({ action: 'set_builtin_enabled', name: 'memory', enabled: false }),
    /name must be one of/
  );
  assert.deepEqual(calls, [
    ['memory', false],
    ['install', 'memory'],
  ]);
});

test('setup rejects missing reset values and unrelated action fields before accessing the runtime', async () => {
  const executor = createSetupToolExecutor({
    getApi() {
      assert.fail('invalid input must not access the runtime');
    },
  });
  const cases = [
    [{ action: 'set_system_shell' }, /command is required/],
    [{ action: 'set_extension_scope', kind: 'skills', name: 'pdf' }, /projects is required/],
    [{ action: 'set_extension_scope', kind: 'skills', name: 'pdf', projects: [' '] }, /projects\[0\]/],
    [{ action: 'set_agent_route', agent: 'worker' }, /route is required/],
    [{ action: 'set_web_search_route' }, /route is required/],
    [{ action: 'set_auto_update', enabled: false, route: { model: 'ignored' } }, /does not accept field\(s\): route/],
    [{ action: 'set_route', route: { model: 'valid' }, enabled: false }, /does not accept field\(s\): enabled/],
    [{ action: 'status', name: 'unused' }, /does not accept field\(s\): name/],
    [{ action: 'reconnect_mcp', enabled: true }, /does not accept field\(s\): enabled/],
  ];
  for (const [args, error] of cases) await assert.rejects(executor.execute(args), error);
});

test('setup preserves explicit resets, scopes and documented optional fields on the first call', async () => {
  const calls = [];
  const facade = {
    setSystemShell(value) {
      calls.push(['shell', value]);
      return value;
    },
    setExtensionScope(...args) {
      calls.push(['scope', ...args]);
      return {};
    },
    setAutoUpdate(enabled) {
      calls.push(['update', enabled]);
      return { enabled };
    },
    inspectHuggingFaceModel(value) {
      calls.push(['inspect', value]);
      return {};
    },
    reconnectMcp() {
      calls.push(['reconnect']);
      return {};
    },
  };
  const executor = createSetupToolExecutor({ getApi: () => facade });
  const cases = [
    { action: 'set_system_shell', command: '' },
    { action: 'set_system_shell', command: ' pwsh ' },
    { action: 'set_extension_scope', kind: 'skills', name: 'pdf', projects: [] },
    { action: 'set_extension_scope', kind: 'skills', name: 'pdf', projects: [' C:\\Project\\mixdog '] },
    { action: 'set_auto_update', enabled: false },
    { action: 'inspect_hf_model', repository: 'owner/model' },
    { action: 'reconnect_mcp' },
  ];
  for (const args of cases) {
    assert.equal(ajv.validate(SETUP_TOOL_DEFS[0].inputSchema, args), true, JSON.stringify(ajv.errors));
    await executor.execute(args);
  }
  assert.deepEqual(calls, [
    ['shell', { command: '' }],
    ['shell', { command: 'pwsh' }],
    ['scope', 'skills', 'pdf', []],
    ['scope', 'skills', 'pdf', ['C:\\Project\\mixdog']],
    ['update', false],
    ['inspect', { repository: 'owner/model', filename: undefined, contextWindow: undefined }],
    ['reconnect'],
  ]);
});
