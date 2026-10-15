import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAntigravityRequest, antigravityFunctionCallingMode } from './antigravity-request.mjs';
import { toGeminiRequestTools } from './gemini-schema.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin/builtin-tools.mjs';
import { TOOL_SEARCH_TOOL } from '../runtime-core/tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../tools/code-graph-tool-defs.mjs';
import { TOOL_DEFS as COMPUTER_TOOL_DEFS } from '../../../computer-bridge/tool-defs.mjs';

const tools = [
  {
    name: 'read',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
];
const messages = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'hello' },
];
const toolConfig = (opts) =>
  buildAntigravityRequest(messages, 'gemini-3.8-flash', tools, opts, 'proj').request.toolConfig;

test('hosted google_search rides in request.tools ahead of function declarations', () => {
  const nativeTools = [{ type: 'google_search' }];
  const searchOnly = buildAntigravityRequest(messages, 'gemini-3.8-flash', undefined, { nativeTools }, 'proj').request;
  assert.deepEqual(searchOnly.tools, [{ googleSearch: {} }]);
  assert.equal(searchOnly.toolConfig, undefined);
  const both = buildAntigravityRequest(messages, 'gemini-3.8-flash', tools, { nativeTools }, 'proj').request;
  assert.deepEqual(both.tools[0], { googleSearch: {} });
  assert.equal(both.tools[1].functionDeclarations[0].name, 'read');
  assert.equal(buildAntigravityRequest(messages, 'gemini-3.8-flash', undefined, {}, 'proj').request.tools, undefined);
});

test('function-calling mode defaults to VALIDATED; the env override and toolChoice take precedence', () => {
  assert.equal(antigravityFunctionCallingMode({}), 'VALIDATED');
  assert.equal(antigravityFunctionCallingMode({ MIXDOG_ANTIGRAVITY_FC_MODE: 'auto' }), 'AUTO');
  assert.equal(antigravityFunctionCallingMode({ MIXDOG_ANTIGRAVITY_FC_MODE: 'ANY' }), 'ANY');
  assert.equal(antigravityFunctionCallingMode({ MIXDOG_ANTIGRAVITY_FC_MODE: 'bogus' }), 'VALIDATED');
  const previous = process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
  try {
    delete process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
    assert.deepEqual(toolConfig({}), { functionCallingConfig: { mode: 'VALIDATED' } });
    process.env.MIXDOG_ANTIGRAVITY_FC_MODE = 'AUTO';
    assert.deepEqual(toolConfig({}), { functionCallingConfig: { mode: 'AUTO' } });
    assert.deepEqual(toolConfig({ toolChoice: 'none' }), { functionCallingConfig: { mode: 'NONE' } });
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
    else process.env.MIXDOG_ANTIGRAVITY_FC_MODE = previous;
  }
});

// ---- Claude tool-schema normalization (GitHub issue #80) ----
const claudeDeclarations = (toolList, model = 'claude-sonnet-4-6') =>
  buildAntigravityRequest(messages, model, toolList, {}, 'proj').request.tools.at(-1).functionDeclarations;
const realToolsByName = new Map(
  [...BUILTIN_TOOLS, TOOL_SEARCH_TOOL, ...CODE_GRAPH_TOOL_DEFS, ...COMPUTER_TOOL_DEFS].map((tool) => [tool.name, tool])
);
const realTools = ['find', 'glob', 'grep', 'read', 'code_graph', 'git', 'load_tool', 'computer'].map((name) => {
  assert.ok(realToolsByName.has(name), `missing real tool ${name}`);
  return realToolsByName.get(name);
});
const declarationSchema = (declaration) => declaration.parameters ?? declaration.parametersJsonSchema;
const hasUnion = (value) => {
  if (Array.isArray(value)) return value.some(hasUnion);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === 'anyOf' || key === 'oneOf' || hasUnion(child));
};

test('Claude declarations carry no anyOf/oneOf, keep order, root objects, and leave sources untouched', () => {
  assert.ok(hasUnion(realTools.map((tool) => tool.inputSchema)), 'fixture must contain unions');
  const before = structuredClone(realTools);
  const declarations = claudeDeclarations(realTools);
  assert.deepEqual(
    declarations.map((d) => d.name),
    realTools.map((t) => t.name)
  );
  assert.equal(declarations[0].name, 'find');
  assert.equal(declarations[1].name, 'glob');
  for (const declaration of declarations) {
    const schema = declarationSchema(declaration);
    assert.equal(hasUnion(declaration), false, `${declaration.name} still has a union`);
    assert.equal(String(schema.type).toLowerCase(), 'object', declaration.name);
    assert.equal(typeof schema.properties, 'object', declaration.name);
  }
  assert.deepEqual(realTools, before);
});

