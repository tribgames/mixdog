// Per-wire tool schema normalization: a schema the wire accepts as written is
// sent byte-identical; a draft-07/04 one is lowered to what the wire accepts;
// only a genuinely broken one is left out (with the session notice).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const { requestAnthropicTools, sanitizeAnthropicInputSchema } = await import('./lib/anthropic-request-utils.mjs');
const { toResponsesTools, toOpenAITools } = await import('./openai-compat-wire.mjs');
const { buildRequestBody } = await import('./openai-responses-payload.mjs');
const { toGeminiTools, geminiAcceptedTools } = await import('./gemini-schema.mjs');
const { buildAntigravityRequest } = await import('./antigravity-request.mjs');
const { OpenRouterProvider } = await import('./openrouter.mjs');
const { DeepSeekProvider } = await import('./deepseek.mjs');
const { BUILTIN_TOOLS } = await import('../tools/builtin/builtin-tools.mjs');
const { TOOL_BRIDGE_TOOLS, TOOL_SEARCH_TOOL, SKILL_TOOL, SESSION_TOOL } = await import('../runtime-core/tool-defs.mjs');
const { CODE_GRAPH_TOOL_DEFS } = await import('../tools/code-graph-tool-defs.mjs');
const { TOOL_DEFS: COMPUTER_TOOL_DEFS } = await import('../../../computer-bridge/tool-defs.mjs');
const { routeToolExclusionReason } = await import('../session/loop/provider-tool-exclusions.mjs');
const { actionInputUnionFor } = await import('./lib/action-input-contract.mjs');

const mcp = (name, inputSchema) => ({ name, description: `${name} tool.`, inputSchema });
const object = (properties, extra = {}) => ({ type: 'object', properties, ...extra });

// Valid as written on every wire: sent exactly as written.
const VALID = [
  mcp('mcp__ok__plain', object({ a: { type: 'string' }, n: { type: 'integer', minimum: 1 } }, { required: ['a'] })),
  mcp('mcp__ok__draft07', {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: false,
  }),
  mcp('mcp__ok__defs', {
    type: 'object',
    properties: { a: { $ref: '#/definitions/id' } },
    definitions: { id: { type: 'string' } },
  }),
  mcp('mcp__ok__defs2020', {
    type: 'object',
    properties: { a: { $ref: '#/$defs/id' } },
    $defs: { id: { type: 'string', description: 'an id' } },
  }),
  mcp('mcp__ok__nullable', object({ a: { type: 'string', nullable: true }, b: { type: ['string', 'null'] } })),
  mcp('mcp__ok__anyofnull', object({ a: { anyOf: [{ type: 'string' }, { type: 'null' }] } })),
  mcp('mcp__ok__const', object({ a: { const: 'x' }, b: { enum: [1, 2] } })),
  mcp('mcp__ok__prefix', object({ a: { type: 'array', prefixItems: [{ type: 'string' }], items: false } })),
  mcp('mcp__ok__deep', object({ l1: object({ l2: object({ l3: object({ l4: { type: 'array', items: object({ x: { type: 'number', exclusiveMinimum: 0 } }) } }) }) }) })),
  mcp('mcp__ok__legacyid', object({ id: { type: 'string' } }, { id: 'urn:legacy' })),
  mcp('mcp__ok__empty', object({})),
];

// Draft-07/04 or sloppy shapes other clients accept: lowered, not excluded.
const REPAIRABLE = [
  mcp('mcp__fix__tuple', object({ a: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } })),
  mcp('mcp__fix__tuple_extra', object({ a: { type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } } })),
  mcp('mcp__fix__exclusive', object({ a: { type: 'number', minimum: 1, exclusiveMinimum: true }, b: { type: 'number', maximum: 9, exclusiveMaximum: false } })),
  mcp('mcp__fix__d07defs', {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { a: { type: 'array', items: [{ $ref: '#/definitions/s' }] } },
    definitions: { s: { type: 'string' } },
  }),
  mcp('mcp__fix__d04', { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: { a: { type: 'integer', minimum: 0, exclusiveMinimum: true } } }),
  mcp('mcp__fix__notype', { properties: { a: { type: 'string' } }, required: ['a'] }),
  mcp('mcp__fix__empty', {}),
  mcp('mcp__fix__deeptuple', object({ l1: object({ l2: { type: 'array', items: [object({ l3: { type: 'array', items: [{ type: 'string' }] } })] } }) })),
];

