// Gemini API-key path against the current Gemini API: one REST wire (no
// legacy SDK), long-decode continuation, the 2.5 redirect, header auth and
// the deprecated sampling parameters.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GeminiProvider } from './gemini.mjs';
import { buildGeminiRequest } from './gemini-request-body.mjs';
import { fetchGeminiModelPages } from './lib/gemini-model-catalog.mjs';

const HELLO = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Hello.' },
];
const sse = (chunks) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const chunkOf = (parts, fields = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...fields }] });

// Uncached provider whose hop N streams `hops[N]`; every request is recorded.
function restProvider(hops, config = {}) {
  const requests = [];
  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    sleepFn: async () => {},
    fetchFn: async (url, init) => {
      requests.push({ url: String(url), headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : null });
      return sse(hops[Math.min(requests.length - 1, hops.length - 1)]);
    },
    ...config,
  });
  provider._ensureGeminiCache = async () => null;
  return { provider, requests };
}

// The legacy SDK would reach the network through the global fetch.
const realFetch = globalThis.fetch;
test.beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error('global fetch used: the request bypassed the provider transport');
  };
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── 1. One REST wire, no legacy SDK ──
test('an uncached send streams over REST with the full request body', async () => {
  const { provider, requests } = restProvider([[chunkOf([{ text: 'Hi.' }], { finishReason: 'STOP' })]]);
  const tools = [{ name: 'read', description: 'Read.', inputSchema: { type: 'object', properties: {} } }];
  const result = await provider.send(HELLO, 'gemini-3.1-pro-preview', tools, { toolChoice: 'required' });
  assert.equal(result.content, 'Hi.');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/v1beta\/models\/gemini-3\.1-pro-preview:streamGenerateContent\?alt=sse$/);
  const body = requests[0].body;
  assert.deepEqual(body.systemInstruction, { role: 'system', parts: [{ text: 'Be brief.' }] });
  assert.equal(body.tools[0].functionDeclarations[0].name, 'read');
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.equal(body.contents.at(-1).parts[0].text, 'Hello.');
  assert.equal('cachedContent' in body, false);
});

test('the legacy @google/generative-ai SDK is no longer a dependency', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies?.['@google/generative-ai'], undefined);
});

// ── 2. Long decode ──
test('a CONTINUATION finish is resumed with its token and presented as one turn', async () => {
  const { provider, requests } = restProvider([
    [
      chunkOf([{ text: 'think 1', thought: true }, { text: 'Part one, ' }]),
      {
        ...chunkOf([], { finishReason: 'CONTINUATION', continuationToken: 'dG9rZW4x' }),
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 60,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 10,
          totalTokenCount: 150,
        },
      },
    ],
    [
      chunkOf([{ text: 'think 2', thought: true }, { text: 'part two.' }]),
      {
        ...chunkOf([], { finishReason: 'STOP' }),
        usageMetadata: {
          promptTokenCount: 150,
          cachedContentTokenCount: 100,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 5,
          totalTokenCount: 175,
        },
      },
    ],
  ]);
  const text = [];
  const reasoning = [];
  const resets = [];
  const result = await provider.send(HELLO, 'gemini-4-argon', [], {
    onTextDelta: (d) => text.push(d),
    onReasoningDelta: (d) => reasoning.push(d),
    onTextReset: (d) => resets.push(d),
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.continuationToken, undefined);
  assert.equal(requests[1].body.continuationToken, 'dG9rZW4x');
  // The same request is resent: only the token differs.
  const { continuationToken: _token, ...resent } = requests[1].body;
  assert.deepEqual(resent, requests[0].body);
  assert.equal(result.content, 'Part one, part two.');
  assert.deepEqual(text, ['Part one, ', 'part two.']);
  assert.deepEqual(reasoning, ['think 1', 'think 2']);
  assert.deepEqual(resets, []);
  // Every hop is billed: usage is summed; the first hop's prompt is the context.
  assert.equal(result.usage.inputTokens, 250);
  assert.equal(result.usage.outputTokens, 75);
  assert.equal(result.usage.raw.totalTokenCount, 325);
  assert.equal(result.usage.raw.initialPromptTokenCount, 100);
  // Billing keeps the summed prompt; the context measurement excludes the repeated hop input.
  assert.equal(result.usage.promptTokens, 250);
  assert.equal(result.usage.contextInputTokens, 100);
  // Cached reads repeat across hops the same way: the context holds the first hop's.
  assert.equal(result.usage.cachedTokens, 160);
  assert.equal(result.usage.contextCachedTokens, 60);
});

