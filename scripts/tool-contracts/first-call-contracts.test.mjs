import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { PATCH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as memory } from '../../src/runtime/memory/tool-defs.mjs';
import { TOOL_DEFS as web } from '../../src/runtime/web-search/tool-defs.mjs';
import { TOOL_DEFS as channels } from '../../src/runtime/channels/tool-defs.mjs';
import { TOOL_DEFS as browser } from '../../src/runtime/browser-bridge/tool-defs.mjs';
import { TOOL_DEFS as computer } from '../../src/runtime/computer-bridge/tool-defs.mjs';
import { TOOL_DEFS as office } from '../../src/runtime/office/tool-defs.mjs';
import { TOOL_DEFS as media } from '../../src/runtime/media/tool-defs.mjs';
import { GOAL_TOOL_DEFS } from '../../src/session-runtime/goal-tool-defs.mjs';
import { SETUP_TOOL_DEFS } from '../../src/session-runtime/setup-tool/tool-defs.mjs';
import { CWD_TOOL, SKILL_TOOL, TOOL_SEARCH_TOOL } from '../../src/session-runtime/tool-defs.mjs';
import { AGENT_TOOL } from '../../src/standalone/agent-tool/tool-def.mjs';
import { normalizeGoalTasks, patchGoalTasks } from '../../src/session-runtime/goal-tasks.mjs';
import { validateBrowserToolArgs } from '../../src/runtime/browser-bridge/action-schema.mjs';
import { validateComputerToolArgs, toComputerHostCommand } from '../../src/runtime/computer-bridge/action-schema.mjs';
import { validateXlsxOperations } from '../../src/runtime/office/portable/xlsx-contract.mjs';
import { normalizeGrokToolSchemas } from '../../src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs';
import { toGeminiTools } from '../../src/runtime/agent/orchestrator/providers/gemini-schema.mjs';
import { sanitizeAnthropicInputSchema } from '../../src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs';
import { toOpenAIResponsesTool } from '../../src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs';

// URI transport/security validation belongs to the tools. Here the independent
// validator checks JSON Schema structure, value types, and numeric/string bounds.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const catalog = [
  ...BUILTIN_TOOLS,
  ...CODE_GRAPH_TOOL_DEFS,
  ...PATCH_TOOL_DEFS,
  ...memory,
  ...web,
  ...channels,
  ...browser,
  ...computer,
  ...office,
  ...media,
  ...GOAL_TOOL_DEFS,
  ...SETUP_TOOL_DEFS,
  CWD_TOOL,
  SKILL_TOOL,
  TOOL_SEARCH_TOOL,
  AGENT_TOOL,
];
const schemaFor = (name) => catalog.find((tool) => tool.name === name).inputSchema;
const accepts = (schema, args) => {
  assert.equal(ajv.validate(schema, args), true, JSON.stringify(ajv.errors));
};
const projections = (tool) => {
  const gemini = toGeminiTools([tool]).functionDeclarations[0];
  return [
    ['canonical', tool.inputSchema],
    ['Gemini/Antigravity', gemini.parametersJsonSchema ?? gemini.parameters],
    ['Grok', normalizeGrokToolSchemas([tool])[0].inputSchema],
    ['Anthropic', sanitizeAnthropicInputSchema(tool.inputSchema, tool.name, 'first-call')],
  ];
};

test('the complete catalog and provider projections remain valid without mutating source contracts', () => {
  assert.equal(new Set(catalog.map((tool) => tool.name)).size, catalog.length);
  const original = JSON.stringify(catalog);
  for (const tool of catalog) {
    for (const [provider, schema] of projections(tool)) {
      assert.equal(ajv.validateSchema(schema), true, `${tool.name}/${provider}: ${JSON.stringify(ajv.errors)}`);
      ajv.compile(schema);
      assert.equal(
        JSON.stringify(schema).includes('__mixdog_unrepresentable_schema_conjunction__'),
        false,
        `${tool.name}/${provider} must not advertise an impossible placeholder`
      );
    }
    const openai = toOpenAIResponsesTool(tool);
    if (openai.type !== 'custom') assert.deepEqual(openai.parameters, tool.inputSchema);
  }
  assert.equal(JSON.stringify(catalog), original);
});