// Genuinely broken: nothing lowers them.
const BROKEN = [
  mcp('mcp__bad__type', object({ a: { type: 'bogus-type' } })),
  mcp('mcp__bad__root', { type: 'string' }),
  mcp('mcp__bad__ref', object({ a: { $ref: '#/definitions/missing' } })),
  mcp('mcp__bad__remote', object({ a: { $ref: 'https://example.com/schema.json' } })),
];

const SURFACE = [
  ...BUILTIN_TOOLS,
  TOOL_SEARCH_TOOL,
  ...CODE_GRAPH_TOOL_DEFS,
  ...COMPUTER_TOOL_DEFS,
  ...TOOL_BRIDGE_TOOLS,
  SKILL_TOOL,
  SESSION_TOOL,
];

const messages = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'hello' },
];
const collect = () => {
  const exclusions = [];
  return { exclusions, onToolExcluded: (e) => exclusions.push(e) };
};
const json = (value) => JSON.stringify(value);
const names = (list) => list.map((t) => t.name ?? t.function?.name);

// Each wire: tools -> what it puts on the wire (`wire`), and the bytes the wire
// produced for a valid tool before schema normalization existed (`legacy`).
const WIRES = {
  'anthropic messages': {
    wire: (tools, onToolExcluded, provider = 'anthropic') => requestAnthropicTools(tools, messages, { onToolExcluded }, provider),
    legacy: (tools) =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: sanitizeAnthropicInputSchema(actionInputUnionFor(t.inputSchema), t.name, 'anthropic'),
      })),
    schemaOf: (e) => e.input_schema,
  },
  'anthropic-oauth messages': {
    wire: (tools, onToolExcluded) => requestAnthropicTools(tools, messages, { onToolExcluded }, 'anthropic-oauth'),
    legacy: (tools) =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: sanitizeAnthropicInputSchema(actionInputUnionFor(t.inputSchema), t.name, 'anthropic-oauth'),
      })),
    schemaOf: (e) => e.input_schema,
  },
  'openai responses (compat)': {
    wire: (tools, onToolExcluded) => toResponsesTools(tools, { provider: 'xai', onToolExcluded }),
    legacy: (tools) => toResponsesTools(tools, { provider: 'xai' }),
    schemaOf: (e) => e.parameters,
    unfiltered: (tools) =>
      tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', additionalProperties: true }, strict: false })),
  },
  'openai / codex responses': {
    wire: (tools, onToolExcluded) =>
      buildRequestBody(messages, 'gpt-5.5', tools, { promptCacheProvider: 'openai-oauth', onToolExcluded }).tools.filter((e) => e.type !== 'tool_search' || true),
    schemaOf: (e) => e.parameters,
  },
};

const sentSchema = (wire, entry) => wire.schemaOf(entry);

