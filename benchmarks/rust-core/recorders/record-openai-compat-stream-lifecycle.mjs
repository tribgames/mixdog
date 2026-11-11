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
  set: 'provider-openai-compat-stream-lifecycle',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs consumeCompatChatCompletionStream / consumeCompatResponsesStream(stream, opts), retry-classifier.mjs classifyError, lib/stream-outcome.mjs readStreamOutcome, openai-compat-response-normalization.mjs normalizeCompatChatResponse. A stream is an async iterable over the recorded `events` (a `throws` entry makes the iterator throw it).',
  compare: 'mixdog-ai providers::compat chat decode (decode.rs:269, :483-489), openai decoder.rs:1011-1027 and compat/error.rs:314, retry/classify.rs: feed `input.events` (+ opts) and compare `error` whole (every own property), `outcome` (readStreamOutcome fields) and `classification`. The no-timer idle / cancel cases are GONE in the core by dec:138: the recording documents the Node timer behaviour only.',
  replay: "Rust entry (pub, on o1): the compat adapter driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079) (CompatAdapter, compat/adapter.rs:63) and mixdog_ai::retry::classify::kind_of (retry/classify.rs:142) for the classification.",
});
const P = 'agent/orchestrator/providers/';
const { consumeCompatChatCompletionStream, consumeCompatResponsesStream } = await rec.P(`${P}openai-compat-stream.mjs`);
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
const callbacks = (seen) => ({ onTextDelta: (text) => seen.push(text) });

for (const { name, consume } of protocols) {
  const slug = name.split(' ')[0].toLowerCase();
  const transient = { message: 'Our servers are currently overloaded. Please try again later.', type: 'server_error' };
  await rec.run(`${slug}-in-band-server-error-default-retries`, `${SRC}:79`, { label: name, wire: transient, shape: 'APIError with `error` attached and status undefined' }, async () => {
    const outcome = await rejection(consume(failingStream(inBandApiError(transient)), { label: name }));
    return { ...outcome, providerErrorIsTheWirePayload: outcome.error.providerError === transient };
  });
  const fatal = { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' };
  await rec.run(`${slug}-in-band-fatal-error-stays-terminal`, `${SRC}:95`, { label: name, wire: fatal }, () => rejection(consume(failingStream(inBandApiError(fatal)), { label: name })));
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
await rec.run('responses-unresolved-call-then-completed-carries-partial-usage', `${SRC}:268`, {}, async () => {
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
for (const { name, consume, event } of protocols) {
  const slug = name.split(' ')[0].toLowerCase();
  for (const interruption of ['cancel', 'idle']) {
    await rec.run(`${slug}-${interruption}-releases-pending-read-and-signal-listener`, `${SRC}:297`, { firstEvent: event, interruption, ...(interruption === 'idle' ? { semanticIdleTimeoutMs: 20, advanceMs: [20] } : { abortReason: { name: 'AbortError', message: 'caller cancellation' } }) }, async () => {
      const controller = new AbortController();
      const stream = waitingStream(event);
      const reason = new Error('caller cancellation');
      reason.name = 'AbortError';
      const result = rejection(consume(stream, { signal: controller.signal, label: 'fixture', onTextDelta() {}, ...(interruption === 'idle' ? { semanticIdleTimeoutMs: 20 } : {}) }));
      await stream.waiting;
      if (interruption === 'cancel') controller.abort(reason);
      else await rec.clock.advance(20);
      const outcome = await result;
      await stream.released;
      return { ...outcome, rejectedWithTheCallerReason: outcome.error === reason, listenersAfter: getEventListeners(controller.signal, 'abort').length };
    });
  }
}
await rec.finish();