test('Goal boundaries are known before a call and updates do not need a failed addition first', () => {
  const task = { text: 'x'.repeat(500), status: 'pending' };
  accepts(schemaFor('goal'), { action: 'create', objective: 'One-shot outcome', tasks: [task] });
  const created = normalizeGoalTasks([task], [], { strict: true });
  const update = { action: 'update_tasks', revision: 1, updates: [{ id: created[0].id, status: 'completed' }] };
  accepts(schemaFor('goal'), update);
  assert.equal(patchGoalTasks(created, update)[0].status, 'completed');
  const tooLong = { ...task, text: 'x'.repeat(501) };
  assert.equal(ajv.validate(schemaFor('goal'), { action: 'create', tasks: [tooLong] }), false);
  assert.throws(() => normalizeGoalTasks([tooLong], [], { strict: true }), /exceeds 500 characters/);
  const unicode = { ...task, text: '😀'.repeat(500) };
  accepts(schemaFor('goal'), { action: 'create', tasks: [unicode] });
  assert.equal(normalizeGoalTasks([unicode], [], { strict: true })[0].text, unicode.text);
  assert.equal(
    ajv.validate(schemaFor('goal'), {
      action: 'create',
      tasks: Array.from({ length: 21 }, (_, i) => ({ ...task, text: `Task ${i}` })),
    }),
    false
  );
});

