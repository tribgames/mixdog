// A tool whose schema Gemini would reject is left out of the request (with the
// session notice) on every Gemini-family route instead of failing the whole
// request with HTTP 400: Gemini API, Antigravity, OpenCode Go and OpenRouter.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const { toGeminiTools, geminiAcceptedTools } = await import('./gemini-schema.mjs');
const { buildGeminiRequest } = await import('./gemini-request-body.mjs');
const { buildAntigravityRequest } = await import('./antigravity-request.mjs');
const { OpenRouterProvider } = await import('./openrouter.mjs');
const { OpenCodeGoProvider } = await import('./opencode-go.mjs');
const { BUILTIN_TOOLS } = await import('../tools/builtin/builtin-tools.mjs');
const { TOOL_BRIDGE_TOOLS, TOOL_SEARCH_TOOL, SKILL_TOOL, SESSION_TOOL } = await import('../runtime-core/tool-defs.mjs');
const { CODE_GRAPH_TOOL_DEFS } = await import('../tools/code-graph-tool-defs.mjs');
const { TOOL_DEFS: COMPUTER_TOOL_DEFS } = await import('../../../computer-bridge/tool-defs.mjs');
const { beginProviderToolExclusions, recordProviderToolExclusion } = await import(
  '../session/loop/provider-tool-exclusions.mjs'
);

const mcp = (name, inputSchema) => ({ name, description: `${name} tool.`, inputSchema });
const read = mcp('read', {
  type: 'object',
  properties: { file_path: { type: 'string' } },
  required: ['file_path'],
});
const bogusType = mcp('mcp__x__bogus', { type: 'object', properties: { a: { type: 'bogus-type' } } });
const tuple = mcp('mcp__x__tuple', {
  type: 'object',
  properties: { a: { type: 'array', items: { type: 'bogus-type' } } },
});
const stringRoot = mcp('mcp__x__root', { type: 'string' });
const invalid = [bogusType, tuple, stringRoot];
const mixed = [bogusType, read, tuple, stringRoot];
const messages = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'hello' },
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

const collect = () => {
  const exclusions = [];
  return { exclusions, onToolExcluded: (exclusion) => exclusions.push(exclusion) };
};
const names = (declarations) => declarations.map((d) => d.name);
const expectedExclusions = (exclusions) => {
  assert.deepEqual(
    exclusions.map((e) => [e.name, e.index]),
    [
      ['mcp__x__bogus', 0],
      ['mcp__x__tuple', 2],
      ['mcp__x__root', 3],
    ]
  );
  assert.equal(exclusions[0].pointer, '/properties/a/type');
  assert.equal(exclusions[1].pointer, '/properties/a/items/type');
  assert.equal(exclusions[2].pointer, '/type');
  for (const exclusion of exclusions) assert.match(exclusion.reason, /\S/);
};

