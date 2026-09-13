import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import {
  consumeCompatChatCompletionStream,
  consumeCompatResponsesStream,
} from './openai-compat-stream.mjs';

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('stream did not settle')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitingStream(firstEvent) {
  const controller = new AbortController();
  const waiting = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    controller,
    waiting: waiting.promise,
    released: released.promise,
    async *[Symbol.asyncIterator]() {
      try {
        yield firstEvent;
        // Match an SDK iterator blocked on its own HTTP request. return() alone
        // cannot interrupt this await: the owning request must be aborted.
        await new Promise((resolve) => {
          controller.signal.addEventListener('abort', resolve, { once: true });
          waiting.resolve();
        });
      } finally {
        released.resolve();
      }
    },
  };
}

const protocols = [
  {
    name: 'Chat Completions',
    consume: consumeCompatChatCompletionStream,
    event: { choices: [{ delta: { content: 'visible partial' }, finish_reason: null }] },
  },
  {
    name: 'Responses',
    consume: consumeCompatResponsesStream,
    event: { type: 'response.output_text.delta', delta: 'visible partial' },
  },
];

for (const { name, consume, event } of protocols) {
  for (const interruption of ['cancel', 'idle']) {
    test(`${name} ${interruption} releases a pending SDK read and its signal listener`, async () => {
      const controller = new AbortController();
      const stream = waitingStream(event);
      const reason = new Error('caller cancellation');
      reason.name = 'AbortError';
      const result = consume(stream, {
        signal: controller.signal,
        label: 'fixture',
        onTextDelta() {},
        ...(interruption === 'idle' ? { semanticIdleTimeoutMs: 20 } : {}),
      });
      await bounded(stream.waiting);
      if (interruption === 'cancel') controller.abort(reason);
      await assert.rejects(bounded(result), (error) =>
        interruption === 'cancel' ? error === reason : error.streamStalled === true);
      await bounded(stream.released);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
}