test('documented browser first calls and stored-login sequences agree with runtime validation', () => {
  const cases = [
    { action: 'navigate', input: { url: 'https://example.test/', includeScreenshot: true } },
    { action: 'locate', input: { query: 'Save', limit: 20 } },
    { action: 'console', input: { limit: 20 } },
    { action: 'snapshot', input: { mode: 'both', maxElements: 100 } },
    { action: 'fill', input: { ref: 'p1-s1-e1', checked: false } },
    {
      action: 'sequence',
      input: {
        steps: [
          { action: 'fill', savedAccount: 'a•••a@example.test' },
          { action: 'click', target: { role: 'button', name: 'Sign in' } },
        ],
      },
    },
  ];
  for (const args of cases) {
    accepts(schemaFor('browser'), args);
    const result = validateBrowserToolArgs(args, { tool: 'browser' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.input, args.input);
  }
  const fields = schemaFor('browser').properties.input.properties;
  assert.match(fields.mode.description, /snapshot only/);
  assert.match(fields.maxChars.description, /not locate\/console/);
  assert.equal(
    validateBrowserToolArgs({ action: 'snapshot', input: '{"mode":"both"}' }).ok,
    true,
    'unambiguous JSON transport shape remains supported'
  );
});

test('browser rejects schema-invalid scalar and nested values before input dispatch', () => {
  const cases = [
    { action: 'snapshot', input: { mode: 'wrong' } },
    { action: 'snapshot', input: { maxElements: -1 } },
    { action: 'fill', input: { ref: 'p1-s1-e1', checked: 'false' } },
    { action: 'click', input: { snapshotId: 's1', x: -1, y: 1 } },
    { action: 'click', input: { ref: 'p1-s1-e1', button: 'other' } },
    { action: 'click', input: { ref: 'p1-s1-e1', expect: { timeoutMs: -1 } } },
    {
      action: 'sequence',
      input: {
        steps: [
          { action: 'fill', ref: 'p1-s1-e1', checked: false },
          { action: 'press', key: 'Enter', submit: 'yes' },
        ],
      },
    },
  ];
  for (const args of cases) {
    assert.equal(ajv.validate(schemaFor('browser'), args), false, JSON.stringify(args));
    assert.equal(validateBrowserToolArgs(args).ok, false, JSON.stringify(args));
  }
  const args = { action: 'init_script', input: { operation: 'add', script: 'x'.repeat(20_001) } };
  assert.equal(ajv.validate(schemaFor('browser_devtools'), args), false);
  assert.equal(validateBrowserToolArgs(args).ok, false);
});

test('every computer action keeps its usable input fields through provider flattening', () => {
  const tool = computer[0];
  const window_id = 'hwnd:0x1';
  const cases = [
    { action: 'list', input: { kind: 'windows' } },
    { action: 'diagnose' },
    { action: 'capture' },
    { action: 'verify', input: { window_id, expect: [{ window_exists: true }] } },
    { action: 'wait_for_user' },
    { action: 'act', input: { window_id, actions: [{ type: 'click', ref: 'ref:1' }] } },
    { action: 'window', input: { window_id, operation: 'focus' } },
    { action: 'menu', input: { window_id, path: ['File'] } },
    { action: 'clipboard', input: { operation: 'read' } },
    { action: 'launch', input: { app: 'notepad.exe' } },
  ];
  assert.deepEqual(cases.map((args) => args.action).sort(), [...tool.inputSchema.properties.action.enum].sort());
  for (const args of cases) {
    assert.equal(validateComputerToolArgs(args), null, JSON.stringify(args));
    assert.equal(typeof toComputerHostCommand(args).action, 'string');
    for (const [, schema] of projections(tool)) accepts(schema, args);
  }
  const sourceFields = [
    ...new Set(tool.inputSchema.oneOf.flatMap((branch) => Object.keys(branch.properties.input.properties))),
  ].sort();
  for (const schema of [
    normalizeGrokToolSchemas([tool])[0].inputSchema,
    sanitizeAnthropicInputSchema(tool.inputSchema, tool.name, 'first-call'),
  ]) {
    assert.deepEqual(Object.keys(schema.properties.input.properties).sort(), sourceFields);
    assert.match(schema.properties.input.description, /actions\*/);
    assert.match(schema.properties.input.description, /operation\*=read\|write/);
    assert.match(schema.properties.input.description, /timeout_ms>=0<=30000/);
  }
});

test('computer nested text bounds match the public schema before host execution', () => {
  const args = { action: 'verify', input: { window_id: 'hwnd:0x1', expect: [{ present: 'x'.repeat(4096) }] } };
  accepts(schemaFor('computer'), args);
  assert.equal(validateComputerToolArgs(args), null);
  args.input.expect[0].present += 'x';
  assert.equal(ajv.validate(schemaFor('computer'), args), false);
  assert.match(validateComputerToolArgs(args), /4096/);
});

test('Office matrices, row values and PDF field maps survive every provider schema', () => {
  const operations = [
    {
      op: 'set_range',
      range: 'A1:B2',
      values: [
        [1, 'two'],
        [true, null],
      ],
    },
    { op: 'append_row', values: [1, 'two', true] },
    { op: 'fill_form', values: { name: 'Ada', accepted: true } },
  ];
  validateXlsxOperations(structuredClone(operations.slice(0, 2)));
  for (const operation of operations) {
    for (const [, schema] of projections(office[0])) {
      accepts(schema, { action: 'batch', operations: [operation] });
    }
  }
  assert.match(schemaFor('office').properties.pages.description, /analysis: select at most 100/);
  accepts(schemaFor('office'), { action: 'render', pages: Array.from({ length: 101 }, (_, i) => i + 1) });
});

test('Gemini uses its JSON Schema wire field for opaque values instead of guessing a type', () => {
  const declaration = toGeminiTools(office).functionDeclarations[0];
  assert.equal(Object.hasOwn(declaration, 'parameters'), false);
  assert.deepEqual(declaration.parametersJsonSchema, office[0].inputSchema);
  const untypedArray = {
    name: 'rows',
    inputSchema: {
      type: 'object',
      properties: { values: { type: 'array' } },
      required: ['values'],
    },
  };
  const arrayDeclaration = toGeminiTools([untypedArray]).functionDeclarations[0];
  assert.equal(Object.hasOwn(arrayDeclaration, 'parameters'), false);
  accepts(arrayDeclaration.parametersJsonSchema, {
    values: [
      [1, 2],
      [3, 4],
    ],
  });
  const typed = toGeminiTools(GOAL_TOOL_DEFS).functionDeclarations[0];
  assert.equal(Object.hasOwn(typed, 'parametersJsonSchema'), false);
  assert.ok(typed.parameters);
});

test('report model-visible contract size against the measured pre-fix baseline', (t) => {
  const before = { browser: 11540, browser_devtools: 8119, computer: 10391, office: 7588, goal: 3767, github: 3074 };
  const rows = Object.entries(before).map(([name, chars]) => {
    const tool = catalog.find((entry) => entry.name === name);
    const after = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }).length;
    return { tool: name, before: chars, after, delta: after - chars };
  });
  t.diagnostic(JSON.stringify({ unit: 'serialized JSON characters, not tokenizer counts', rows }));
});
