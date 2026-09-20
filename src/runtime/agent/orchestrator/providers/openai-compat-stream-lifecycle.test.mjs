import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { consumeCompatChatCompletionStream, consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { classifyError } from './retry-classifier.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';

// The SDK shape for an in-band `{"error": …}` stream chunk: the payload is
// attached, the status is absent.
function inBandApiError(error) {
  return Object.assign(new Error(error.message), { name: 'APIError', status: undefined, error });
}

function failingStream(error) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw error;
        },
      };
    },
  };
}

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

for (const { name, consume } of protocols) {
  test(`${name} in-band server error chunk default-retries under the wire-error contract`, async () => {
    const wire = { message: 'Our servers are currently overloaded. Please try again later.', type: 'server_error' };
    const err = await bounded(
      consume(failingStream(inBandApiError(wire)), { label: name }).then(
        () => assert.fail('expected the stream to reject'),
        (error) => error
      )
    );
    assert.equal(err.providerWireError, true);
    assert.equal(err.providerError, wire);
    assert.equal(err.providerErrorCode, 'server_error');
    assert.equal(err.httpStatus, undefined, 'no status is synthesized from text');
    assert.equal(readStreamOutcome(err).replaySafe, true, 'nothing was exposed');
    assert.equal(classifyError(err), 'transient');
  });

  test(`${name} in-band fatal error chunk stays terminal`, async () => {
    const wire = {
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    };
    const err = await bounded(
      consume(failingStream(inBandApiError(wire)), { label: name }).then(
        () => assert.fail('expected the stream to reject'),
        (error) => error
      )
    );
    assert.equal(err.providerWireError, true);
    assert.equal(classifyError(err), 'permanent');
  });
}

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
        interruption === 'cancel' ? error === reason : error.streamStalled === true
      );
      await bounded(stream.released);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
}
