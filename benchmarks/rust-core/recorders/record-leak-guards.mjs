#!/usr/bin/env node
// leak-guards.test.mjs (25 tests): the real leaked-tool-call guards of the four stream consumers over scripted streams: the Gemini text
// leak guard (`createGeminiTextLeakGuard`), the Anthropic SSE parser (`parseSSEStream` with known tool names), the compat Chat stream
// (`consumeCompatChatCompletionStream`) and the compat Responses stream (`consumeCompatResponsesStream`). Each row records the visible
// text deltas, the dispatched calls and the folded result.
//   node benchmarks/rust-core/recorders/record-leak-guards.mjs --tree <exact export of b6f10295a>
import { startRecording, stream } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-leak-guards',
  net: false,
  entry: 'gemini-stream.mjs createGeminiTextLeakGuard({ knownToolNames, onTextDelta, onToolCall }) (feedText / finalize / scrubAssistantText / getLeakedToolCalls); anthropic-oauth.mjs parseSSEStream(response, null, abort, onStreamDelta, onToolCall, {}, onTextDelta, knownToolNames); openai-compat-stream.mjs consumeCompatChatCompletionStream / consumeCompatResponsesStream (with openai-compat.mjs parseToolCalls / parseResponsesToolCalls) over scripted events. Not run: a network send.',
  compare: 'mixdog-ai providers::leak.rs (:60-163) and leak_tests.rs / anthropic/leak_tests.rs over fixtures/agent/leaked-toolcall (K1 row 3: 19 of 25 cases already replayed there): feed `input.deltas` per route and compare `result.texts` (visible text deltas), `result.captured` (dispatched calls) and `result.folded` whole.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::leak::LeakGuard (leak.rs:359) and scan (leak.rs:310), exercised through each route's adapter driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const P = 'agent/orchestrator/providers/';
const { createGeminiTextLeakGuard } = await rec.P(`${P}gemini-stream.mjs`);
const { parseSSEStream } = await rec.P(`${P}anthropic-oauth.mjs`);
const { consumeCompatChatCompletionStream, consumeCompatResponsesStream } = await rec.P(`${P}openai-compat-stream.mjs`);
const { parseToolCalls, parseResponsesToolCalls } = await rec.P(`${P}openai-compat.mjs`);
const SRC = 'scripts/provider-toolcall/leak-guards.test.mjs';
const TOOLS = ['shell', 'read'];

