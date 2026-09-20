/**
 * cursor-wire-stream-sink.mjs — the OpenAI-shaped SSE side of one Cursor
 * run: completion chunks, the terminal usage record and the two ways a
 * stream ends (finish / fail).
 */
import { textEncoder } from './cursor-wire-transport.mjs';

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
      usage: {
        completion_tokens: state.outputTokens,
        // Checkpoint occupancy is not per-request prompt usage
        // and supplies no cache split or billable token count.
        input_tokens_known: false,
        cache_tokens_known: false,
        context_tokens: state.contextTokens,
      },
    });
    controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
    state.closed = true;
    controller.close();
  };
  const fail = (error) => {
    if (state.closed) return;
    watchdog.stop();
    state.closed = true;
    controller.error(error instanceof Error ? error : new Error(String(error)));
  };
  return { send, emit, finish, fail };
}
