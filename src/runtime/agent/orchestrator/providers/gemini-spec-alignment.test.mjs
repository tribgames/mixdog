// Gemini request history / schema / media alignment with the official API:
// parameters vs parametersJsonSchema, thought-signature provenance, real MIME
// types and part metadata, and tool-result media inside functionResponse.parts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { toGeminiContents, toGeminiTools } from './gemini-schema.mjs';
import { buildAntigravityRequest } from './antigravity-request.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { normalizeContentForGeminiParts } from './media-normalization.mjs';

const declaration = (inputSchema) =>
  toGeminiTools([{ name: 't', description: 'd', inputSchema }]).functionDeclarations[0];

test('schemas the legacy Schema cannot express use parametersJsonSchema unchanged', () => {
  const unrepresentable = {
    closed: {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    },
    numericEnum: { type: 'object', properties: { level: { type: 'integer', enum: [1, 2, 3] } }, required: ['level'] },
    numericConst: { type: 'object', properties: { v: { type: 'number', const: 2 } } },
    nestedClosed: {
      type: 'object',
      properties: { o: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } },
    },
    freeForm: { type: 'object', properties: { bag: { type: 'object' } } },
    oneOf: { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } },
    exclusive: { type: 'object', properties: { n: { type: 'number', exclusiveMinimum: 0 } } },
    nullOnly: { type: 'object', properties: { n: { type: 'null' } } },
    union: { type: 'object', properties: { n: { type: ['string', 'integer'] } } },
  };
  for (const [name, schema] of Object.entries(unrepresentable)) {
    const before = structuredClone(schema);
    const out = declaration(schema);
    assert.equal(out.parameters, undefined, name);
    assert.deepEqual(out.parametersJsonSchema, before, name);
    assert.deepEqual(schema, before, name);
  }
  assert.equal(JSON.stringify(declaration(unrepresentable.numericEnum)).includes('__mixdog'), false);
});

test('schemas the legacy Schema expresses exactly keep using parameters', () => {
  const out = declaration({
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['a', 'b'], description: 'm' },
      n: { type: 'integer', minimum: 1, exclusiveMaximum: 10 },
      list: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      maybe: { type: ['string', 'null'] },
    },
    required: ['mode'],
    additionalProperties: true,
  });
  assert.equal(out.parametersJsonSchema, undefined);
  assert.equal(out.parameters.properties.n.maximum, 9);
  assert.equal(out.parameters.properties.maybe.nullable, true);
  assert.deepEqual(out.parameters.required, ['mode']);
});

const toolHistory = () => [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'glob', arguments: { p: '*' }, thoughtSignature: 'claude-sig' }],
    providerMetadata: { gemini: { thoughtParts: [{ text: 'hmm', thoughtSignature: 'claude-thought-sig' }] } },
    providerReplay: {
      ...createProviderReplay('antigravity', [
        { text: 'hmm', thought: true, thoughtSignature: 'claude-thought-sig' },
        { functionCall: { name: 'glob', args: { p: '*' } }, thoughtSignature: 'claude-sig' },
      ]),
      requestContext: { model: 'claude-sonnet-4-6' },
    },
  },
  { role: 'tool', toolCallId: 'c1', content: 'done' },
];

test('an Antigravity replay recorded for Claude never reaches Gemini; the function call gets the documented bypass', () => {
  const history = toolHistory();
  const requests = [
    toGeminiContents(history, 'gemini-3.1-pro'),
    buildAntigravityRequest(history, 'gemini-3.1-pro-high', [], {}, 'p').request.contents,
  ];
  for (const contents of requests) {
    const model = contents.find((content) => content.role === 'model');
    assert.equal(JSON.stringify(contents).includes('claude-'), false);
    assert.equal(
      model.parts.some((part) => part.thought),
      false
    );
    assert.equal(model.parts.find((part) => part.functionCall).thoughtSignature, 'skip_thought_signature_validator');
  }
});

test('a replay recorded for a Gemini model through Antigravity still replays its signatures', () => {
  const history = toolHistory();
  const parts = [{ functionCall: { name: 'glob', args: { p: '*' } }, thoughtSignature: 'gemini-sig' }];
  history[1].providerReplay = {
    ...createProviderReplay('antigravity', parts),
    requestContext: { model: 'gemini-3.1-pro-high' },
  };
  assert.deepEqual(toGeminiContents(history, 'gemini-3.1-pro').find((c) => c.role === 'model').parts, parts);
});

