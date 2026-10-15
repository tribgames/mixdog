import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CUSTOM_PROVIDER_SCHEMA_VERSION,
  CUSTOM_REASONING_LEVELS,
  createCustomProvider,
  effectiveCustomModelRows,
  normalizeCustomProviderConfig,
} from './custom-provider.mjs';
import { initProviders, getProvider, getProviderInitErrors, providerInputExcludesCache } from './registry.mjs';
import { mergeStoredProviders } from '../config-providers-merge.mjs';

// Hermetic catalog: remote catalog fetches 404 in every mock below and fall
// back to this disk copy (models.dev is keyed by provider id).
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-custom-provider-'));
process.env.MIXDOG_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));
writeFileSync(
  join(dataDir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      'custom-ant-enrich': {
        models: {
          'ant-reason': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['high', 'low', 'ultra', 'bogus'] }],
            interleaved: { field: 'reasoning_content' },
            limit: { context: 77000, output: 7000 },
            tool_call: true,
          },
        },
      },
      // A first-party vendor row: custom endpoints serving this id match it by bare id.
      openai: {
        models: {
          'gpt-fixture-1': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            limit: { context: 123000, output: 4000 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    },
  })
);

async function withFetch(handler, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.startsWith('https://llm.example.com') && !href.startsWith('https://gw.example.com'))
      return new Response('{}', { status: 404 });
    return handler(href, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const prompt = [{ role: 'user', content: 'hello' }];
const tools = [
  { name: 'lookup', description: 'look', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
];
const base = { type: 'custom', name: 'Mine', baseURL: 'https://llm.example.com/v1', enabled: true };

function sse(events) {
  const body = events.map((e) => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function mock(provider, respond) {
  const requests = [];
  provider.client.fetch = async (url, init) => {
    requests.push({ url: new URL(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return respond(requests.at(-1));
  };
  return requests;
}

const CHAT = [
  {
    id: 'c1',
    model: 'm1',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  },
];
const RESPONSES = [
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'm1',
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', status: 'completed' },
      ],
    },
  },
];
const ANTHROPIC = [
  { type: 'message_start', message: { id: 'msg_1', model: 'm1', role: 'assistant', usage: { input_tokens: 1 } } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

test('legacy config migrates to v2 deterministically and idempotently', () => {
  assert.equal(CUSTOM_PROVIDER_SCHEMA_VERSION, 2);
  assert.deepEqual(CUSTOM_REASONING_LEVELS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const legacy = {
    ...base,
    id: 'x',
    apiKey: 'secret',
    protocol: 'openai-chat',
    baseURL: ' https://llm.example.com/v1/ ',
    models: [{ id: 'm1', name: 'M', contextWindow: '1000', maxOutputTokens: 50, extra: 1 }, { id: ' m2 ' }],
  };
  const out = normalizeCustomProviderConfig(legacy);
  assert.deepEqual(out, {
    type: 'custom',
    schemaVersion: 2,
    name: 'Mine',
    protocol: 'openai-chat',
    baseURL: 'https://llm.example.com/v1',
    enabled: true,
    auth: 'key',
    discovery: { newModelsHidden: true },
    modelOverrides: {
      m1: { manual: true, hidden: false, name: 'M', contextWindow: 1000, maxOutputTokens: 50 },
      m2: { manual: true, hidden: false },
    },
  });
  assert.deepEqual(normalizeCustomProviderConfig(out), out);
  assert.deepEqual(normalizeCustomProviderConfig(legacy), out);
  const empty = normalizeCustomProviderConfig({ ...base, protocol: 'anthropic' });
  assert.deepEqual(empty.discovery, { newModelsHidden: false });
  assert.deepEqual(empty.modelOverrides, {});
  assert.throws(() => normalizeCustomProviderConfig({ ...out, schemaVersion: 3 }), /unsupported schemaVersion 3/);
  assert.throws(() => normalizeCustomProviderConfig({ ...out, schemaVersion: 1 }), /invalid schemaVersion/);
});

test('v2 validation rejects invalid overrides and canonicalizes levels', () => {
  const v2 = { ...base, schemaVersion: 2, protocol: 'openai-chat' };
  const ok = normalizeCustomProviderConfig({
    ...v2,
    auth: 'none',
    discovery: { newModelsHidden: false },
    modelOverrides: {
      r1: {
        hidden: true,
        reasoning: {
          levels: ['ultra', 'low', 'none'],
          wireFormat: 'deepseek',
          wireValues: { ultra: 'max', low: 'l' },
          replay: false,
        },
      },
      r2: { reasoning: { levels: [] } },
    },
  });
  assert.equal(ok.auth, 'none');
  assert.deepEqual(ok.modelOverrides, {
    r1: {
      hidden: true,
      reasoning: {
        levels: ['none', 'low', 'max'],
        wireFormat: 'deepseek',
        wireValues: { low: 'l', max: 'max' },
        replay: false,
      },
    },
    r2: { reasoning: { levels: [] } },
  });
  assert.deepEqual(normalizeCustomProviderConfig(ok), ok);
  const bad = (patch, re) => assert.throws(() => normalizeCustomProviderConfig({ ...v2, ...patch }), re);
  const ov = (override, extra = {}) => bad({ modelOverrides: { m: override }, ...extra });
  // v2 rejects unknown fields, numeric strings and unsafe integers.
  ov({ extra: 1 }, /unsupported field/);
  ov({ reasoning: { levels: [], extra: 1 } }, /unsupported field/);
  // Level entries must be strings: nested arrays and other non-strings never coerce.
  for (const entry of [['low'], 1, null, { toString: () => 'low' }]) {
    ov({ reasoning: { levels: [entry] } }, /unknown level/);
  }
  bad({ discovery: { newModelsHidden: false, extra: 1 } }, /unsupported field/);
  ov({ contextWindow: '1000' }, /positive integer/);
  ov({ maxOutputTokens: 2 ** 60 }, /positive integer/);
  ov({ reasoning: { levels: ['huge'] } });
  ov({ reasoning: { levels: ['max', 'ultra'] } });
  ov({ reasoning: { levels: 'high' } });
  ov({ reasoning: { levels: ['low'], wireValues: { high: 'h' } } });
  ov({ reasoning: { wireValues: { bogus: 'x' } } });
  ov({ reasoning: { wireValues: { low: ' ' } } });
  ov({ reasoning: { wireValues: { low: 'x'.repeat(65) } } });
  ov({ reasoning: { wireFormat: 'other' } });
  ov({ reasoning: { replay: 'yes' } });
  ov({ reasoning: { wireFormat: 'deepseek' } }, { protocol: 'openai-responses' });
  ov({ reasoning: { wireFormat: 'deepseek' } }, { protocol: 'anthropic' });
  ov({ hidden: 'no' });
  ov({ manual: 1 });
  ov({ name: 5 });
  ov({ name: 'x'.repeat(201) });
  ov({ contextWindow: 0 });
  ov({ maxOutputTokens: 1.5 });
  ov([]);
  bad({ modelOverrides: JSON.parse('{"__proto__":{}}') }, /unsafe/);
  bad({ modelOverrides: { constructor: {} } }, /unsafe/);
  bad({ modelOverrides: { prototype: {} } }, /unsafe/);
  bad({ modelOverrides: { ' m': {} } });
  bad({ modelOverrides: { [`m${'x'.repeat(256)}`]: {} } });
  bad({ modelOverrides: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`m${i}`, {}])) }, /at most 500/);
  bad({ modelOverrides: [] });
  bad({ auth: 'token' });
  bad({ discovery: { newModelsHidden: 'yes' } });
  bad({ discovery: [] });
  bad({ name: 'x'.repeat(201) });
});

test('layering: discovery base, overrides by presence, manual append, hidden retained', () => {
  const config = normalizeCustomProviderConfig({
    ...base,
    schemaVersion: 2,
    protocol: 'openai-chat',
    discovery: { newModelsHidden: true },
    modelOverrides: {
      d1: {
        name: 'Renamed',
        contextWindow: 9000,
        reasoning: { wireFormat: 'deepseek', wireValues: { high: 'max-ish', low: 'l' } },
      },
      d2: { hidden: false, reasoning: { levels: [], replay: false } },
      d3: { reasoning: { levels: ['medium'] } },
      gone: { name: 'Not manual' },
      man: { manual: true, maxOutputTokens: 321, reasoning: { levels: ['low', 'high'], replay: true } },
      hid: { manual: true, hidden: true },
    },
  });
  const discovered = [
    {
      id: 'd1',
      name: 'd1',
      provider: 'p',
      contextWindow: 100,
      outputTokens: 10,
      supportsReasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['high', 'ultra'] }],
      reasoningContentField: 'reasoning_content',
      pricingSource: 'litellm',
    },
    {
      id: 'd2',
      provider: 'p',
      contextWindow: null,
      supportsReasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low'] }],
      reasoningContentField: 'reasoning_content',
    },
    { id: 'd3', provider: 'p', contextWindow: 5, reasoningContentField: 'thinking' },
    { id: 'd4', provider: 'p', contextWindow: 5, supportsReasoning: true, reasoningOptions: [] },
    { id: 'd1', provider: 'p', contextWindow: 1 },
  ];
  const rows = effectiveCustomModelRows(config, discovered, { providerId: 'custom-x' });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['d1', 'd2', 'd3', 'd4', 'man', 'hid']
  );
  const [d1, d2, d3, d4, man, hid] = rows;
  assert.deepEqual(d1, {
    id: 'd1',
    name: 'Renamed',
    provider: 'custom-x',
    contextWindow: 9000,
    outputTokens: 10,
    pricingSource: 'litellm',
    hidden: false,
    manual: false,
    supportsReasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['high', 'max'] }],
    reasoningLevels: ['high', 'max'],
    customReasoning: { wireFormat: 'deepseek', wireValues: { high: 'max-ish' }, replay: true },
    reasoningContentField: 'reasoning_content',
  });
  // Explicit [] and false are values, not "inherit".
  assert.equal(d2.supportsReasoning, false);
  assert.deepEqual(d2.reasoningLevels, []);
  assert.deepEqual(d2.reasoningOptions, []);
  assert.equal(d2.customReasoning.replay, false);
  assert.equal('reasoningContentField' in d2, false);
  assert.equal(d2.contextWindow, 0);
  assert.equal(d2.hidden, false);
  // Override without `hidden` keeps the model visible; catalog field other than reasoning_content → no replay.
  assert.equal(d3.hidden, false);
  assert.deepEqual(d3.reasoningLevels, ['medium']);
  assert.deepEqual(d3.customReasoning, { wireFormat: 'standard', wireValues: {}, replay: false });
  assert.equal('reasoningContentField' in d3, false);
  // Unknown levels: no reasoning option fields; new discovered models hidden.
  assert.equal(d4.hidden, true);
  assert.equal(d4.manual, false);
  assert.equal(d4.supportsReasoning, true);
  assert.equal('reasoningOptions' in d4, false);
  assert.equal('reasoningLevels' in d4, false);
  assert.deepEqual(man, {
    id: 'man',
    name: 'man',
    provider: 'custom-x',
    contextWindow: 0,
    outputTokens: 321,
    hidden: false,
    manual: true,
    supportsReasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    reasoningLevels: ['low', 'high'],
    customReasoning: { wireFormat: 'standard', wireValues: {}, replay: true },
    reasoningContentField: 'reasoning_content',
  });
  assert.equal(hid.hidden, true);
  assert.equal(hid.manual, true);
  // Without newModelsHidden discovered rows stay visible.
  const visible = effectiveCustomModelRows({ ...config, discovery: { newModelsHidden: false } }, discovered, {
    providerId: 'custom-x',
  });
  assert.equal(visible.find((r) => r.id === 'd4').hidden, false);
});

