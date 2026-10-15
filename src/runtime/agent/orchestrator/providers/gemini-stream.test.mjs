import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeGeminiRestStreamResponse,
  consumeGeminiSdkStream,
  createGeminiTextLeakGuard,
} from './gemini-stream.mjs';

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

  for (const deferToolCalls of [true, false]) {
    test(`Gemini ${name} cut stream with a text-leaked call is ${deferToolCalls ? 'replayable when the call is held back' : 'a replay boundary when the call is dispatched'}`, async () => {
      const dispatched = [];
      const textLeakGuard = createGeminiTextLeakGuard({
        knownToolNames: ['read'],
        onToolCall: (call) => dispatched.push(call),
        deferToolCalls,
      });
      const leaked = '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>';
      await assert.rejects(
        consume([{ candidates: [{ content: { parts: [{ text: leaked }] } }] }], { label: 'fixture', textLeakGuard }),
        (error) => {
          assert.equal(error.code, 'TRUNCATED_STREAM');
          assert.equal(textLeakGuard.getLeakedToolCalls().length, 1);
          assert.equal(error.emittedToolCall, deferToolCalls ? undefined : true);
          assert.equal(error.unsafeToRetry, deferToolCalls ? undefined : true);
          return true;
        }
      );
      assert.equal(dispatched.length, deferToolCalls ? 0 : 1);
    });
  }

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

  const inBand = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'quota gone',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }],
    },
  };
  const assertInBand = (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'resource_exhausted');
    assert.equal(error.retryAfterMs, 5000);
    assert.equal(error.details.length, 1);
    return true;
  };

  test(`Gemini ${name} in-band error envelope throws before dispatching text`, async () => {
    const text = [];
    await assert.rejects(consume([inBand], { label: 'fixture', onTextDelta: (d) => text.push(d) }), assertInBand);
    assert.deepEqual(text, []);
  });

  test(`Gemini ${name} in-band error after STOP does not become success`, async () => {
    await assert.rejects(
      consume(
        [{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }, inBand],
        { label: 'fixture' }
      ),
      assertInBand
    );
  });
}

test('Gemini REST in-band error in the unterminated tail is typed, not corruption', async () => {
  await assert.rejects(
    consumeGeminiRestStreamResponse(new Response(`data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })}`), {
      label: 'fixture',
    }),
    (error) => error.status === 503 && error.code === 'unavailable' && !error.truncatedStream
  );
});
