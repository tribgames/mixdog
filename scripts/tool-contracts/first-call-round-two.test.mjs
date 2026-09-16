import './_env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { TOOL_DEFS as browser } from '../../src/runtime/browser-bridge/tool-defs.mjs';
import { validateBrowserToolArgs } from '../../src/runtime/browser-bridge/action-schema.mjs';
import { COMPUTER_INPUT_SCHEMA, validateComputerToolArgs } from '../../src/runtime/computer-bridge/action-schema.mjs';
import { COMPUTER_CORE_ACTION_SCHEMA } from '../../src/runtime/computer-bridge/core-actions.mjs';
import { TOOL_DEFS as computer } from '../../src/runtime/computer-bridge/tool-defs.mjs';
import { GOAL_TOOL_DEFS } from '../../src/session-runtime/goal-tool-defs.mjs';
import { normalizeGoalTasks, patchGoalTasks } from '../../src/session-runtime/goal-tasks.mjs';
import { SETUP_TOOL_DEFS } from '../../src/session-runtime/setup-tool/tool-defs.mjs';
import { createSetupToolExecutor } from '../../src/session-runtime/setup-tool/executor.mjs';
import { schemaStringLength, schemaValueError } from '../../src/runtime/shared/schema-value-error.mjs';
import { classifyToolFailure } from '../../src/runtime/agent/orchestrator/agent-trace-format.mjs';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const browserSchema = browser.find((tool) => tool.name === 'browser').inputSchema;
const accepts = (schema, value) => assert.equal(ajv.validate(schema, value), true, JSON.stringify(ajv.errors));
const browserAccepts = (args) => {
  accepts(browserSchema, args);
  const result = validateBrowserToolArgs(args);
  assert.equal(result.ok, true, result.error);
};

test('setup refuses malformed or misspelled fields before reaching the settings facade', async () => {
  let facadeReads = 0;
  const executor = createSetupToolExecutor({ getApi: () => { facadeReads++; return {}; } });
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
  const executor = createSetupToolExecutor({ getApi: () => ({
    async setRoute(route) { calls.push(['route', route]); return route; },
    async setAgentRoute(agent, route) { calls.push(['agent', agent, route]); return route; },
    async addMcpServer(server) { calls.push(['mcp', server]); return { name: server.name }; },
  }) });
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
  const note = SETUP_TOOL_DEFS[0].inputSchema.properties.name.description;
  assert.match(note, /set_builtin_enabled: git\|office\|tidy\|localProvider/);
  assert.match(note, /install_builtin also accepts memory/);
  assert.match(note, /set_memory_enabled/);
  const calls = [];
  const executor = createSetupToolExecutor({ getApi: () => ({
    async setMemoryToolsEnabled(enabled) { calls.push(['memory', enabled]); return {}; },
    async installBuiltinFeature(name) { calls.push(['install', name]); return {}; },
  }) });
  await executor.execute({ action: 'set_memory_enabled', enabled: false });
  await executor.execute({ action: 'install_builtin', name: 'memory' });
  await assert.rejects(executor.execute({ action: 'set_builtin_enabled', name: 'memory', enabled: false }), /name must be one of/);
  assert.deepEqual(calls, [['memory', false], ['install', 'memory']]);
});

test('computer action ordering is visible before composing a multi-action call', () => {
  const act = COMPUTER_INPUT_SCHEMA.oneOf.find((branch) => branch.properties.action.enum.includes('act'));
  assert.match(act.properties.input.properties.actions.description, /only type\/key\/wait/);
  assert.match(act.properties.input.properties.actions.description, /without targets/);
  assert.match(act.properties.input.properties.actions.description, /total ≤10s/);
  const args = { action: 'act', input: { window_id: 'hwnd:0x1', actions: [
    { type: 'click', ref: 'ref:1' },
    { type: 'type', text: 'Value' },
    { type: 'key', keys: '{ENTER}' },
  ] } };
  accepts(COMPUTER_INPUT_SCHEMA, args);
  assert.equal(validateComputerToolArgs(args), null);
  args.input.actions[1] = { type: 'click', ref: 'ref:2' };
  assert.match(validateComputerToolArgs(args), /after the first must be type, key, or wait/);
});

