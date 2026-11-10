import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildAntigravityRequest, antigravityFunctionCallingMode } from './antigravity-request.mjs';
import { toGeminiRequestTools } from './gemini-schema.mjs';
import { actionInputUnionFor } from './lib/action-input-contract.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin/builtin-tools.mjs';
import { TOOL_SEARCH_TOOL, TOOL_BRIDGE_TOOLS, SKILL_TOOL, SESSION_TOOL } from '../runtime-core/tool-defs.mjs';
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

// ---- Claude tool-schema handling (GitHub issue #80) ----
// Claude declarations reach Anthropic as draft 2020-12 input_schemas with an
// object root. Valid schemas pass through as written; a tool whose schema is
// invalid is left out with a warning and the request proceeds.
const claudeRequest = (toolList, model = 'claude-sonnet-4-6', opts = {}) => {
  const warnings = [];
  const { request } = buildAntigravityRequest(
    messages,
    model,
    toolList,
    { onToolExcluded: (exclusion) => warnings.push(exclusion.message), ...opts },
    'proj'
  );
  return { request, warnings, declarations: request.tools?.at(-1)?.functionDeclarations ?? [] };
};
const claudeDeclarations = (toolList, model) => claudeRequest(toolList, model).declarations;
const realToolsByName = new Map(
  [...BUILTIN_TOOLS, TOOL_SEARCH_TOOL, ...CODE_GRAPH_TOOL_DEFS, ...COMPUTER_TOOL_DEFS].map((tool) => [tool.name, tool])
);
const realTools = ['find', 'glob', 'grep', 'read', 'code_graph', 'git', 'load_tool', 'computer'].map((name) => {
  assert.ok(realToolsByName.has(name), `missing real tool ${name}`);
  return realToolsByName.get(name);
});
const hasUnion = (value) => {
  if (Array.isArray(value)) return value.some(hasUnion);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === 'anyOf' || key === 'oneOf' || hasUnion(child));
};
const mcp = (name, inputSchema) => ({ name, description: 'd', inputSchema });
const claudeSchema = (inputSchema) => claudeDeclarations([mcp('t', inputSchema)])[0]?.parametersJsonSchema;
const excluded = (inputSchema, name = 't') => {
  const { declarations, warnings } = claudeRequest([mcp(name, inputSchema)]);
  assert.deepEqual(declarations, []);
  assert.equal(warnings.length, 1);
  return warnings[0];
};

test('the full built-in + bridge surface is valid 2020-12 as authored, sent unchanged to Sonnet and Opus', () => {
  const surface = [
    ...BUILTIN_TOOLS,
    ...CODE_GRAPH_TOOL_DEFS,
    ...COMPUTER_TOOL_DEFS,
    ...TOOL_BRIDGE_TOOLS,
    SKILL_TOOL,
    SESSION_TOOL,
  ];
  assert.ok(hasUnion(surface.map((tool) => tool.inputSchema)), 'fixture must contain unions');
  const before = structuredClone(surface);
  const sonnet = claudeRequest(surface, 'claude-sonnet-4-6');
  const opus = claudeRequest(surface, 'claude-opus-4-6-thinking');
  assert.deepEqual(sonnet.warnings, []);
  assert.deepEqual(sonnet.declarations, opus.declarations);
  assert.deepEqual(
    sonnet.declarations.map((d) => d.name),
    surface.map((t) => t.name)
  );
  const meta = new Ajv2020({ strict: false, validateFormats: false });
  for (const [i, declaration] of sonnet.declarations.entries()) {
    const schema = declaration.parametersJsonSchema;
    assert.equal(declaration.parameters, undefined, declaration.name);
    // Authored schemas pass unchanged; a per-action input union opts into its
    // nested form on this verified path.
    assert.deepEqual(
      schema,
      actionInputUnionFor(surface[i].inputSchema),
      `${declaration.name} must be sent as authored`
    );
    assert.equal(meta.validateSchema(schema), true, `${declaration.name}: ${meta.errorsText(meta.errors)}`);
    assert.equal(schema.type, 'object', declaration.name);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'not']) assert.equal(schema[key], undefined, declaration.name);
  }
  assert.deepEqual(surface, before);
});

