#!/usr/bin/env node
// openai-ws-stream.test.mjs (15 tests): the real Responses WS stream reader (`_streamResponse`) over a scripted socket (an EventEmitter
// that receives the frames below as message events, then optionally a close event; the socket records the close codes the reader sends).
// 7 tests are recorded. NOT recorded (8): the watchdog / idle / first-output / reopened-deadline cases (:231-:361: pre-stream first-byte
// window, inter-chunk stall, silent thinking past the idle, first-output deadline, semantic idle, reopened logical deadline, retry after output)
// are wall-clock watchdogs that the core removed (dec:138, dec:145); they have no Rust counterpart.
//   node benchmarks/rust-core/recorders/record-openai-ws-stream.mjs --tree <exact export of b6f10295a>
import { EventEmitter } from 'node:events';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-stream',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs _streamResponse({ entry: { socket }, externalSignal, onStreamDelta, onToolCall, onTextDelta, state, knownToolNames }) fed by a scripted socket (frames as message events, close events). Not run: the watchdog timers (see the header).',
  replay: 'mixdog-ai providers::openai decoder.rs (:696-745 bundle salvage, :1011-1027, :1144-1179 max-output) and mixdog-agent send.rs:541-556: feed `input.frames` (+ `input.close`) and compare `result`/`error` (message, wsCloseCode, partialToolCalls, pendingToolUse, providerErrorCode, ...), the callbacks (`text`, `tools`, `progress`) in order, `state` flags and `closes`.',
});
const { _streamResponse } = await rec.P('agent/orchestrator/providers/openai-ws-stream.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-stream.test.mjs';
const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } };

// One stream: frames are emitted after the reader started; `close` = [code, reason] is emitted last; `signal` is an abort controller step.
async function stream(frames, { close = null, knownToolNames, abort = null } = {}) {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.closes = [];
  socket.close = (code, reason) => { socket.readyState = 3; socket.closes.push([code, reason]); };
  socket.terminate = socket.close;
  const seen = { text: [], tools: [], progress: [] };
  const state = { sessionId: 'ws-stream-test' };
  const controller = new AbortController();
  const pending = _streamResponse({
    entry: { socket, ephemeral: true }, externalSignal: abort ? controller.signal : null,
    onStreamDelta: (kind) => seen.progress.push(kind), onToolCall: (call) => seen.tools.push(call), onTextDelta: (chunk) => seen.text.push(chunk),
    state, logSuppressedReasoningDeltas: false, ...(knownToolNames ? { knownToolNames } : {}),
  });
  for (const event of frames) socket.emit('message', Buffer.from(JSON.stringify(event)));
  if (close) socket.emit('close', close[0], Buffer.from(close[1]));
  if (abort) controller.abort(abort);
  let out;
  try {
    out = { result: await pending };
  } catch (error) {
    out = { error };
  }
  return { ...out, ...seen, state, closes: socket.closes };
}
const row = (id, line, frames, options = {}) => rec.run(id, `${SRC}:${line}`, { frames, ...(options.close ? { close: options.close } : {}), ...(options.knownToolNames ? { knownToolNames: options.knownToolNames } : {}) }, () => stream(frames, options));

await row('text-call-and-usage-in-one-result', 58, [
  created, { type: 'response.output_text.delta', delta: 'Hello ' }, { type: 'response.output_text.delta', delta: 'world' },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path"' }, { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', end_turn: false, usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }] } },
]);
await row('call-id-only-in-completed-bundle-is-salvaged', 112, [created, { type: 'response.function_call_arguments.done', item_id: 'fc_late', arguments: '{"q":1}' }, { type: 'response.completed', response: { output: [{ type: 'function_call', id: 'fc_late', call_id: 'call_late', name: 'search' }] } }]);
await row('unsalvageable-call-fails', 112, [created, { type: 'response.function_call_arguments.done', item_id: 'fc_lost', arguments: '{}' }, { type: 'response.completed', response: { output: [] } }]);
const leaked = '<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>';
await row('leaked-tool-call-recovered-once', 140, [created, { type: 'response.output_text.delta', delta: 'Sure. ' }, { type: 'response.output_text.delta', delta: leaked }, { type: 'response.completed', response: { output: [] } }], { knownToolNames: ['read'] });
await row('max-output-tokens-truncated-success', 155, [created, { type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]);
await row('response-failed-rejects-with-frame', 155, [created, { type: 'response.failed', response: { error: { message: 'boom', code: 'server_error', status: 503 } } }]);
await row('response-done-cancelled-rejects', 155, [created, { type: 'response.done', response: { status: 'cancelled' } }]);
await row('close-before-terminal-keeps-partial-state', 133, [created, { type: 'response.output_text.delta', delta: 'half' }, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'c', name: 'n' } }], { close: [1006, 'gone'] });
const done = { type: 'function_call', id: 'fc_done', call_id: 'call_done', name: 'read' };
await row('close-after-finished-call-carries-it', 203, [
  created, { type: 'response.output_item.added', item: done }, { type: 'response.function_call_arguments.done', item_id: 'fc_done', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', item: { ...done, arguments: '{"path":"a.txt"}' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'call_open', name: 'edit' } }, { type: 'response.function_call_arguments.delta', item_id: 'fc_open', delta: '{"pa' },
], { close: [1006, 'gone'] });
const abortRows = [['user-abort', new Error('stop')], ['watchdog-abort', Object.assign(new Error('stalled'), { name: 'AgentStallAbortError' })]];
for (const [id, reason] of abortRows) await rec.run(`external-abort-tags-${id}`, `${SRC}:361`, { frames: [created], abort: { name: reason.name, message: reason.message } }, () => stream([created], { abort: reason }));
await rec.finish();
