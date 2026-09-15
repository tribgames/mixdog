import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createSetupToolExecutor } from '../../src/session-runtime/setup-tool/executor.mjs';
import { SETUP_TOOL_DEFS } from '../../src/session-runtime/setup-tool/tool-defs.mjs';
import { toGeminiTools } from '../../src/runtime/agent/orchestrator/providers/gemini-schema.mjs';
import { sanitizeAnthropicInputSchema } from '../../src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs';
import { normalizeGrokToolSchemas } from '../../src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs';
import { TOOL_DEFS as browser } from '../../src/runtime/browser-bridge/tool-defs.mjs';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { validateBuiltinArgs } from '../../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { executeBuiltinTool } from '../../src/runtime/agent/orchestrator/tools/builtin.mjs';

const ajv = new Ajv({ strict: false, validateFormats: false });

test('find query constraints agree between the public schema, Gemini wire and runtime', () => {
  const tool = BUILTIN_TOOLS.find(tool => tool.name === 'find');
  const original = structuredClone(tool);
  const wire = toGeminiTools([tool]).functionDeclarations[0];
  const validators = [
    ajv.compile(tool.inputSchema),
    ajv.compile(wire.parametersJsonSchema || wire.parameters),
  ];
  for (const [args, expected] of [
    [{ query: '' }, false],
    [{ query: ' \t\n' }, false],
    [{}, false],
    [{ query: 'network' }, true],
    [{ query: 'src network' }, true],
    [{ query: ' 네트워크 ' }, true],
  ]) {
    for (const validate of validators) assert.equal(validate(args), expected, JSON.stringify(args));
    assert.equal(validateBuiltinArgs('find', structuredClone(args)) === null, expected, JSON.stringify(args));
  }
  assert.deepEqual(tool, original, 'Provider conversion must preserve the source contract');
});

test('invalid find queries stay errors and explain discovery without silently changing the operation', async () => {
  for (const args of [{ query: '' }, { query: ' \t\n' }, {}]) {
    const original = structuredClone(args);
    const result = String(await executeBuiltinTool('find', args));
    assert.match(result, /^Error: find requires non-empty string "query"/);
    assert.match(result, /use glob in the current Project/);
    assert.match(result, /known filename\/path fragment/);
    assert.deepEqual(args, original);
  }
});