test('external image URLs keep a real MIME type, resolved from the source or extension, else omitted', () => {
  const parts = normalizeContentForGeminiParts([
    { type: 'image_url', image_url: { url: 'https://example.com/photo.JPG?x=1' } },
    { type: 'image_url', image_url: { url: 'https://example.com/shot.webp' } },
    { type: 'image_url', image_url: { url: 'https://example.com/image' } },
    { fileData: { fileUri: 'https://example.com/clip', mimeType: 'video/mp4' } },
  ]);
  assert.deepEqual(parts, [
    { fileData: { fileUri: 'https://example.com/photo.JPG?x=1', mimeType: 'image/jpeg' } },
    { fileData: { fileUri: 'https://example.com/shot.webp', mimeType: 'image/webp' } },
    { fileData: { fileUri: 'https://example.com/image' } },
    { fileData: { fileUri: 'https://example.com/clip', mimeType: 'video/mp4' } },
  ]);
  const history = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a' } }] }];
  assert.deepEqual(toGeminiContents(history, 'gemini-3-pro-preview')[0].parts, [
    { fileData: { fileUri: 'https://example.com/a' } },
  ]);
});

test('supplied part metadata such as mediaResolution survives normalization', () => {
  const mediaResolution = { level: 'MEDIA_RESOLUTION_HIGH' };
  const history = [
    {
      role: 'user',
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png', mediaResolution },
        { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' }, mediaResolution },
        { fileData: { fileUri: 'gs://b/v.mp4', mimeType: 'video/mp4' }, videoMetadata: { fps: 2 } },
      ],
    },
  ];
  assert.deepEqual(toGeminiContents(history, 'gemini-3-pro-preview')[0].parts, [
    { inlineData: { mimeType: 'image/png', data: 'AAAA' }, mediaResolution },
    { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' }, mediaResolution },
    { fileData: { fileUri: 'gs://b/v.mp4', mimeType: 'video/mp4' }, videoMetadata: { fps: 2 } },
  ]);
});

test('each parallel tool result keeps its own media inside functionResponse.parts', () => {
  const img = (data) => [
    { type: 'text', text: 'ok' },
    { type: 'image', data, mimeType: 'image/png' },
  ];
  const history = [
    { role: 'user', content: 'both' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'read', arguments: {} },
        { id: 'b', name: 'read', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'a', content: img('AAAA') },
    { role: 'tool', toolCallId: 'b', content: img('BBBB') },
  ];
  const turn = toGeminiContents(history, 'gemini-3-pro-preview')[2];
  assert.equal(turn.parts.length, 2);
  assert.deepEqual(
    turn.parts.map((part) => [part.functionResponse.id, part.functionResponse.parts[0].inlineData.data]),
    [
      ['a', 'AAAA'],
      ['b', 'BBBB'],
    ]
  );
  const antigravity = buildAntigravityRequest(history, 'gemini-3.1-pro-high', [], {}, 'p').request.contents[2];
  assert.equal(antigravity.parts.length, 2);
  assert.equal(antigravity.parts[1].functionResponse.parts[0].inlineData.data, 'BBBB');
});

const replayedTurn = (model, parts, toolCalls) => [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: '',
    toolCalls,
    providerReplay: { ...createProviderReplay('antigravity', parts), requestContext: { model } },
  },
  ...toolCalls.map((call, index) => ({ role: 'tool', toolCallId: call.id, content: `out${index}` })),
];
const callAndResponseIds = (contents) => ({
  calls: contents
    .find((c) => c.role === 'model')
    .parts.filter((p) => p.functionCall)
    .map((p) => p.functionCall.id),
  responses: contents
    .filter((c) => c.parts.some((p) => p.functionResponse))
    .flatMap((c) => c.parts.map((p) => p.functionResponse.id)),
});

test('Gemini: a replayed functionCall without a server id gets a functionResponse without one', () => {
  const model = 'gemini-3.1-pro-high';
  // The transcript id is generated, and renamed because the history already used it.
  const history = replayedTurn(
    model,
    [{ functionCall: { name: 'glob', args: { p: '*' } }, thoughtSignature: 'sig' }],
    [{ id: 'gemini_0123456789abcdef-2', name: 'glob', arguments: { p: '*' } }]
  );
  for (const contents of [
    toGeminiContents(history, model),
    buildAntigravityRequest(history, model, [], {}, 'p').request.contents,
  ]) {
    const { calls, responses } = callAndResponseIds(contents);
    assert.deepEqual(calls, [undefined]);
    assert.deepEqual(responses, [undefined]);
    assert.equal(JSON.stringify(contents).includes('gemini_0123456789abcdef'), false);
  }
});

test('Gemini: a response follows the server id the replayed functionCall carries', () => {
  const model = 'gemini-3.1-pro-high';
  const history = replayedTurn(
    model,
    [{ functionCall: { id: 'srv-call', name: 'glob', args: {} }, thoughtSignature: 'sig' }],
    [{ id: 'srv-call-2', name: 'glob', arguments: {} }]
  );
  const { calls, responses } = callAndResponseIds(
    buildAntigravityRequest(history, model, [], {}, 'p').request.contents
  );
  assert.deepEqual(calls, ['srv-call']);
  assert.deepEqual(responses, ['srv-call']);
});