test('standard 2020-12 forms are sent as written: unions, type arrays, nullable, numeric enums, null', () => {
  const properties = {
    maybe: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    nullable: { type: ['string', 'null'] },
    multi: { type: ['string', 'number'] },
    level: { type: 'integer', enum: [1, 2, 3] },
    flag: { const: null },
    open: { nullable: true, type: 'string' },
    deep: { type: 'array', items: { oneOf: [{ type: 'boolean' }, { type: 'object', properties: {} }] } },
  };
  const source = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:example:tool',
    type: 'object',
    properties,
    additionalProperties: { type: 'string' },
  };
  const before = structuredClone(source);
  const { $schema, ...expected } = source;
  assert.deepEqual(claudeSchema(source), expected);
  assert.deepEqual(source, before);
});

test('boolean schemas, recursive $defs and keyword-like property names are valid and untouched', () => {
  const source = {
    type: 'object',
    properties: {
      examples: { type: 'array', items: { type: 'string' } },
      type: { type: 'string', enum: ['a', 'b'] },
      items: { type: 'array', items: { type: 'string' } },
      definitions: { type: 'string' },
      $ref: { type: 'string' },
      anyOf: { type: 'string', default: { anyOf: 1 } },
      anything: true,
      never: false,
      node: { $ref: '#/$defs/Node' },
    },
    required: ['type'],
    $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
  };
  assert.deepEqual(claudeSchema(source), source);
});

test('declared draft-07 is translated by the standard keyword mapping only', () => {
  const source = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'urn:example:tool',
    type: 'object',
    properties: {
      closed: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false },
      typed: { type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } },
      open: { type: 'array', items: [{ type: 'string' }] },
      plain: { type: 'array', items: { type: 'string' } },
      ref: { $ref: '#/definitions/Name' },
      definitions: { type: 'string' },
    },
    definitions: { Name: { type: 'string' } },
    dependencies: { closed: ['open'], open: { required: ['typed'] }, plain: true },
  };
  const before = structuredClone(source);
  assert.deepEqual(claudeSchema(source), {
    $id: 'urn:example:tool',
    type: 'object',
    properties: {
      closed: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false },
      typed: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } },
      open: { type: 'array', prefixItems: [{ type: 'string' }] },
      plain: { type: 'array', items: { type: 'string' } },
      ref: { $ref: '#/$defs/Name' },
      definitions: { type: 'string' },
    },
    dependentRequired: { closed: ['open'] },
    dependentSchemas: { open: { required: ['typed'] }, plain: true },
    $defs: { Name: { type: 'string' } },
  });
  assert.deepEqual(source, before);
});

test('draft-07 definitions follow their own $id scope', () => {
  const out = claudeSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      embedded: {
        $id: 'urn:example:inner',
        type: 'object',
        definitions: { Leaf: { type: 'string' } },
        properties: { leaf: { $ref: '#/definitions/Leaf' } },
      },
    },
  });
  assert.deepEqual(out.properties.embedded, {
    $id: 'urn:example:inner',
    type: 'object',
    $defs: { Leaf: { type: 'string' } },
    properties: { leaf: { $ref: '#/$defs/Leaf' } },
  });
});

test('draft-07 keywords beside $ref are ignored, so the translated schema is not stricter', () => {
  const out = claudeSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      sibling: { $ref: '#/definitions/s', maxLength: 1, description: 'ignored', type: 'integer' },
      nested: {
        type: 'array',
        items: { anyOf: [{ $ref: '#/definitions/s', minLength: 5 }, { type: 'null' }] },
      },
      deep: { type: 'object', properties: { inner: { $ref: '#/definitions/s', pattern: '^z$' } } },
      // Keyword-like property names are data: a property named "$ref" is not a reference.
      $ref: { type: 'string', maxLength: 1 },
      holder: { type: 'object', properties: { $ref: { type: 'string', minLength: 2 } }, required: ['$ref'] },
    },
    definitions: { s: { type: 'string' } },
  });
  assert.deepEqual(out.properties.sibling, { $ref: '#/$defs/s' });
  assert.deepEqual(out.properties.nested.items.anyOf, [{ $ref: '#/$defs/s' }, { type: 'null' }]);
  assert.deepEqual(out.properties.deep.properties.inner, { $ref: '#/$defs/s' });
  assert.deepEqual(out.properties.$ref, { type: 'string', maxLength: 1 });
  assert.deepEqual(out.properties.holder, {
    type: 'object',
    properties: { $ref: { type: 'string', minLength: 2 } },
    required: ['$ref'],
  });
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(out);
  assert.equal(validate({ sibling: 'long string', nested: ['abc', null], deep: { inner: 'abc' } }), true);
  assert.equal(validate({ sibling: 5 }), false, 'the referenced schema still applies');
  assert.equal(validate({ $ref: 'xx' }), false, 'a property named $ref keeps its own constraints');
});