const anthropicResponse = (events) => {
  const chunks = events.map((e) => new TextEncoder().encode(`event: ${e.type || 'message'}\ndata: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return { body: { getReader: () => ({ read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: () => Promise.resolve(), releaseLock() {} }) } };
};
const textDeltaEvents = (chunks, stopReason = 'end_turn') => [
  { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  ...chunks.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
];
const chatEvents = (chunks) => [...chunks.map((text) => ({ choices: [{ delta: { content: text } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1 } }];
const responsesEvents = (chunks) => [...chunks.map((delta) => ({ type: 'response.output_text.delta', delta })), { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } }];

const consumers = {
  gemini: async (chunks) => {
    const texts = [];
    const captured = [];
    const guard = createGeminiTextLeakGuard({ knownToolNames: new Set(TOOLS), onTextDelta: (t) => texts.push(t), onToolCall: (c) => captured.push(c) });
    const joined = chunks.join('');
    guard.feedText(joined);
    guard.finalize();
    return { texts, captured, folded: { scrubbed: guard.scrubAssistantText(joined), leakedToolCalls: guard.getLeakedToolCalls() } };
  },
  anthropic: async (chunks, events) => {
    const texts = [];
    const captured = [];
    const folded = await parseSSEStream(anthropicResponse(events ?? textDeltaEvents(chunks)), null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), new Set(TOOLS));
    return { texts, captured, folded };
  },
  chat: async (chunks, events) => {
    const texts = [];
    const captured = [];
    const folded = await consumeCompatChatCompletionStream(stream(events ?? chatEvents(chunks)), { label: 'test', parseToolCalls, onToolCall: (c) => captured.push(c), onTextDelta: (t) => texts.push(t), knownToolNames: new Set(TOOLS) });
    return { texts, captured, folded };
  },
  responses: async (chunks) => {
    const texts = [];
    const captured = [];
    const folded = await consumeCompatResponsesStream(stream(responsesEvents(chunks)), { label: 'test', parseResponsesToolCalls, responseOutputText: () => '', onToolCall: (c) => captured.push(c), onTextDelta: (t) => texts.push(t), knownToolNames: new Set(TOOLS) });
    return { texts, captured, folded };
  },
};
const row = (id, line, route, chunks, events) => rec.run(id, `${SRC}:${line}`, { route, knownToolNames: TOOLS, deltas: chunks, ...(events ? { events } : {}) }, async () => {
  try {
    return await consumers[route](chunks, events);
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
await row('chat-known-tool-recovered', 173, 'chat', [`Sure.\n${fc('shell', 'command', 'ls -la')}`]);
await row('chat-harmony-recovered', 202, 'chat', ['ok ', '<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a.txt"}<|call|>']);
await row('chat-tags-split-across-deltas', 226, 'chat', ['<invoke name="sh', 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>']);
await row('chat-unknown-tool-text-preserved', 248, 'chat', [fc('nonexistent_tool', 'x', '1')]);
await row('chat-benign-prose-preserved', 272, 'chat', ['Use the <function> keyword in JavaScript.']);
await row('chat-native-tool-calls-with-guard', 293, 'chat', [], [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } }]);
await row('responses-leaked-invoke-recovered', 322, 'responses', ['Working.\n<invoke name="shell">\n<parameter name="command">whoami</parameter>\n</invoke>']);
await row('responses-harmony-split-across-deltas', 345, 'responses', ['<|channel|>commentary to=functions.read <|message|>{"path":', '"b.txt"}<|call|>']);
await row('responses-benign-prose', 364, 'responses', ['Just some prose about functions and channels.']);
await row('anthropic-fence-invoke-in-code-block', 389, 'anthropic', ['Example:\n```\n<invoke name="read"><parameter name="path">a</parameter></invoke>\n```\ndone']);
await row('anthropic-fence-opens-and-closes-across-deltas', 413, 'anthropic', ['Here is an example:\n```json\n', '<invoke name="read"><parameter name="path">a</parameter></invoke>\n', '```\nEnd.']);
await row('anthropic-inline-code-span', 438, 'anthropic', ['Call it like `<invoke name="read"><parameter name="path">a</parameter></invoke>` in the docs.']);
await row('anthropic-fence-control-outside-fence', 462, 'anthropic', ['Sure.\n<invoke name="read"><parameter name="path">a</parameter></invoke>']);
await row('chat-harmony-inside-fence', 485, 'chat', ['Doc:\n```\n<|channel|>commentary to=functions.read <|message|>{"path":"a"}<|call|>\n```\n']);
const leakedShell = '<invoke name="shell"><parameter name="command">ls</parameter></invoke>';
await row('anthropic-dedupe-leaked-plus-native', 515, 'anthropic', [], [
  { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: leakedShell } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }, { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
]);
await row('chat-dedupe-leaked-plus-native', 536, 'chat', [], [
  { choices: [{ delta: { content: '<invoke name="read"><parameter name="path">a</parameter></invoke>' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } },
]);
await row('anthropic-bare-antml-prose-streamed', 559, 'anthropic', ['The tag antml:invoke is used internally; here we just mention it in a sentence.']);
await row('anthropic-bare-antml-control-bracket-form', 579, 'anthropic', ['ok\n<invoke name="read"><parameter name="path">z</parameter></invoke>']);
await row('anthropic-unmatched-backtick-in-suppressed-args', 604, 'anthropic', ['<invoke name="read"><parameter name="path">a`b</parameter></invoke> some visible prose <invoke name="shell"><parameter name="command">ls</parameter></invoke>']);
await rec.finish();
