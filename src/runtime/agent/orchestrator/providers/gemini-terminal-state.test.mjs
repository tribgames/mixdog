import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeGeminiRestStreamResponse, consumeGeminiSdkStream } from './gemini-stream.mjs';
import { geminiInvalidStreamReason } from './gemini-retry-policy.mjs';
import {
  geminiFinishReasonKind,
  geminiPolicyFinishCode,
} from './gemini-error-contract.mjs';
import { geminiBareModelId, geminiCacheCreateBody, geminiPrefixBelowMinimum } from './gemini-cache-policy.mjs';
import { buildGeminiRequest, geminiCachedRestBody } from './gemini-request-body.mjs';
import { GeminiProvider } from './gemini.mjs';

const rest = (chunks, options = {}) =>
  consumeGeminiRestStreamResponse(
    new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')),
    { label: 'fixture', ...options }
  );
const sdk = (chunks, options = {}) =>
  consumeGeminiSdkStream(
    {
      stream: (async function* () {
        yield* chunks;
      })(),
      response: Promise.resolve({}),
    },
    { label: 'fixture', ...options }
  );
const transports = [
  ['REST', rest],
  ['SDK', sdk],
];
const cand = (fields) => ({ candidates: [{ content: { role: 'model', parts: [] }, ...fields }] });

for (const [name, consume] of transports) {
  test(`${name}: streamed grounding metadata merges instead of being replaced`, async () => {
    const response = await consume([
      cand({
        content: { role: 'model', parts: [{ text: 'a' }] },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'u0' } }],
          webSearchQueries: ['q1'],
          searchEntryPoint: { renderedContent: 'r' },
        },
      }),
      cand({
        content: { role: 'model', parts: [{ text: 'b' }] },
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'u1' } }],
          groundingSupports: [{ groundingChunkIndices: [0, 1], segment: { endIndex: 2 } }],
          webSearchQueries: ['q1', 'q2'],
        },
      }),
      cand({ finishReason: 'STOP' }),
    ]);
    assert.deepEqual(response.candidates[0].groundingMetadata, {
      groundingChunks: [{ web: { uri: 'u0' } }, { web: { uri: 'u1' } }],
      webSearchQueries: ['q1', 'q2'],
      searchEntryPoint: { renderedContent: 'r' },
      groundingSupports: [{ groundingChunkIndices: [0, 1], segment: { endIndex: 2 } }],
    });
  });

  test(`${name}: promptFeedback from an early chunk survives later chunks`, async () => {
    const response = await consume([
      { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'C', probability: 'HIGH' }] } },
      { promptFeedback: {} },
      cand({ finishReason: 'STOP' }),
    ]);
    assert.equal(response.promptFeedback.blockReason, 'SAFETY');
    assert.equal(response.promptFeedback.safetyRatings.length, 1);
  });

  test(`${name}: candidates are indexed by their index field`, async () => {
    const response = await consume([
      { candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'one' }] } }] },
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'zero' }] } }] },
      { candidates: [{ index: 1, finishReason: 'STOP' }] },
      { candidates: [{ index: 0, finishReason: 'STOP' }] },
    ]);
    assert.deepEqual(
      response.candidates.map((c) => [c.index, c.content.parts[0].text, c.finishReason]),
      [
        [0, 'zero', 'STOP'],
        [1, 'one', 'STOP'],
      ]
    );
  });

  test(`${name}: a later chunk without finishReason does not erase an earlier one`, async () => {
    const response = await consume([cand({ finishReason: 'STOP', safetyRatings: [{ category: 'C' }] }), cand({})]);
    assert.equal(response.candidates[0].finishReason, 'STOP');
    assert.equal(response.candidates[0].safetyRatings.length, 1);
  });

  test(`${name}: thought-only EOF without finishReason is unfinished; an empty STOP is complete`, async () => {
    const thought = cand({ content: { role: 'model', parts: [{ text: 'hmm', thought: true }] } });
    await assert.rejects(consume([thought]), (error) => error.code === 'TRUNCATED_STREAM' && /no finishReason/.test(error.message));
    await assert.rejects(consume([cand({ finishReason: 'FINISH_REASON_UNSPECIFIED' })]), /no finishReason/);
    const empty = await consume([cand({ finishReason: 'STOP' })]);
    assert.equal(empty.candidates[0].finishReason, 'STOP');
  });

  test(`${name}: a finishReason-less tool turn needs every functionCall part complete`, async () => {
    const callPart = (functionCall) => cand({ content: { role: 'model', parts: [{ functionCall }] } });
    const good = { name: 'read', args: { path: 'a.txt' } };
    const done = await consume([callPart(good)]);
    assert.equal(done.candidates[0].content.parts.length, 1);
    await assert.rejects(
      consume([callPart(good), callPart({ name: 'read', args: 'unfinished' })]),
      (error) => error.code === 'TRUNCATED_STREAM' && /no finishReason/.test(error.message)
    );
    await assert.rejects(
      consume([callPart({ name: 'read', args: 'unfinished' }), callPart(good)]),
      /no finishReason/
    );
  });

  test(`${name}: continuationToken is preserved`, async () => {
    const response = await consume([cand({ finishReason: 'CONTINUATION', continuationToken: 'dG9rZW4=' })]);
    assert.equal(response.candidates[0].continuationToken, 'dG9rZW4=');
  });
}

