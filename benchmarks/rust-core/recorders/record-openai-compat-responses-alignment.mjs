#!/usr/bin/env node
// openai-compat-responses-alignment.test.mjs (7 tests): the real compat Responses sender (`sendCompatResponses`) and the OpenCode Go base
// resolver. The Responses client is the scripted external side (as in the test): its `create(params, options)` records the request
// body and headers option and replays the scripted events then a `response.completed` frame.
//   node benchmarks/rust-core/recorders/record-openai-compat-responses-alignment.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-compat-responses-alignment',
  net: false,
  entry: 'openai-compat-responses.mjs sendCompatResponses(provider, history, model, tools, opts) on an OpenAICompatProvider-prototype instance whose `client.responses.create` is the scripted SDK endpoint (records body + headers, yields the scripted events and a response.completed), opencode-go.mjs resolveOpenCodeGoBaseURLs, openai-compat-presets.mjs OPENAI_COMPAT_PRESETS; fixtures from openai-compat-responses-parity.fixtures.mjs (nativeHistory) are inlined. Not run: a live endpoint or the SDK transport.',
  compare: 'mixdog-ai providers::openai decoder.rs:558-569,758-761,813-847,1091-1093 (refusal, namespace) and compat Responses codec (openai_profiles.rs:374,675; compat/profile.rs:667): feed `input.events` + `input.output` and compare `result` (stopReason, refusal, toolCalls incl. namespace) and `requests[*].body`; the preset/base rows compare `result` whole. K1 gap G1: the Responses wire is not built for OpenCode Go today.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const P = 'agent/orchestrator/providers/';
const { sendCompatResponses } = await rec.P(`${P}openai-compat-responses.mjs`);
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const { OPENAI_COMPAT_PRESETS } = await rec.P(`${P}openai-compat-presets.mjs`);
const { resolveOpenCodeGoBaseURLs } = await rec.P(`${P}opencode-go.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-compat-responses-alignment.test.mjs';

function nativeHistory() {
  return [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'ts1', name: 'load_tool', arguments: { names: ['x'] }, nativeType: 'tool_search_call' }, { id: 'cu1', name: 'apply_patch', arguments: { patch: 'P' }, nativeType: 'custom_tool_call' }, { id: 'fn1', name: 'Read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'ts1', content: 'loaded' }, { role: 'tool', toolCallId: 'cu1', content: 'patched' }, { role: 'tool', toolCallId: 'fn1', content: 'file' }, { role: 'user', content: 'next' },
  ];
}
function scripted(name, events, output, config = {}) {
  const requests = [];
  const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
    name, config: { preconnect: false, ...config }, nativePdf: true,
    client: { responses: { create: async (params, options) => {
      requests.push({ body: structuredClone(params), headers: options?.headers ?? null });
      return (async function* () {
        for (const event of events) yield event;
        yield { type: 'response.completed', response: { id: 'r1', model: params.model, status: 'completed', output } };
      })();
    } } },
  });
  rec.describe(provider, { $instance: 'OpenAICompatProvider (prototype instance, fields as set)', name, config: provider.config, nativePdf: true, client: { responses: { create: { scripted: 'records (params, options) and answers with the events, then response.completed with the output', events, output } } } });
  return { provider, requests };
}
const hist = [{ role: 'user', content: 'hi' }];
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};

const refusalEvents = [{ type: 'response.refusal.delta', item_id: 'm1', content_index: 0, delta: 'I can' }, { type: 'response.refusal.delta', item_id: 'm1', content_index: 0, delta: "'t" }];
const refusalOutput = [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'refusal', refusal: "I can't" }] }];
await rec.run('streamed-refusal-typed', `${SRC}:24`, { name: 'opencode-go', model: 'gpt-5.5', events: refusalEvents, output: refusalOutput }, async () => {
  const { provider, requests } = scripted('opencode-go', refusalEvents, refusalOutput);
  return { ...(await attempt(sendCompatResponses(provider, hist, 'gpt-5.5', [], {}))), requests };
});
const finalRefusal = [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }];
await rec.run('final-part-refusal-typed', `${SRC}:39`, { name: 'muse-code', model: 'muse-spark', events: [], output: finalRefusal }, async () => {
  const { provider, requests } = scripted('muse-code', [], finalRefusal);
  return { ...(await attempt(sendCompatResponses(provider, hist, 'muse-spark', [], {}))), requests };
});
const nsOutput = [{ type: 'function_call', id: 'f1', call_id: 'c1', name: 'run', namespace: 'ns', arguments: '{}' }];
await rec.run('function-call-namespace-preserved', `${SRC}:50`, { name: 'opencode-go', model: 'gpt-5.5', events: [], output: nsOutput }, async () => {
  const { provider, requests } = scripted('opencode-go', [], nsOutput);
  return { ...(await attempt(sendCompatResponses(provider, hist, 'gpt-5.5', [], {}))), requests };
});
await rec.run('pinned-native-deferred-tools-route', `${SRC}:61`, { name: 'opencode-go', model: 'gpt-5.5' }, async () => {
  const tools = [{ name: 'load_tool', description: 'd', inputSchema: { type: 'object' } }];
  const history = nativeHistory();
  history[2] = { ...history[2], nativeToolSearch: { provider: 'opencode-go', openaiTools: [{ type: 'function', name: 'x', defer_loading: true, parameters: { type: 'object' } }] } };
  const out = {};
  for (const [label, session] of [['nativeDeferredTools on', { wireRoute: { provider: 'opencode-go', model: 'gpt-5.5', wire: 'responses', nativeDeferredTools: true } }], ['off', { wireRoute: { provider: 'opencode-go', model: 'gpt-5.5', wire: 'responses' } }]]) {
    const { provider, requests } = scripted('opencode-go', [], [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]);
    await sendCompatResponses(provider, history, 'gpt-5.5', tools, { session });
    out[label] = { session, request: requests[0] };
  }
  return out;
});
await rec.run('openrouter-responses-rejects-imported-state', `${SRC}:95`, { slots: [{ previousResponseId: 'resp_old' }, { store: true }] }, async () => {
  const out = [];
  for (const slot of [{ previousResponseId: 'resp_old' }, { store: true }]) {
    const { provider, requests } = scripted('openrouter', [], []);
    out.push({ slot, ...(await attempt(sendCompatResponses(provider, hist, 'openai/gpt-5.5', [], { providerState: { compatResponses: slot } }))), requestsSent: requests.length });
  }
  return { out };
});
await rec.run('opencode-go-base-urls', `${SRC}:106`, {}, () => ({
  presetPresent: Object.hasOwn(OPENAI_COMPAT_PRESETS, 'opencode-go'),
  defaults: resolveOpenCodeGoBaseURLs(undefined),
  override: resolveOpenCodeGoBaseURLs('https://example.test/v1/'),
  openrouterChatCacheControl: OPENAI_COMPAT_PRESETS.openrouter.chatCacheControl,
}));
await rec.finish();