test('normalizer validates connection fields', () => {
  const bad = (patch, opts) =>
    assert.throws(() =>
      normalizeCustomProviderConfig({ ...base, protocol: 'anthropic', models: [{ id: 'a' }], ...patch }, opts)
    );
  bad({ protocol: 'grpc' });
  bad({ protocol: '' });
  bad({ name: ' ' });
  bad({ baseURL: '' });
  bad({ baseURL: 'ftp://x.com' });
  bad({ baseURL: 'https://u:p@x.com/v1' });
  bad({ baseURL: 'https://x.com/v1?k=1' });
  bad({ baseURL: 'https://x.com/v1#h' });
  bad({ baseURL: 'http://public.example/v1' });
  for (const baseURL of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
    assert.equal(normalizeCustomProviderConfig({ ...base, protocol: 'anthropic', baseURL }).baseURL, baseURL);
  }
  bad({ models: 'm1' });
  bad({ models: [{ id: 'a' }, { id: 'a' }] });
  bad({ models: [{ id: 'a', contextWindow: -1 }] });
  bad({ models: [{ id: '__proto__' }] });
  bad({ models: [{}] });
});

test('apiKeyEnv: normalize accept/reject, env-only key, missing-variable error', async () => {
  const cfg = { ...base, schemaVersion: 2, protocol: 'openai-chat' };
  assert.equal(normalizeCustomProviderConfig({ ...cfg, apiKeyEnv: 'MY_KEY_1' }).apiKeyEnv, 'MY_KEY_1');
  assert.equal('apiKeyEnv' in normalizeCustomProviderConfig({ ...cfg, apiKeyEnv: null }), false);
  assert.equal('apiKeyEnv' in normalizeCustomProviderConfig({ ...cfg, auth: 'none', apiKeyEnv: 'MY_KEY_1' }), false);
  for (const bad of ['1ABC', 'a-b', '', 'a b', 'A'.repeat(129), 5])
    assert.throws(() => normalizeCustomProviderConfig({ ...cfg, apiKeyEnv: bad }), /apiKeyEnv/);

  const NAME = 'MIXDOG_TEST_PROVIDER_KEY';
  const id = 'custom-env-1';
  delete process.env[NAME];
  const p = await createCustomProvider(id, { ...cfg, apiKey: 'typed-ignored', apiKeyEnv: NAME });
  let fetched = 0;
  await withFetch(
    () => {
      fetched++;
      return new Response('{}', { status: 500 });
    },
    async () => {
      await assert.rejects(p.send(prompt, 'm', []), new Error(`API key environment variable ${NAME} is not set`));
      await assert.rejects(p.listModels({ throwOnError: true }), new RegExp(`${NAME} is not set`));
    }
  );
  assert.equal(fetched, 0);
  process.env[NAME] = 'env-secret';
  try {
    const q = await createCustomProvider(id, { ...cfg, apiKeyEnv: NAME, modelOverrides: { m: { manual: true } } });
    const requests = mock(q, () => sse(CHAT));
    await q.send(prompt, 'm', []);
    assert.equal(requests[0].headers.get('authorization'), 'Bearer env-secret');
    // The merge overlay takes the env var only, never a keychain/plaintext key.
    const merged = mergeStoredProviders({
      raw: { providers: { [id]: { ...cfg, apiKey: 'plain', apiKeyEnv: NAME } } },
      defaults: {},
      includeSecrets: true,
    });
    assert.equal(merged[id].apiKey, 'env-secret');
  } finally {
    delete process.env[NAME];
  }
});