const response = (finishReason, parts = []) => ({ candidates: [{ finishReason, content: { parts } }] });

test('every documented non-STOP finish is classified; only STOP with no text is "no text"', () => {
  const terminal = [
    'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER', 'NO_IMAGE', 'IMAGE_RECITATION', 'TOO_MANY_TOOL_CALLS',
    'MISSING_THOUGHT_SIGNATURE', 'ESCALATION', 'PUP_LIMITED_DISABLED', 'MAX_TOKENS', 'CONTINUATION',
    'FINISH_REASON_BLOCKLIST', 'SOME_FUTURE_REASON',
  ];
  for (const finish of terminal) assert.equal(geminiInvalidStreamReason(response(finish)), null, finish);
  for (const finish of ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'MALFORMED_RESPONSE']) {
    assert.equal(geminiInvalidStreamReason(response(finish)), finish);
  }
  assert.equal(geminiInvalidStreamReason(response('STOP')), 'NO_RESPONSE_TEXT');
  assert.equal(geminiInvalidStreamReason(response('FINISH_REASON_UNSPECIFIED')), null);
  assert.equal(geminiFinishReasonKind('CONTINUATION'), 'continuation');
  assert.equal(geminiFinishReasonKind(undefined), 'none');
});

test('policy finish reasons carry policy codes', () => {
  for (const finish of ['BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'ESCALATION', 'PUP_LIMITED_DISABLED']) {
    assert.equal(geminiPolicyFinishCode(finish), 'safety', finish);
  }
  assert.equal(geminiPolicyFinishCode('IMAGE_RECITATION'), 'recitation');
  assert.equal(geminiPolicyFinishCode('LANGUAGE'), 'content_filter');
  for (const finish of ['OTHER', 'MAX_TOKENS', 'CONTINUATION', 'TOO_MANY_TOOL_CALLS']) {
    assert.equal(geminiPolicyFinishCode(finish), null, finish);
  }
});

function sdkProvider(chunks, captured = {}) {
  return new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    sleepFn: async () => {},
    genAI: {
      getGenerativeModel: (params) => {
        captured.params = params;
        return {
          async generateContentStream() {
            return {
              stream: (async function* () {
                yield* chunks;
              })(),
              response: Promise.resolve({}),
            };
          },
        };
      },
    },
  });
}
const call = { functionCall: { name: 'read', args: { path: 'x' } } };
const send = (provider, opts = {}) => provider.send([{ role: 'user', content: 'hi' }], 'gemini-test', [], opts);

test('a failed candidate never dispatches its native tool calls; a STOP one does', async () => {
  const dispatched = [];
  const onToolCall = (c) => dispatched.push(c.name);
  const failed = sdkProvider([cand({ content: { role: 'model', parts: [call] }, finishReason: 'SAFETY', safetyRatings: [{ category: 'C', probability: 'HIGH' }], finishMessage: 'blocked' })]);
  await assert.rejects(send(failed, { onToolCall }), (error) => {
    assert.equal(error.code, 'safety');
    assert.equal(error.finishReason, 'SAFETY');
    assert.equal(error.finishMessage, 'blocked');
    assert.deepEqual(error.safetyRatings, [{ category: 'C', probability: 'HIGH' }]);
    return true;
  });
  assert.deepEqual(dispatched, []);
  const ok = sdkProvider([cand({ content: { role: 'model', parts: [call] }, finishReason: 'STOP' })]);
  await send(ok, { onToolCall });
  assert.deepEqual(dispatched, ['read']);
});

test('a call leaked as text is dispatched only when the response finishes cleanly', async () => {
  const dispatched = [];
  const onToolCall = (c) => dispatched.push(c.name);
  const leaked = {
    text: '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>',
  };
  const tools = [{ name: 'read', description: 'd', inputSchema: { type: 'object', properties: {} } }];
  const sendWithTools = (provider) => provider.send([{ role: 'user', content: 'hi' }], 'gemini-test', tools, { onToolCall });
  const failed = sdkProvider([cand({ content: { role: 'model', parts: [leaked] }, finishReason: 'SAFETY' })]);
  await assert.rejects(sendWithTools(failed), (error) => error.finishReason === 'SAFETY');
  assert.deepEqual(dispatched, []);
  const ok = sdkProvider([cand({ content: { role: 'model', parts: [leaked] }, finishReason: 'STOP' })]);
  await sendWithTools(ok);
  assert.deepEqual(dispatched, ['read']);
});

