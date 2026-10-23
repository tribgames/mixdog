// Gemini fixes shared by the API-key (SDK + cached REST) and Antigravity paths:
// thought relay and usage, the default output ceiling, whole-functionCall ends
// without a finishReason, the empty-STOP re-ask, and leak-guard fence state.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-gemini-fixes-'));

// Catalog output limits by model id; an unlisted model has none declared.
const declaredOutput = new Map();
const catalogUrl = new URL('../../../shared/llm/model-catalog.mjs', import.meta.url).href;
const realCatalog = await import(catalogUrl);
mock.module(catalogUrl, {
  namedExports: {
    ...realCatalog,
    getModelMetadataSync(id) {
      return declaredOutput.has(id) ? { outputTokens: declaredOutput.get(id) } : null;
    },
  },
});

const { consumeGeminiRestStreamResponse, consumeGeminiSdkStream, createGeminiTextLeakGuard } = await import(
  './gemini-stream.mjs'
);
const { GeminiProvider } = await import('./gemini.mjs');
const { AntigravityOAuthProvider } = await import('./antigravity-oauth.mjs');
const { antigravityModelCache } = await import('./antigravity-oauth-catalog.mjs');
const { buildGeminiRequest } = await import('./gemini-request-body.mjs');
const { buildAntigravityRequest } = await import('./antigravity-request.mjs');
const { normalizeAntigravityUsage } = await import('./antigravity-response.mjs');

const protocols = [
  {
    name: 'REST',
    consume: (chunks, options) =>
      consumeGeminiRestStreamResponse(
        new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')),
        options
      ),
  },
  {
    name: 'SDK',
    consume: (chunks, options) =>
      consumeGeminiSdkStream(
        {
          stream: (async function* () {
            yield* chunks;
          })(),
          response: Promise.resolve({}),
        },
        options
      ),
  },
];

const chunkOf = (parts, finishReason) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
});
const USAGE = { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 19 };
const HELLO = [{ role: 'user', content: 'Hello.' }];

