#!/usr/bin/env node
// openai-compat-stream-lifecycle.test.mjs (every test: in-band server error, finish_reason network_error / error, malformed frame, label
// constructors, unresolved call partialUsage, cancel / idle release of a pending read): the real `consumeCompatChatCompletionStream` /
// `consumeCompatResponsesStream` over scripted async-iterable event streams, the real `classifyError`, `readStreamOutcome` and
// `normalizeCompatChatResponse`. A rejection is recorded whole (name, message, code and every own property incl. `cause`) with the
// outcome and classification the test reads. The idle case runs the semantic-idle timer on the virtual clock (the step is an input).
//   node benchmarks/rust-core/recorders/record-openai-compat-stream-lifecycle.mjs --tree <exact export of b6f10295a>
import { getEventListeners } from 'node:events';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  pure: {
    'chat-*': 'mixdog-ai/src/providers/compat/chat/decode.rs:155 ChatDecoder (pub, re-exported at compat/chat/mod.rs:18; feed :578, finish :601, with_known_tools :224)',
    'responses-*': 'mixdog-ai/src/providers/openai/decoder.rs:140 ResponsesDecoder (pub mod decoder; new :408, with_label :724, compat_events :734, feed/finish in `impl WireDecoder` :1362)',
    'non-streaming-*': 'RUST WORK: no public Rust function takes a non-streaming chat response (looked in providers/compat/chat/decode.rs: pub items are ChatDecoder and usage_from only)',
  },
  set: 'provider-openai-compat-stream-lifecycle',
  entry: 'src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs consumeCompatChatCompletionStream / consumeCompatResponsesStream(stream, opts), retry-classifier.mjs classifyError, lib/stream-outcome.mjs readStreamOutcome, openai-compat-response-normalization.mjs normalizeCompatChatResponse. A stream is an async iterable over the recorded `events` (a `throws` entry makes the iterator throw it).',
  compare: 'WIRE cases (in-band error frames, cancel, idle: the `requests` array holds the request as it arrived; `clock` the ordered virtual-clock steps, retry backoffs included): serve each case\'s frames from a loopback endpoint through the Rust provider send and compare `error` whole (every own property), `outcome` and `classification`. PURE cases (decoder-only): feed `input.events` (chat chunks or Responses events, each as one SSE `data:` unit) to the named public decoder and compare the error / typed interruption it returns; `levels` in this manifest names the Rust function per case.',
  replay: "WIRE: mixdog_ai provider send (ModelBroker::send, mixdog-ai/src/broker/send.rs:75, with the compat adapter providers/compat/adapter.rs:63) against a loopback endpoint; PURE: the public decoders named per case in `levels`: mixdog-ai/src/providers/compat/chat/decode.rs:155 ChatDecoder (pub, re-exported at compat/chat/mod.rs:18; feed :578, finish :601, with_known_tools :224); mixdog-ai/src/providers/openai/decoder.rs:140 ResponsesDecoder (pub mod decoder; new :408, with_label :724, compat_events :734, feed/finish in `impl WireDecoder` :1362). The non-streaming normalizer case is Rust work: compat/chat/decode.rs exposes only the streaming ChatDecoder (+ `usage_from` :99), no public function turns an already assembled non-streaming chat response into a typed result.",
});
const P = 'agent/orchestrator/providers/';
const { consumeCompatChatCompletionStream, consumeCompatResponsesStream } = await rec.P(`${P}openai-compat-stream.mjs`);
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const { sendCompatResponses } = await rec.P(`${P}openai-compat-responses.mjs`);
const { PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS } = await rec.P('agent/orchestrator/stall-policy.mjs');
const { classifyError } = await rec.P(`${P}retry-classifier.mjs`);
const { readStreamOutcome } = await rec.P(`${P}lib/stream-outcome.mjs`);
const { normalizeCompatChatResponse } = await rec.P(`${P}openai-compat-response-normalization.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-compat-stream-lifecycle.test.mjs';

const inBandApiError = (error) => Object.assign(new Error(error.message), { name: 'APIError', status: undefined, error });
const failingStream = (error) => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw error; } }) });
const arrayStream = (events) => ({ async *[Symbol.asyncIterator]() { yield* events; } });
const protocols = [
  { name: 'Chat Completions', consume: consumeCompatChatCompletionStream, event: { choices: [{ delta: { content: 'visible partial' }, finish_reason: null }] } },
  { name: 'Responses', consume: consumeCompatResponsesStream, event: { type: 'response.output_text.delta', delta: 'visible partial' } },
];
const rejection = async (promise) => {
  try {
    await promise;
    return { resolved: true };
  } catch (error) {
    return { error, outcome: readStreamOutcome(error), classification: classifyError(error) };
  }
};
// WIRE level: the real provider (real SDK client) sends to the loopback endpoint, which serves the scripted frames (each its own socket write; `hold` keeps the response open
// until the client closes the connection). The request that arrived is recorded in `requests` of the case.
const HISTORY = [{ role: 'user', content: 'hi' }];
const wireProvider = () => new OpenAICompatProvider('gateway', { apiKey: 'fixture-key', baseURL: 'https://gateway.example/v1', preconnect: false });
const serveFrames = (name, frames, hold = false) => {
  rec.net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: frames.map((e) => (name === 'Responses' ? `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`)), hold });
};
const sendOver = (name, opts) => (name === 'Responses' ? sendCompatResponses(wireProvider(), HISTORY, 'gpt-5.5', [], opts) : wireProvider().send(HISTORY, 'm1', [], opts));
const callbacks = (seen) => ({ onTextDelta: (text) => seen.push(text) });

for (const { name, consume } of protocols) {
  const slug = name.split(' ')[0].toLowerCase();
  const transient = { message: 'Our servers are currently overloaded. Please try again later.', type: 'server_error' };
  await rec.run(`${slug}-in-band-server-error-default-retries`, `${SRC}:79`, { label: name, wire: transient, frames: [{ error: transient }] }, async () => {
    serveFrames(name, [{ error: transient }]);
    return rec.clock.followRetries(rejection(sendOver(name, {})));
  });
  const fatal = { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' };
  await rec.run(`${slug}-in-band-fatal-error-stays-terminal`, `${SRC}:95`, { label: name, wire: fatal, frames: [{ error: fatal }] }, async () => {
    serveFrames(name, [{ error: fatal }]);
    return rec.clock.followRetries(rejection(sendOver(name, {})));
  });
}
const chatEvents = {
  networkError: [{ choices: [{ delta: { content: 'half an ans' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'network_error' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }],
  error: [{ choices: [{ delta: { content: 'part' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'error' }] }],
  bareError: [{ choices: [{ delta: {}, finish_reason: 'error' }] }],
  upperNetworkError: [{ choices: [{ delta: {}, finish_reason: 'NETWORK_ERROR' }] }],
};
await rec.run('chat-network-error-typed-interruption-keeps-partial-and-exposure', `${SRC}:126`, { events: chatEvents.networkError, opts: { label: 'gateway', providerName: 'gateway' } }, async () => {
  const seen = [];
  return { ...(await rejection(consumeCompatChatCompletionStream(arrayStream(chatEvents.networkError), { label: 'gateway', providerName: 'gateway', ...callbacks(seen), parseToolCalls: () => [] }))), textDeltas: seen };
});
await rec.run('chat-error-finish-typed-502-upstream-error', `${SRC}:152`, { events: chatEvents.error, bareEvents: chatEvents.bareError, opts: { label: 'command-code-oauth', providerName: 'command-code-oauth' } }, async () => ({
  withOutput: await rejection(consumeCompatChatCompletionStream(arrayStream(chatEvents.error), { label: 'command-code-oauth', providerName: 'command-code-oauth', onTextDelta() {}, parseToolCalls: () => [] })),
  bare: await rejection(consumeCompatChatCompletionStream(arrayStream(chatEvents.bareError), { label: 'command-code-oauth', providerName: 'command-code-oauth', parseToolCalls: () => [] })),
}));
await rec.run('chat-network-error-before-exposure-replay-safe', `${SRC}:181`, { events: chatEvents.upperNetworkError, opts: { label: 'gateway', providerName: 'gateway' } }, () => rejection(consumeCompatChatCompletionStream(arrayStream(chatEvents.upperNetworkError), { label: 'gateway', providerName: 'gateway', parseToolCalls: () => [] })));
const assembled = { response: { model: 'm', choices: [{ message: { content: 'cut' }, finish_reason: 'network_error' }] }, toolCalls: [], content: 'cut' };
await rec.run('non-streaming-network-error-never-normalizes-to-success', `${SRC}:197`, { providerName: 'gateway', useModel: 'm', opts: {}, assembled }, () => {
  try {
    return { normalized: normalizeCompatChatResponse({ providerName: 'gateway', useModel: 'm', opts: {}, assembled }) };
  } catch (error) {
    return { error };
  }
});
for (const { name, consume, event } of protocols) {
  const slug = name.split(' ')[0].toLowerCase();
  await rec.run(`${slug}-malformed-json-frame-typed-with-exposure`, `${SRC}:213`, { label: 'gateway', events: [event], then: "JSON.parse('{\"choices\": [')" }, async () => {
    const stream = { async *[Symbol.asyncIterator]() { yield event; JSON.parse('{"choices": ['); } };
    return rejection(consume(stream, { label: 'gateway', providerName: 'gateway', onTextDelta() {}, parseToolCalls: () => [] }));
  });
  await rec.run(`${slug}-malformed-json-before-output-replay-safe`, `${SRC}:234`, { label: 'gateway', events: [], then: "JSON.parse('not json')" }, async () => {
    const stream = { async *[Symbol.asyncIterator]() { JSON.parse('not json'); } };
    return rejection(consume(stream, { label: 'gateway', providerName: 'gateway' }));
  });
}
await rec.run('responses-failure-constructors-carry-the-provider-label', `${SRC}:246`, { label: 'custom-gw:responses' }, async () => {
  const label = 'custom-gw:responses';
  const events = [
    { type: 'response.failed', response: { error: { message: 'boom' } } },
    { type: 'error', message: 'bad' },
    { type: 'response.done', response: { status: 'failed', error: { message: 'x' } } },
    { type: 'response.done', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } },
  ];
  const rows = [];
  for (const event of events) rows.push({ event, ...(await rejection(consumeCompatResponsesStream(arrayStream([event]), { label }))) });
  const salvageEvents = [{ type: 'response.function_call_arguments.done', item_id: 'item_9', arguments: '{}' }, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } }];
  const salvage = { events: salvageEvents, ...(await rejection(consumeCompatResponsesStream(arrayStream(salvageEvents), { label, responseOutputText: () => '', parseResponsesToolCalls: () => [] }))) };
  return { rows, salvage };
});
await rec.run('responses-unresolved-call-then-completed-carries-partial-usage', `${SRC}:284`, {}, async () => {
  const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
  const events = [{ type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: '{}' }, { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage } }];
  return { events, ...(await rejection(consumeCompatResponsesStream(arrayStream(events), { label: 'fixture', responseOutputText: () => '', parseResponsesToolCalls: () => [] }))) };
});

const waitingStream = (firstEvent) => {
  const controller = new AbortController();
  const waiting = Promise.withResolvers();
  const released = Promise.withResolvers();
  return rec.describe({
    controller,
    waiting: waiting.promise,
    released: released.promise,
    async *[Symbol.asyncIterator]() {
      try {
        yield firstEvent;
        await new Promise((resolve) => {
          controller.signal.addEventListener('abort', resolve, { once: true });
          waiting.resolve();
        });
      } finally {
        released.resolve();
      }
    },
  }, { $stream: [firstEvent], then: 'the stream yields the first event, then waits until the caller aborts its signal and ends' });
};
for (const { name, event } of protocols) {
  const slug = name.split(' ')[0].toLowerCase();
  for (const interruption of ['cancel', 'idle']) {
    await rec.run(`${slug}-${interruption}-releases-pending-read-and-signal-listener`, `${SRC}:312`, { firstEvent: event, interruption, ...(interruption === 'idle' ? { advanceMs: [PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS] } : { abortReason: { name: 'AbortError', message: 'caller cancellation' } }) }, async () => {
      const controller = new AbortController();
      const reason = new Error('caller cancellation');
      reason.name = 'AbortError';
      const delivered = Promise.withResolvers();
      serveFrames(name, [event], true);
      const result = rejection(sendOver(name, { signal: controller.signal, onTextDelta: () => delivered.resolve() }));
      await delivered.promise;
      if (interruption === 'cancel') controller.abort(reason);
      else await rec.clock.advance(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS, { what: 'semantic idle window' });
      const outcome = await result;
      await rec.net.records[0].whenClientClosed;
      return { ...outcome, rejectedWithTheCallerReason: outcome.error === reason, listenersAfter: getEventListeners(controller.signal, 'abort').length };
    });
  }
}
await rec.finish();