test('Claude glob.pattern advertises a string instead of a typed union', () => {
  const glob = claudeDeclarations(realTools).find((d) => d.name === 'glob');
  const pattern = declarationSchema(glob).properties.pattern;
  assert.equal(String(pattern.type).toLowerCase(), 'string');
  assert.equal(pattern.anyOf, undefined);
  assert.ok(pattern.description);
});

test('Claude union collapsing follows the enum / nullable / heterogeneous rules', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { description: 'm', anyOf: [{ type: 'string', enum: ['a', 'b'] }, { enum: ['b', 'c'] }, { const: 'd' }] },
      maybe: { description: 'n', oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      mixed: { description: 'x', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'number' }, { type: 'string' }] },
      deep: { type: 'array', items: { anyOf: [{ type: 'boolean' }, { type: 'object', properties: {} }] } },
      anyOf: { type: 'string', default: { anyOf: 1 } },
    },
  };
  const source = [{ name: 't', description: 'd', inputSchema: schema }];
  const before = structuredClone(source);
  const out = declarationSchema(claudeDeclarations(source)[0]);
  assert.deepEqual(source, before);
  const type = (node) => String(node.type).toLowerCase();
  assert.equal(type(out.properties.mode), 'string');
  assert.deepEqual(out.properties.mode.enum, ['a', 'b', 'c', 'd']);
  assert.equal(type(out.properties.maybe), 'integer');
  assert.equal(out.properties.maybe.nullable, true);
  assert.equal(out.properties.maybe.description, 'n');
  assert.equal(type(out.properties.mixed), 'number');
  assert.equal(out.properties.mixed.description, 'x');
  assert.equal(type(out.properties.deep.items), 'boolean');
  assert.equal(type(out.properties.anyOf), 'string');
  assert.equal(hasUnion(out.properties.mode) || hasUnion(out.properties.maybe) || hasUnion(out.properties.mixed), false);
});

test('Claude MCP roots with composition become a flat object schema', () => {
  const source = [
    {
      name: 'mcp__s__t',
      description: 'd',
      inputSchema: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] },
    },
    { name: 'bare', description: 'd', inputSchema: undefined },
  ];
  const [composed, bare] = claudeDeclarations(source);
  assert.equal(String(declarationSchema(composed).type).toLowerCase(), 'object');
  assert.equal(hasUnion(composed), false);
  assert.deepEqual(Object.keys(declarationSchema(composed).properties).sort(), ['a', 'b']);
  // No union, so no #80 failure: the declaration keeps its historical shape.
  assert.equal(JSON.stringify(bare), '{"name":"bare","description":"d"}');
});

// Output of the pre-change toGeminiRequestTools (git 3c8ac67df^) for these
// schemas; Claude declarations without a union must stay byte-identical.
const PRE_CHANGE_CLAUDE_BYTES =
  '[{"functionDeclarations":[{"name":"closed","description":"d","parameters":{"type":"object","properties":{"a":{"type":"string"},"o":{"type":"object","properties":{"x":{"type":"string"}}}},"required":["a"]}},{"name":"closedOpaque","description":"d","parametersJsonSchema":{"type":"object","properties":{"a":{},"b":{"type":"string"}},"additionalProperties":false}},{"name":"ref","description":"d","parametersJsonSchema":{"type":"object","properties":{"a":{"$ref":"#/$defs/x"}},"$defs":{"x":{"type":"string"}}}},{"name":"multiType","description":"d","parameters":{"type":"object","properties":{"v":{"type":"string","enum":["__mixdog_unrepresentable_schema_conjunction__"],"description":"Schema conjunction could not be represented safely: unsupported type union string|number"}}}}]}]';

test('Claude declarations without a union are byte-identical to the pre-change output', () => {
  const source = [
    {
      name: 'closed',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string' }, o: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } },
        required: ['a'],
        additionalProperties: false,
      },
    },
    { name: 'closedOpaque', inputSchema: { type: 'object', properties: { a: {}, b: { type: 'string' } }, additionalProperties: false } },
    { name: 'ref', inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/x' } }, $defs: { x: { type: 'string' } } } },
    { name: 'multiType', inputSchema: { type: 'object', properties: { v: { type: ['string', 'number'] } } } },
  ].map((tool) => ({ ...tool, description: 'd' }));
  const bytes = JSON.stringify(
    buildAntigravityRequest(messages, 'claude-sonnet-4-6', source, {}, 'proj').request.tools
  );
  assert.equal(bytes, PRE_CHANGE_CLAUDE_BYTES);
});