test('a later hop that fails carries the earlier hops’ output and replay boundary on the error', async () => {
  const hop1 = [
    chunkOf([{ text: 'plan', thought: true, thoughtSignature: 'sig1' }, { text: 'FIRST' }]),
    chunkOf([], { finishReason: 'CONTINUATION', continuationToken: 't' }),
  ];
  for (const [label, hop2, failingText] of [
    ['visible failing hop', [chunkOf([{ text: 'SECOND' }])], 'SECOND'],
    ['silent failing hop', [chunkOf([{ text: 'more', thought: true, thoughtSignature: 'sig2' }])], ''],
  ]) {
    const { provider } = restProvider([hop1, hop2]);
    await assert.rejects(provider.send(HELLO, 'gemini-4-argon', [], { onTextDelta: () => {} }), (error) => {
      assert.equal(error.code, 'TRUNCATED_STREAM', label);
      assert.equal(error.partialContent, `FIRST${failingText}`, label);
      assert.equal(error.liveTextEmitted, true, label);
      assert.equal(error.unsafeToRetry, true, label);
      assert.equal(error.streamStalled, true, label);
      const thoughts = error.providerMetadata.gemini.thoughtParts.map((part) => part.thoughtSignature);
      assert.deepEqual(thoughts, failingText ? ['sig1'] : ['sig1', 'sig2'], label);
      return true;
    });
  }
});

test('continuation stops when the caller aborts between hops', async () => {
  const controller = new AbortController();
  const { provider, requests } = restProvider([
    [chunkOf([{ text: 'Part one' }], { finishReason: 'CONTINUATION', continuationToken: 't' })],
  ]);
  await assert.rejects(
    provider.send(HELLO, 'gemini-4-argon', [], {
      signal: controller.signal,
      onTextDelta: () => controller.abort(new Error('closed')),
    }),
    /closed/
  );
  assert.equal(requests.length, 1);
});

test('continuation is bounded', async () => {
  const { provider, requests } = restProvider([
    [chunkOf([{ text: 'x' }], { finishReason: 'CONTINUATION', continuationToken: 't' })],
  ]);
  await assert.rejects(provider.send(HELLO, 'gemini-4-argon', [], {}), (error) => {
    assert.equal(error.code, 'CONTINUATION_LIMIT');
    return true;
  });
  assert.equal(requests.length, 32);
});

// ── 3. Gemini 2.5 redirect ──
const DEC_1_2026 = Date.parse('2026-12-01T00:00:00Z');
const ok = () => [[chunkOf([{ text: 'ok' }], { finishReason: 'STOP' })]];

test('from 2026-12-01 gemini-2.5-pro/flash resolve to their redirect targets, with one notice', async () => {
  for (const [from, to] of [
    ['gemini-2.5-pro', 'gemini-3.8-flash'],
    ['models/gemini-2.5-flash', 'gemini-3.5-flash-lite'],
  ]) {
    const { provider, requests } = restProvider(ok(), { nowFn: () => DEC_1_2026 });
    const notices = [];
    const onStageChange = (stage, detail) => stage === 'notice' && notices.push(detail);
    const first = await provider.send(HELLO, from, [], { effort: 'high', temperature: 0.2, onStageChange });
    await provider.send(HELLO, from, [], { effort: 'high', onStageChange });
    assert.match(requests[0].url, new RegExp(`/models/${to.replace(/\./g, '\\.')}:streamGenerateContent`));
    const config = requests[0].body.generationConfig;
    assert.equal(config.thinkingConfig.thinkingLevel, 'high');
    assert.equal('thinkingBudget' in config.thinkingConfig, false);
    assert.equal('temperature' in config, false);
    assert.equal(first.model, to);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, new RegExp(`${from.replace(/^models\//, '')}.*${to}`));
  }
});

