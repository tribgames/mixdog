#!/usr/bin/env node
// openai-compat-chat-stream-tool-calls.test.mjs (5 tests, 7 rows with the finish_reason loop): the real compat chat stream collector
// (`consumeCompatChatCompletionStream`) and response normalizer over scripted chunk lists, with the tool-call dispatch callbacks.
//   node benchmarks/rust-core/recorders/record-compat-chat-stream-tool-calls.mjs --tree <exact export of b6f10295a>
import { startRecording, stream } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-compat-chat-stream-tool-calls',
  net: false,
  pure: { '*': 'mixdog-ai/src/providers/compat/chat/decode.rs:155 ChatDecoder (pub; feed :578, finish :601)' },
  entry: 'openai-compat-stream.mjs consumeCompatChatCompletionStream(chunks, { label, providerName, parseToolCalls, knownToolNames, onToolCall }) and openai-compat-response-normalization.mjs normalizeCompatChatResponse({ providerName, useModel, opts, assembled }). The test\'s own parseToolCalls (JSON.parse of the arguments) is the callback the collector receives.',
  compare: 'mixdog-ai providers::compat chat decode (decode.rs:295 fragment join, finish handling, leak guard): feed `input.chunks` and compare `result` (assembled response/toolCalls), `dispatched` (calls handed out, in order) and `normalized` (the typed incomplete error: providerIncomplete, finishReason, partialToolCalls).',
  replay: "mixdog-ai/src/providers/compat/chat/decode.rs: `pub struct ChatDecoder` (:155, re-exported pub at providers/compat/chat/mod.rs:18) built by `ChatDecoder::new(profile, owner)` (:193) and `.with_known_tools(names)` (:224), fed each recorded chunk as one SSE `data: <json>\n\n` unit through `WireDecoder::feed(&[u8])` (:578) and ended by `finish()` (:601). `feed` returns the StreamEvents (text, tool dispatches, errors) the Node consumer returns/dispatches for the same chunks; the `normalized` field (normalizeCompatChatResponse over a cut stream) maps to the typed error `finish()` / `feed` returns for a cut finish_reason.",
});
const P = 'agent/orchestrator/providers/';
const { consumeCompatChatCompletionStream } = await rec.P(`${P}openai-compat-stream.mjs`);
const { normalizeCompatChatResponse } = await rec.P(`${P}openai-compat-response-normalization.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-compat-chat-stream-tool-calls.test.mjs';

const parseToolCalls = (choice) => choice.message.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') }));
const toolDelta = (args, extra = {}) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...extra, function: { arguments: args, ...extra.function } }] } }] });
const consume = async (events, extra = {}) => {
  const dispatched = [];
  const out = {};
  try {
    out.result = await consumeCompatChatCompletionStream(stream(events), { label: 'gateway', providerName: 'gateway', parseToolCalls, onToolCall: (call) => dispatched.push(call), ...extra });
  } catch (error) {
    out.error = error;
  }
  return { ...out, dispatched };
};

const repeat = [toolDelta('{"a":"', { id: 'c1', function: { name: 'f' } }), toolDelta('{"a":"'), toolDelta('"}'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
await rec.run('prefix-repeating-fragment-verbatim', `${SRC}:34`, { chunks: repeat }, async () => {
  const out = await consume(repeat, { parseToolCalls: (choice) => choice.message.tool_calls });
  return { ...out, arguments: out.result.response.choices[0].message.tool_calls[0].function.arguments };
});
const fragmented = [toolDelta('', { id: 'c1', function: { name: 'f' } }), toolDelta('{"x"'), toolDelta(':1}'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
await rec.run('fragmented-dispatches-once', `${SRC}:47`, { chunks: fragmented }, () => consume(fragmented));
for (const finish of ['length', 'content_filter']) {
  const events = [toolDelta('{"x":1}', { id: 'c1', function: { name: 'f' } }), { choices: [{ delta: {}, finish_reason: finish }] }];
  await rec.run(`finish-${finish}-never-dispatches`, `${SRC}:63`, { chunks: events }, async () => {
    const out = await consume(events);
    let normalized = null;
    try {
      normalizeCompatChatResponse({ providerName: 'gateway', useModel: 'm', opts: {}, assembled: out.result });
    } catch (error) {
      normalized = error;
    }
    return { ...out, normalized };
  });
}
const leak = '<invoke name="f"><parameter name="x">1</parameter></invoke>';
for (const finish of ['stop', 'length', 'content_filter', 'network_error']) {
  const events = [{ choices: [{ delta: { content: leak } }] }, { choices: [{ delta: {}, finish_reason: finish }] }];
  await rec.run(`leaked-call-finish-${finish}`, `${SRC}:82`, { chunks: events, knownToolNames: ['f'] }, () => consume(events, { knownToolNames: new Set(['f']) }));
}
await rec.finish();