test('toGeminiTools leaves invalid declarations out with name, pointer and reason; valid ones are unchanged', () => {
  const { exclusions, onToolExcluded } = collect();
  const { functionDeclarations } = toGeminiTools(mixed, { onToolExcluded });
  assert.deepEqual(functionDeclarations, [
    {
      name: 'read',
      description: 'read tool.',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
  ]);
  expectedExclusions(exclusions);
});

test("anyOf branches that only narrow the parent's required keys are valid and not excluded", () => {
  const { exclusions, onToolExcluded } = collect();
  const either = mcp('either', {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' } },
    anyOf: [{ required: ['a'] }, { required: ['b'] }],
  });
  const projected = toGeminiTools([
    mcp('legacy_union', {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      anyOf: [
        { properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    }),
  ]).functionDeclarations;
  assert.deepEqual(names(projected), ['legacy_union']);
  assert.ok(projected[0].parameters, 'the union stays on the legacy parameters path');
  const noProperties = mcp('narrow_only', { type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }] });
  const { functionDeclarations } = toGeminiTools([either, noProperties], { onToolExcluded });
  assert.deepEqual(exclusions, []);
  assert.deepEqual(names(functionDeclarations), ['either', 'narrow_only']);
  // A node that declares properties must still list its required names there.
  const missing = toGeminiTools(
    [mcp('missing', { type: 'object', properties: { a: { type: 'string' } }, required: ['zz'] })],
    { onToolExcluded }
  );
  assert.deepEqual(
    names(missing.functionDeclarations),
    ['missing'],
    'convertSchema adds an explicit conflict property, so it stays valid'
  );
});

test('an unconstrained JSON value keeps its parametersJsonSchema declaration', () => {
  const free = mcp('office', { type: 'object', properties: { value: {} }, 'x-vendor': true });
  const { functionDeclarations } = toGeminiTools([free]);
  assert.deepEqual(functionDeclarations[0].parametersJsonSchema, { type: 'object', properties: { value: {} } });
});

test('Gemini API / OpenCode Go request: invalid tools are left out, the rest and toolConfig are sent', () => {
  const { exclusions, onToolExcluded } = collect();
  const request = buildGeminiRequest(messages, 'gemini-3.5-flash-lite', mixed, {
    onToolExcluded,
    toolChoice: 'required',
  });
  assert.deepEqual(names(request.geminiTools.at(-1).functionDeclarations), ['read']);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  expectedExclusions(exclusions);

  const none = buildGeminiRequest(messages, 'gemini-3.5-flash-lite', invalid, { ...collect(), toolChoice: 'required' });
  assert.equal(none.geminiTools, undefined);
  assert.equal(none.toolConfig, undefined);
});

test('Antigravity Gemini request: invalid tools are left out, the rest and toolConfig are sent', () => {
  const { exclusions, onToolExcluded } = collect();
  const { request } = buildAntigravityRequest(messages, 'gemini-3.8-flash', mixed, { onToolExcluded }, 'proj');
  assert.deepEqual(names(request.tools.at(-1).functionDeclarations), ['read']);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } });
  expectedExclusions(exclusions);

  const { request: none } = buildAntigravityRequest(messages, 'gemini-3.8-flash', invalid, collect(), 'proj');
  assert.equal(none.tools, undefined);
  assert.equal(none.toolConfig, undefined);
});

test('the exclusion reaches the session as the standard notice', () => {
  const session = { id: 'gemini-notice' };
  const notices = [];
  beginProviderToolExclusions(session);
  const onToolExcluded = (exclusion) =>
    recordProviderToolExclusion(session, exclusion, (stage, detail) => notices.push({ stage, ...detail }));
  buildAntigravityRequest(messages, 'gemini-3.8-flash', mixed, { onToolExcluded }, 'proj');
  assert.deepEqual(
    notices.map((n) => [n.stage, n.tone, n.message.match(/^Tool "([^"]+)" was excluded/)?.[1]]),
    [
      ['notice', 'warn', 'mcp__x__bogus'],
      ['notice', 'warn', 'mcp__x__tuple'],
      ['notice', 'warn', 'mcp__x__root'],
    ]
  );
  assert.match(notices[0].message, /input schema is invalid at \/properties\/a\/type/);
});

test('Antigravity non-Gemini models (GPT-OSS) keep the previous conversion: no validation, no exclusion, no log', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { exclusions, onToolExcluded } = collect();
  const { request } = buildAntigravityRequest(messages, 'gpt-oss-120b', mixed, { onToolExcluded }, 'proj');
  // Byte-identical to what HEAD's toGeminiTools produced for these tools.
  const headBytes =
    '[{"functionDeclarations":[{"name":"mcp__x__bogus","description":"mcp__x__bogus tool.","parametersJsonSchema":{"type":"object","properties":{"a":{"type":"bogus-type"}}}},{"name":"read","description":"read tool.","parameters":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}},{"name":"mcp__x__tuple","description":"mcp__x__tuple tool.","parametersJsonSchema":{"type":"object","properties":{"a":{"type":"array","items":{"type":"bogus-type"}}}}},{"name":"mcp__x__root","description":"mcp__x__root tool.","parameters":{"type":"string"}}]}]';
  assert.equal(JSON.stringify(request.tools), headBytes);
  assert.deepEqual(exclusions, []);
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } });
});

test('the default channel is console.warn when no listener is given', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  toGeminiTools([mcp('mcp__warn__bad', { type: 'object', properties: { a: { type: 'nope' } } })]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    warn.mock.calls[0].arguments[0],
    /^\[gemini\] tool "mcp__warn__bad" \(tools\[0\]\) excluded: invalid input schema at "\/properties\/a\/type"/
  );
});

