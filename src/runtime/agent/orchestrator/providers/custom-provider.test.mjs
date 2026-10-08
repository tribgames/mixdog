import assert from 'node:assert/strict';
import test from 'node:test';

import { createCustomProvider, normalizeCustomProviderConfig } from './custom-provider.mjs';
import { initProviders, getProvider, providerInputExcludesCache } from './registry.mjs';
import { mergeStoredProviders } from '../config-providers-merge.mjs';

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
        delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
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
      output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', status: 'completed' }],
    },
  },
];
const ANTHROPIC = [
  { type: 'message_start', message: { id: 'msg_1', model: 'm1', role: 'assistant', usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

test('normalizer returns only contract fields and validates input', () => {
  const out = normalizeCustomProviderConfig({
    ...base,
    id: 'x',
    apiKey: 'secret',
    protocol: 'openai-chat',
    baseURL: ' https://llm.example.com/v1/ ',
    models: [{ id: 'm1', name: 'M', contextWindow: '1000', maxOutputTokens: 50, extra: 1 }],
  });
  assert.deepEqual(out, {
    type: 'custom',
    name: 'Mine',
    protocol: 'openai-chat',
    baseURL: 'https://llm.example.com/v1',
    models: [{ id: 'm1', name: 'M', contextWindow: 1000, maxOutputTokens: 50 }],
    enabled: true,
  });
  const bad = (patch, opts) => assert.throws(() => normalizeCustomProviderConfig({ ...base, protocol: 'anthropic', models: [{ id: 'a' }], ...patch }, opts));
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
    assert.equal(normalizeCustomProviderConfig({ ...base, protocol: 'anthropic', baseURL }, { requireModels: false }).baseURL, baseURL);
  }
  bad({ models: [] });
  bad({ models: [{ id: 'a' }, { id: 'a' }] });
  bad({ models: [{ id: 'a', contextWindow: -1 }] });
  assert.deepEqual(normalizeCustomProviderConfig({ ...base, protocol: 'anthropic' }, { requireModels: false }).models, []);
});

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
  const models = await p.listModels();
  assert.deepEqual(models, [
    { id: 'm1', name: 'Model One', provider: id, contextWindow: 5000, outputTokens: 700 },
  ]);
  assert.equal(p.getCachedModelInfo('m1').contextWindow, 5000);
  assert.equal(await p.isAvailable(), true);
  assert.equal(providerInputExcludesCache(id), false);
});

test('openai-chat: empty models discover from /models', async () => {
  const p = await createCustomProvider('custom-chat-2', { ...base, protocol: 'openai-chat', apiKey: 'k', preconnect: false });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://llm.example.com')) return new Response('{}', { status: 404 });
    calls.push({ url: String(url), auth: init.headers.Authorization });
    return Response.json({ data: [{ id: 'found-1' }] });
  };
  try {
    const models = await p.listModels();
    assert.equal(calls[0].url, 'https://llm.example.com/v1/models');
    assert.equal(calls[0].auth, 'Bearer k');
    assert.equal(models[0].id, 'found-1');
    assert.equal(models[0].provider, 'custom-chat-2');
    globalThis.fetch = async () => new Response('denied', { status: 401 });
    await assert.rejects(p.listModels(), /models 401/);
  } finally {
    globalThis.fetch = realFetch;
  }
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
  assert.equal((await p.listModels())[0].provider, id);
  assert.equal(p.constructor.inputExcludesCache, true);
  // base without /v1 yields the same path
  const q = await createCustomProvider(id, { ...base, baseURL: 'https://gw.example.com/anthropic', protocol: 'anthropic', apiKey: 'k' });
  const r2 = mock(q, () => sse(ANTHROPIC));
  await q.send(prompt, 'm1', [], {});
  assert.equal(r2[0].url.pathname, '/anthropic/v1/messages');
});

test('anthropic: empty models discover from /v1/models without built-in fallback', async () => {
  const p = await createCustomProvider('custom-ant-2', { ...base, protocol: 'anthropic', apiKey: 'k' });
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://llm.example.com')) return new Response('{}', { status: 404 });
    calls.push({ url: String(url), key: init.headers['x-api-key'] });
    return Response.json({ data: [{ id: 'ant-found', display_name: 'Found' }] });
  };
  try {
    const models = await p.listModels();
    assert.equal(calls[0].url, 'https://llm.example.com/v1/models');
    assert.equal(calls[0].key, 'k');
    assert.deepEqual(models.map((m) => [m.id, m.name, m.provider]), [['ant-found', 'Found', 'custom-ant-2']]);
    globalThis.fetch = async () => new Response('no', { status: 500 });
    await assert.rejects(p.listModels(), /models 500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('registry instantiates custom providers without presets and reports invalid entries', async () => {
  const id = 'custom-reg-1';
  await initProviders({
    [id]: { ...base, protocol: 'openai-chat', apiKey: 'k', preconnect: false, models: [{ id: 'm1' }] },
  });
  const p = getProvider(id);
  assert.ok(p);
  assert.equal(p.name, id);
  assert.equal((await p.listModels())[0].provider, id);
  await assert.rejects(initProviders({
    'custom-bad': { ...base, protocol: 'nope', apiKey: 'k', models: [{ id: 'm1' }] },
  }), /unsupported protocol/);
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
  } finally {
    delete process.env[`MIXDOG_AGENT_${id.toUpperCase().replace(/[.\s]+/g, '_')}_APIKEY`];
  }
});