test('Claude unions are collapsed on the unchanged declaration path (closed objects keep additionalProperties:false)', () => {
  const closedUnion = {
    type: 'object',
    properties: { v: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, o: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } },
    required: ['v'],
    additionalProperties: false,
  };
  const opaqueUnion = {
    type: 'object',
    properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] }, any: {} },
    additionalProperties: false,
  };
  const [typed, opaque] = claudeDeclarations([
    { name: 'closedUnion', description: 'd', inputSchema: closedUnion },
    { name: 'opaqueUnion', description: 'd', inputSchema: opaqueUnion },
  ]);
  assert.equal(
    JSON.stringify(typed),
    '{"name":"closedUnion","description":"d","parameters":{"type":"object","properties":{"v":{"type":"string"},"o":{"type":"object","properties":{"x":{"type":"string"}}}},"required":["v"]}}'
  );
  assert.equal(
    JSON.stringify(opaque),
    '{"name":"opaqueUnion","description":"d","parametersJsonSchema":{"type":"object","properties":{"v":{"type":"string","nullable":true},"any":{}},"additionalProperties":false}}'
  );
});

test('Gemini declarations are unchanged by the Claude normalization', () => {
  const expected = toGeminiRequestTools(realTools, undefined).at(-1).functionDeclarations;
  const actual = claudeDeclarations(realTools, 'gemini-3.8-flash');
  assert.deepEqual(actual, expected);
  assert.equal(hasUnion(actual), true);
});

test('Claude replay drops the empty text parts recorded around a tool call', () => {
  const call = { id: 'toolu_1', name: 'glob', arguments: { pattern: '*.md' } };
  const recorded = [
    { text: '' },
    { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_1' } },
    { text: '' },
    { text: '', thoughtSignature: 'sig' },
  ];
  const history = (model) => [
    { role: 'user', content: 'find markdown' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [call],
      providerReplay: { version: 1, provider: 'antigravity', items: recorded, requestContext: { model } },
    },
    { role: 'tool', toolCallId: 'toolu_1', content: 'README.md' },
  ];
  const modelParts = (model) =>
    buildAntigravityRequest(history(model), model, BUILTIN_TOOLS, {}).request.contents.find((c) => c.role === 'model')
      .parts;

  const claude = modelParts('claude-sonnet-5-5-low');
  assert.equal(
    claude.some((part) => part.text === '' && part.thoughtSignature === undefined),
    false
  );
  assert.ok(claude.some((part) => part.functionCall?.name === 'glob'));
  assert.ok(claude.some((part) => part.thoughtSignature === 'sig'));
  assert.equal(modelParts('gemini-3.8-flash').filter((part) => part.text === '' && !part.thoughtSignature).length, 2);
});

test('a Claude assistant turn that held only empty parts is omitted, not sent as parts:[]', () => {
  const history = (model) => [
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: '',
      providerReplay: { version: 1, provider: 'antigravity', items: [{ text: '' }, { text: '' }], requestContext: { model } },
    },
    { role: 'user', content: 'second' },
  ];
  const contents = (model) => buildAntigravityRequest(history(model), model, [], {}).request.contents;
  const claude = contents('claude-sonnet-5-5-low');
  assert.equal(
    claude.some((content) => !content.parts?.length),
    false
  );
  assert.equal(claude.some((content) => content.role === 'model'), false);
  // Gemini history is left as recorded.
  assert.equal(contents('gemini-3.8-flash').filter((content) => content.role === 'model').length, 1);
});

test('Claude replay rejoins streamed thinking deltas into one signed block', () => {
  const call = { id: 'toolu_2', name: 'glob', arguments: { pattern: '*.md' } };
  const recorded = [
    { text: '' },
    { thought: true, text: 'first ' },
    { thought: true, text: 'second' },
    { thought: true, text: '', thoughtSignature: 'sig-a' },
    { thought: true, text: 'next block', thoughtSignature: 'sig-b' },
    { text: 'answer ' },
    { text: 'text' },
    { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_2' } },
    { text: '' },
  ];
  const history = (model) => [
    { role: 'user', content: 'find markdown' },
    {
      role: 'assistant',
      content: 'answer text',
      toolCalls: [call],
      providerReplay: { version: 1, provider: 'antigravity', items: recorded, requestContext: { model } },
    },
    { role: 'tool', toolCallId: 'toolu_2', content: 'README.md' },
  ];
  const modelParts = (model) =>
    buildAntigravityRequest(history(model), model, BUILTIN_TOOLS, {}).request.contents.find((c) => c.role === 'model')
      .parts;

  const thoughts = modelParts('claude-sonnet-5-5-low').filter((part) => part.thought === true);
  assert.deepEqual(
    thoughts.map((part) => [part.text, part.thoughtSignature]),
    [
      ['first second', 'sig-a'],
      ['next block', 'sig-b'],
    ]
  );
  assert.equal(modelParts('gemini-3.8-flash').filter((part) => part.thought === true).length, 4);
});