for (const [protocol, events] of [
  ['openai-chat', CHAT],
  ['openai-responses', RESPONSES],
  ['anthropic', ANTHROPIC],
]) {
  test(`apiKeyEnv: 401 reload re-checks the variable (${protocol})`, async () => {
    const NAME = 'MIXDOG_TEST_RELOAD_KEY';
    const cfg = {
      ...base,
      schemaVersion: 2,
      protocol,
      apiKeyEnv: NAME,
      modelOverrides: { m1: { manual: true } },
    };
    const keyOf = (init) => {
      const h = new Headers(init.headers);
      return h.get('x-api-key') || h.get('authorization');
    };
    const run = async (afterFirst) => {
      process.env[NAME] = 'old-key';
      const seen = [];
      try {
        return await withFetch(
          (href, init) => {
            if (href.endsWith('/models')) return new Response('{"data":[]}', { status: 200 });
            seen.push(keyOf(init));
            if (seen.length === 1) {
              afterFirst();
              return new Response('{"error":{"message":"bad key"}}', { status: 401 });
            }
            return sse(events);
          },
          async () => {
            const p = await createCustomProvider('custom-reload-1', cfg);
            const result = await p.send(prompt, 'm1', []).then(
              () => null,
              (error) => error
            );
            return { result, seen };
          }
        );
      } finally {
        delete process.env[NAME];
      }
    };
    const unset = await run(() => delete process.env[NAME]);
    assert.equal(unset.result?.message, `API key environment variable ${NAME} is not set`);
    assert.equal(unset.seen.length, 1);
    assert.match(unset.seen[0], /old-key/);
    const rotated = await run(() => {
      process.env[NAME] = 'new-key';
    });
    assert.equal(rotated.result, null);
    assert.equal(rotated.seen.length, 2);
    assert.match(rotated.seen[1], /new-key/);
  });
}