// ── Harnesses ──
// API-key provider on the SDK path: attempt N streams `attempts[N]`.
function sdkProvider(attempts) {
  const configs = [];
  let attempt = 0;
  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    sleepFn: async () => {},
    genAI: {
      getGenerativeModel(config) {
        configs.push(config);
        return {
          async generateContentStream() {
            const chunks = attempts[Math.min(attempt++, attempts.length - 1)];
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
  provider._ensureGeminiCache = async () => null;
  return { provider, configs, attemptsMade: () => attempt };
}

// API-key provider on the cachedContents REST path.
function restProvider(attempts) {
  const bodies = [];
  let attempt = 0;
  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    sleepFn: async () => {},
    genAI: { getGenerativeModel: () => ({}) },
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const chunks = attempts[Math.min(attempt++, attempts.length - 1)];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  provider._ensureGeminiCache = async () => 'cachedContents/fixture';
  return { provider, bodies, attemptsMade: () => attempt };
}

// Antigravity provider: attempt N streams `attempts[N]`, wrapped in `response`.
function antigravityProvider(attempts) {
  const bodies = [];
  let attempt = 0;
  const provider = new AntigravityOAuthProvider({
    preconnectFn: () => {},
    ensureVersionFn: async () => {},
    ensureAuthFn: async () => ({ accessToken: 'access-token', projectId: 'test-project', email: 'dev@example.com' }),
    sleepFn: async () => {},
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const chunks = attempts[Math.min(attempt++, attempts.length - 1)];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ response: chunk })}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return { provider, bodies, attemptsMade: () => attempt };
}

// ── Fix 1: thoughts ──
for (const { name, consume } of protocols) {
  test(`Gemini ${name} stream relays thought parts as reasoning and keeps them out of the answer`, async () => {
    const reasoning = [];
    const text = [];
    const response = await consume(
      [
        chunkOf([{ text: 'weighing options', thought: true }]),
        chunkOf([{ text: 'more thought', thought: true }, { text: 'Answer.' }], 'STOP'),
      ],
      { label: 'fixture', onReasoningDelta: (d) => reasoning.push(d), onTextDelta: (d) => text.push(d) }
    );
    assert.deepEqual(reasoning, ['weighing options', 'more thought']);
    assert.deepEqual(text, ['Answer.']);
    assert.equal(response.candidates[0].content.parts.length, 3);
  });
}

test('API-key SDK send relays thoughts through onReasoningDelta, not the answer', async () => {
  const { provider } = sdkProvider([[chunkOf([{ text: 'thinking...', thought: true }, { text: 'Done.' }], 'STOP')]]);
  const reasoning = [];
  const result = await provider.send(HELLO, 'gemini-3.1-pro', [], { onReasoningDelta: (d) => reasoning.push(d) });
  assert.deepEqual(reasoning, ['thinking...']);
  assert.equal(result.content, 'Done.');
});

test('API-key cached REST send relays thoughts through onReasoningDelta, not the answer', async () => {
  const { provider } = restProvider([[chunkOf([{ text: 'thinking...', thought: true }, { text: 'Done.' }], 'STOP')]]);
  const reasoning = [];
  const result = await provider.send(HELLO, 'gemini-3.1-pro', [], { onReasoningDelta: (d) => reasoning.push(d) });
  assert.deepEqual(reasoning, ['thinking...']);
  assert.equal(result.content, 'Done.');
});

test('Antigravity send relays thoughts through onReasoningDelta, not the answer', async () => {
  const { provider } = antigravityProvider([[chunkOf([{ text: 'thinking...', thought: true }, { text: 'Done.' }], 'STOP')]]);
  const reasoning = [];
  const result = await provider.send(HELLO, 'gemini-3-flash', [], { onReasoningDelta: (d) => reasoning.push(d) });
  assert.deepEqual(reasoning, ['thinking...']);
  assert.equal(result.content, 'Done.');
});

test('Antigravity usage: output is candidates + thoughts, reasoning is thoughts, total is the reported total', () => {
  const usage = normalizeAntigravityUsage(USAGE);
  assert.equal(usage.outputTokens, 8);
  assert.equal(usage.reasoningTokens, 3);
  assert.equal(usage.totalTokens, 19);
  // No reported total: the sum of the parts.
  const noTotal = normalizeAntigravityUsage({ promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 3 });
  assert.equal(noTotal.totalTokens, 19);
  // A gateway that reports no thoughts reports no reasoning (missing is not zero).
  assert.equal('reasoningTokens' in normalizeAntigravityUsage({ promptTokenCount: 4, candidatesTokenCount: 2 }), false);
});

test('API-key replay signs the first functionCall of a tool-result turn with the sentinel', () => {
  const history = [
    { role: 'user', content: 'Read it.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'call_a', content: 'a' },
  ];
  const { contents } = buildGeminiRequest(history, 'gemini-3.1-pro', [], {});
  const call = contents.find((content) => content.role === 'model').parts.find((part) => part.functionCall);
  assert.equal(call.thoughtSignature, 'skip_thought_signature_validator');
});

// ── Fix 2: maxOutputTokens ──
test('an uncatalogued model sends no maxOutputTokens on either builder, whatever its family', () => {
  declaredOutput.clear();
  for (const model of ['gemini-9.9-pro-fixture', 'gemini-9.9-flash-fixture', 'gemini-2.0-flash-lite']) {
    assert.equal('maxOutputTokens' in buildGeminiRequest(HELLO, model, [], {}).generationConfig, false);
    assert.equal(
      'maxOutputTokens' in buildAntigravityRequest(HELLO, model, [], {}, 'p').request.generationConfig,
      false
    );
  }
});

test('with no known ceiling an explicit maxOutputTokens passes through unclamped', () => {
  declaredOutput.clear();
  const model = 'gemini-9.9-flash-fixture';
  assert.equal(buildGeminiRequest(HELLO, model, [], { maxOutputTokens: 123456 }).generationConfig.maxOutputTokens, 123456);
  assert.equal(
    buildAntigravityRequest(HELLO, model, [], { maxOutputTokens: 123456 }, 'p').request.generationConfig.maxOutputTokens,
    123456
  );
});

test('a catalog-declared output limit is the ceiling; an explicit value wins but is clamped to it', () => {
  declaredOutput.clear();
  declaredOutput.set('gemini-9.9-pro-fixture', 32768);
  const model = 'gemini-9.9-pro-fixture';
  const apiMax = (opts, roster) => buildGeminiRequest(HELLO, model, [], opts, roster).generationConfig.maxOutputTokens;
  const agMax = (opts) => buildAntigravityRequest(HELLO, model, [], opts, 'p').request.generationConfig.maxOutputTokens;
  assert.equal(apiMax({}), 32768);
  assert.equal(agMax({}), 32768);
  assert.equal(apiMax({ maxOutputTokens: 1000 }), 1000);
  assert.equal(agMax({ maxOutputTokens: 1000 }), 1000);
  assert.equal(apiMax({ maxOutputTokens: 500000 }), 32768);
  assert.equal(agMax({ maxOutputTokens: 500000 }), 32768);
  // The provider roster's declared limit outranks the shared catalog.
  assert.equal(apiMax({}, 16384), 16384);
  assert.throws(() => agMax({ maxOutputTokens: 0 }), /maxOutputTokens/);
  declaredOutput.clear();
});

test('Antigravity falls back to the fixed Claude cap without a declared limit and sends none for non-Gemini models', () => {
  declaredOutput.clear();
  const claude = buildAntigravityRequest(HELLO, 'claude-opus-4-6-thinking', [], {}, 'p');
  assert.equal(claude.request.generationConfig.maxOutputTokens, 64000);
  const oss = buildAntigravityRequest(HELLO, 'gpt-oss-120b-medium', [], {}, 'p', 65535);
  assert.equal(oss.request.generationConfig?.maxOutputTokens, undefined);
});

test('the gateway-declared limit is the Antigravity Gemini ceiling: sent by default, clamping an explicit value', () => {
  declaredOutput.clear();
  const model = 'gemini-9.9-flash-fixture';
  const sent = (opts, limit) =>
    buildAntigravityRequest(HELLO, model, [], opts, 'p', limit).request.generationConfig.maxOutputTokens;
  assert.equal(sent({}, 65535), 65535);
  assert.equal(sent({ maxOutputTokens: 1000 }, 65535), 1000);
  assert.equal(sent({ maxOutputTokens: 4194304 }, 65535), 65535);
  // Nothing declared: nothing sent, an explicit value passes through.
  assert.equal(sent({}, null), undefined);
  assert.equal(sent({ maxOutputTokens: 4194304 }, null), 4194304);
  // The roster/catalog metadata outranks the gateway's declaration.
  declaredOutput.set(model, 32768);
  assert.equal(sent({}, 65535), 32768);
  declaredOutput.clear();
});

test('a catalog/roster limit above the gateway-declared limit is clamped to the gateway limit', () => {
  declaredOutput.clear();
  const model = 'gemini-9.9-flash-fixture';
  declaredOutput.set(model, 65536);
  const sent = (opts, limit) =>
    buildAntigravityRequest(HELLO, model, [], opts, 'p', limit).request.generationConfig.maxOutputTokens;
  assert.equal(sent({}, 65535), 65535);
  assert.equal(sent({ maxOutputTokens: 65536 }, 65535), 65535);
  // A catalog limit below the gateway's still wins, and without a gateway limit it applies alone.
  assert.equal(sent({}, 100000), 65536);
  assert.equal(sent({}, null), 65536);
  declaredOutput.clear();
});

test('a declared Claude limit replaces the fixed cap and bounds the thinking budget', () => {
  const claude = 'claude-opus-5-5';
  const body = (opts, limit) => buildAntigravityRequest(HELLO, claude, [], opts, 'p', limit).request.generationConfig;
  assert.equal(body({}, 128000).maxOutputTokens, 128000);
  assert.equal(body({}, null).maxOutputTokens, 64000);
  assert.equal(body({ thinkingBudget: 100000 }, 128000).thinkingConfig.thinkingBudget, 100000);
  assert.throws(() => body({ thinkingBudget: 100000 }, null), /1024 to 63999/);
  assert.throws(() => body({ thinkingBudget: 128000 }, 128000), /1024 to 127999/);
});

test('the Antigravity send carries the maxOutputTokens its catalog row declared', async () => {
  declaredOutput.clear();
  const sentCap = async (rows) => {
    antigravityModelCache.save(rows);
    const ag = antigravityProvider([[chunkOf([{ text: 'ok' }], 'STOP')]]);
    await ag.provider.send(HELLO, 'gemini-9.9-flash-fixture', [], {});
    return ag.bodies[0].request.generationConfig.maxOutputTokens;
  };
  const row = { id: 'gemini-9.9-flash-fixture', provider: 'antigravity-oauth', wire: 'gemini-9.9-flash-fixture' };
  assert.equal(await sentCap([{ ...row, maxOutputTokens: 65535 }]), 65535);
  assert.equal(await sentCap([row]), undefined);
  antigravityModelCache.save([]);
});

test('the sent request carries a catalogued ceiling, and none otherwise, on the SDK, cached REST and Antigravity wires', async () => {
  const ok = () => [[chunkOf([{ text: 'ok' }], 'STOP')]];
  const sentCaps = async () => {
    const sdk = sdkProvider(ok());
    await sdk.provider.send(HELLO, 'gemini-9.9-flash-fixture', [], {});
    const rest = restProvider(ok());
    await rest.provider.send(HELLO, 'gemini-9.9-flash-fixture', [], {});
    const ag = antigravityProvider(ok());
    await ag.provider.send(HELLO, 'gemini-9.9-flash-fixture', [], {});
    return [
      sdk.configs[0].generationConfig.maxOutputTokens,
      rest.bodies[0].generationConfig.maxOutputTokens,
      ag.bodies[0].request.generationConfig.maxOutputTokens,
    ];
  };
  declaredOutput.clear();
  assert.deepEqual(await sentCaps(), [undefined, undefined, undefined]);
  declaredOutput.set('gemini-9.9-flash-fixture', 8192);
  assert.deepEqual(await sentCaps(), [8192, 8192, 8192]);
  declaredOutput.clear();
});

// ── Fix 3: missing finishReason with a whole functionCall ──
// (the stream-level cases live in gemini-stream.test.mjs)
const TOOLS = [{ name: 'read', description: 'Read a file.', input_schema: { type: 'object', properties: {} } }];
const callPart = { functionCall: { name: 'read', args: { path: 'a.txt' } }, thoughtSignature: 'sig' };

test('Antigravity ends a tool-use turn that arrived without a finishReason', async () => {
  const { provider, attemptsMade } = antigravityProvider([[chunkOf([callPart])]]);
  const dispatched = [];
  const result = await provider.send(HELLO, 'gemini-3-flash', TOOLS, { onToolCall: (call) => dispatched.push(call) });
  assert.equal(attemptsMade(), 1);
  assert.deepEqual(result.toolCalls.map((call) => call.name), ['read']);
  assert.equal(dispatched.length, 1);
});

test('API-key SDK and cached REST end a tool-use turn that arrived without a finishReason', async () => {
  for (const make of [sdkProvider, restProvider]) {
    const { provider, attemptsMade } = make([[chunkOf([callPart])]]);
    const result = await provider.send(HELLO, 'gemini-3.1-pro', TOOLS, {});
    assert.equal(attemptsMade(), 1);
    assert.deepEqual(result.toolCalls.map((call) => call.name), ['read']);
  }
});

test('text-only and empty streams without a finishReason stay truncated', async () => {
  for (const chunks of [[chunkOf([{ text: 'cut off' }])], [chunkOf([])]]) {
    const { provider } = antigravityProvider([chunks]);
    await assert.rejects(provider.send(HELLO, 'gemini-3-flash', [], {}), (error) => error.code === 'TRUNCATED_STREAM');
  }
});

// ── Fix 4: empty STOP re-ask ──
const emptyStop = [chunkOf([], 'STOP')];
const answer = [chunkOf([{ text: 'Real answer.' }], 'STOP')];

test('Antigravity re-asks an empty STOP and discards the thinking the dead attempt showed', async () => {
  const { provider, bodies } = antigravityProvider([
    [chunkOf([{ text: 'first thoughts', thought: true }]), chunkOf([], 'STOP')],
    answer,
  ]);
  const events = [];
  const result = await provider.send(HELLO, 'gemini-3-flash', [], {
    onReasoningDelta: (d) => events.push(`reasoning:${d}`),
    onTextReset: (detail) => events.push(`reset:${detail.reasoning}:${detail.chars}`),
  });
  assert.equal(bodies.length, 2);
  assert.equal(result.content, 'Real answer.');
  assert.deepEqual(events, ['reasoning:first thoughts', 'reset:true:0']);
});

test('Antigravity empty STOP right after a tool result is accepted, not re-asked', async () => {
  const { provider, attemptsMade } = antigravityProvider([emptyStop, answer]);
  const messages = [
    { role: 'user', content: 'Read it.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'call_a', content: 'a' },
  ];
  const result = await provider.send(messages, 'gemini-3-flash', TOOLS, {});
  assert.equal(attemptsMade(), 1);
  assert.equal(result.content, '');
});

test('Antigravity empty STOP that never recovers fails after the bounded re-asks', async () => {
  const { provider, attemptsMade } = antigravityProvider([emptyStop]);
  await assert.rejects(provider.send(HELLO, 'gemini-3-flash', [], {}), (error) => error.code === 'no_response_text');
  assert.equal(attemptsMade(), 4);
});

test('API-key SDK re-asks an empty STOP and discards the thinking the dead attempt showed', async () => {
  const { provider, attemptsMade } = sdkProvider([
    [chunkOf([{ text: 'first thoughts', thought: true }]), chunkOf([], 'STOP')],
    answer,
  ]);
  const events = [];
  const result = await provider.send(HELLO, 'gemini-3.1-pro', [], {
    onReasoningDelta: (d) => events.push(`reasoning:${d}`),
    onTextReset: (detail) => events.push(`reset:${detail.reasoning}:${detail.chars}`),
  });
  assert.equal(attemptsMade(), 2);
  assert.equal(result.content, 'Real answer.');
  assert.deepEqual(events, ['reasoning:first thoughts', 'reset:true:0']);
});

// ── Fix 5: leak-guard fence state ──
const LEAKED = '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>';

for (const { name, consume } of protocols) {
  test(`Gemini ${name} leak guard keeps a call example inside a fence opened in an earlier chunk`, async () => {
    const text = [];
    const dispatched = [];
    const textLeakGuard = createGeminiTextLeakGuard({
      knownToolNames: ['read'],
      onTextDelta: (d) => text.push(d),
      onToolCall: (call) => dispatched.push(call),
    });
    await consume(
      [
        chunkOf([{ text: 'Example:\n```xml\n' }]),
        chunkOf([{ text: `${LEAKED}\n` }]),
        chunkOf([{ text: '```\nDone.' }], 'STOP'),
      ],
      { label: 'fixture', textLeakGuard }
    );
    assert.deepEqual(textLeakGuard.getLeakedToolCalls(), []);
    assert.equal(dispatched.length, 0);
    assert.equal(text.join(''), `Example:\n\`\`\`xml\n${LEAKED}\n\`\`\`\nDone.`);
  });

  test(`Gemini ${name} leak guard does not hold an unfinished tag inside an earlier fence`, async () => {
    const text = [];
    const textLeakGuard = createGeminiTextLeakGuard({ knownToolNames: ['read'], onTextDelta: (d) => text.push(d) });
    const seenBeforeEnd = [];
    await consume(
      [
        chunkOf([{ text: '```\n' }]),
        chunkOf([{ text: '<invoke name="read">' }]),
        chunkOf([{ text: ' still going' }], 'STOP'),
      ],
      {
        label: 'fixture',
        textLeakGuard,
        onStreamDelta: () => seenBeforeEnd.push(text.join('')),
      }
    );
    // The opener is shown as soon as its chunk arrives, not held until stream end.
    assert.ok(seenBeforeEnd.some((shown) => shown.includes('<invoke name="read">')));
  });

  test(`Gemini ${name} leak guard still recovers a call outside any fence`, async () => {
    const dispatched = [];
    const textLeakGuard = createGeminiTextLeakGuard({
      knownToolNames: ['read'],
      onToolCall: (call) => dispatched.push(call),
    });
    await consume([chunkOf([{ text: 'Reading.\n' }]), chunkOf([{ text: LEAKED }], 'STOP')], {
      label: 'fixture',
      textLeakGuard,
    });
    assert.equal(textLeakGuard.getLeakedToolCalls().length, 1);
  });
}
