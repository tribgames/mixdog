// Gateways that speak Anthropic Messages declare their own capabilities
// (effort, documents, file-ID betas, output ceilings, tool_choice) instead of
// inheriting Claude rules; dispatch follows the resolved route only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gateway-messages-caps-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const { DeepSeekProvider, deepSeekEffortProjection } = await import('./deepseek.mjs');
const { OpenRouterProvider, withTopProviderOutputCeiling } = await import('./openrouter.mjs');
const { OpenCodeGoProvider } = await import('./opencode-go.mjs');
const { createCustomProvider } = await import('./custom-provider.mjs');
const { lowerHistoryForRoute, sendWireRoute, resolveWireRoute } = await import('./wire-route.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const prompt = [{ role: 'user', content: 'hi' }];
const tool = { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } };
const frame = (event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
const sse = (events) => new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });

function respond({ path, body }) {
  if (path.endsWith('/messages')) {
    return sse([
      {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
  }
  if (path.endsWith('/responses')) {
    return sse([
      {
        type: 'response.completed',
        response: {
          id: 'r',
          model: body.model,
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        },
      },
    ]);
  }
  return sse([
    { id: 'c', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
  ]);
}

function recorder() {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input));
    const request = {
      url: url.href,
      path: url.pathname,
      headers: new Headers(init.headers || {}),
      body: JSON.parse(init.body),
    };
    requests.push(request);
    return respond(request);
  };
  return { requests, fetchImpl };
}

function deepseek() {
  const { requests, fetchImpl } = recorder();
  const provider = new DeepSeekProvider({
    apiKey: 'ds',
    preconnect: false,
    fetchImpl,
    clientOptions: { fetch: fetchImpl },
  });
  return { provider, requests };
}

test('DeepSeek projects effort into output_config.effort and ignores budget_tokens', async () => {
  const expected = { low: 'low', medium: 'high', high: 'high', max: 'max' };
  for (const [effort, sent] of Object.entries(expected)) {
    const { provider, requests } = deepseek();
    await provider.send(prompt, 'deepseek-v4-pro', [tool], { effort });
    assert.deepEqual(requests[0].body.output_config, { effort: sent }, effort);
    assert.equal(requests[0].body.thinking, undefined, effort);
  }
  // A manual budget never turns into budget_tokens either.
  const { provider, requests } = deepseek();
  await provider.send(prompt, 'deepseek-v4-pro', [tool], { effort: 'high', thinkingBudgetTokens: 4096 });
  assert.equal(requests[0].body.thinking?.budget_tokens, undefined);
  assert.deepEqual(requests[0].body.output_config, { effort: 'high' });
  // No effort: the default (thinking on) is left alone.
  const plain = deepseek();
  await plain.provider.send(prompt, 'deepseek-v4-pro', [tool], {});
  assert.equal(plain.requests[0].body.output_config, undefined);
  assert.equal(plain.requests[0].body.thinking, undefined);
});

test('DeepSeek off disables thinking with the documented toggle', async () => {
  const body = {};
  assert.equal(deepSeekEffortProjection(body, { effort: 'none' }), true);
  assert.deepEqual(body, { thinking: { type: 'disabled' }, reasoning: { effort: 'none' } });
  const { provider, requests } = deepseek();
  await provider.send(prompt, 'deepseek-v4-pro', [tool], { effort: 'none' });
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.equal(requests[0].body.output_config, undefined);
});

test('DeepSeek declares no documents and no parallel-disable; OpenRouter Messages takes PDFs', async () => {
  const { provider, requests } = deepseek();
  assert.equal(provider.anthropic.nativePdf, false);
  assert.equal(provider.anthropic.nativeDocuments, false);
  await provider.send(prompt, 'deepseek-v4-pro', [tool], { disableParallelToolUse: true });
  assert.equal(JSON.stringify(requests[0].body).includes('disable_parallel_tool_use'), false);
  const router = new OpenRouterProvider({ apiKey: 'or', preconnect: false });
  assert.equal(router.anthropic.nativePdf, true);
  assert.equal(router.anthropic.nativeDocuments, undefined);
  assert.equal(router.nativePdf, false, 'the provider-level flag still covers the Chat and Responses wires');
});

test('DeepSeek sends the Files API beta only on a request with a file-ID image', async () => {
  const { provider, requests } = deepseek();
  const withFile = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'file', file_id: 'file_1' } },
      ],
    },
  ];
  await provider.send(withFile, 'deepseek-v4-pro', [tool], {});
  assert.equal(requests[0].headers.get('anthropic-beta'), 'files-api-2025-04-14');
  await provider.send(prompt, 'deepseek-v4-pro', [tool], {});
  assert.equal(requests[1].headers.get('anthropic-beta'), null);
});