test('openai-chat: path, bearer auth, tool calls, configured models, custom identity', async () => {
  const id = 'custom-chat-1';
  const p = await createCustomProvider(id, {
    ...base,
    protocol: 'openai-chat',
    apiKey: 'sk-chat',
    preconnect: false,
    models: [{ id: 'm1', name: 'Model One', contextWindow: 5000, maxOutputTokens: 700 }],
  });
  assert.equal(p.name, id);
  const requests = mock(p, () => sse(CHAT));
  const res = await p.send(prompt, 'm1', tools, {});
  assert.equal(requests[0].url.pathname, '/v1/chat/completions');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer sk-chat');
  assert.equal(requests[0].body.model, 'm1');
  assert.equal(res.toolCalls[0].name, 'lookup');
  assert.deepEqual(res.toolCalls[0].arguments, { q: 'x' });
  assert.equal(p.defaultModel, 'm1');
  assert.equal(p.customConfig.schemaVersion, 2);
  assert.equal(p.getCachedModelInfo('m1').contextWindow, 5000);
  const models = await withFetch(
    () => Response.json({ data: [{ id: 'extra' }] }),
    () => p.listModels()
  );
  assert.deepEqual(models, [
    {
      id: 'extra',
      name: 'extra',
      provider: id,
      contextWindow: 0,
      outputTokens: null,
      created: null,
      hidden: true,
      manual: false,
      supportsReasoning: false,
      customReasoning: { wireFormat: 'standard', wireValues: {}, replay: false },
    },
    {
      id: 'm1',
      name: 'Model One',
      provider: id,
      contextWindow: 5000,
      outputTokens: 700,
      hidden: false,
      manual: true,
      supportsReasoning: false,
      customReasoning: { wireFormat: 'standard', wireValues: {}, replay: false },
    },
  ]);
  // Hidden rows stay in metadata; the default stays on the first visible row.
  assert.equal(p.getCachedModelInfo('extra').hidden, true);
  assert.equal(p.defaultModel, 'm1');
  assert.equal(await p.isAvailable(), true);
  assert.equal(providerInputExcludesCache(id), false);
});

test('openai-chat: discovery, failure retention, throwOnError and sanitized error', async () => {
  const p = await createCustomProvider('custom-chat-2', {
    ...base,
    protocol: 'openai-chat',
    apiKey: 'k-secret',
    preconnect: false,
  });
  const calls = [];
  await withFetch(
    (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return Response.json({ data: [{ id: 'found-1' }] });
    },
    async () => {
      const models = await p.listModels();
      assert.equal(calls[0].url, 'https://llm.example.com/v1/models');
      assert.equal(calls[0].auth, 'Bearer k-secret');
      assert.equal(models[0].id, 'found-1');
      assert.equal(models[0].provider, 'custom-chat-2');
      assert.equal(models[0].hidden, false);
      assert.equal(p.defaultModel, 'found-1');
      assert.equal(p.customDiscoveryError, null);
    }
  );
  await withFetch(
    () => new Response('denied', { status: 401 }),
    async () => {
      const kept = await p.listModels();
      assert.deepEqual(
        kept.map((m) => m.id),
        ['found-1']
      );
      assert.equal(p.customDiscoveryError.status, 401);
      assert.match(p.customDiscoveryError.message, /models 401/);
      await assert.rejects(p.listModels({ throwOnError: true }), /models 401/);
      assert.equal(p.getCachedModelInfo('found-1').id, 'found-1');
    }
  );
  // Nothing usable → the sanitized error is thrown.
  const q = await createCustomProvider('custom-chat-3', {
    ...base,
    protocol: 'openai-chat',
    apiKey: 'k-secret',
    preconnect: false,
  });
  await withFetch(
    () => {
      throw new Error('upstream rejected key k-secret');
    },
    async () => {
      await assert.rejects(q.listModels(), (error) => {
        assert.equal(error.message.includes('k-secret'), false);
        assert.match(error.message, /\[redacted\]/);
        return true;
      });
    }
  );
  // Manual rows survive a failed discovery without throwing.
  const r = await createCustomProvider('custom-chat-4', {
    ...base,
    schemaVersion: 2,
    protocol: 'openai-chat',
    apiKey: 'k',
    preconnect: false,
    modelOverrides: { man: { manual: true } },
  });
  await withFetch(
    () => new Response('down', { status: 503 }),
    async () => {
      assert.deepEqual(
        (await r.listModels()).map((m) => m.id),
        ['man']
      );
      assert.equal(r.customDiscoveryError.status, 503);
    }
  );
});

