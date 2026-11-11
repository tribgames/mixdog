#!/usr/bin/env node
// mixdog-local-wire.test.mjs (3 tests): the real `toLocalProviderMessages` (instruction merge) and the real MixdogLocalProvider sending
// a tool-call turn and its follow-up to a scripted strict single-system local endpoint (the model-server manager is the test's
// `ensureServer` seam: it hands back the endpoint and records the request signals), and a pre-cancelled send.
//   node benchmarks/rust-core/recorders/record-mixdog-local-wire.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-mixdog-local-wire',
  entry: 'mixdog-local-wire.mjs toLocalProviderMessages(history); mixdog-local.mjs MixdogLocalProvider({}, { ensureServer }).send(messages, "test-local", tools, { signal, onToolCall }) where ensureServer returns { baseURL: http://127.0.0.1:8080/v1, apiKey: "test-key" } (the OpenAI SDK sends real HTTP to the scripted endpoint, which answers 400 if a system message is not first). Not run: a real llama server.',
  compare: 'mixdog-ai providers::local (local/mod.rs:109-132) and mixdog-services local_provider provider.rs:231-233: compare the merged messages, the two requests (body incl. the single merged system message and tool_call_id), the results, the dispatched calls and the signal states; a pre-cancelled send never calls ensureServer.',
  replay: "Rust entry (pub, on o1): mixdog_services::local_provider local_context_settings (context.rs:48), save_local_context (context.rs:75), Catalog::status (catalog.rs:224), RequestQueue::run (request_queue.rs:124), download_verified_asset (assets.rs:324); the local provider adapter is mixdog_ai::providers::local::adapter() (local/mod.rs:109).",
});
const { MixdogLocalProvider } = await rec.P('agent/orchestrator/providers/mixdog-local.mjs');
const { toLocalProviderMessages } = await rec.P('agent/orchestrator/providers/mixdog-local-wire.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/mixdog-local-wire.test.mjs';

const history = [
  { role: 'system', content: 'base', cacheTier: 'tier1' },
  { role: 'system', content: [{ type: 'text', text: 'profile' }], cacheTier: 'tier2' },
  { role: 'user', content: 'hello' },
  { role: 'developer', content: 'runtime instructions' },
  { role: 'assistant', content: 'reply' },
];
await rec.run('instructions-merge', `${SRC}:8`, { history }, () => {
  const saved = structuredClone(history);
  const merged = toLocalProviderMessages(history);
  let imageError = null;
  try {
    toLocalProviderMessages([{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'not-text' } }] }]);
  } catch (error) {
    imageError = error;
  }
  return { merged, historyUnchanged: JSON.stringify(history) === JSON.stringify(saved), imageError };
});

const tools = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const messages = ['base', 'profile', 'workflow', 'environment'].map((content) => ({ role: 'system', content }));
messages.push({ role: 'user', content: 'Look up the answer.' });
await rec.run('streamed-tool-call-single-system', `${SRC}:30`, { messages, tools }, async ({ net }) => {
  net.reply = (req) => {
    const body = JSON.parse(req.body);
    if (body.messages.some((message, index) => message.role === 'system' && index !== 0)) {
      return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'System message must be at the beginning.' } }) };
    }
    const followup = body.messages.at(-1).role === 'tool';
    const delta = followup ? { content: 'The result is 42.' } : { tool_calls: [{ index: 0, id: 'call_local', type: 'function', function: { name: 'lookup', arguments: '{"key":"answer"}' } }] };
    return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ id: 'local-response', model: body.model, choices: [{ index: 0, delta, finish_reason: followup ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n` };
  };
  const seenSignals = [];
  const provider = new MixdogLocalProvider({}, { ensureServer: async (_model, { signal }) => (seenSignals.push(signal), { baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'test-key' }) });
  const controller = new AbortController();
  const sent = structuredClone(messages);
  const dispatched = [];
  const first = await provider.send(sent, 'test-local', tools, { signal: controller.signal, onToolCall: (call) => dispatched.push(call) });
  sent.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls });
  sent.push({ role: 'tool', toolCallId: first.toolCalls[0].id, content: '42' });
  const second = await provider.send(sent, 'test-local', tools, { signal: controller.signal });
  const before = seenSignals.map((s) => ({ isAbortSignal: s instanceof AbortSignal, aborted: s.aborted }));
  controller.abort();
  return { first, dispatched, second, signalsBeforeAbort: before, signalsAfterAbort: seenSignals.map((s) => s.aborted), systemMessagesLeftInHistory: sent.filter((m) => m.role === 'system').length };
});
await rec.run('cancelled-send-starts-no-server', `${SRC}:120`, {}, async () => {
  let started = 0;
  const provider = new MixdogLocalProvider({}, { ensureServer: () => { started += 1; } });
  let error = null;
  try {
    await provider.send([], 'test', [], { signal: AbortSignal.abort(new Error('cancelled')) });
  } catch (e) {
    error = e;
  }
  return { error, serverStarts: started };
});
await rec.finish();
