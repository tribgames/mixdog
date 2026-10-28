import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { VERTEX_TOKEN_URI } from './vertex-ai-auth.mjs';
import { VertexAIProvider } from './vertex-ai.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'key-project',
  client_email: 'mixdog@key-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

function chatSse(chunks) {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

// The endpoint's chunk shapes: the first chunk may carry no role, and the last
// may carry the role together with finish_reason.
function textReply(text = 'ok', usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
  return chatSse([
    { id: 'r1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: text } }] },
    {
      id: 'r1',
      object: 'chat.completion.chunk',
      model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage,
    },
  ]);
}

// A provider whose API requests (not token requests) are answered by `respond`.
function maasProvider(config, respond) {
  const requests = [];
  let tokens = 0;
  const provider = new VertexAIProvider({
    apiKey: SERVICE_ACCOUNT,
    preconnect: false,
    ...config,
    fetchFn: async (url, init = {}) => {
      if (String(url) === VERTEX_TOKEN_URI) {
        tokens += 1;
        return Response.json({ access_token: `gcp-token-${tokens}`, expires_in: 3600 });
      }
      const request = {
        url: String(url),
        authorization: new Headers(init.headers).get('authorization'),
        body: JSON.parse(init.body),
      };
      requests.push(request);
      return respond(request, requests.length);
    },
  });
  return { provider, requests, tokenCount: () => tokens };
}

const hi = [{ role: 'user', content: 'hi' }];

test('Vertex open models go to the OpenAI-compatible endpoint of the configured location', async () => {
  const expected = {
    global: 'https://aiplatform.googleapis.com/v1/projects/key-project/locations/global/endpoints/openapi/chat/completions',
    'us-central1':
      'https://us-central1-aiplatform.googleapis.com/v1/projects/key-project/locations/us-central1/endpoints/openapi/chat/completions',
    us: 'https://aiplatform.us.rep.googleapis.com/v1/projects/key-project/locations/us/endpoints/openapi/chat/completions',
  };
  for (const [location, url] of Object.entries(expected)) {
    const { provider, requests } = maasProvider({ location }, () => textReply('maas-ok'));
    // A free-form (unlisted) id goes wherever it is configured.
    const result = await provider.send(hi, 'acme-ai/open-unlisted-maas', [], {});
    assert.equal(result.content, 'maas-ok');
    assert.equal(requests[0].url, url, location);
    assert.equal(requests[0].body.model, 'acme-ai/open-unlisted-maas');
    assert.equal(requests[0].authorization, 'Bearer gcp-token-1');
  }
  // Grok by its bare id, and Google's open models, use the same endpoint.
  const grok = maasProvider({ location: 'global' }, () => textReply());
  await grok.provider.send(hi, 'grok-4.7', [], {});
  assert.equal(grok.requests[0].body.model, 'xai/grok-4.7');
  const gemma = maasProvider({ location: 'global' }, () => textReply());
  await gemma.provider.send(hi, 'google/gemma-4-26b-a4b-it-maas', [], {});
  assert.match(gemma.requests[0].url, /\/endpoints\/openapi\/chat\/completions$/);
  assert.equal(gemma.requests[0].body.model, 'google/gemma-4-26b-a4b-it-maas');
});

test('Vertex open models carry only the access token, refreshed through the setter after a 401', async () => {
  const { provider, requests, tokenCount } = maasProvider({ location: 'global' }, (_request, n) =>
    n === 1 ? Response.json({ error: { message: 'token expired' } }, { status: 401 }) : textReply('after-refresh')
  );
  const result = await provider.send(hi, 'moonshotai/kimi-k2-thinking-maas', [], {});
  assert.equal(result.content, 'after-refresh');
  assert.deepEqual(
    requests.map((request) => request.authorization),
    ['Bearer gcp-token-1', 'Bearer gcp-token-2']
  );
  assert.equal(tokenCount(), 2);
  for (const request of requests) assert.doesNotMatch(request.authorization, /private_key|service_account/);
  // The next send reuses the refreshed token.
  await provider.send(hi, 'moonshotai/kimi-k2-thinking-maas', [], {});
  assert.equal(requests[2].authorization, 'Bearer gcp-token-2');
});

test('Vertex open-model usage is cache-exclusive and priced by its publisher/model row', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_tokens_details: { cached_tokens: 800 } };
  const { provider } = maasProvider({ location: 'global' }, () => textReply('cached', usage));
  const result = await provider.send(hi, 'qwen/qwen3-coder-480b-a35b-instruct-maas', [], {});
  assert.equal(VertexAIProvider.inputExcludesCache, true);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.cachedTokens, 800);
  assert.equal(result.usage.promptTokens, 1000);
  assert.equal(result.pricingModel, 'qwen/qwen3-coder-480b-a35b-instruct-maas');
});

test('Vertex open models round-trip a tool call over chat completions', async () => {
  const tools = [{ name: 'lookup', description: 'Look a word up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
  const { provider, requests } = maasProvider({ location: 'global' }, (_request, n) =>
    n === 1
      ? chatSse([
          {
            id: 't1',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"vertex"}' } }],
                },
              },
            ],
          },
          {
            id: 't1',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          },
        ])
      : textReply('the answer')
  );
  const first = await provider.send(hi, 'zai-org/glm-5-maas', tools, {});
  assert.equal(first.toolCalls.length, 1);
  assert.equal(first.toolCalls[0].name, 'lookup');
  assert.deepEqual(first.toolCalls[0].arguments, { q: 'vertex' });
  assert.equal(requests[0].body.tools[0].function.name, 'lookup');

  const history = [
    ...hi,
    { role: 'assistant', content: '', toolCalls: first.toolCalls },
    { role: 'tool', toolCallId: first.toolCalls[0].id, content: 'a cloud platform' },
  ];
  const second = await provider.send(history, 'zai-org/glm-5-maas', tools, {});
  assert.equal(second.content, 'the answer');
  const sent = requests[1].body.messages;
  const assistant = sent.find((message) => message.role === 'assistant');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  const tool = sent.find((message) => message.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(tool.content, 'a cloud platform');
});

test('Vertex open models map a not-enabled model to the Model Garden error', async () => {
  const { provider } = maasProvider({ location: 'global' }, () =>
    Response.json({ error: { code: 404, message: 'Model minimaxai/minimax-m2-maas not found', status: 'NOT_FOUND' } }, { status: 404 })
  );
  await assert.rejects(provider.send(hi, 'minimaxai/minimax-m2-maas', [], {}), (error) => {
    assert.equal(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    assert.match(error.message, /publishers\/minimaxai\/model-garden\/minimax-m2-maas/);
    return true;
  });
  // Vertex error bodies may be a JSON array of error objects.
  const listed = maasProvider({ location: 'global' }, () =>
    Response.json([{ error: { code: 403, message: 'Model zai-org/glm-5-maas has not been enabled. Enable it in Model Garden.', status: 'PERMISSION_DENIED' } }], { status: 403 })
  );
  await assert.rejects(listed.provider.send(hi, 'zai-org/glm-5-maas', [], {}), (error) => {
    assert.equal(error.code, 'VERTEX_MODEL_NOT_ENABLED');
    assert.match(error.message, /publishers\/zai-org\/model-garden\/glm-5-maas/);
    return true;
  });
});
