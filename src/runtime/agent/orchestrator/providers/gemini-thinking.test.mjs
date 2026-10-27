import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Catalog rows by `${provider}:${model}`; an unlisted model has no catalog row.
const catalogRows = new Map();
const catalogHits = [];
const catalogUrl = new URL('../../../shared/llm/model-catalog.mjs', import.meta.url).href;
const realCatalog = await import(catalogUrl);
mock.module(catalogUrl, {
  namedExports: {
    ...realCatalog,
    getModelMetadataSync(id, provider) {
      catalogHits.push(`${provider}:${id}`);
      return catalogRows.get(`${provider}:${id}`) ?? null;
    },
  },
});
const { geminiThinkingConfig } = await import('./gemini-thinking.mjs');
const { GeminiProvider } = await import('./gemini.mjs');
const { toGeminiContents } = await import('./gemini-schema.mjs');
const { buildAntigravityRequest } = await import('./antigravity-request.mjs');

const effortRow = (...values) => ({ supportsReasoning: true, reasoningOptions: [{ type: 'effort', values }] });

test('Gemini thinking controls preserve explicit values and reject only what the wire cannot carry', () => {
  catalogRows.clear();
  assert.equal(geminiThinkingConfig('gemini-3.1-pro'), undefined);
  assert.deepEqual(geminiThinkingConfig('gemini-3.1-pro', { effort: 'medium' }), { thinkingLevel: 'medium' });
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-flash', { effort: 'high', thinkingBudget: 0 }), {
    thinkingBudget: 0,
  });
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro', { thinkingBudgetTokens: -1 }), { thinkingBudget: -1 });
  assert.deepEqual(geminiThinkingConfig('gemini-3.6-flash', { effort: 'minimal' }), { thinkingLevel: 'minimal' });
  assert.throws(
    () => geminiThinkingConfig('gemini-3.8-flash', { effort: 'minimal' }),
    /supports thinking levels low, medium, high/
  );
  assert.throws(() => geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: 0 }), /cannot disable/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-flash', { thinkingBudget: 30000 }), /0, or 0–24576/);
  // Only values outside the wire's own vocabulary fail locally.
  assert.throws(() => geminiThinkingConfig('gemini-3.1-pro', { effort: 'max' }), /supports thinking levels/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: -2 }), /thinkingBudget must be/);
  assert.throws(
    () => geminiThinkingConfig('gemini-3.1-pro', { thinkingLevel: 'low', thinkingBudget: 1024 }),
    /not both/
  );
});

test('Gemini sends selected thinking configuration with and without cachedContent', async () => {
  const payload = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
  };
  for (const cached of [false, true]) {
    for (const effort of ['low', 'high']) {
      let captured;
      const provider = new GeminiProvider({
        apiKey: 'fixture-key',
        preconnectFn: () => {},
        genAI: {
          getGenerativeModel(config) {
            captured = config;
            return {
              async generateContentStream() {
                return {
                  stream: (async function* () {
                    yield payload;
                  })(),
                  response: Promise.resolve(payload),
                };
              },
            };
          },
        },
        fetchFn: async (_url, init) => {
          captured = JSON.parse(init.body);
          return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      provider._ensureGeminiCache = async () => (cached ? 'cachedContents/fixture' : null);
      const response = await provider.send(
        [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello.' },
        ],
        'gemini-3.1-pro',
        [],
        { effort }
      );
      assert.equal(response.content, 'ok');
      assert.deepEqual(captured.generationConfig, {
        thinkingConfig: { includeThoughts: true, thinkingLevel: effort },
      });
      if (cached) {
        assert.equal(captured.cachedContent, 'cachedContents/fixture');
        assert.equal(captured.systemInstruction, undefined);
        assert.equal(captured.tools, undefined);
      }
    }
  }
});

test('catalog effort ladder decides the allowed levels for gemini-4-argon, by the bare Gemini API id', () => {
  catalogRows.clear();
  catalogHits.length = 0;
  catalogRows.set('gemini:gemini-4-argon', effortRow('low', 'medium', 'high', 'xhigh'));
  for (const level of ['low', 'medium', 'high']) {
    assert.deepEqual(geminiThinkingConfig('gemini-4-argon', { effort: level }), { thinkingLevel: level });
    assert.deepEqual(geminiThinkingConfig('models/gemini-4-argon', { thinkingLevel: level }), {
      thinkingLevel: level,
    });
  }
  // 'xhigh' is a catalog value the Gemini wire cannot take; 'minimal' is not declared.
  assert.throws(
    () => geminiThinkingConfig('gemini-4-argon', { effort: 'xhigh' }),
    /supports thinking levels low, medium, high/
  );
  assert.throws(() => geminiThinkingConfig('gemini-4-argon', { effort: 'minimal' }), /supports thinking levels/);
  assert.ok(catalogHits.every((hit) => hit === 'gemini:gemini-4-argon'));
});

test('a catalog ladder decides the allowed levels for any id, whatever its name says', () => {
  catalogRows.clear();
  // Any id can be declared narrower or wider than its neighbours.
  catalogRows.set('gemini:gemini-3.1-pro', effortRow('minimal', 'high'));
  assert.deepEqual(geminiThinkingConfig('gemini-3.1-pro', { effort: 'minimal' }), { thinkingLevel: 'minimal' });
  assert.throws(
    () => geminiThinkingConfig('gemini-3.1-pro', { effort: 'medium' }),
    /supports thinking levels minimal, high/
  );
  // A catalog row with no effort ladder declares nothing, so the value passes through.
  catalogRows.set('gemini:gemini-3.6-flash', { supportsReasoning: true, reasoningOptions: [] });
  assert.deepEqual(geminiThinkingConfig('gemini-3.6-flash', { effort: 'minimal' }), { thinkingLevel: 'minimal' });
});

test('a hypothetical future id needs no code change: without catalog data the wire vocabulary passes through', () => {
  catalogRows.clear();
  for (const model of ['gemini-4.2-pro', 'gemini-12-flash']) {
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      assert.deepEqual(geminiThinkingConfig(model, { effort: level }), { thinkingLevel: level }, `${model} ${level}`);
    }
    assert.throws(() => geminiThinkingConfig(model, { effort: 'max' }), /supports thinking levels/);
  }
  assert.deepEqual(geminiThinkingConfig('gemini-4-argon', { thinkingBudget: 2048 }), { thinkingBudget: 2048 });
});

test('the Antigravity request resolves a bare Gemini id against the antigravity-oauth roster', () => {
  catalogRows.clear();
  catalogRows.set('antigravity-oauth:gemini-4-pro', effortRow('low', 'high'));
  const messages = [{ role: 'user', content: 'hi' }];
  const body = buildAntigravityRequest(messages, 'gemini-4-pro', [], { effort: 'high' }, 'p');
  assert.deepEqual(body.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' });
  assert.throws(
    () => buildAntigravityRequest(messages, 'gemini-4-pro', [], { effort: 'medium' }, 'p'),
    /supports thinking levels low, high/
  );
});

const IMAGE_DATA = 'iVBORw0KGgo=';
const imageHistory = () => [
  { role: 'user', content: 'Read the screenshot.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.png' } }] },
  {
    role: 'tool',
    toolCallId: 'call_1',
    content: [
      { type: 'text', text: 'Image read successfully' },
      { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
    ],
  },
];

