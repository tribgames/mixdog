// Advanced request options of a custom provider: config normalisation, the
// shallow merge (provider JSON → model JSON → app-owned fields) and the request
// that reaches the wire on every custom protocol.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
import {
  CUSTOM_REQUEST_BODY_MAX_CHARS,
  CUSTOM_RESERVED_BODY_KEYS,
  resolveCustomRequestExtras,
} from './custom-provider-config.mjs';
import { createCustomProvider, normalizeCustomProviderConfig } from './custom-provider.mjs';

const dataDir = makeTempDirSync('custom-request-options');
process.env.MIXDOG_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));
writeFileSync(join(dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

const base = { type: 'custom', schemaVersion: 2, name: 'Mine', baseURL: 'https://llm.example.com/v1' };
const prompt = [{ role: 'user', content: 'hello' }];
const tools = [{ name: 'lookup', description: 'look', inputSchema: { type: 'object', properties: {} } }];
const sse = (events) =>
  new Response(events.map((e) => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const CHAT = [{ id: 'c1', model: 'm1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }];
const RESPONSES = [
  {
    type: 'response.completed',
    response: { id: 'r1', model: 'm1', status: 'completed', output: [] },
  },
];
const ANTHROPIC = [
  { type: 'message_start', message: { id: 'msg_1', model: 'm1', role: 'assistant', usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

function mock(provider, respond) {
  const requests = [];
  provider.client.fetch = async (url, init) => {
    requests.push({ url: new URL(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return respond();
  };
  return requests;
}

const refuses = (patch, pattern) =>
  assert.throws(() => normalizeCustomProviderConfig({ ...base, protocol: 'openai-chat', ...patch }), pattern);

test('config: request options normalise, persist through a second pass and old configs are unchanged', () => {
  const plain = normalizeCustomProviderConfig({ ...base, protocol: 'openai-chat' });
  assert.equal(Object.hasOwn(plain, 'requestBody'), false);
  assert.equal(plain.schemaVersion, 2);
  const input = {
    ...base,
    protocol: 'openai-chat',
    requestBody: { service_tier: 'flex', provider: { order: ['z-ai'] } },
    modelOverrides: {
      m1: { requestBody: { temperature: 0 }, requestHeaders: { 'X-Provider': ' z-ai ' }, contextWindow: 10 },
      m2: { requestBody: {}, requestHeaders: {} },
    },
  };
  const out = normalizeCustomProviderConfig(input);
  assert.deepEqual(out.requestBody, input.requestBody);
  assert.deepEqual(out.modelOverrides.m1, {
    contextWindow: 10,
    requestBody: { temperature: 0 },
    requestHeaders: { 'X-Provider': 'z-ai' },
  });
  assert.deepEqual(out.modelOverrides.m2, {});
  assert.deepEqual(normalizeCustomProviderConfig(out), out);
});

test('config: app-owned keys, auth/transport headers, non-objects and oversize JSON are refused', () => {
  for (const key of CUSTOM_RESERVED_BODY_KEYS) {
    refuses({ requestBody: { [key]: 1 } }, new RegExp(`requestBody must not set ${key}`));
    refuses({ modelOverrides: { m: { requestBody: { [key]: 1 } } } }, new RegExp(`requestBody must not set ${key}`));
  }
  for (const key of ['model', 'messages', 'input', 'stream', 'tools']) assert.ok(CUSTOM_RESERVED_BODY_KEYS.has(key));
  for (const name of ['Authorization', 'x-api-key', 'API-Key', 'Content-Type', 'Host']) {
    refuses({ modelOverrides: { m: { requestHeaders: { [name]: 'x' } } } }, /requestHeaders must not set/);
  }
  refuses({ requestBody: [] }, /must be a JSON object/);
  refuses({ requestBody: 'x' }, /must be a JSON object/);
  refuses({ modelOverrides: { m: { requestHeaders: { A: 1 } } } }, /must be a string/);
  refuses({ requestBody: { big: 'x'.repeat(CUSTOM_REQUEST_BODY_MAX_CHARS) } }, /at most \d+ characters/);
  refuses({ requestBody: JSON.parse('{"__proto__": {"a": 1}}') }, /unsafe key/);
  assert.throws(
    () => normalizeCustomProviderConfig({ type: 'custom', name: 'L', protocol: 'openai-chat', baseURL: base.baseURL, requestBody: { a: 1 } }),
    /require.*schemaVersion 2/
  );
});

test('merge: provider JSON, then model JSON over it (shallow); stored reserved keys never survive', () => {
  const config = {
    requestBody: { service_tier: 'auto', provider: { order: ['a'], allow_fallbacks: true }, keep: false, model: 'evil' },
    modelOverrides: {
      m1: {
        requestBody: { service_tier: 'flex', provider: { order: ['z'] }, stream: false },
        requestHeaders: { 'X-Provider': 'z', Authorization: 'Bearer evil' },
      },
    },
  };
  assert.deepEqual(resolveCustomRequestExtras(config, 'm1'), {
    body: { service_tier: 'flex', provider: { order: ['z'] }, keep: false },
    headers: { 'X-Provider': 'z' },
  });
  assert.deepEqual(resolveCustomRequestExtras(config, 'other').body, {
    service_tier: 'auto',
    provider: { order: ['a'], allow_fallbacks: true },
    keep: false,
  });
  assert.deepEqual(resolveCustomRequestExtras(null, 'm1'), { body: {}, headers: {} });
});

const ADVANCED = {
  ...base,
  apiKey: 'sk-adv',
  preconnect: false,
  headers: { 'X-Region': 'eu', 'X-Provider': 'default' },
  requestBody: { service_tier: 'auto', vendor_flag: true },
  modelOverrides: {
    m1: {
      manual: true,
      requestBody: { service_tier: 'flex', provider: { order: ['z-ai'] } },
      requestHeaders: { 'x-provider': 'z-ai' },
    },
    plain: { manual: true },
  },
};

for (const [protocol, events, path] of [
  ['openai-chat', CHAT, '/v1/chat/completions'],
  ['openai-responses', RESPONSES, '/v1/responses'],
  ['anthropic', ANTHROPIC, '/v1/messages'],
]) {
  test(`request (${protocol}): extras reach the body and headers; app-owned fields and auth stay the app's`, async () => {
    const p = await createCustomProvider(`custom-adv-${protocol}`, { ...ADVANCED, protocol });
    // A stored config that somehow carries reserved keys must still not override the app.
    p.customConfig.requestBody = { ...p.customConfig.requestBody, model: 'evil', stream: false, tools: [] };
    p.customConfig.modelOverrides.m1.requestHeaders = { ...p.customConfig.modelOverrides.m1.requestHeaders, Authorization: 'Bearer evil' };
    const requests = mock(p, () => sse(events));
    await p.send(prompt, 'm1', tools, {});
    await p.send(prompt, 'plain', tools, {});
    const [withModel, withProviderOnly] = requests;
    assert.equal(withModel.url.pathname, path);
    assert.equal(withModel.body.model, 'm1');
    assert.equal(withModel.body.stream, true);
    assert.equal(withModel.body.tools.length, 1);
    assert.equal(withModel.body.service_tier, 'flex');
    assert.equal(withModel.body.vendor_flag, true);
    assert.deepEqual(withModel.body.provider, { order: ['z-ai'] });
    assert.equal(withModel.headers.get('x-provider'), 'z-ai');
    assert.equal(withModel.headers.get('x-region'), 'eu');
    assert.notEqual(withModel.headers.get('authorization'), 'Bearer evil');
    assert.equal(withProviderOnly.body.model, 'plain');
    assert.equal(withProviderOnly.body.service_tier, 'auto');
    assert.equal(withProviderOnly.body.vendor_flag, true);
    assert.equal(Object.hasOwn(withProviderOnly.body, 'provider'), false);
    assert.equal(withProviderOnly.headers.get('x-provider'), 'default');
    assert.equal(withProviderOnly.headers.get('x-region'), 'eu');
  });
}

test('request (anthropic): user thinking is seen by the forced tool_choice guard, direct and routed', async () => {
  const cfg = { ...base, apiKey: 'sk-t', preconnect: false, modelOverrides: { m1: { manual: true } } };
  const thinking = { requestBody: { thinking: { type: 'adaptive' } } };
  const opts = { toolChoice: 'required' };
  const direct = await createCustomProvider('custom-adv-think-a', { ...cfg, protocol: 'anthropic', ...thinking });
  const control = await createCustomProvider('custom-adv-think-b', { ...cfg, protocol: 'anthropic' });
  const routed = await createCustomProvider('custom-adv-think-c', {
    ...cfg,
    protocol: 'openai-chat',
    wires: ['chat', 'messages'],
    modelWires: { m1: 'messages' },
    ...thinking,
  });
  const sent = async (provider, target = provider) => {
    const requests = mock(target, () => sse(ANTHROPIC));
    await provider.send(prompt, 'm1', tools, opts);
    return requests[0].body;
  };
  // Without thinking the forced choice is sent; with the user's thinking it is dropped.
  assert.deepEqual((await sent(control)).tool_choice, { type: 'any' });
  for (const body of [await sent(direct), await sent(routed, routed.messagesEngine)]) {
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.equal(Object.hasOwn(body, 'tool_choice'), false);
  }
});

test('request (messages wire on an OpenAI-protocol provider): the bound Messages engine applies the extras', async () => {
  const p = await createCustomProvider('custom-adv-routed', {
    ...ADVANCED,
    protocol: 'openai-chat',
    wires: ['chat', 'messages'],
    modelWires: { m1: 'messages' },
  });
  const requests = mock(p.messagesEngine, () => sse(ANTHROPIC));
  await p.send(prompt, 'm1', tools, {});
  assert.equal(requests[0].url.pathname, '/v1/messages');
  assert.equal(requests[0].body.service_tier, 'flex');
  assert.equal(requests[0].headers.get('x-provider'), 'z-ai');
  assert.equal(requests[0].body.model, 'm1');
});

test('request: a provider without request options sends the unchanged body', async () => {
  const withOptions = await createCustomProvider('custom-adv-none-a', {
    ...base,
    protocol: 'openai-chat',
    apiKey: 'k',
    preconnect: false,
    modelOverrides: { m1: { manual: true } },
  });
  const requests = mock(withOptions, () => sse(CHAT));
  await withOptions.send(prompt, 'm1', tools, {});
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['messages', 'model', 'stream', 'stream_options', 'tools']);
});