test('gateway output ceilings reach max_tokens', async () => {
  assert.deepEqual(
    withTopProviderOutputCeiling({ id: 'x', top_provider: { max_completion_tokens: 9000 } }).max_output_tokens,
    9000
  );
  const { requests, fetchImpl } = recorder();
  const router = new OpenRouterProvider({
    apiKey: 'or',
    preconnect: false,
    fetchImpl,
    clientOptions: { fetch: fetchImpl },
  });
  router.openai._enrichedModels = [{ id: 'anthropic/claude-opus-4.8', outputTokens: 12000 }];
  await router.send(prompt, 'anthropic/claude-opus-4.8', [tool], {});
  assert.equal(requests[0].path.endsWith('/messages'), true);
  assert.equal(requests[0].body.max_tokens, 12000);
  const go = recorder();
  const goProvider = new OpenCodeGoProvider({ apiKey: 'go', preconnect: false });
  goProvider.anthropic.client.fetch = go.fetchImpl;
  goProvider.getCachedModelInfo = () => ({ outputTokens: 5000 });
  await goProvider.send(prompt, 'minimax-m3', [tool], {});
  assert.equal(go.requests[0].body.max_tokens, 5000);
});

test('a caller wire switch never overrides the resolved route', async () => {
  const { provider, requests } = deepseek();
  await provider.send(prompt, 'deepseek-v4-pro', [], { compatWireApi: 'responses', responsesTransport: 'ws' });
  assert.equal(requests[0].path, '/chat/completions');
  const go = recorder();
  const goProvider = new OpenCodeGoProvider({ apiKey: 'go', preconnect: false });
  goProvider.openai.client.fetch = go.fetchImpl;
  await goProvider.send(prompt, 'glm-5.2', [], { compatWireApi: 'responses' });
  assert.equal(go.requests[0].path.endsWith('/chat/completions'), true);
  const custom = await createCustomProvider('custom-switch-1', {
    type: 'custom',
    name: 'C',
    baseURL: 'https://llm.example.com/v1',
    enabled: true,
    schemaVersion: 2,
    protocol: 'openai-chat',
    apiKey: 'k',
    preconnect: false,
  });
  const seen = recorder();
  custom.client.fetch = seen.fetchImpl;
  await custom.send(prompt, 'm', [], { compatWireApi: 'responses' });
  assert.equal(seen.requests[0].path.endsWith('/chat/completions'), true);
});

test("a custom provider's routed Messages engine matches the Anthropic protocol effort", async () => {
  const model = 'claude-opus-5';
  const config = {
    type: 'custom',
    name: 'Mine',
    baseURL: 'https://llm.example.com/v1',
    enabled: true,
    schemaVersion: 2,
    apiKey: 'k',
    preconnect: false,
    modelOverrides: { [model]: { manual: true, reasoning: { levels: ['low', 'high'] } } },
  };
  const direct = await createCustomProvider('custom-eff-ant', { ...config, protocol: 'anthropic' });
  const routed = await createCustomProvider('custom-eff-routed', {
    ...config,
    protocol: 'openai-chat',
    wires: ['chat', 'messages'],
    modelWires: { [model]: 'messages' },
  });
  const a = recorder();
  direct.client.fetch = a.fetchImpl;
  const b = recorder();
  routed.messagesEngine.client.fetch = b.fetchImpl;
  await direct.send(prompt, model, [tool], { effort: 'high' });
  await routed.send(prompt, model, [tool], { effort: 'high' });
  assert.deepEqual(a.requests[0].body.output_config, { effort: 'high' });
  assert.deepEqual(b.requests[0].body.output_config, a.requests[0].body.output_config);
  assert.deepEqual(b.requests[0].body.thinking, a.requests[0].body.thinking);
});

const assistant = (id) => ({
  role: 'assistant',
  content: id,
  reasoningContent: 'r',
  reasoningItems: [{ id }],
  thinkingBlocks: [{ type: 'thinking' }],
});