for (const [label, wire] of Object.entries(WIRES)) {
  test(`${label}: every built-in tool passes, none is excluded`, () => {
    const { exclusions, onToolExcluded } = collect();
    const sent = wire.wire(SURFACE, onToolExcluded);
    assert.deepEqual(exclusions.map((e) => `${e.name} @ ${e.pointer}: ${e.reason}`), []);
    assert.equal(sent.length, SURFACE.length);
  });

  test(`${label}: valid schemas (drafts, $ref, nullable, deep) are sent byte-identical`, () => {
    const { exclusions, onToolExcluded } = collect();
    const sent = wire.wire(VALID, onToolExcluded);
    assert.deepEqual(exclusions, []);
    for (const [i, tool] of VALID.entries()) {
      const expected = label.startsWith('anthropic')
        ? sanitizeAnthropicInputSchema(actionInputUnionFor(tool.inputSchema), tool.name, 'anthropic')
        : tool.inputSchema;
      assert.equal(json(sentSchema(wire, sent[i])), json(expected), tool.name);
    }
    // And the whole list is deterministic.
    assert.equal(json(wire.wire(VALID, () => {})), json(sent));
    if (wire.legacy && label !== 'anthropic-oauth messages' && label !== 'anthropic messages') {
      assert.equal(json(sent), json(wire.legacy(VALID)));
    }
  });

  test(`${label}: draft-07/04 and sloppy schemas are lowered and sent, only broken ones are excluded`, () => {
    const { exclusions, onToolExcluded } = collect();
    const all = [...REPAIRABLE, ...BROKEN, ...VALID];
    const sent = wire.wire(all, onToolExcluded);
    assert.deepEqual(exclusions.map((e) => e.name).sort(), BROKEN.map((t) => t.name).sort());
    for (const e of exclusions) assert.match(e.reason, /\S/);
    const sentNames = names(sent);
    for (const tool of [...REPAIRABLE, ...VALID]) assert.ok(sentNames.includes(tool.name), `${tool.name} sent`);
    for (const tool of BROKEN) assert.ok(!sentNames.includes(tool.name), `${tool.name} excluded`);
    // The lowered schemas hold nothing a 2020-12 validator rejects.
    const lowered = sent.find((e) => e.name === 'mcp__fix__tuple');
    assert.deepEqual(sentSchema(wire, lowered).properties.a, { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] });
    const exclusive = sentSchema(wire, sent.find((e) => e.name === 'mcp__fix__exclusive'));
    assert.deepEqual(exclusive.properties, { a: { type: 'number', exclusiveMinimum: 1 }, b: { type: 'number', maximum: 9 } });
    assert.equal(sentSchema(wire, sent.find((e) => e.name === 'mcp__fix__notype')).type, 'object');
    assert.equal(sentSchema(wire, sent.find((e) => e.name === 'mcp__fix__empty')).type, 'object');
    const d07 = sentSchema(wire, sent.find((e) => e.name === 'mcp__fix__d07defs'));
    assert.deepEqual(d07.properties.a, { type: 'array', prefixItems: [{ $ref: '#/$defs/s' }] });
    assert.deepEqual(d07.$defs, { s: { type: 'string' } });
    // Repairing is deterministic.
    const again = wire.wire(all, () => {});
    assert.equal(json(again), json(sent));
  });

  test(`${label}: the route predicts the exclusion for load_tool / call_tool`, () => {
    const providerFor = { 'anthropic messages': 'anthropic', 'anthropic-oauth messages': 'anthropic-oauth', 'openai / codex responses': 'openai-oauth' }[label] || 'xai';
    const session = { provider: providerFor, model: 'm' };
    for (const tool of BROKEN) assert.match(routeToolExclusionReason(session, tool), /unavailable/, tool.name);
    for (const tool of [...VALID, ...REPAIRABLE, ...SURFACE]) assert.equal(routeToolExclusionReason(session, tool), null, tool.name);
  });
}