test('draft-07 definitions stay reachable from a $ref node that carries them', () => {
  const out = claudeSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      x: { $ref: '#/properties/x/definitions/t', definitions: { t: { type: 'string' } }, maxLength: 1 },
    },
  });
  assert.deepEqual(out.properties.x, { $ref: '#/properties/x/definitions/t', definitions: { t: { type: 'string' } } });
});

test('an invalid tool is left out with a warning (tool, index, pointer, reason); the request proceeds in order', () => {
  const good = (name) => mcp(name, { type: 'object', properties: { x: { type: 'string' } } });
  const { request, warnings, declarations } = claudeRequest(
    [
      good('first'),
      mcp('badtype', { type: 'object', properties: { a: { type: 'bogus-type' } } }),
      good('second'),
      mcp('missing', { type: 'object', properties: { value: { $ref: '#/$defs/Absent' } } }),
      good('third'),
    ],
    'claude-sonnet-4-6',
    { nativeTools: [{ type: 'google_search' }] }
  );
  assert.deepEqual(
    declarations.map((d) => d.name),
    ['first', 'second', 'third']
  );
  assert.deepEqual(request.tools[0], { googleSearch: {} });
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } });
  assert.equal(warnings.length, 2);
  assert.match(
    warnings[0],
    /"badtype" \(tools\[1\]\) excluded: invalid input schema at "\/properties\/a\/type": .*2020-12/
  );
  assert.match(
    warnings[1],
    /"missing" \(tools\[3\]\) excluded: invalid input schema at "\/properties\/value\/\$ref": unresolvable \$ref/
  );
});

test('roots the provider forbids exclude the tool; nothing is merged or widened', () => {
  const branch = { type: 'object', properties: { a: { type: 'string' } } };
  assert.match(excluded({ type: 'object', allOf: [branch] }), /"\/allOf": .*root "allOf"/);
  assert.match(excluded({ type: 'object', anyOf: [branch] }), /"\/anyOf": .*root "anyOf"/);
  assert.match(excluded({ type: 'object', oneOf: [branch] }), /"\/oneOf": .*root "oneOf"/);
  assert.match(excluded({ type: 'object', properties: {}, not: {} }), /"\/not": .*root "not"/);
  assert.match(excluded({ anyOf: [branch] }), /"\/type": .*"object"/);
  assert.match(excluded({ type: 'string' }), /"\/type": .*"object"/);
  assert.match(excluded({ $ref: '#/$defs/A', $defs: { A: branch } }), /"\/type"/);
  assert.match(excluded(undefined), /the input schema must be a JSON object schema/);
  assert.match(excluded(true), /the input schema must be a JSON object schema/);
});

test('schemas invalid under their dialect are excluded with the standard reason', () => {
  assert.match(excluded({ type: 'object', required: ['a', 'a'] }), /"\/required": .*2020-12/);
  assert.match(
    excluded({ type: 'object', properties: { a: { type: 'bogus-type' } } }),
    /"\/properties\/a\/type": .*2020-12/
  );
  assert.match(
    excluded({ type: 'object', properties: { a: { $ref: 'https://example.invalid/a.json' } } }),
    /"\/properties\/a\/\$ref": unresolvable \$ref/
  );
  assert.match(
    excluded({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: { items: [{}], prefixItems: [{}] } },
    }),
    /"\/properties\/a\/items": tuple "items"/
  );
});

