// Per-model wire routing of the DeepSeek and OpenCode Go gateways on the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gateway-wire-routing-'));
process.env.MIXDOG_DATA_DIR = dir;
// models.dev names the SDK package (= the one wire) of these Go models.
writeFileSync(
  join(dir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: { 'opencode-go': { models: { 'gpt-6-luna': { provider: { npm: '@ai-sdk/openai' } } } } },
  })
);
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const { DeepSeekProvider, deepSeekMessagesBaseURL } = await import('./deepseek.mjs');
const { OpenCodeGoProvider } = await import('./opencode-go.mjs');
const { COMPAT_RETRY_POLICY } = await import('./openai-compat-retry-profile.mjs');

const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_AUTH_TOKEN = 'env-anthropic-token';
test.after(() => {
  if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  rmSync(dir, { recursive: true, force: true });
});

const prompt = [{ role: 'user', content: 'hi' }];
const tool = { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } };
const frame = (event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
const sse = (events) =>
  new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });

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
          usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 40 },
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
  return sse([{ id: 'c', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
}

function recorder() {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input));
    const request = { url: url.href, path: url.pathname, headers: new Headers(init.headers || {}), body: JSON.parse(init.body) };
    requests.push(request);
    return respond(request);
  };
  return { requests, fetchImpl };
}

test('DeepSeek agent/tool sends use its Anthropic endpoint with the DeepSeek key only', async () => {
  const { requests, fetchImpl } = recorder();
  const provider = new DeepSeekProvider({ apiKey: 'ds-key', preconnect: false, fetchImpl, clientOptions: { fetch: fetchImpl } });
  assert.equal(provider.retryPolicy, COMPAT_RETRY_POLICY);
  const result = await provider.send(prompt, 'deepseek-v4-pro', [tool], { sessionId: 's' });
  assert.equal(requests[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(requests[0].body.model, 'deepseek-v4-pro');
  assert.equal(requests[0].headers.get('x-api-key'), 'ds-key');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('anthropic-beta'), null);
  assert.equal(result.usage.inputTokens, 43);
  // A tool-less one-shot request stays on Chat; V4 Pro never goes to Responses.
  await provider.send(prompt, 'deepseek-v4-pro', [], {});
  assert.equal(requests[1].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[1].headers.get('authorization'), 'Bearer ds-key');
  assert.equal(deepSeekMessagesBaseURL('https://api.deepseek.com/v1'), 'https://api.deepseek.com/anthropic');
});

function goHarness(config = {}) {
  const { requests, fetchImpl } = recorder();
  const provider = new OpenCodeGoProvider({ apiKey: 'go-key', preconnect: false, ...config });
  provider.anthropic.client.fetch = fetchImpl;
  provider.openai.client.fetch = fetchImpl;
  return { provider, requests };
}

test('OpenCode Go sends cold-catalog Claude to Messages; a pre-table session keeps Chat', async () => {
  const { provider, requests } = goHarness();
  await provider.send(prompt, 'claude-haiku-5-5', [tool], {});
  assert.equal(requests[0].url, 'https://opencode.ai/inference/go/v1/messages');
  const legacy = await provider.resolveWireRoute('claude-haiku-5-5', { legacy: true });
  assert.equal(legacy.wire, 'chat');
  await provider.send(prompt, 'claude-haiku-5-5', [tool], {
    session: { wireRoute: { provider: 'opencode-go', model: 'claude-haiku-5-5', ...legacy } },
  });
  assert.equal(requests[1].url, 'https://opencode.ai/inference/go/v1/chat/completions');
  await provider.send(prompt, 'gpt-6-luna', [tool], {});
  assert.equal(requests[2].url, 'https://opencode.ai/inference/go/v1/responses');
});

test('an OpenCode Go per-model override picks the wire', async () => {
  const { provider, requests } = goHarness({ modelWires: { 'glm-5.2': 'messages' } });
  await provider.send(prompt, 'glm-5.2', [tool], {});
  assert.equal(requests[0].url, 'https://opencode.ai/inference/go/v1/messages');
});

test('an OpenCode Go override cannot pick a wire the catalog says the model lacks', async () => {
  const { provider, requests } = goHarness({ modelWires: { 'gpt-6-luna': 'messages' } });
  const route = await provider.resolveWireRoute('gpt-6-luna', { agent: true });
  assert.equal(route.wire, 'responses');
  assert.equal(route.source, 'catalog');
  await provider.send(prompt, 'gpt-6-luna', [tool], {});
  assert.equal(requests[0].url, 'https://opencode.ai/inference/go/v1/responses');
});