test('CONTINUATION surfaces a typed unsupported error that keeps the token and partial text', async () => {
  const provider = sdkProvider([
    cand({ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'CONTINUATION', continuationToken: 'dG9rZW4=' }),
  ]);
  await assert.rejects(send(provider), (error) => {
    assert.equal(error.code, 'CONTINUATION_UNSUPPORTED');
    assert.equal(error.continuationUnsupported, true);
    assert.equal(error.continuationToken, 'dG9rZW4=');
    assert.equal(error.finishReason, 'CONTINUATION');
    assert.equal(error.partialContent, 'partial');
    return true;
  });
});

test('a prompt block keeps its reason and ratings on the error', async () => {
  const provider = sdkProvider([
    { promptFeedback: { blockReason: 'PROHIBITED_CONTENT', safetyRatings: [{ category: 'C' }] } },
  ]);
  await assert.rejects(send(provider), (error) => {
    assert.equal(error.code, 'safety');
    assert.equal(error.finishReason, 'PROMPT_PROHIBITED_CONTENT');
    assert.equal(error.blockReason, 'PROHIBITED_CONTENT');
    assert.deepEqual(error.promptSafetyRatings, [{ category: 'C' }]);
    return true;
  });
});

test('the model id is canonicalized once for cache bodies and REST URLs', async () => {
  assert.equal(geminiBareModelId('models/gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(geminiBareModelId('gemini-2.5-pro'), 'gemini-2.5-pro');
  for (const model of ['gemini-2.5-pro', 'models/gemini-2.5-pro']) {
    assert.equal(geminiCacheCreateBody({ model, ttlSeconds: 60, contents: [] }).model, 'models/gemini-2.5-pro');
  }
  const urls = [];
  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    genAI: { getGenerativeModel: () => ({}) },
    fetchFn: async (url) => {
      urls.push(url);
      return new Response(`data: ${JSON.stringify(cand({ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }))}\n\n`);
    },
  });
  provider._ensureGeminiCache = async () => 'cachedContents/x';
  await provider.send([{ role: 'user', content: 'hi' }], 'models/gemini-2.5-pro', [], {});
  assert.match(urls[0], /\/v1beta\/models\/gemini-2\.5-pro:streamGenerateContent/);
  // The body is SSE, not JSON: only the requested URL matters here.
  await provider._restGenerateContent('models/gemini-2.5-pro', 'k', {}, null).catch(() => {});
  assert.match(urls[1], /\/v1beta\/models\/gemini-2\.5-pro:generateContent/);
});

test('the explicit-cache minimum is per model, and unsupported models skip caching', () => {
  const base = { systemInstruction: 'x'.repeat(12_000), geminiTools: [], contents: [], opts: {}, currentIter: 1 };
  // ~3000 tokens: above the 2048 minimum of 2.5 Flash, below the 4096 default.
  assert.equal(geminiPrefixBelowMinimum({ ...base, model: 'gemini-2.5-flash' }), false);
  assert.equal(geminiPrefixBelowMinimum({ ...base, model: 'gemini-3.1-pro' }), true);
  const huge = { ...base, systemInstruction: 'x'.repeat(400_000) };
  assert.equal(geminiPrefixBelowMinimum({ ...huge, model: 'gemini-3.1-pro' }), false);
  assert.equal(geminiPrefixBelowMinimum({ ...huge, model: 'gemini-4-argon' }), true);
});

test('safetySettings are forwarded on the SDK and cached REST paths; absent stays byte-identical', async () => {
  const safetySettings = [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }];
  const messages = [{ role: 'user', content: 'hi' }];
  const request = buildGeminiRequest(messages, 'gemini-2.5-pro', [], { safetySettings });
  assert.deepEqual(request.safetySettings, safetySettings);
  assert.equal(buildGeminiRequest(messages, 'gemini-2.5-pro', [], {}).safetySettings, undefined);
  const without = geminiCachedRestBody({ opts: {}, contents: request.contents, cachedContent: 'c' });
  assert.equal('safetySettings' in without, false);
  assert.deepEqual(
    geminiCachedRestBody({ opts: {}, contents: request.contents, cachedContent: 'c', safetySettings }).safetySettings,
    safetySettings
  );

  const captured = {};
  const provider = sdkProvider([cand({ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' })], captured);
  await send(provider, { safetySettings });
  assert.deepEqual(captured.params.safetySettings, safetySettings);
  await send(provider, {});
  assert.equal('safetySettings' in captured.params, false);

  const bodies = [];
  const cached = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    genAI: { getGenerativeModel: () => ({}) },
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(`data: ${JSON.stringify(cand({ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }))}\n\n`);
    },
  });
  cached._ensureGeminiCache = async () => 'cachedContents/x';
  await send(cached, { safetySettings });
  await send(cached, {});
  assert.deepEqual(bodies[0].safetySettings, safetySettings);
  assert.equal('safetySettings' in bodies[1], false);
});