test('openai chat (OpenRouter Claude/GPT, DeepSeek): lowered, broken left out, valid byte-identical', async () => {
  const chatReply = (body) =>
    new Response(
      `data: ${json({ id: 'c1', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }
    );
  const run = async (Provider, model, tools) => {
    const requests = [];
    const fetchImpl = async (_input, init = {}) => {
      requests.push(JSON.parse(init.body));
      return chatReply(JSON.parse(init.body));
    };
    const provider = new Provider({ apiKey: 'k', preconnect: false, fetchImpl, clientOptions: { fetch: fetchImpl } });
    const { exclusions, onToolExcluded } = collect();
    await provider.send([{ role: 'user', content: 'hi' }], model, tools, {
      onToolExcluded,
      wireRoute: { provider: provider.name, model, wire: 'chat', source: 'test' },
    });
    return { body: requests[0], exclusions };
  };
  for (const [Provider, model] of [
    [OpenRouterProvider, 'anthropic/claude-sonnet-4.5'],
    [OpenRouterProvider, 'openai/gpt-5.5'],
    [DeepSeekProvider, 'deepseek-chat'],
  ]) {
    const builtins = await run(Provider, model, SURFACE);
    assert.deepEqual(builtins.exclusions, [], `${model} built-ins`);
    assert.equal(json(builtins.body.tools), json(toOpenAITools(SURFACE)), `${model} built-ins byte-identical`);
    const valid = await run(Provider, model, VALID);
    assert.deepEqual(valid.exclusions, []);
    assert.equal(json(valid.body.tools), json(toOpenAITools(VALID)), `${model} valid byte-identical`);
    const mixed = await run(Provider, model, [...REPAIRABLE, ...BROKEN, ...VALID]);
    assert.deepEqual(mixed.exclusions.map((e) => e.name).sort(), BROKEN.map((t) => t.name).sort());
    const sent = mixed.body.tools.map((t) => t.function.name);
    for (const tool of [...REPAIRABLE, ...VALID]) assert.ok(sent.includes(tool.name), `${model} ${tool.name}`);
    const tuple = mixed.body.tools.find((t) => t.function.name === 'mcp__fix__tuple');
    assert.deepEqual(tuple.function.parameters.properties.a.prefixItems, [{ type: 'string' }, { type: 'number' }]);
  }
});

test('Gemini routes lower draft-07 constructs and keep valid declarations byte-identical', () => {
  const sameAsUnvalidated = (list) => json(toGeminiTools(list).functionDeclarations) === json(toGeminiTools(list, { validate: false }).functionDeclarations);
  assert.ok(sameAsUnvalidated(VALID));
  assert.ok(sameAsUnvalidated(SURFACE));
  const { exclusions, onToolExcluded } = collect();
  const all = [...REPAIRABLE, ...BROKEN, ...VALID];
  const declared = toGeminiTools(all, { onToolExcluded }).functionDeclarations;
  const accepted = geminiAcceptedTools(all, () => {});
  for (const tool of [...REPAIRABLE, ...VALID]) {
    assert.ok(names(declared).includes(tool.name), `gemini ${tool.name}`);
    assert.ok(names(accepted).includes(tool.name), `compat gemini ${tool.name}`);
  }
  for (const tool of BROKEN) assert.ok(!names(declared).includes(tool.name), tool.name);
  assert.deepEqual(exclusions.map((e) => e.name).sort(), BROKEN.map((t) => t.name).sort());
});

test('Antigravity Claude lowers draft-07 constructs, excludes broken ones, built-ins pass', () => {
  const { exclusions, onToolExcluded } = collect();
  const all = [...REPAIRABLE, ...BROKEN, ...VALID];
  const { request } = buildAntigravityRequest(messages, 'claude-sonnet-4-5', all, { onToolExcluded }, 'proj');
  const declared = request.tools.at(-1).functionDeclarations;
  for (const tool of [...REPAIRABLE, ...VALID]) assert.ok(names(declared).includes(tool.name), tool.name);
  assert.deepEqual(exclusions.map((e) => e.name).sort(), BROKEN.map((t) => t.name).sort());
  const builtins = collect();
  buildAntigravityRequest(messages, 'claude-sonnet-4-5', SURFACE, { onToolExcluded: builtins.onToolExcluded }, 'proj');
  assert.deepEqual(builtins.exclusions, []);
  const session = { provider: 'antigravity-oauth', model: 'claude-sonnet-4-5' };
  for (const tool of BROKEN) assert.match(routeToolExclusionReason(session, tool), /unavailable/);
  for (const tool of [...VALID, ...REPAIRABLE, ...SURFACE]) assert.equal(routeToolExclusionReason(session, tool), null, tool.name);
  const gemini = { provider: 'gemini', model: 'gemini-3.5-flash' };
  for (const tool of BROKEN) assert.match(routeToolExclusionReason(gemini, tool), /unavailable/);
  for (const tool of [...VALID, ...REPAIRABLE, ...SURFACE]) assert.equal(routeToolExclusionReason(gemini, tool), null, tool.name);
});

test('lowering is targeted: valid constraints survive, draft-07 $ref semantics only when declared', async () => {
  const { wireInputSchema } = await import('./lib/claude-bridge-schema.mjs');
  const lowered = (schema, rule) => {
    const result = wireInputSchema(schema, rule);
    assert.ok(result.schema, JSON.stringify(result));
    return result.schema;
  };
  for (const rule of ['anthropic', 'openai', 'gemini']) {
    // No root type, 2020-12 $ref siblings: only the root type is added.
    const noType = {
      properties: { x: { $ref: '#/$defs/X', maxLength: 2, description: 'kept' } },
      $defs: { X: { type: 'string' } },
    };
    if (rule !== 'gemini') {
      assert.deepEqual(lowered(noType, rule), { type: 'object', ...noType });
    }
    // Undeclared + tuple items: tuple lowered, $ref siblings and unevaluated* kept.
    const undeclared = {
      type: 'object',
      properties: {
        pair: { type: 'array', items: [{ type: 'string' }] },
        x: { $ref: '#/$defs/X', maxLength: 2 },
      },
      unevaluatedProperties: false,
      $defs: { X: { type: 'string' } },
    };
    const out = lowered(undeclared, rule);
    assert.deepEqual(out.properties.pair, { type: 'array', prefixItems: [{ type: 'string' }] });
    assert.deepEqual(out.properties.x, { $ref: '#/$defs/X', maxLength: 2 });
    assert.equal(out.unevaluatedProperties, false);
    assert.deepEqual(out.$defs, undeclared.$defs);
    // Declared 2019-09 / 2020-12: siblings kept as well.
    for (const dialect of ['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
      const declared = lowered({ $schema: dialect, ...undeclared, properties: { ...undeclared.properties, b: { type: 'number', minimum: 1, exclusiveMinimum: true } } }, rule);
      assert.deepEqual(declared.properties.x, { $ref: '#/$defs/X', maxLength: 2 });
      assert.deepEqual(declared.properties.b, { type: 'number', exclusiveMinimum: 1 });
    }
    // Declared draft-07: $ref siblings are ignored by that dialect, so dropped.
    const d07 = lowered({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', definitions: { Y: { type: 'string' } }, properties: { y: { $ref: '#/definitions/Y', maxLength: 1 }, pair: undeclared.properties.pair } }, rule);
    assert.deepEqual(d07.properties.y, { $ref: '#/$defs/Y' });
    // definitions that nothing refers to stay where they are.
    const plain = lowered({ type: 'object', properties: { t: { type: 'array', items: [{ type: 'string' }] } }, definitions: { Z: { type: 'array', items: [{ type: 'number' }] } } }, rule);
    assert.deepEqual(Object.keys(plain.definitions), ['Z']);
    assert.deepEqual(plain.definitions.Z, { type: 'array', prefixItems: [{ type: 'number' }] });
    // prefixItems + items:false and a $ref sibling pass through untouched when valid.
    const valid = { type: 'object', properties: { a: { type: 'array', prefixItems: [{ type: 'string' }], items: false }, r: { $ref: '#/$defs/X', minLength: 1 } }, $defs: { X: { type: 'string' } } };
    assert.equal(wireInputSchema(valid, rule).schema, valid);
  }
});
