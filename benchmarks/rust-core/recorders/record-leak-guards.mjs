#!/usr/bin/env node
// leak-guards.test.mjs (25 tests): the real leaked-tool-call guards of the four stream consumers over scripted streams: the Gemini text
// leak guard (`createGeminiTextLeakGuard`), the Anthropic SSE parser (`parseSSEStream` with known tool names), the compat Chat stream
// (`consumeCompatChatCompletionStream`) and the compat Responses stream (`consumeCompatResponsesStream`). Each row records the visible
// text deltas, the dispatched calls and the folded result.
//   node benchmarks/rust-core/recorders/record-leak-guards.mjs --tree <exact export of b6f10295a>
import { sseBody, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-leak-guards',
  entry: 'the real provider send of each route over a scripted loopback endpoint: gemini.mjs GeminiProvider.send, anthropic.mjs AnthropicProvider.send, openai-compat.mjs OpenAICompatProvider.send (Chat: provider deepseek; Responses: compatWireApi "responses" on a custom gateway); the guards run inside them (gemini-stream.mjs createGeminiTextLeakGuard, anthropic-oauth.mjs parseSSEStream, openai-compat-stream.mjs consumeCompat*Stream). Each case sends two turns: the scripted leaked stream, then the transcript the agent keeps. Not run: a live endpoint.',
  compare: 'mixdog-ai providers::leak.rs (:60-163) and leak_tests.rs / anthropic/leak_tests.rs over fixtures/agent/leaked-toolcall: replay the case through the route\'s adapter against a scripted endpoint serving turn 1\'s `requests[0].reply`-equivalent stream (`input.deltas`/`input.events`) and compare `result.events` (visible text deltas and dispatched calls interleaved in order), `result.first` whole, and BOTH recorded requests (`requests`: method, origin, path, every header, body bytes): the second request\'s transcript must not contain the guarded markup.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::leak::LeakGuard (leak.rs:359) and scan (leak.rs:310), exercised through each route's adapter driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const P = 'agent/orchestrator/providers/';
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const { AnthropicProvider } = await rec.P(`${P}anthropic.mjs`);
const { GeminiProvider } = await rec.P(`${P}gemini.mjs`);
const SRC = 'scripts/provider-toolcall/leak-guards.test.mjs';
const TOOLS = ['shell', 'read'];
const toolDefs = TOOLS.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } }));

const textDeltaEvents = (chunks, stopReason = 'end_turn') => [
  { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  ...chunks.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
];
const chatEvents = (chunks) => [...chunks.map((text) => ({ choices: [{ delta: { content: text } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1 } }];
const responsesEvents = (chunks) => [...chunks.map((delta) => ({ type: 'response.output_text.delta', delta })), { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } }];
const geminiFrames = (chunks) => chunks.map((text, i) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(i === chunks.length - 1 ? { finishReason: 'STOP' } : {}) }] }));
const anthropicBody = (events) => events.map((e) => `event: ${e.type || 'message'}\ndata: ${JSON.stringify(e)}\n\n`).join('');

// Each route is the provider's REAL send over a scripted endpoint: turn 1 answers with the case's stream; turn 2 sends the transcript the agent
// would keep (the assistant message of turn 1 and its tool results) plus a follow-up, so the recorded request bytes of BOTH turns show what
// reached the socket. The proof that nothing leaked is those requests (and `events`, the visible deltas and dispatched calls in order).
const routes = {
  gemini: { model: 'gemini-3-pro', make: () => new GeminiProvider({ apiKey: 'fixture-key', preconnect: false }), body: (chunks) => sseBody(geminiFrames(chunks)), ok: () => sseBody(geminiFrames(['ok'])), type: 'text/event-stream' },
  anthropic: { model: 'claude-opus-4-8', make: () => new AnthropicProvider({ apiKey: 'fixture-key' }), body: (chunks, events) => anthropicBody(events ?? textDeltaEvents(chunks)), ok: () => anthropicBody(textDeltaEvents(['ok'])), type: 'text/event-stream' },
  chat: { model: 'deepseek-v4-pro', make: () => new OpenAICompatProvider('deepseek', { apiKey: 'fixture-key', preconnect: false }), body: (chunks, events) => `${sseBody(events ?? chatEvents(chunks))}data: [DONE]\n\n`, ok: () => `${sseBody(chatEvents(['ok']))}data: [DONE]\n\n`, type: 'text/event-stream' },
  responses: { model: 'gpt-x', opts: { compatWireApi: 'responses' }, make: () => new OpenAICompatProvider('custom-x', { apiKey: 'fixture-key', preconnect: false, baseURL: 'https://gw.example/v1' }), body: (chunks) => sseBody(responsesEvents(chunks), true), ok: () => sseBody(responsesEvents(['ok']), true), type: 'text/event-stream' },
};
const viaProvider = async (route, chunks, events, net) => {
  const r = routes[route];
  net.reply = (_req, n) => ({ status: 200, contentType: r.type, body: n === 1 ? r.body(chunks, events) : r.ok() });
  const provider = r.make();
  const seen = [];
  const history = [{ role: 'user', content: 'hi' }];
  const sendOpts = { ...(r.opts ?? {}), onTextDelta: (text) => seen.push({ text }), onToolCall: (call) => seen.push({ tool: call }) };
  const first = await provider.send(history, r.model, toolDefs, sendOpts);
  const transcript = [...history, { role: 'assistant', content: first.content, ...(first.toolCalls?.length ? { toolCalls: first.toolCalls } : {}), ...(first.providerState ? { providerState: first.providerState } : {}), ...(first.providerReplay ? { providerReplay: first.providerReplay } : {}) }, ...(first.toolCalls ?? []).map((c) => ({ role: 'tool', toolCallId: c.id, content: 'done' })), { role: 'user', content: 'continue' }];
  const second = await provider.send(transcript, r.model, toolDefs, { ...(r.opts ?? {}) });
  return { events: seen, first, transcript, second };
};
const row = (id, line, route, chunks, events) => rec.run(id, `${SRC}:${line}`, { route, knownToolNames: TOOLS, deltas: chunks, ...(events ? { events } : {}) }, async ({ net }) => {
  try {
    return await viaProvider(route, chunks, events, net);
  } catch (error) {
    return { error };
  }
});