test('openai-chat: keyless discovery sends no Authorization and honours abort', async () => {
  const p = await createCustomProvider('custom-chat-none', {
    ...base,
    schemaVersion: 2,
    protocol: 'openai-chat',
    auth: 'none',
    preconnect: false,
  });
  const seen = [];
  await withFetch(
    (_url, init) => {
      seen.push(new Headers(init.headers));
      if (init.signal?.aborted) throw init.signal.reason;
      return Response.json({ data: [{ id: 'local-1' }] });
    },
    async () => {
      assert.deepEqual(
        (await p.listModels()).map((m) => m.id),
        ['local-1']
      );
      assert.equal(seen[0].has('authorization'), false);
      const controller = new AbortController();
      controller.abort(new Error('cancelled by caller'));
      await assert.rejects(p.listModels({ signal: controller.signal }), /cancelled by caller/);
    }
  );
});

test('openai-responses: generic /responses path, bearer auth, tool calls', async () => {
  const id = 'custom-resp-1';
  const p = await createCustomProvider(id, {
    ...base,
    protocol: 'openai-responses',
    apiKey: 'sk-resp',
    preconnect: false,
    models: [{ id: 'm1' }],
  });
  const requests = mock(p, () => sse(RESPONSES));
  const res = await p.send(prompt, 'm1', tools, {});
  assert.equal(requests[0].url.pathname, '/v1/responses');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer sk-resp');
  assert.equal(requests[0].body.model, 'm1');
  assert.equal(requests[0].body.tools[0].name, 'lookup');
  assert.equal(requests[0].body.stream, true);
  assert.equal(res.toolCalls[0].name, 'lookup');
  assert.deepEqual(res.toolCalls[0].arguments, { q: 'x' });
  assert.equal(p.defaultModel, 'm1');
});

test('anthropic: /v1 base maps to /v1/messages, x-api-key auth, tool use, models', async () => {
  const id = 'custom-ant-1';
  const p = await createCustomProvider(id, {
    ...base,
    protocol: 'anthropic',
    apiKey: 'sk-ant',
    models: [{ id: 'm1', name: 'Claude-ish', contextWindow: 9000 }],
  });
  const requests = mock(p, () => sse(ANTHROPIC));
  const res = await p.send(prompt, 'm1', tools, {});
  assert.equal(requests[0].url.pathname, '/v1/messages');
  assert.equal(requests[0].headers.get('x-api-key'), 'sk-ant');
  assert.equal(requests[0].body.model, 'm1');
  assert.equal(res.toolCalls[0].name, 'lookup');
  assert.deepEqual(res.toolCalls[0].arguments, { q: 'x' });
  assert.equal(p.defaultModel, 'm1');
  const listed = await withFetch(
    () => Response.json({ data: [] }),
    () => p.listModels()
  );
  assert.deepEqual(
    listed.map((m) => [m.id, m.provider, m.contextWindow]),
    [['m1', id, 9000]]
  );
  assert.equal(p.constructor.inputExcludesCache, true);
  // base without /v1 yields the same path
  const q = await createCustomProvider(id, {
    ...base,
    baseURL: 'https://gw.example.com/anthropic',
    protocol: 'anthropic',
    apiKey: 'k',
  });
  const r2 = mock(q, () => sse(ANTHROPIC));
  await q.send(prompt, 'm1', [], {});
  assert.equal(r2[0].url.pathname, '/anthropic/v1/messages');
});

test('anthropic: empty models discover from /v1/models without built-in fallback', async () => {
  const p = await createCustomProvider('custom-ant-2', { ...base, protocol: 'anthropic', apiKey: 'k' });
  const calls = [];
  await withFetch(
    (url, init) => {
      calls.push({ url, key: init.headers['x-api-key'] });
      return Response.json({ data: [{ id: 'ant-found', display_name: 'Found' }] });
    },
    async () => {
      const models = await p.listModels();
      assert.equal(calls[0].url, 'https://llm.example.com/v1/models');
      assert.equal(calls[0].key, 'k');
      assert.deepEqual(
        models.map((m) => [m.id, m.name, m.provider]),
        [['ant-found', 'Found', 'custom-ant-2']]
      );
      assert.equal(p.defaultModel, 'ant-found');
    }
  );
  await withFetch(
    () => new Response('no', { status: 500 }),
    async () => {
      assert.deepEqual(
        (await p.listModels()).map((m) => m.id),
        ['ant-found']
      );
      await assert.rejects(p.listModels({ throwOnError: true }), /models 500/);
    }
  );
  const q = await createCustomProvider('custom-ant-3', { ...base, protocol: 'anthropic', apiKey: 'k' });
  await withFetch(
    () => new Response('no', { status: 500 }),
    () => assert.rejects(q.listModels(), /models 500/)
  );
});