test('screenshot and select-sequence descriptions give the accepted first-call combinations', () => {
  const fields = browserSchema.properties.input.properties;
  assert.match(fields.quality.description, /Requires format=jpeg/);
  assert.match(fields.format.description, /snapshot with mode=visual only/);
  assert.match(fields.steps.description, /select requires values/);
  for (const args of [
    { action: 'snapshot', input: { mode: 'visual', format: 'jpeg', quality: 80 } },
    { action: 'snapshot', input: { mode: 'visual', format: 'pdf' } },
    { action: 'select', input: { ref: 'p1-s1-e1' } },
    { action: 'sequence', input: { steps: [
      { action: 'click', ref: 'p1-s1-e1' },
      { action: 'select', ref: 'p1-s1-e2', values: ['KR'] },
    ] } },
  ]) browserAccepts(args);
  assert.deepEqual(browser.find((tool) => tool.name === 'browser_devtools').inputSchema.properties.input.properties.format.enum, ['jpeg', 'png']);
  assert.equal(validateBrowserToolArgs({ action: 'snapshot', input: { mode: 'visual', quality: 80 } }).ok, false);
  assert.equal(validateBrowserToolArgs({ action: 'snapshot', input: { mode: 'both', format: 'pdf' } }).ok, false);
});

test('schema string bounds use Unicode code points, including minimum lengths', () => {
  assert.equal(schemaStringLength('a😀한'), 3);
  const schema = { type: 'string', minLength: 2, maxLength: 3 };
  for (const value of ['😀', '😀a', '😀a한', '😀a한b']) {
    assert.equal(schemaValueError(value, schema, 'text') === null, ajv.validate(schema, value));
  }
});

test('browser string guards agree with the schema on BMP and astral text', () => {
  for (const character of ['한', '😀']) {
    browserAccepts({ action: 'click', input: { target: { name: character.repeat(500) } } });
    browserAccepts({ action: 'snapshot', input: { query: character.repeat(4096) } });
    browserAccepts({ action: 'fill', input: { fields: [{ ref: 'p1-s1-e1', values: [character.repeat(4096)] }] } });
    browserAccepts({ action: 'click', input: { ref: 'p1-s1-e1', expect: { text: character.repeat(10000) } } });
    browserAccepts({ action: 'extract', input: { selector: 'a', attributes: [character.repeat(60)] } });
    browserAccepts({ action: 'sequence', input: { steps: [
      { action: 'fill', savedAccount: character.repeat(320) },
      { action: 'press', key: 'Enter' },
    ] } });
    const tooLong = { action: 'click', input: { target: { name: character.repeat(501) } } };
    assert.equal(ajv.validate(browserSchema, tooLong), false);
    assert.equal(validateBrowserToolArgs(tooLong).ok, false);
  }
});

test('computer Unicode text respects schema bounds without increasing the native foreground budget', () => {
  const args = { action: 'verify', input: { window_id: 'hwnd:0x1', expect: [{ present: '😀'.repeat(4096) }] } };
  accepts(COMPUTER_INPUT_SCHEMA, args);
  assert.equal(validateComputerToolArgs(args), null);
  args.input.expect[0].present += '😀';
  assert.equal(ajv.validate(COMPUTER_INPUT_SCHEMA, args), false);
  assert.match(validateComputerToolArgs(args), /4096/);
  const type = { action: 'act', input: { window_id: 'hwnd:0x1', delivery: 'background', actions: [
    { type: 'type', text: '😀'.repeat(30000) },
  ] } };
  accepts(COMPUTER_INPUT_SCHEMA, type);
  assert.equal(validateComputerToolArgs(type), null);
  type.input.delivery = 'foreground';
  type.input.actions[0].text = '😀'.repeat(2000);
  assert.equal(validateComputerToolArgs(type), null);
  type.input.actions[0].text += '😀';
  assert.match(validateComputerToolArgs(type), /4000 UTF-16 code units/);
  assert.match(COMPUTER_CORE_ACTION_SCHEMA.properties.text.description, /4000 UTF-16 code units/);
});

test('Goal describes the retained-task total without weakening the cap', () => {
  assert.match(GOAL_TOOL_DEFS[0].inputSchema.properties.tasks.description, /Max 20 total, including completed\/dropped/);
  const previous = normalizeGoalTasks(Array.from({ length: 19 }, (_, i) => ({
    text: `Task ${i}`, status: i % 2 ? 'completed' : 'dropped', kind: 'work',
  })), [], { strict: true });
  const added = { text: 'New work', status: 'pending', kind: 'work' };
  assert.equal(patchGoalTasks(previous, { tasks: [added] }).length, 20);
  assert.throws(() => patchGoalTasks(previous, { tasks: [added, { ...added, text: 'Overflow' }] }), /at most 20 entries/);
});

test('report round-two context change without confusing characters with tokens', (t) => {
  const before = { browser: 11872, browser_devtools: 8212, computer: 10391, goal: 3827, setup: 5605 };
  const rows = [...browser, ...computer, ...GOAL_TOOL_DEFS, ...SETUP_TOOL_DEFS].map((tool) => {
    const after = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }).length;
    return { tool: tool.name, before: before[tool.name], after, delta: after - before[tool.name] };
  });
  t.diagnostic(JSON.stringify({ unit: 'serialized JSON characters', rows }));
});