test('OpenRouter chat to a Gemini model: invalid tools are left out, valid ones sent as written', async () => {
  const chatReply = (body) =>
    new Response(
      `data: ${JSON.stringify({ id: 'c1', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }
    );
  const run = async (model, tools, extra = {}) => {
    const requests = [];
    const fetchImpl = async (_input, init = {}) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return chatReply(body);
    };
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      preconnect: false,
      fetchImpl,
      clientOptions: { fetch: fetchImpl },
    });
    const { exclusions, onToolExcluded } = collect();
    await provider.send([{ role: 'user', content: 'hi' }], model, tools, {
      onToolExcluded,
      wireRoute: { provider: provider.name, model, wire: 'chat', source: 'test' },
      ...extra,
    });
    return { body: requests[0], exclusions };
  };
  const model = 'google/gemini-3.5-flash-lite';
  const { body, exclusions } = await run(model, mixed);
  assert.deepEqual(body.tools, [
    { type: 'function', function: { name: 'read', description: 'read tool.', parameters: read.inputSchema } },
  ]);
  expectedExclusions(exclusions);
  const all = await run(model, invalid, { toolChoice: 'required' });
  assert.equal(all.body.tools, undefined);
  assert.equal(all.body.tool_choice, undefined);
  // Other model families on the same route are validated by the OpenAI rule:
  // the same broken tools are left out.
  const other = await run('openrouter/auto', mixed);
  assert.deepEqual(
    other.body.tools.map((t) => t.function.name),
    ['read']
  );
  assert.deepEqual(
    other.exclusions.map((e) => e.name),
    ['mcp__x__bogus', 'mcp__x__tuple', 'mcp__x__root']
  );
  // A draft-07 tuple is lowered for them (normalized, not excluded).
  const draft07 = mcp('mcp__x__draft07', {
    type: 'object',
    properties: { a: { type: 'array', items: [{ type: 'string' }] } },
  });
  const lowered = await run('openrouter/auto', [read, draft07]);
  assert.deepEqual(lowered.exclusions, []);
  assert.deepEqual(lowered.body.tools[1].function.parameters.properties.a, {
    type: 'array',
    prefixItems: [{ type: 'string' }],
  });
});

// opencode-go answers Gemini ids on the gateway's generateContent endpoint (the
// catalog names @ai-sdk/google, so a chat pin cannot stand): the request that
// matters is the Gemini one.
test('OpenCode Go Gemini model: invalid tools are left out of the generateContent request', async () => {
  const run = async (tools, extra = {}) => {
    const requests = [];
    const fetchImpl = async (_input, init = {}) => {
      requests.push(JSON.parse(init.body));
      const chunk = {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const provider = new OpenCodeGoProvider({ apiKey: 'k', preconnect: false, fetchImpl });
    const model = 'gemini-4-argon-contributor';
    assert.equal((await provider.resolveWireRoute(model, { agent: true })).wire, 'gemini');
    const { exclusions, onToolExcluded } = collect();
    await provider.send([{ role: 'user', content: 'hi' }], model, tools, { onToolExcluded, ...extra });
    return { body: requests[0], exclusions };
  };
  const { body, exclusions } = await run(mixed);
  assert.deepEqual(names(body.tools.at(-1).functionDeclarations), ['read']);
  expectedExclusions(exclusions);
  const all = await run(invalid, { toolChoice: 'required' });
  assert.equal(all.body.tools, undefined);
  assert.equal(all.body.toolConfig, undefined);
  assert.equal(all.exclusions.length, invalid.length);
});

test('every built-in tool passes on every Gemini route (an exclusion here is a bug)', () => {
  const { exclusions, onToolExcluded } = collect();
  const surfaceNames = SURFACE.map((tool) => tool.name);
  assert.ok(surfaceNames.includes('call_tool') && surfaceNames.includes('load_tool'));
  const api = buildGeminiRequest(messages, 'gemini-3.5-flash-lite', SURFACE, { onToolExcluded });
  const agy = buildAntigravityRequest(messages, 'gemini-3.8-flash', SURFACE, { onToolExcluded }, 'proj').request;
  const compat = geminiAcceptedTools(SURFACE, onToolExcluded);
  assert.deepEqual(
    exclusions.map((e) => `${e.name} @ ${e.pointer}: ${e.reason}`),
    [],
    'built-in tool excluded'
  );
  assert.deepEqual(names(api.geminiTools.at(-1).functionDeclarations), surfaceNames);
  assert.deepEqual(names(agy.tools.at(-1).functionDeclarations), surfaceNames);
  assert.deepEqual(api.geminiTools, agy.tools);
  assert.equal(compat.length, SURFACE.length);
  assert.ok(
    compat.every((tool, i) => tool === SURFACE[i]),
    'compat tools are passed through unchanged'
  );
});