test('when every tool is invalid the request carries no tools or toolConfig and still builds', () => {
  const { request, warnings } = claudeRequest([mcp('bad', { anyOf: [] })]);
  assert.equal(warnings.length, 1);
  assert.equal(request.tools, undefined);
  assert.equal(request.toolConfig, undefined);
});

test('the default warning channel is console.warn, reported once per distinct problem', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const bad = mcp('warn_once_tool', { type: 'object', properties: {}, allOf: [{}] });
  buildAntigravityRequest(messages, 'claude-sonnet-4-6', [bad], {}, 'proj');
  buildAntigravityRequest(messages, 'claude-sonnet-4-6', [bad], {}, 'proj');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /"warn_once_tool" \(tools\[0\]\) excluded/);
});

test('a missing schema excludes the tool; declaration order of valid tools is kept', () => {
  const source = [
    mcp('b', { type: 'object', properties: {} }),
    mcp('a', { type: 'object', properties: { x: { type: 'string' } } }),
  ];
  assert.deepEqual(
    claudeDeclarations(source).map((d) => d.name),
    ['b', 'a']
  );
});

test('Gemini declarations are unchanged by the Claude normalization', () => {
  const expected = toGeminiRequestTools(realTools, undefined).at(-1).functionDeclarations;
  const actual = claudeDeclarations(realTools, 'gemini-3.8-flash');
  assert.deepEqual(actual, expected);
  assert.equal(hasUnion(actual), true);
});

test('Ajv resolves from the root package dependency', async () => {
  const require = createRequire(import.meta.url);
  const rootManifest = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  assert.match(rootManifest.dependencies.ajv, /^\^8\./);
  // Compare canonical real paths so a linked (junction/symlink) node_modules still matches.
  const resolved = realpathSync.native(require.resolve('ajv/dist/2020.js'));
  const rootAjv = realpathSync.native(fileURLToPath(new URL('../../../../../node_modules/ajv', import.meta.url)));
  assert.ok(resolved.startsWith(rootAjv + sep), resolved);
});

test('computer keeps per-action input alternatives for Claude and the flat projection for Gemini', () => {
  const computer = realToolsByName.get('computer');
  const actions = computer.inputSchema.properties.action.enum;
  const [claude] = claudeDeclarations([computer], 'claude-sonnet-4-6');
  const schema = claude.parametersJsonSchema;
  const meta = new Ajv2020({ strict: false, validateFormats: false });
  assert.equal(meta.validateSchema(schema), true, meta.errorsText(meta.errors));
  for (const key of ['anyOf', 'oneOf', 'allOf', 'not']) assert.equal(schema[key], undefined);
  assert.deepEqual(schema.properties.input.anyOf.map((alternative) => alternative.title).sort(), [...actions].sort());
  const validate = meta.compile(schema);
  assert.equal(validate({ action: 'list', input: { kind: 'windows' } }), true);
  assert.equal(validate({ action: 'list', input: { kind: 'windows', bogus: 1 } }), false);

  const [gemini] = claudeDeclarations([computer], 'gemini-3.8-flash');
  const flat = gemini.parametersJsonSchema.properties.input;
  assert.equal(flat.anyOf, undefined);
  assert.ok(flat.properties.kind && flat.properties.actions && flat.properties.operation);
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
      providerReplay: {
        version: 1,
        provider: 'antigravity',
        items: [{ text: '' }, { text: '' }],
        requestContext: { model },
      },
    },
    { role: 'user', content: 'second' },
  ];
  const contents = (model) => buildAntigravityRequest(history(model), model, [], {}).request.contents;
  const claude = contents('claude-sonnet-5-5-low');
  assert.equal(
    claude.some((content) => !content.parts?.length),
    false
  );
  assert.equal(
    claude.some((content) => content.role === 'model'),
    false
  );
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

