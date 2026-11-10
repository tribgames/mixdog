import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSSEStream } from './anthropic-sse.mjs';

const encoder = new TextEncoder();
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const MESSAGE_START = frame({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } });
const TEXT_BLOCK = [
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  frame({ type: 'content_block_stop', index: 0 }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
].join('');
const MESSAGE_STOP = frame({ type: 'message_stop' });

// A response whose reader yields `steps` in order: a string chunk, or an
// Error the read rejects with. `releaseLockError` makes releaseLock throw.
function scriptedResponse(steps, { releaseLockError = null } = {}) {
  const queue = [...steps];
  const reader = {
    read: async () => {
      if (!queue.length) return { done: true, value: undefined };
      const step = queue.shift();
      if (step instanceof Error) throw step;
      return { done: false, value: encoder.encode(step) };
    },
    cancel: async () => {},
    releaseLock: () => {
      if (releaseLockError) throw releaseLockError;
    },
  };
  return { body: { getReader: () => reader } };
}

const parse = (response, state = {}, options = {}) =>
  parseSSEStream(response, new AbortController().signal, () => {}, null, null, state, null, null, {
    labels: { display: 'Anthropic', tag: 'anthropic' },
    ...options,
  });

test('a read failure before message_start rejects with the transport error untouched', async () => {
  const dropped = new Error('socket reset');
  await assert.rejects(parse(scriptedResponse([dropped])), (err) => {
    assert.equal(err, dropped);
    assert.equal(err.streamOutcome, undefined);
    return true;
  });
});

test('a read failure after message_start carries the partial turn on the same error', async () => {
  const dropped = new Error('socket reset');
  await assert.rejects(parse(scriptedResponse([MESSAGE_START, dropped])), (err) => {
    assert.equal(err, dropped);
    assert.equal(typeof err.streamOutcome, 'object');
    assert.equal(err.streamOutcome.provider, 'anthropic');
    return true;
  });
});

test('message_stop ends reading mid-chunk and the records after it are ignored', async () => {
  const late = frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE' } });
  const result = await parse(
    scriptedResponse([MESSAGE_START + TEXT_BLOCK + MESSAGE_STOP + late, new Error('never read')])
  );
  assert.equal(result.content, 'hi');
});

test('a releaseLock failure is reported under the stream tag and the turn still resolves', async () => {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    const result = await parse(
      scriptedResponse([MESSAGE_START + TEXT_BLOCK + MESSAGE_STOP], { releaseLockError: new Error('lock busy') })
    );
    assert.equal(result.content, 'hi');
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(
    lines.filter((line) => line.includes('releaseLock')),
    ['[anthropic] reader releaseLock failed: lock busy\n']
  );
});