test('image tool results nest in functionResponse.parts on Gemini 3+, and stay siblings elsewhere', () => {
  const response = { name: 'read', id: 'call_1', response: { result: 'Image read successfully' } };
  const image = { inlineData: { mimeType: 'image/png', data: IMAGE_DATA } };
  for (const model of ['gemini-2.5-pro', '', 'claude-opus-4-6-thinking']) {
    const contents = toGeminiContents(imageHistory(), model);
    assert.equal(contents.length, 3, model);
    assert.deepEqual(contents[2].parts, [{ functionResponse: response }, image], model);
  }
  for (const model of ['gemini-3-pro-preview', 'gemini-4-argon', 'models/gemini-11-future']) {
    const contents = toGeminiContents(imageHistory(), model);
    assert.equal(contents.length, 3, model);
    assert.equal(contents[1].parts[0].functionCall.id, 'call_1', model);
    assert.equal(contents[2].role, 'user', model);
    assert.deepEqual(contents[2].parts, [{ functionResponse: { ...response, parts: [image] } }], model);
  }
});

test('parallel tool results share one turn: each result keeps its own media, every functionResponse first', () => {
  const history = [
    { role: 'user', content: 'inspect both' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'read', arguments: { path: 'a.png' } },
        { id: 'call_2', name: 'list', arguments: { path: 'src' } },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: imageHistory()[2].content },
    { role: 'tool', toolCallId: 'call_2', content: 'second result' },
  ];
  const legacy = toGeminiContents(history, 'gemini-2.5-pro');
  assert.equal(legacy.length, 3);
  assert.deepEqual(
    legacy[2].parts.map((part) => Object.keys(part)[0]),
    ['functionResponse', 'functionResponse', 'inlineData']
  );
  assert.equal(legacy[2].parts[2].inlineData.data, IMAGE_DATA);

  const contents = toGeminiContents(history, 'gemini-4-argon');
  assert.equal(contents.length, 3);
  assert.deepEqual(
    contents[2].parts.map((part) => Object.keys(part)[0]),
    ['functionResponse', 'functionResponse']
  );
  assert.deepEqual(
    contents[2].parts.map((part) => part.functionResponse.id),
    ['call_1', 'call_2']
  );
  assert.equal(contents[2].parts[0].functionResponse.parts[0].inlineData.data, IMAGE_DATA);
  assert.equal('parts' in contents[2].parts[1].functionResponse, false);
  assert.equal(JSON.stringify(contents).includes('tool_media'), false);
});

test('the unsigned current-turn functionCall is repaired for the whole Gemini family, never for other families', () => {
  const signature = (model) => toGeminiContents(imageHistory(), model)[1].parts[0].thoughtSignature;
  for (const model of ['gemini-4-argon', 'models/gemini-7-x', 'gemini-3-pro-preview', 'gemini-2.5-pro']) {
    assert.equal(signature(model), 'skip_thought_signature_validator', model);
  }
  for (const model of ['claude-opus-4-6-thinking', 'gpt-oss-120b-medium', '']) {
    assert.equal(signature(model), undefined, model);
  }
});
