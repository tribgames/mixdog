import assert from 'node:assert/strict';
import test from 'node:test';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import { resolveOpenCodeGoBaseURLs } from './opencode-go.mjs';
import { compatProvider, nativeHistory } from './openai-compat-responses-parity.fixtures.mjs';

function scripted(name, events, output, config = {}) {
  const { provider, requests } = compatProvider(name, config);
  provider.client.responses.create = async (params) => {
    requests.push(structuredClone(params));
    return (async function* () {
      for (const event of events) yield event;
      yield {
        type: 'response.completed',
        response: { id: 'r1', model: params.model, status: 'completed', output },
      };
    })();
  };
  return { provider, requests };
}
const hist = [{ role: 'user', content: 'hi' }];

test('streamed refusal surfaces as a typed refusal, not an empty success', async () => {
  const { provider } = scripted(
    'opencode-go',
    [
      { type: 'response.refusal.delta', item_id: 'm1', content_index: 0, delta: 'I can' },
      { type: 'response.refusal.delta', item_id: 'm1', content_index: 0, delta: "'t" },
    ],
    [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'refusal', refusal: "I can't" }] }]
  );
  const r = await sendCompatResponses(provider, hist, 'gpt-5.5', [], {});
  assert.equal(r.stopReason, 'refusal');
  assert.equal(r.refusal, "I can't");
  assert.equal(r.content, "I can't");
});

test('final refusal part alone (no stream events) is a typed refusal', async () => {
  const { provider } = scripted(
    'muse-code',
    [],
    [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }]
  );
  const r = await sendCompatResponses(provider, hist, 'muse-spark', [], {});
  assert.equal(r.stopReason, 'refusal');
  assert.equal(r.refusal, 'no');
});

test('function_call namespace is preserved on parsed calls', async () => {
  const { provider } = scripted(
    'opencode-go',
    [],
    [{ type: 'function_call', id: 'f1', call_id: 'c1', name: 'run', namespace: 'ns', arguments: '{}' }]
  );
  const r = await sendCompatResponses(provider, hist, 'gpt-5.5', [], {});
  assert.equal(r.toolCalls[0].namespace, 'ns');
  assert.equal(r.toolCalls[0].name, 'run');
});

test('pinned nativeDeferredTools route declares native tool_search and replays tool_search_output', async () => {
  const tools = [{ name: 'load_tool', description: 'd', inputSchema: { type: 'object' } }];
  const history = nativeHistory();
  history[2] = {
    ...history[2],
    nativeToolSearch: {
      provider: 'opencode-go',
      openaiTools: [{ type: 'function', name: 'x', defer_loading: true, parameters: { type: 'object' } }],
    },
  };
  const run = async (session) => {
    const { provider, requests } = scripted(
      'opencode-go',
      [],
      [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
    );
    await sendCompatResponses(provider, history, 'gpt-5.5', tools, { session });
    return requests[0];
  };
  const on = await run({
    wireRoute: { provider: 'opencode-go', model: 'gpt-5.5', wire: 'responses', nativeDeferredTools: true },
  });
  assert.equal(on.tools[0].type, 'tool_search');
  const out = on.input.find((i) => i.type === 'tool_search_output');
  assert.equal(out.tools[0].name, 'x');
  assert.equal(out.tools[0].defer_loading, true);
  const off = await run({ wireRoute: { provider: 'opencode-go', model: 'gpt-5.5', wire: 'responses' } });
  assert.equal(off.tools[0].type, 'function');
  assert.equal(
    off.input.some((i) => i.type === 'tool_search_output'),
    false
  );
});

test('openrouter Responses rejects imported previous_response_id / store:true', async () => {
  for (const slot of [{ previousResponseId: 'resp_old' }, { store: true }]) {
    const { provider, requests } = scripted('openrouter', [], []);
    await assert.rejects(
      sendCompatResponses(provider, hist, 'openai/gpt-5.5', [], { providerState: { compatResponses: slot } }),
      { code: 'OPENROUTER_RESPONSES_STATELESS_ONLY' }
    );
    assert.equal(requests.length, 0);
  }
});

test('opencode-go gateway uses /inference/go/v1; overrides kept', () => {
  assert.equal(Object.hasOwn(OPENAI_COMPAT_PRESETS, 'opencode-go'), false);
  assert.deepEqual(resolveOpenCodeGoBaseURLs(undefined), {
    openai: 'https://opencode.ai/inference/go/v1',
    anthropic: 'https://opencode.ai/inference/go',
  });
  assert.equal(resolveOpenCodeGoBaseURLs('https://example.test/v1/').openai, 'https://example.test/v1');
  assert.equal(OPENAI_COMPAT_PRESETS.openrouter.chatCacheControl, true);
});