// ---- Unsigned thinking from history never reaches the Claude bridge ----
// "messages.N.content.M.thinking.signature: Field required": every thinking
// block a Claude request carries must hold the signature this route recorded.
const CLAUDE = 'claude-sonnet-4-6';
const GEMINI = 'gemini-3.8-flash';
const SENTINEL = 'skip_thought_signature_validator';
const replayOf = (items, model, provider = 'antigravity') => ({
  version: 1,
  provider,
  items,
  ...(model ? { requestContext: { model } } : {}),
});
const modelTurns = (history, model) =>
  buildAntigravityRequest(history, model, BUILTIN_TOOLS, {}).request.contents.filter((c) => c.role === 'model');
const thoughtsOf = (turns) =>
  turns.flatMap((turn) => turn.parts.filter((part) => part.thought === true)).map((p) => [p.text, p.thoughtSignature]);
const assertClaudeThoughtsSigned = (turns) => {
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.thought !== true) continue;
      assert.equal(typeof part.thoughtSignature, 'string');
      assert.notEqual(part.thoughtSignature, '');
      assert.notEqual(part.thoughtSignature, SENTINEL);
    }
  }
};
const toolTurn = (assistant, id = 'toolu_9') => [
  { role: 'user', content: 'go' },
  { ...assistant, toolCalls: [{ id, name: 'glob', arguments: { pattern: '*' } }] },
  { role: 'tool', toolCallId: id, content: 'ok' },
  { role: 'user', content: 'next' },
];
const call = (id = 'toolu_9') => ({ functionCall: { name: 'glob', args: { pattern: '*' }, id } });

test('plain history without a providerReplay (imported, compacted, leak-scrubbed) drops thinking for Claude', () => {
  const history = toolTurn({
    role: 'assistant',
    content: 'answer',
    providerMetadata: { gemini: { thoughtParts: [{ text: 'because', thoughtSignature: 'unknown-origin' }] } },
  });
  const claude = modelTurns(history, CLAUDE);
  assert.deepEqual(thoughtsOf(claude), []);
  assert.ok(claude[0].parts.some((part) => part.functionCall?.name === 'glob'));
  assert.ok(claude[0].parts.some((part) => part.text === 'answer'));
  // Gemini keeps the recovery sentinel.
  assert.deepEqual(thoughtsOf(modelTurns(history, GEMINI)), [['because', SENTINEL]]);
});

test('a replay recorded by another family or provider drops its thinking and signatures for Claude', () => {
  const items = [
    { thought: true, text: 'gemini thought', thoughtSignature: 'gemini-sig' },
    { text: 'answer', thoughtSignature: 'gemini-text-sig' },
    { ...call(), thoughtSignature: 'gemini-call-sig' },
  ];
  for (const providerReplay of [
    replayOf(items, 'gemini-3.1-pro-high'),
    replayOf(items, 'gemini-3.1-pro-high', 'gemini'),
    replayOf(items, undefined, 'gemini'),
  ]) {
    const claude = modelTurns(toolTurn({ role: 'assistant', content: 'answer', providerReplay }), CLAUDE);
    assert.deepEqual(thoughtsOf(claude), []);
    assert.ok(claude[0].parts.some((part) => part.functionCall?.name === 'glob'));
    assert.ok(claude[0].parts.some((part) => part.text === 'answer'));
    assert.equal(
      claude[0].parts.some((part) => 'thoughtSignature' in part),
      false
    );
  }
});

test('an interrupted thought run with no signature is dropped for Claude and keeps the sentinel for Gemini', () => {
  const history = (model) =>
    toolTurn({
      role: 'assistant',
      content: '',
      providerReplay: replayOf(
        [{ thought: true, text: 'cut ' }, { thought: true, text: 'off' }, { text: '' }, call()],
        model
      ),
    });
  const claude = modelTurns(history(CLAUDE), CLAUDE);
  assert.deepEqual(thoughtsOf(claude), []);
  assert.ok(claude[0].parts.some((part) => part.functionCall?.name === 'glob'));
  assert.deepEqual(thoughtsOf(modelTurns(history(GEMINI), GEMINI)), [
    ['cut ', SENTINEL],
    ['off', SENTINEL],
  ]);
});

test('a recorded sentinel or empty signature is not an own Claude signature', () => {
  const history = toolTurn({
    role: 'assistant',
    content: '',
    providerReplay: replayOf(
      [
        { thought: true, text: 'a', thoughtSignature: SENTINEL },
        { thought: true, text: 'b', thoughtSignature: '' },
        call(),
      ],
      CLAUDE
    ),
  });
  assert.deepEqual(thoughtsOf(modelTurns(history, CLAUDE)), []);
});