test('before 2026-12-01 gemini-2.5 requests are unchanged', async () => {
  const { provider, requests } = restProvider(ok(), { nowFn: () => DEC_1_2026 - 1 });
  const notices = [];
  const result = await provider.send(HELLO, 'gemini-2.5-pro', [], {
    effort: 'high',
    onStageChange: (stage, detail) => stage === 'notice' && notices.push(detail),
  });
  assert.match(requests[0].url, /\/models\/gemini-2\.5-pro:streamGenerateContent/);
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingBudget, 32768);
  assert.equal(result.model, 'gemini-2.5-pro');
  assert.deepEqual(notices, []);
  // gemini-2.5-flash-lite is not redirected.
  const lite = restProvider(ok(), { nowFn: () => DEC_1_2026 });
  await lite.provider.send(HELLO, 'gemini-2.5-flash-lite', [], {});
  assert.match(lite.requests[0].url, /\/models\/gemini-2\.5-flash-lite:streamGenerateContent/);
});

// ── 4. API key header ──
test('the API key travels only in x-goog-api-key, never in a URL', async () => {
  const seen = [];
  const record =
    (body) =>
    async (url, init = {}) => {
      seen.push({ url: String(url), headers: { ...init.headers } });
      return typeof body === 'function' ? body() : new Response(JSON.stringify(body));
    };
  const stream = restProvider(ok());
  await stream.provider.send(HELLO, 'gemini-3.8-flash', [], {});
  seen.push(...stream.requests);

  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    fetchFn: record({ name: 'cachedContents/new', candidates: [] }),
  });
  await provider._restGenerateContent('gemini-3.8-flash', 'fixture-key', { contents: [] }, null);
  await provider._createGeminiCache({
    apiKey: 'fixture-key',
    model: 'gemini-3.1-pro-preview',
    ttlSeconds: 60,
    request: { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
    prefix: { cachePrefixContentCount: 1, cachePrefixHash: 'h' },
    globalCacheKey: 'api-update-test',
    credentialFingerprint: 'fp',
    priorCacheName: null,
    canAttachState: false,
    opts: {},
    currentIter: 1,
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    provider._scheduleGeminiCacheDelete('cachedContents/old', 'fixture-key');
    mock.timers.runAll();
  } finally {
    mock.timers.reset();
  }
  assert.equal(await provider.isAvailable(), true);
  await fetchGeminiModelPages('fixture-key', record({ models: [] }));

  assert.equal(seen.length, 6);
  for (const { url, headers } of seen) {
    assert.doesNotMatch(url, /fixture-key|[?&]key=/, url);
    assert.equal(headers['x-goog-api-key'], 'fixture-key', url);
  }
});

// ── 5. Deprecated sampling parameters ──
test('temperature is not sent to models that ignore it, and still sent to models that honour it', async () => {
  for (const model of ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']) {
    const { provider, requests } = restProvider(ok());
    await provider.send(HELLO, model, [], { temperature: 0.3 });
    assert.equal('temperature' in (requests[0].body.generationConfig || {}), false, model);
  }
  for (const model of ['gemini-3.1-pro-preview', 'gemini-2.5-flash-lite']) {
    const { provider, requests } = restProvider(ok());
    await provider.send(HELLO, model, [], { temperature: 0.3 });
    assert.equal(requests[0].body.generationConfig.temperature, 0.3, model);
  }
  // The shared builder other routes use keeps its behaviour.
  assert.equal(buildGeminiRequest(HELLO, 'gemini-4-argon', [], { temperature: 0.3 }).generationConfig.temperature, 0.3);
});