test('anthropic: discovery built without a config key sends the stored key', async () => {
  const id = 'custom-ant-stored';
  const envKey = `MIXDOG_AGENT_${id.toUpperCase().replace(/[.\s]+/g, '_')}_APIKEY`;
  const p = await createCustomProvider(id, { ...base, protocol: 'anthropic' });
  process.env[envKey] = 'stored-ant';
  try {
    const calls = [];
    await withFetch(
      (_url, init) => {
        calls.push(init.headers);
        return Response.json({ data: [{ id: 'ant-stored' }] });
      },
      () => p.listModels()
    );
    assert.equal(calls[0]['x-api-key'], 'stored-ant');
  } finally {
    delete process.env[envKey];
  }
});

test('anthropic: discovered rows are catalog-enriched; keyless sends no x-api-key', async () => {
  const p = await createCustomProvider('custom-ant-enrich', {
    ...base,
    schemaVersion: 2,
    protocol: 'anthropic',
    auth: 'none',
  });
  assert.equal(await p.isAvailable(), true);
  const calls = [];
  await withFetch(
    (_url, init) => {
      calls.push(init.headers);
      return Response.json({ data: [{ id: 'ant-reason' }] });
    },
    async () => {
      const [row] = await p.listModels();
      assert.equal('x-api-key' in calls[0], false);
      assert.equal(row.contextWindow, 77000);
      assert.equal(row.outputTokens, 7000);
      assert.equal(row.supportsReasoning, true);
      assert.deepEqual(row.reasoningLevels, ['low', 'high', 'max']);
      assert.deepEqual(row.reasoningOptions, [{ type: 'effort', values: ['low', 'high', 'max'] }]);
      assert.deepEqual(row.customReasoning, { wireFormat: 'standard', wireValues: {}, replay: true });
      assert.equal(row.reasoningContentField, 'reasoning_content');
      assert.equal(p.getCachedModelInfo('ant-reason').reasoningContentField, 'reasoning_content');
    }
  );
});

test('registry instantiates custom providers without presets and reports invalid entries', async () => {
  const id = 'custom-reg-1';
  await initProviders({
    [id]: { ...base, protocol: 'openai-chat', apiKey: 'k', preconnect: false, models: [{ id: 'm1' }] },
  });
  const p = getProvider(id);
  assert.ok(p);
  assert.equal(p.name, id);
  const listed = await withFetch(
    () => Response.json({ data: [] }),
    () => p.listModels()
  );
  assert.equal(listed[0].provider, id);
  // Only an invalid custom provider: nothing usable, the live registry is kept
  // and the reason is recorded.
  await assert.rejects(
    initProviders({ 'custom-bad': { ...base, protocol: 'nope', apiKey: 'k', models: [{ id: 'm1' }] } }),
    /all providers disabled/
  );
  assert.match(getProviderInitErrors().get('custom-bad'), /unsupported protocol/);
  assert.ok(getProvider(id));
});