test('a thinking-only Claude turn without a signature is omitted; a signed one is kept', () => {
  const history = (items, model) => [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '', providerReplay: replayOf(items, model) },
    { role: 'user', content: 'second' },
  ];
  const unsigned = [{ thought: true, text: 'thinking' }, { text: '' }];
  const contents = buildAntigravityRequest(history(unsigned, CLAUDE), CLAUDE, [], {}).request.contents;
  assert.equal(
    contents.some((c) => c.role === 'model'),
    false
  );
  assert.equal(
    contents.some((c) => !c.parts?.length),
    false
  );
  const signed = [
    { thought: true, text: 'thinking' },
    { thought: true, text: '', thoughtSignature: 'sig' },
  ];
  assert.deepEqual(thoughtsOf(modelTurns(history(signed, CLAUDE), CLAUDE)), [['thinking', 'sig']]);
  assert.deepEqual(thoughtsOf(modelTurns(history(unsigned, GEMINI), GEMINI)), [['thinking', SENTINEL]]);
});

test('thinking after a tool call keeps its signed run and drops an unsigned one', () => {
  const history = toolTurn({
    role: 'assistant',
    content: '',
    providerReplay: replayOf(
      [
        { thought: true, text: 'before', thoughtSignature: 'sig-1' },
        call(),
        { thought: true, text: 'after ' },
        { thought: true, text: 'call' },
        { thought: true, text: '', thoughtSignature: 'sig-2' },
        { thought: true, text: 'tail without signature' },
      ],
      CLAUDE
    ),
  });
  const claude = modelTurns(history, CLAUDE);
  assertClaudeThoughtsSigned(claude);
  assert.deepEqual(thoughtsOf(claude), [
    ['before', 'sig-1'],
    ['after call', 'sig-2'],
  ]);
  assert.equal(
    claude[0].parts.findIndex((part) => part.functionCall),
    1
  );
});

test('thought runs never merge across messages or across other part types', () => {
  const history = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'toolu_a', name: 'glob', arguments: { pattern: '*' } }],
      providerReplay: replayOf([{ thought: true, text: 'unsigned head' }, call('toolu_a')], CLAUDE),
    },
    { role: 'tool', toolCallId: 'toolu_a', content: 'ok' },
    {
      role: 'assistant',
      content: 'done',
      providerReplay: replayOf(
        [
          { thought: true, text: 'split ' },
          { text: 'interleaved' },
          { thought: true, text: 'run', thoughtSignature: 'sig-b' },
        ],
        CLAUDE
      ),
    },
    { role: 'user', content: 'next' },
  ];
  const claude = modelTurns(history, CLAUDE);
  assertClaudeThoughtsSigned(claude);
  assert.deepEqual(thoughtsOf([claude[0]]), []);
  assert.deepEqual(thoughtsOf([claude[1]]), [['run', 'sig-b']]);
  assert.deepEqual(
    claude[1].parts.map((part) => part.text),
    ['interleaved', 'run']
  );
});

// ---- Closing a tool loop whose turn lost its thinking ----
const THINKING = 'claude-opus-4-6-thinking';
const wire = (history, model = THINKING, opts = {}) =>
  buildAntigravityRequest(history, model, BUILTIN_TOOLS, opts).request.contents;
const openLoop = (assistant) => [
  { role: 'user', content: 'earlier' },
  {
    role: 'assistant',
    content: 'earlier answer',
    providerReplay: replayOf(
      [{ thought: true, text: 'old', thoughtSignature: 'sig-old' }, { text: 'earlier answer' }],
      THINKING
    ),
  },
  { role: 'user', content: 'go' },
  { ...assistant, toolCalls: [{ id: 'toolu_9', name: 'glob', arguments: { pattern: '*' } }] },
  { role: 'tool', toolCallId: 'toolu_9', content: 'ok' },
];
const assertWellFormed = (contents) => {
  for (const content of contents) assert.ok(content.parts.length, 'no empty turn');
  for (let i = 1; i < contents.length; i += 1) {
    if (contents[i].role === 'model') assert.equal(contents[i - 1].role, 'user', `turn ${i} follows a user turn`);
  }
  for (const [i, content] of contents.entries()) {
    if (content.parts.some((part) => part.functionCall)) {
      assert.ok(
        contents[i + 1]?.parts.some((part) => part.functionResponse),
        'each call is answered'
      );
    }
  }
};
const synthetic = [
  { role: 'model', parts: [{ text: '[Tool result received.]' }] },
  { role: 'user', parts: [{ text: '[Continue.]' }] },
];

