import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeGeminiRestStreamResponse, consumeGeminiSdkStream } from './gemini-stream.mjs';

const protocols = [
  {
    name: 'REST',
    consume(chunks, options) {
      return consumeGeminiRestStreamResponse(
        new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')),
        options
      );
    },
  },
  {
    name: 'SDK',
    consume(chunks, options) {
      return consumeGeminiSdkStream(
        {
          stream: (async function* () {
            yield* chunks;
          })(),
          response: Promise.resolve({}),
        },
        options
      );
    },
  },
];

const nativePart = {
  functionCall: { id: 'native-id', name: 'read', args: { path: 'fixture' } },
  thoughtSignature: 'native-signature',
};

for (const { name, consume } of protocols) {
  test(`Gemini ${name} native tool chunks remain replayable until stream completion`, async () => {
    const progress = [];
    await assert.rejects(
      consume([{ candidates: [{ content: { parts: [nativePart] } }] }], {
        label: 'fixture',
        onStreamDelta: (kind) => progress.push(kind),
      }),
      (error) => {
        assert.equal(error.code, 'TRUNCATED_STREAM');
        assert.equal(error.emittedToolCall, undefined);
        assert.equal(error.unsafeToRetry, undefined);
        return true;
      }
    );
    assert.deepEqual(progress, ['tool']);
  });

  test(`Gemini ${name} visible text still prevents replay when a native tool chunk follows`, async () => {
    const text = [];
    await assert.rejects(
      consume(
        [
          { candidates: [{ content: { parts: [{ text: 'visible' }] } }] },
          { candidates: [{ content: { parts: [nativePart] } }] },
        ],
        { label: 'fixture', onTextDelta: (delta) => text.push(delta) }
      ),
      (error) => {
        assert.equal(error.code, 'TRUNCATED_STREAM');
        assert.equal(error.unsafeToRetry, true);
        assert.equal(error.liveTextEmitted, true);
        assert.equal(error.emittedToolCall, undefined);
        assert.equal(error.pendingToolUse, false);
        assert.equal(error.partialContent, 'visible');
        return true;
      }
    );
    assert.deepEqual(text, ['visible']);
  });

  test(`Gemini ${name} completion retains ordered native tool parts and signatures`, async () => {
    const parts = [{ text: 'answer' }, nativePart];
    const response = await consume(
      parts.map((part, index) => ({
        candidates: [{ content: { role: 'model', parts: [part] }, ...(index === 1 ? { finishReason: 'STOP' } : {}) }],
      })),
      { label: 'fixture' }
    );
    assert.deepEqual(response.candidates[0].content, { role: 'model', parts });
    assert.equal(response.candidates[0].finishReason, 'STOP');
  });
}