test('a pinned wire the provider no longer offers is rerouted, recorded, and its history lowered', async () => {
  const provider = {
    name: 'command-code-oauth',
    resolveWireRoute: async (m, ctx) => resolveWireRoute('command-code-oauth', m, { ...ctx, endpoints: ['chat'] }),
  };
  const pin = {
    provider: 'command-code-oauth',
    model: 'gpt-5.5',
    wire: 'responses',
    profileId: 'command-code-oauth:responses',
    source: 'family',
  };
  const session = {
    provider: 'command-code-oauth',
    model: 'gpt-5.5',
    wireRoute: pin,
    messages: [assistant('a'), { role: 'user', content: 'u' }, assistant('b')],
  };
  const route = await sendWireRoute(provider, 'gpt-5.5', [], { session }, session.messages);
  assert.equal(route.wire, 'chat');
  assert.equal(route.source, 'reroute');
  assert.equal(route.reroutedFrom, 'responses');
  assert.equal(session.wireRoute, route);
  const lowered = lowerHistoryForRoute(session.messages, route);
  for (const index of [0, 2]) {
    for (const field of ['reasoningContent', 'reasoningItems', 'thinkingBlocks'])
      assert.equal(field in lowered[index], false, field);
  }
  // Turns produced on the new wire keep their replay.
  const later = [...session.messages, assistant('c')];
  assert.equal(lowerHistoryForRoute(later, route)[3].reasoningContent, 'r');
  // The recorded reroute is stable on later sends.
  assert.equal(await sendWireRoute(provider, 'gpt-5.5', [], { session }, later), route);
});

test('a custom provider edited to drop a pinned wire reroutes to Chat and records it', async () => {
  const make = (wires) =>
    createCustomProvider('custom-reroute-1', {
      type: 'custom',
      name: 'R',
      baseURL: 'https://llm.example.com/v1',
      enabled: true,
      schemaVersion: 2,
      protocol: 'openai-chat',
      wires,
      apiKey: 'k',
      preconnect: false,
    });
  await make(['chat', 'responses']);
  const edited = await make(['chat']);
  const seen = recorder();
  edited.client.fetch = seen.fetchImpl;
  const pin = {
    provider: 'custom-reroute-1',
    model: 'm',
    wire: 'responses',
    profileId: 'custom-reroute-1:responses',
    source: 'default',
  };
  const session = { provider: 'custom-reroute-1', model: 'm', wireRoute: pin, messages: [assistant('a')] };
  await edited.send([assistant('a'), { role: 'user', content: 'next' }], 'm', [], { session });
  assert.equal(seen.requests[0].path.endsWith('/chat/completions'), true);
  assert.equal(session.wireRoute.source, 'reroute');
  assert.equal(session.wireRoute.reroutedFrom, 'responses');
  assert.equal(JSON.stringify(seen.requests[0].body).includes('reasoning'), false);
});

test('a gateway offers a higher one-shot max_tokens only on a Messages route, bounded by its own ceiling', async () => {
  const router = new OpenRouterProvider({ apiKey: 'or', preconnect: false });
  const claude = 'anthropic/claude-opus-5.5';
  router.getCachedModelInfo = () => ({ outputTokens: 128_000 });
  assert.equal(resolveWireRoute('openrouter', claude, { agent: true }).wire, 'messages');
  assert.equal(await router.escalatedMaxTokens(claude, {}, [tool]), 128_000);
  // A model served on another wire has no Messages max_tokens to raise.
  const other = 'openai/gpt-5';
  assert.notEqual(resolveWireRoute('openrouter', other, { agent: true }).wire, 'messages');
  assert.equal(await router.escalatedMaxTokens(other, {}, [tool]), null);
  // The gateway ceiling bounds the escalation: nothing above the normal request.
  router.getCachedModelInfo = () => ({ outputTokens: 32_000 });
  assert.equal(await router.escalatedMaxTokens(claude, {}, [tool]), null);

  // The one-shot override reaches the wire request, and only that request.
  router.getCachedModelInfo = () => ({ outputTokens: 128_000 });
  const seen = recorder();
  router.anthropic.client.fetch = seen.fetchImpl;
  await router.send(prompt, claude, [tool], {});
  await router.send(prompt, claude, [tool], { maxOutputTokensOverride: 128_000 });
  await router.send(prompt, claude, [tool], {});
  assert.deepEqual(
    seen.requests.map((request) => request.body.max_tokens),
    [65_536, 128_000, 65_536]
  );
});

test('OpenCode Go Messages requests carry the preset headers; user headers win', async () => {
  const send = async (config) => {
    const go = recorder();
    const provider = new OpenCodeGoProvider({ apiKey: 'go', preconnect: false, ...config });
    provider.anthropic.client.fetch = go.fetchImpl;
    await provider.send(prompt, 'minimax-m3', [tool], {});
    return go.requests[0].headers;
  };
  assert.equal((await send({})).get('user-agent'), 'mixdog');
  assert.equal((await send({ extraHeaders: { 'User-Agent': 'mine' } })).get('user-agent'), 'mine');
});