test('an open tool loop whose thinking was dropped is closed with a fresh turn, wire-only', () => {
  const cases = {
    interrupted: {
      role: 'assistant',
      content: '',
      providerReplay: replayOf([{ thought: true, text: 'cut' }, call()], THINKING),
    },
    foreign: {
      role: 'assistant',
      content: '',
      providerReplay: replayOf(
        [{ thought: true, text: 'g', thoughtSignature: 'gemini-sig' }, call()],
        'gemini-3.1-pro-high'
      ),
    },
    // Compaction keeps the call and its result but no thinking or replay.
    compacted: { role: 'assistant', content: '' },
  };
  for (const [name, assistant] of Object.entries(cases)) {
    const history = openLoop(assistant);
    const snapshot = structuredClone(history);
    const contents = wire(history);
    assert.deepEqual(contents.slice(-2), synthetic, name);
    assert.ok(
      contents.at(-3).parts.some((part) => part.functionResponse),
      name
    );
    assert.equal(
      contents.some((c) => c.parts.some((part) => part.thought === true)),
      false,
      `${name}: the closed part keeps no thinking`
    );
    assertWellFormed(contents);
    assert.deepEqual(history, snapshot, `${name}: the transcript and its replays are unchanged`);
  }
});

test('a signed loop, a turn without an open loop, thinking off and Gemini are left as built', () => {
  const signed = openLoop({
    role: 'assistant',
    content: '',
    providerReplay: replayOf([{ thought: true, text: 'plan', thoughtSignature: 'sig-plan' }, call()], THINKING),
  });
  const signedContents = wire(signed);
  assert.ok(signedContents.at(-1).parts.some((part) => part.functionResponse));
  assert.deepEqual(thoughtsOf(signedContents.filter((c) => c.role === 'model')), [
    ['old', 'sig-old'],
    ['plan', 'sig-plan'],
  ]);

  const compacted = openLoop({ role: 'assistant', content: '' });
  const answered = [...compacted, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }];
  assert.equal(wire(answered).at(-1).parts[0].text, 'next');
  assert.ok(
    wire(compacted, 'claude-sonnet-4-6')
      .at(-1)
      .parts.some((part) => part.functionResponse)
  );
  assert.equal(wire(compacted, 'claude-sonnet-4-6', { effort: 'high' }).at(-1).parts[0].text, '[Continue.]');
  assert.ok(
    wire(compacted, GEMINI)
      .at(-1)
      .parts.some((part) => part.functionResponse)
  );
});

test('later steps keep the closure in place and the fresh turn keeps its signed thinking', () => {
  const history = [
    ...openLoop({ role: 'assistant', content: '' }),
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'toolu_10', name: 'glob', arguments: { pattern: '*.md' } }],
      providerReplay: replayOf(
        [
          { thought: true, text: 'fresh', thoughtSignature: 'sig-fresh' },
          { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_10' } },
        ],
        THINKING
      ),
    },
    { role: 'tool', toolCallId: 'toolu_10', content: 'README.md' },
  ];
  const contents = wire(history);
  const closure = contents.findIndex((c) => c.role === 'model' && c.parts[0]?.text === '[Tool result received.]');
  assert.ok(closure > 0);
  assert.deepEqual(contents.slice(closure, closure + 2), synthetic);
  assert.deepEqual(thoughtsOf(contents.slice(closure + 2)), [['fresh', 'sig-fresh']]);
  assert.ok(contents.at(-1).parts.some((part) => part.functionResponse));
  assertWellFormed(contents);
});