test('setup rejects missing reset values and unrelated action fields before accessing the runtime', async () => {
  const executor = createSetupToolExecutor({
    getApi() { assert.fail('invalid input must not access the runtime'); },
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
    [{ action: 'reconnect_mcp', name: 'unused' }, /does not accept field\(s\): name/],
  ];
  for (const [args, error] of cases) await assert.rejects(executor.execute(args), error);
});

test('setup preserves explicit resets, scopes and documented optional fields on the first call', async () => {
  const calls = [];
  const facade = {
    setSystemShell(value) { calls.push(['shell', value]); return value; },
    setExtensionScope(...args) { calls.push(['scope', ...args]); return {}; },
    setAutoUpdate(enabled) { calls.push(['update', enabled]); return { enabled }; },
    inspectHuggingFaceModel(value) { calls.push(['inspect', value]); return {}; },
    reconnectMcp() { calls.push(['reconnect']); return {}; },
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

test('Gemini preserves MCP reference definitions and rejects values outside their constraints', () => {
  for (const keyword of ['$defs', 'definitions']) {
    const schema = {
      type: 'object',
      properties: { count: { $ref: `#/${keyword}/count` } },
      required: ['count'], additionalProperties: false,
      [keyword]: { count: { type: 'integer', minimum: 1 } },
    };
    const original = structuredClone(schema);
    const declaration = toGeminiTools([{ name: 'mcp_count', inputSchema: schema }]).functionDeclarations[0];
    assert.equal(Object.hasOwn(declaration, 'parameters'), false);
    assert.deepEqual(declaration.parametersJsonSchema, schema);
    const validate = ajv.compile(declaration.parametersJsonSchema);
    assert.equal(validate({ count: 1 }), true);
    for (const args of [{ count: 'wrong' }, { count: 0 }, {}]) assert.equal(validate(args), false);
    declaration.parametersJsonSchema[keyword].count.minimum = 2;
    assert.deepEqual(schema, original, 'wire projection must not alias the source');
  }
});

test('Gemini retains a recursive reference rather than dereferencing or dropping it', () => {
  const schema = {
    type: 'object',
    properties: { value: { type: 'integer' }, child: { $ref: '#' } },
    required: ['value'],
  };
  const declaration = toGeminiTools([{ name: 'mcp_tree', inputSchema: schema }]).functionDeclarations[0];
  assert.deepEqual(declaration.parametersJsonSchema, schema);
  const validate = ajv.compile(declaration.parametersJsonSchema);
  assert.equal(validate({ value: 1, child: { value: 2 } }), true);
  assert.equal(validate({ value: 1, child: { value: 'wrong' } }), false);
});

test('Anthropic allOf retains required fields and intersections instead of treating them as alternatives', () => {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
    required: ['path'],
    allOf: [
      { required: ['count'], properties: { count: { maximum: 3 } } },
      { allOf: [{ required: ['path'], properties: { path: { minLength: 1 } } }] },
    ],
  };
  const original = structuredClone(schema);
  const wire = sanitizeAnthropicInputSchema(schema, 'mcp_read', 'test');
  assert.equal(Object.hasOwn(wire, 'allOf'), false, 'Anthropic forbids root combinators');
  const sourceAccepts = ajv.compile(schema);
  const wireAccepts = ajv.compile(wire);
  for (const [args, expected] of [
    [{ path: 'file', count: 1 }, true], [{ path: 'file', count: 3 }, true],
    [{ path: 'file', count: 0 }, false], [{ path: 'file', count: 4 }, false],
    [{ path: '', count: 1 }, false], [{ path: 'file' }, false], [{ count: 1 }, false],
    [{ path: 'file', count: '2' }, false], [{ path: 'file', count: 1, extra: true }, false],
  ]) {
    assert.equal(sourceAccepts(args), expected);
    assert.equal(wireAccepts(args), expected, JSON.stringify(args));
  }
  assert.deepEqual(schema, original);
});

test('Grok normalizes nested array and map schemas without interpreting data-valued keywords', () => {
  const alternatives = { anyOf: [
    { type: 'string', minLength: 1 },
    { type: 'array', items: { type: 'string' } },
  ] };
  const schema = {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { type: 'object', properties: { value: alternatives }, required: ['value'] } },
      values: { type: 'array', items: alternatives },
      labels: { type: 'object', additionalProperties: alternatives },
      literal: { type: 'object', default: { anyOf: ['not a schema'] } },
    },
    required: ['rows', 'values', 'labels'],
  };
  const original = structuredClone(schema);
  const [tool] = normalizeGrokToolSchemas([{ name: 'mcp_rows', inputSchema: schema }]);
  for (const field of [
    tool.inputSchema.properties.rows.items.properties.value,
    tool.inputSchema.properties.values.items,
    tool.inputSchema.properties.labels.additionalProperties,
  ]) {
    assert.equal(field.type, 'string');
    assert.equal(Object.hasOwn(field, 'anyOf'), false);
    assert.equal(field.minLength, 1);
    assert.match(field.description, /single value.*not an array/);
  }
  const validate = ajv.compile(tool.inputSchema);
  assert.equal(validate({ rows: [{ value: 'one' }], values: ['two'], labels: { a: 'three' } }), true);
  assert.equal(validate({ rows: [{ value: '' }], values: ['two'], labels: {} }), false);
  assert.equal(validate({ rows: [], values: [['two']], labels: {} }), false);
  assert.deepEqual(tool.inputSchema.properties.literal.default, schema.properties.literal.default);
  assert.deepEqual(schema, original);
  assert.deepEqual(normalizeGrokToolSchemas([tool]), [tool], 'normalization is idempotent');
});

test('report this cycle model-visible contract size without adding runtime dispatch maps', (t) => {
  const before = { setup: 5660, browser: 11888, browser_devtools: 8186 };
  const rows = [...SETUP_TOOL_DEFS, ...browser].map(({ name, description, inputSchema }) => {
    const after = JSON.stringify({ description, inputSchema }).length;
    return { name, before: before[name], after, delta: after - before[name] };
  });
  t.diagnostic(JSON.stringify({ unit: 'serialized JSON characters, not tokenizer counts', rows }));
});