const fc = (name, arg, val) => `<function_calls>\n<invoke name="${name}">\n<parameter name="${arg}">${val}</parameter>\n</invoke>\n</function_calls>`;
await row('gemini-known-tool-recovered', 19, 'gemini', [`Sure.\n${fc('read', 'path', 'a.txt').replace('<function_calls>\n', '<function_calls>\n')}`]);
await row('gemini-unknown-tool-text-flushed', 49, 'gemini', [fc('nonexistent_tool', 'x', '1')]);
await row('anthropic-known-tool-recovered', 67, 'anthropic', [`Sure.\n${fc('shell', 'command', 'ls -la')}`]);
await row('anthropic-tags-split-across-chunks', 95, 'anthropic', ['<invoke name="sh', 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>']);
await row('anthropic-unknown-tool-text-flushed', 120, 'anthropic', [fc('nonexistent_tool', 'x', '1')]);
await row('anthropic-benign-function-prose', 148, 'anthropic', ['Use the <function> keyword in JavaScript to declare a function.']);
await row('chat-known-tool-recovered', 182, 'chat', [`Sure.\n${fc('shell', 'command', 'ls -la')}`]);
await row('chat-harmony-recovered', 182, 'chat', ['ok ', '<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a.txt"}<|call|>']);
await row('chat-tags-split-across-deltas', 202, 'chat', ['<invoke name="sh', 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>']);
await row('chat-unknown-tool-text-preserved', 221, 'chat', [fc('nonexistent_tool', 'x', '1')]);
await row('chat-benign-prose-preserved', 239, 'chat', ['Use the <function> keyword in JavaScript.']);
await row('chat-native-tool-calls-with-guard', 256, 'chat', [], [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } }]);
await row('responses-leaked-invoke-recovered', 283, 'responses', ['Working.\n<invoke name="shell">\n<parameter name="command">whoami</parameter>\n</invoke>']);
await row('responses-harmony-split-across-deltas', 305, 'responses', ['<|channel|>commentary to=functions.read <|message|>{"path":', '"b.txt"}<|call|>']);
await row('responses-benign-prose', 323, 'responses', ['Just some prose about functions and channels.']);
await row('anthropic-fence-invoke-in-code-block', 342, 'anthropic', ['Example:\n```\n<invoke name="read"><parameter name="path">a</parameter></invoke>\n```\ndone']);
await row('anthropic-fence-opens-and-closes-across-deltas', 362, 'anthropic', ['Here is an example:\n```json\n', '<invoke name="read"><parameter name="path">a</parameter></invoke>\n', '```\nEnd.']);
await row('anthropic-inline-code-span', 385, 'anthropic', ['Call it like `<invoke name="read"><parameter name="path">a</parameter></invoke>` in the docs.']);
await row('anthropic-fence-control-outside-fence', 404, 'anthropic', ['Sure.\n<invoke name="read"><parameter name="path">a</parameter></invoke>']);
await row('chat-harmony-inside-fence', 426, 'chat', ['Doc:\n```\n<|channel|>commentary to=functions.read <|message|>{"path":"a"}<|call|>\n```\n']);
const leakedShell = '<invoke name="shell"><parameter name="command">ls</parameter></invoke>';
await row('anthropic-dedupe-leaked-plus-native', 443, 'anthropic', [], [
  { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: leakedShell } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }, { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
]);
await row('chat-dedupe-leaked-plus-native', 476, 'chat', [], [
  { choices: [{ delta: { content: '<invoke name="read"><parameter name="path">a</parameter></invoke>' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } },
]);
await row('anthropic-bare-antml-prose-streamed', 512, 'anthropic', ['The tag antml:invoke is used internally; here we just mention it in a sentence.']);
await row('anthropic-bare-antml-control-bracket-form', 533, 'anthropic', ['ok\n<invoke name="read"><parameter name="path">z</parameter></invoke>']);
await row('anthropic-unmatched-backtick-in-suppressed-args', 604, 'anthropic', ['<invoke name="read"><parameter name="path">a`b</parameter></invoke> some visible prose <invoke name="shell"><parameter name="command">ls</parameter></invoke>']);
await rec.finish();
