/**
 * cursor-wire-stream-sink.mjs — the OpenAI-shaped SSE side of one Cursor
 * run: completion chunks, the terminal usage record and the two ways a
 * stream ends (finish / fail).
 */
import { textEncoder } from './cursor-wire-transport.mjs';

// Normalized usage of a Cursor run, from the terminal usage record.
export function cursorUsage(rawUsage) {
  const inputTokens =
    rawUsage.input_tokens_known === false ? null : Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens: Number(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0),
    cachedTokens: rawUsage.cache_tokens_known === false ? null : Number(rawUsage.cached_tokens ?? 0),
    promptTokens: inputTokens,
    inputTokensKnown: rawUsage.input_tokens_known !== false,
    cacheTokensKnown: rawUsage.cache_tokens_known !== false,
    contextTokens: rawUsage.context_tokens ?? null,
    raw: { ...rawUsage },
  };
}

export function completionChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function createStreamSink({ controller, id, model, filter, watchdog, state }) {
  const send = (event) => {
    if (!state.closed) controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const emit = (fields) => send(completionChunk(id, model, fields));
  const terminalUsage = () => ({
    completion_tokens: state.outputTokens,
    // Checkpoint occupancy is not per-request prompt usage
    // and supplies no cache split or billable token count.
    input_tokens_known: false,
    cache_tokens_known: false,
    context_tokens: state.contextTokens,
  });
  const finish = (reason = 'stop') => {
    if (state.closed) return;
    watchdog.stop();
    const flushed = filter.flush();
    if (flushed.reasoning) emit({ reasoning_content: flushed.reasoning });
    if (flushed.content) emit({ content: flushed.content });
    send(completionChunk(id, model, {}, reason));
    send({
      ...completionChunk(id, model, {}),
      choices: [],
      usage: terminalUsage(),
    });
    controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
    state.closed = true;
    controller.close();
  };
  const fail = (error) => {
    if (state.closed) return;
    watchdog.stop();
    state.closed = true;
    const failure = error instanceof Error ? error : new Error(String(error));
    // Output the provider already reported is carried in the shape the
    // successful result reports; input/cache stay unknown, as in finish().
    if (state.outputTokens > 0 && !failure.partialUsage) {
      try {
        failure.partialUsage = cursorUsage(terminalUsage());
      } catch {
        /* best-effort */
      }
    }
    controller.error(failure);
  };
  return { send, emit, finish, fail };
}