test('Claude/GPT-OSS on Antigravity: the replayed functionCall carries the final id its response uses', () => {
  for (const model of ['claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
    // Second call has no recorded id, first was renamed; names are the
    // call_tool bridge wire name, so pairing cannot depend on a target name.
    const history = replayedTurn(
      model,
      [
        { functionCall: { id: 'toolu_1', name: 'call_tool', args: { name: 'a', arguments: {} } } },
        { functionCall: { name: 'call_tool', args: { name: 'b', arguments: {} } } },
      ],
      [
        { id: 'toolu_1-2', name: 'call_tool', arguments: { name: 'a', arguments: {} } },
        { id: 'gemini_deadbeef', name: 'call_tool', arguments: { name: 'b', arguments: {} } },
      ]
    );
    for (const contents of [
      toGeminiContents(history, model),
      buildAntigravityRequest(history, model, [], {}, 'p').request.contents,
    ]) {
      const { calls, responses } = callAndResponseIds(contents);
      assert.deepEqual(calls, ['toolu_1-2', 'gemini_deadbeef'], model);
      assert.deepEqual(responses, calls, model);
    }
    assert.equal(history[1].providerReplay.items[0].functionCall.id, 'toolu_1', 'stored replay is not mutated');
  }
});

test('a tool result with no replayed call keeps its own id', () => {
  const contents = toGeminiContents(
    [
      { role: 'user', content: 'x' },
      { role: 'tool', toolCallId: 'orphan', content: 'r' },
    ],
    'gemini-3-pro'
  );
  assert.equal(contents[1].parts[0].functionResponse.id, 'orphan');
});

test('a failed tool result is sent under error, a successful one under result', () => {
  const history = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'read', arguments: {} },
        { id: 'b', name: 'read', arguments: {} },
        { id: 'c', name: 'read', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'a', content: 'boom', toolKind: 'error' },
    { role: 'tool', toolCallId: 'b', content: 'bad', isError: true },
    { role: 'tool', toolCallId: 'c', content: 'fine' },
  ];
  const responses = toGeminiContents(history, 'gemini-3-pro')[2].parts.map((p) => p.functionResponse.response);
  assert.deepEqual(responses, [{ error: 'boom' }, { error: 'bad' }, { result: 'fine' }]);
});

test('parametersJsonSchema drops non-standard keys recursively but keeps names, enums and defaults', () => {
  const inputSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: 'c',
    'x-internal': true,
    type: 'object',
    additionalProperties: false,
    properties: {
      // Property names that look like keywords are data, not keywords.
      examples: { type: 'string', deprecated: true, 'x-ui': 'a', examples: ['q'] },
      'x-name': { type: 'array', items: { type: 'object', 'x-deep': 1, additionalProperties: false, properties: {} } },
      choice: {
        anyOf: [
          { type: 'string', $comment: 'c' },
          { type: 'integer', examples: [1] },
        ],
        default: { 'x-data': 1, examples: [] },
      },
      mode: { enum: ['x-a', 'deprecated'], type: 'string' },
    },
    $defs: { d: { type: 'string', 'x-d': 1, deprecated: false } },
    required: ['examples'],
  };
  const before = structuredClone(inputSchema);
  const out = declaration(inputSchema);
  assert.deepEqual(inputSchema, before);
  assert.equal(out.parameters, undefined);
  assert.deepEqual(out.parametersJsonSchema, {
    type: 'object',
    additionalProperties: false,
    properties: {
      examples: { type: 'string' },
      'x-name': { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } },
      choice: {
        anyOf: [{ type: 'string' }, { type: 'integer' }],
        default: { 'x-data': 1, examples: [] },
      },
      mode: { enum: ['x-a', 'deprecated'], type: 'string' },
    },
    $defs: { d: { type: 'string' } },
    required: ['examples'],
  });
});

test('Claude-via-Antigravity declarations are lossless JSON Schema; Gemini gets the representability choice', () => {
  const tools = [
    {
      name: 'closed',
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          o: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false },
        },
        required: ['a'],
        additionalProperties: false,
      },
    },
    {
      name: 'union',
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: {
          v: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
          w: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] },
        },
      },
    },
    {
      name: 'numeric',
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: { level: { type: 'integer', enum: [1, 2, 3] }, c: { type: 'number', const: 2 } },
        required: ['level'],
      },
    },
  ];
  const messages = [{ role: 'user', content: 'hi' }];
  const bytes = (model) => JSON.stringify(buildAntigravityRequest(messages, model, tools, {}, 'p').request.tools);
  // Claude gets the lossless draft 2020-12 schema (no legacy projection).
  assert.deepEqual(
    JSON.parse(bytes('claude-sonnet-4-6'))[0].functionDeclarations,
    tools.map(({ name, description, inputSchema }) => ({ name, description, parametersJsonSchema: inputSchema }))
  );
  const gemini = JSON.parse(bytes('gemini-3.1-pro-high'))[0].functionDeclarations;
  assert.deepEqual(
    gemini.map((d) => Object.keys(d).includes('parametersJsonSchema')),
    [true, true, true]
  );
});
