import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { consumeCompatChatCompletionStream, consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { classifyError } from './retry-classifier.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { normalizeCompatChatResponse } from './openai-compat-response-normalization.mjs';

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

const rejection = (promise) =>
  bounded(promise).then(
    () => assert.fail('expected the stream to reject'),
    (error) => error
  );

function arrayStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

test('chat finish_reason network_error is a typed interruption that keeps partial output and exposure', async () => {
  const events = [
    { choices: [{ delta: { content: 'half an ans' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'network_error' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ];
  const seen = [];
  const err = await rejection(
    consumeCompatChatCompletionStream(arrayStream(events), {
      label: 'gateway',
      providerName: 'gateway',
      onTextDelta: (text) => seen.push(text),
      parseToolCalls: () => [],
    })
  );
  assert.equal(err.name, 'StreamInterruptedError');
  assert.equal(err.streamInterrupted, true);
  assert.equal(err.finishReason, 'network_error');
  assert.equal(err.partialContent, 'half an ans');
  assert.equal(err.partialUsage.outputTokens, 2);
  assert.equal(err.liveTextEmitted, true);
  const outcome = readStreamOutcome(err);
  assert.equal(outcome.terminalObserved, false);
  assert.equal(outcome.continuation, true);
  assert.equal(outcome.replaySafe, false);
});

test('chat finish_reason error is a typed 502 upstream_error that keeps partial output', async () => {
  const events = [
    { choices: [{ delta: { content: 'part' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'error' }] },
  ];
  const err = await rejection(
    consumeCompatChatCompletionStream(arrayStream(events), {
      label: 'command-code-oauth',
      providerName: 'command-code-oauth',
      onTextDelta() {},
      parseToolCalls: () => [],
    })
  );
  assert.equal(err.status, 502);
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.finishReason, 'error');
  assert.equal(err.partialContent, 'part');
  assert.equal(readStreamOutcome(err).replaySafe, false);
  const bare = await rejection(
    consumeCompatChatCompletionStream(arrayStream([{ choices: [{ delta: {}, finish_reason: 'error' }] }]), {
      label: 'command-code-oauth',
      providerName: 'command-code-oauth',
      parseToolCalls: () => [],
    })
  );
  assert.equal(readStreamOutcome(bare).replaySafe, true);
  assert.equal(classifyError(bare), 'transient');
});

test('chat finish_reason network_error before any exposure stays replay-safe', async () => {
  const events = [{ choices: [{ delta: {}, finish_reason: 'NETWORK_ERROR' }] }];
  const err = await rejection(
    consumeCompatChatCompletionStream(arrayStream(events), {
      label: 'gateway',
      providerName: 'gateway',
      parseToolCalls: () => [],
    })
  );
  assert.equal(err.streamInterrupted, true);
  const outcome = readStreamOutcome(err);
  assert.equal(outcome.terminalObserved, false);
  assert.equal(outcome.replaySafe, true);
  assert.equal(classifyError(err), 'transient');
});

test('chat finish_reason network_error from a non-streaming response never normalizes to success', () => {
  const assembled = {
    response: {
      model: 'm',
      choices: [{ message: { content: 'cut' }, finish_reason: 'network_error' }],
    },
    toolCalls: [],
    content: 'cut',
  };
  assert.throws(
    () => normalizeCompatChatResponse({ providerName: 'gateway', useModel: 'm', opts: {}, assembled }),
    (error) => error.streamInterrupted === true && error.partialContent === 'cut'
  );
});

for (const { name, consume } of protocols) {
  test(`${name} malformed JSON frame is typed malformed_stream with exposure evidence`, async () => {
    const protocol = protocols.find((p) => p.name === name);
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield protocol.event;
        // The SDK's own JSON.parse of a frame.
        JSON.parse('{"choices": [');
      },
    };
    const err = await rejection(
      consume(stream, { label: 'gateway', providerName: 'gateway', onTextDelta() {}, parseToolCalls: () => [] })
    );
    assert.equal(err.code, 'malformed_stream');
    assert.equal(err.malformedStream, true);
    assert.ok(err.cause instanceof SyntaxError);
    assert.match(err.message, /gateway malformed stream frame/);
    assert.equal(err.partialContent, 'visible partial');
    assert.equal(err.liveTextEmitted, true);
    assert.equal(readStreamOutcome(err).replaySafe, false);
  });

  test(`${name} malformed JSON before any output stays replay-safe`, async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        JSON.parse('not json');
      },
    };
    const err = await rejection(consume(stream, { label: 'gateway', providerName: 'gateway' }));
    assert.equal(err.code, 'malformed_stream');
    assert.equal(readStreamOutcome(err).replaySafe, true);
  });
}

test('Responses failure constructors carry the provider label', async () => {
  const label = 'custom-gw:responses';
  const cases = [
    [{ type: 'response.failed', response: { error: { message: 'boom' } } }, `${label} stream response.failed: boom`],
    [{ type: 'error', message: 'bad' }, `${label} stream error: bad`],
    [
      { type: 'response.done', response: { status: 'failed', error: { message: 'x' } } },
      `${label} stream response.done failed: x`,
    ],
    [
      { type: 'response.done', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } },
      `${label} stream response.done incomplete: content_filter`,
    ],
    [
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } },
      `${label} stream response.incomplete: content_filter`,
    ],
  ];
  for (const [event, message] of cases) {
    const err = await rejection(consumeCompatResponsesStream(arrayStream([event]), { label }));
    assert.equal(err.message, message);
    assert.doesNotMatch(err.message, /xAI/);
  }
  const salvage = await rejection(
    consumeCompatResponsesStream(
      arrayStream([
        { type: 'response.function_call_arguments.done', item_id: 'item_9', arguments: '{}' },
        { type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } },
      ]),
      { label, responseOutputText: () => '', parseResponsesToolCalls: () => [] }
    )
  );
  assert.equal(
    salvage.message,
    `${label} stream function_call salvage failed: missing call_id/name for item_id=item_9`
  );
});

test('Responses unresolved call followed by response.completed carries partialUsage', async () => {
  const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
  const events = [
    { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: '{}' },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage } },
  ];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
  const err = await bounded(
    consumeCompatResponsesStream(stream, {
      label: 'fixture',
      responseOutputText: () => '',
      parseResponsesToolCalls: () => [],
    }).then(
      () => assert.fail('expected the stream to reject'),
      (error) => error
    )
  );
  assert.match(err.message, /salvage failed/);
  assert.equal(err.partialUsage.outputTokens, 7);
  assert.equal(err.partialUsage.inputTokens, 11);
});

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
