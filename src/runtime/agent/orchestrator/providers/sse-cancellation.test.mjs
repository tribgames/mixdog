import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSSEStream } from './anthropic-sse.mjs';
import { consumeGeminiRestStreamResponse } from './gemini-stream.mjs';

const protocols = [
  {
    name: 'Anthropic',
    frames: [
      { type: 'message_start', message: { id: 'fixture', model: 'fixture', usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'visible partial' } },
    ],
    consume: (response, signal, onText) =>
      parseSSEStream(response, signal, null, null, null, {}, onText),
  },
  {
    name: 'Gemini REST',
    frames: [{ candidates: [{ content: { role: 'model', parts: [{ text: 'visible partial' }] } }] }],
    consume: (response, signal, onText) => consumeGeminiRestStreamResponse(response, {
      signal, onTextDelta: onText, label: 'fixture',
    }),
  },
];

function openResponse(frames) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      if (frames.length) controller.enqueue(new TextEncoder().encode(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      ));
    },
    cancel() { cancelled = true; },
  });
  return { response: { body }, cancelled: () => cancelled };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cancelled stream did not settle')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const { name, frames, consume } of protocols) {
  test(`${name} cancellation preserves the caller error when cancel resolves read as EOF`, async () => {
    const { response, cancelled } = openResponse(frames);
    const controller = new AbortController();
    const visible = Promise.withResolvers();
    const text = [];
    const result = consume(response, controller.signal, (delta) => {
      text.push(delta);
      visible.resolve();
    });
    await bounded(visible.promise);
    const reason = new Error('explicit caller cancellation');
    reason.name = 'AbortError';
    controller.abort(reason);
    await assert.rejects(bounded(result), (error) => error === reason);
    assert.equal(text.join(''), 'visible partial');
    assert.equal(cancelled(), true);
  });

  test(`${name} releases a received response body when cancellation precedes consumption`, async (t) => {
    const { response, cancelled } = openResponse([]);
    t.after(() => response.body.cancel().catch(() => {}));
    const controller = new AbortController();
    const reason = new Error('cancelled before consume');
    controller.abort(reason);
    await assert.rejects(bounded(consume(response, controller.signal)), (error) => error === reason);
    assert.equal(cancelled(), true);
  });
}