test('one invalid custom provider is isolated: valid custom and first-party providers still load', async () => {
  const good = 'custom-iso-good';
  const bad = 'custom-iso-bad';
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await initProviders({
      'mixdog-local': { enabled: true },
      [good]: {
        ...base,
        schemaVersion: 2,
        protocol: 'openai-chat',
        auth: 'none',
        preconnect: false,
        modelOverrides: { m1: { manual: true, reasoning: { levels: ['low'] } } },
      },
      // Invalid override: the whole provider is skipped, never loaded minus the bad override.
      [bad]: {
        ...base,
        schemaVersion: 2,
        protocol: 'openai-chat',
        auth: 'none',
        preconnect: false,
        modelOverrides: { ok: { manual: true }, broken: { contextWindow: '4096' } },
      },
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(getProvider('mixdog-local')?.name, 'mixdog-local');
  assert.equal(getProvider(good)?.name, good);
  assert.equal(getProvider(bad), undefined);
  assert.deepEqual([...getProviderInitErrors().keys()], [bad]);
  assert.match(getProviderInitErrors().get(bad), /modelOverrides\[broken\]\.contextWindow/);
  assert.ok(stderr.some((line) => line.includes(bad) && line.includes('skipped')));
  // Fixing it on the next init loads it and clears the error.
  await initProviders({
    'mixdog-local': { enabled: true },
    [good]: {
      ...base,
      schemaVersion: 2,
      protocol: 'openai-chat',
      auth: 'none',
      preconnect: false,
      modelOverrides: { m1: { manual: true, reasoning: { levels: ['low'] } } },
    },
    [bad]: {
      ...base,
      schemaVersion: 2,
      protocol: 'openai-chat',
      auth: 'none',
      preconnect: false,
      modelOverrides: { ok: { manual: true }, broken: { contextWindow: 4096 } },
    },
  });
  assert.equal(getProvider(bad)?.name, bad);
  assert.equal(getProviderInitErrors().size, 0);
});

const invalidCustom = {
  ...base,
  schemaVersion: 2,
  protocol: 'openai-chat',
  auth: 'none',
  preconnect: false,
  modelOverrides: { broken: { maxOutputTokens: 0 } },
};
const validCustom = {
  ...base,
  schemaVersion: 2,
  protocol: 'openai-chat',
  auth: 'none',
  preconnect: false,
  modelOverrides: { m1: { manual: true } },
};

test('only-invalid custom config, warm: the now-invalid live provider is removed and the reason is reported', async () => {
  const warm = 'custom-only-warm';
  await initProviders({ 'mixdog-local': { enabled: true }, [warm]: validCustom });
  assert.equal(getProvider(warm)?.name, warm);
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await assert.rejects(initProviders({ 'mixdog-local': { enabled: false }, [warm]: invalidCustom }), (err) => {
      assert.equal(err.code, 'PROVIDERS_NONE_ENABLED');
      assert.match(err.message, /all providers disabled/);
      assert.match(err.message, new RegExp(`${warm}.*modelOverrides\\[broken\\]\\.maxOutputTokens`));
      return true;
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(getProvider(warm), undefined);
  // Genuinely-disabled guard semantics are unchanged: the rest of the live registry stays.
  assert.equal(getProvider('mixdog-local')?.name, 'mixdog-local');
  assert.match(getProviderInitErrors().get(warm), /maxOutputTokens/);
  // Restoring the previously applied config reloads the removed provider.
  await initProviders({ 'mixdog-local': { enabled: true }, [warm]: validCustom });
  assert.equal(getProvider(warm)?.name, warm);
  assert.equal(getProviderInitErrors().size, 0);
});

test('only-invalid custom config, cold: rejected with the reason, nothing registered under that name', async () => {
  const cold = 'custom-only-cold';
  await initProviders({ 'mixdog-local': { enabled: true } });
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await assert.rejects(
      initProviders({ [cold]: invalidCustom }),
      new RegExp(`all providers disabled.*${cold}.*maxOutputTokens`)
    );
  } finally {
    process.stderr.write = write;
  }
  assert.equal(getProvider(cold), undefined);
  assert.equal(getProvider('mixdog-local')?.name, 'mixdog-local');
  // A config with no enabled provider at all keeps the old message.
  await assert.rejects(initProviders({ 'mixdog-local': { enabled: false } }), (err) => {
    assert.equal(err.message, '[provider] all providers disabled in config — refusing to clear registry');
    return true;
  });
  assert.equal(getProvider('mixdog-local')?.name, 'mixdog-local');
});

test('legacy migration is idempotent and only emits values the v2 loader accepts', () => {
  const edges = [
    '',
    null,
    undefined,
    1,
    '1',
    '4096',
    ' 512 ',
    2 ** 53 - 1,
    2 ** 53,
    2 ** 60,
    '1e21',
    0,
    -1,
    1.5,
    'abc',
    Infinity,
    NaN,
  ];
  for (const value of edges) {
    const legacy = {
      ...base,
      protocol: 'openai-chat',
      models: [{ id: 'm', contextWindow: value, maxOutputTokens: value }],
    };
    let out;
    try {
      out = normalizeCustomProviderConfig(legacy);
    } catch {
      continue; // rejected outright: nothing emitted
    }
    assert.deepEqual(normalizeCustomProviderConfig(out), out, `idempotent for ${String(value)}`);
    const { contextWindow, maxOutputTokens } = out.modelOverrides.m;
    for (const n of [contextWindow, maxOutputTokens]) {
      if (n !== undefined) assert.ok(Number.isSafeInteger(n) && n > 0, `safe for ${String(value)}`);
    }
  }
  // Unsafe integers are dropped, not clamped.
  const unsafe = normalizeCustomProviderConfig({
    ...base,
    protocol: 'openai-chat',
    models: [{ id: 'm', contextWindow: 2 ** 60 }],
  });
  assert.deepEqual(unsafe.modelOverrides.m, { manual: true, hidden: false });
});

test('keyless sends carry no credential header on every protocol', async () => {
  const keyless = {
    ...base,
    schemaVersion: 2,
    auth: 'none',
    preconnect: false,
    modelOverrides: { m1: { manual: true } },
  };
  for (const [protocol, events] of [
    ['openai-chat', CHAT],
    ['openai-responses', RESPONSES],
    ['anthropic', ANTHROPIC],
  ]) {
    const p = await createCustomProvider(`custom-keyless-${protocol}`, { ...keyless, protocol });
    const requests = mock(p, () => sse(events));
    await p.send(prompt, 'm1', tools, {});
    assert.equal(requests[0].headers.has('authorization'), false, protocol);
    assert.equal(requests[0].headers.has('x-api-key'), false, protocol);
  }
  // auth 'none' is authoritative: a supplied key is never sent.
  for (const [protocol, events] of [
    ['openai-chat', CHAT],
    ['openai-responses', RESPONSES],
    ['anthropic', ANTHROPIC],
  ]) {
    const p = await createCustomProvider(`custom-keyless-key-${protocol}`, { ...keyless, protocol, apiKey: 'sk-leak' });
    const requests = mock(p, () => sse(events));
    await p.send(prompt, 'm1', tools, {});
    assert.equal(requests[0].headers.has('authorization'), false, protocol);
    assert.equal(requests[0].headers.has('x-api-key'), false, protocol);
    assert.equal(
      [...requests[0].headers.values()].some((v) => v.includes('sk-leak')),
      false,
      protocol
    );
  }
  // A keyed provider still authenticates.
  const keyed = await createCustomProvider('custom-keyed-chat', {
    ...keyless,
    auth: 'key',
    apiKey: 'sk-k',
    protocol: 'openai-chat',
  });
  const requests = mock(keyed, () => sse(CHAT));
  await keyed.send(prompt, 'm1', tools, {});
  assert.equal(requests[0].headers.get('authorization'), 'Bearer sk-k');
});

test('custom anthropic: no Claude-id fast mode, server fallback or first-party betas', async () => {
  const model = 'claude-opus-5';
  const p = await createCustomProvider('custom-ant-ids', {
    ...base,
    schemaVersion: 2,
    protocol: 'anthropic',
    apiKey: 'k',
    modelOverrides: { [model]: { manual: true } },
  });
  const requests = mock(p, () => sse(ANTHROPIC));
  await p.send(prompt, model, tools, { fast: true, effort: 'high' });
  assert.equal(requests[0].body.speed, undefined);
  assert.equal(requests[0].body.fallbacks, undefined);
  assert.equal(requests[0].headers.has('anthropic-beta'), false);
  assert.equal(p.fastModeBetaHeaderLatched, false);
  // Row-declared levels drive the effort body and its beta only.
  const q = await createCustomProvider('custom-ant-ids-2', {
    ...base,
    schemaVersion: 2,
    protocol: 'anthropic',
    apiKey: 'k',
    modelOverrides: { [model]: { manual: true, reasoning: { levels: ['low', 'high'] } } },
  });
  const r2 = mock(q, () => sse(ANTHROPIC));
  await q.send(prompt, model, tools, { fast: true, effort: 'high' });
  assert.deepEqual(r2[0].body.output_config, { effort: 'high' });
  assert.equal(r2[0].body.speed, undefined);
  const { EFFORT_BETA_HEADER } = await import('../../../shared/llm/anthropic-effort.mjs');
  assert.equal(r2[0].headers.get('anthropic-beta'), EFFORT_BETA_HEADER);
});

test('catalog reasoning defaults reach custom rows by bare model id; overrides win; first-party unchanged', async () => {
  const { getModelMetadataSync } = await import('./model-catalog.mjs');
  const p = await createCustomProvider('custom-bare-1', {
    ...base,
    schemaVersion: 2,
    protocol: 'openai-chat',
    apiKey: 'k',
    preconnect: false,
    modelOverrides: { 'gpt-fixture-1': { reasoning: { levels: ['high'] } } },
  });
  const rows = await withFetch(
    () => Response.json({ data: [{ id: 'openai/gpt-fixture-1' }, { id: 'gpt-fixture-1' }, { id: 'unknown-x' }] }),
    () => p.listModels()
  );
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId['openai/gpt-fixture-1'].reasoningLevels, ['low', 'medium', 'high']);
  assert.equal(byId['openai/gpt-fixture-1'].supportsReasoning, true);
  // Only reasoning capabilities are defaults: no vendor price or limits.
  assert.equal(byId['openai/gpt-fixture-1'].contextWindow, 0);
  assert.equal(byId['openai/gpt-fixture-1'].inputCostPerM, undefined);
  assert.deepEqual(byId['gpt-fixture-1'].reasoningLevels, ['high']);
  assert.equal(byId['unknown-x'].reasoningLevels, undefined);
  assert.equal(byId['unknown-x'].supportsReasoning, false);
  // First-party lookups keep their provider-keyed results.
  assert.equal(getModelMetadataSync('gpt-fixture-1', 'openai').contextWindow, 123000);
  assert.equal(getModelMetadataSync('gpt-fixture-1', 'deepseek'), null);
});

test('config merge injects keychain key only for stored custom providers and stays secret-free', () => {
  const id = 'custom-merge-1';
  process.env[`MIXDOG_AGENT_${id.toUpperCase().replace(/[.\s]+/g, '_')}_APIKEY`] = 'env-secret';
  try {
    const raw = { providers: { [id]: { ...base, protocol: 'anthropic', models: [{ id: 'a' }] } } };
    const merged = mergeStoredProviders({ raw, defaults: { providers: {} }, includeSecrets: true });
    assert.equal(merged[id].apiKey, 'env-secret');
    assert.equal(merged[id].enabled, true);
    const plain = mergeStoredProviders({ raw, defaults: { providers: {} }, includeSecrets: false });
    assert.equal(plain[id].apiKey, undefined);
    assert.equal(raw.providers[id].apiKey, undefined);
    // Keyless: neither the keychain key nor a hand-edited plaintext key survives.
    const keyless = {
      providers: { [id]: { ...base, schemaVersion: 2, auth: 'none', protocol: 'anthropic', apiKey: 'plain-secret' } },
    };
    for (const includeSecrets of [true, false]) {
      const out = mergeStoredProviders({ raw: keyless, defaults: { providers: {} }, includeSecrets });
      assert.equal(Object.hasOwn(out[id], 'apiKey'), false);
      assert.equal(out[id].auth, 'none');
    }
  } finally {
    delete process.env[`MIXDOG_AGENT_${id.toUpperCase().replace(/[.\s]+/g, '_')}_APIKEY`];
  }
});
