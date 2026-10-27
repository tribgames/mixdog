import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const { OpenCodeGoProvider } = await import('./opencode-go.mjs');
const { applyCompatToolChoice } = await import('./compat-request-policy.mjs');
const { toOpenAIMessages } = await import('./openai-compat-wire.mjs');

test('OpenCode Go sends Gemini models to the gateway generateContent endpoint with the Go key only', async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input));
    requests.push({ url, headers: new Headers(init.headers || {}), body: JSON.parse(init.body) });
    const chunk = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = new OpenCodeGoProvider({ apiKey: 'go-key', preconnect: false, fetchImpl });
  const route = await provider.resolveWireRoute('gemini-4-argon-contributor', { agent: true });
  assert.equal(route.wire, 'gemini');
  const result = await provider.send(
    [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    'gemini-4-argon-contributor',
    [],
    { sessionId: 's1' }
  );
  assert.equal(result.content, 'ok');
  const [req] = requests;
  assert.equal(
    req.url.href,
    'https://opencode.ai/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse'
  );
  assert.equal(req.headers.get('authorization'), 'Bearer go-key');
  assert.equal(req.headers.get('x-opencode-session'), 's1');
  assert.equal(req.headers.get('user-agent'), 'mixdog');
  assert.equal(req.body.systemInstruction.parts[0].text, 'be brief');
  assert.equal(req.body.cachedContent, undefined);
});

test('Chat content keeps cache_control only where the gateway documents it', () => {
  const content = [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }];
  const kept = toOpenAIMessages([{ role: 'user', content }], 'openrouter', { cacheControl: true });
  assert.deepEqual(kept[0].content, content);
  const dropped = toOpenAIMessages([{ role: 'user', content }], 'deepseek', {});
  assert.equal(JSON.stringify(dropped).includes('cache_control'), false);
});

test('Mistral and Groq hosts get forced tool_choice and parallel_tool_calls', () => {
  for (const baseURL of ['https://api.mistral.ai/v1', 'https://api.groq.com/openai/v1']) {
    const body = applyCompatToolChoice(
      { tools: [{}] },
      { toolChoice: 'required', parallelToolCalls: false },
      { provider: 'custom-x', baseURL, wire: 'chat' }
    );
    assert.equal(body.tool_choice, 'required', baseURL);
    assert.equal(body.parallel_tool_calls, false, baseURL);
  }
});
