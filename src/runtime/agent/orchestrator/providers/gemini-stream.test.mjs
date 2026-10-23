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

// A call whose arguments are still streaming in pieces is not a whole call.
const partialPart = {
  functionCall: { id: 'partial-id', name: 'read', args: { path: 'frag' }, willContinue: true },
};

for (const { name, consume } of protocols) {
  test(`Gemini ${name} stream without finishReason that delivered a whole functionCall ends normally`, async () => {
    const progress = [];
    const response = await consume([{ candidates: [{ content: { role: 'model', parts: [nativePart] } }] }], {
      label: 'fixture',
      onStreamDelta: (kind) => progress.push(kind),
    });
    assert.deepEqual(response.candidates[0].content.parts, [nativePart]);
    assert.equal(response.candidates[0].finishReason, undefined);
    assert.deepEqual(progress, ['tool']);
  });

  test(`Gemini ${name} stream without finishReason with parallel calls, one complete and one unfinished, stays TRUNCATED_STREAM`, async () => {
    for (const parts of [
      [nativePart, partialPart],
      [partialPart, nativePart],
      [nativePart, { functionCall: { name: 'read', partialArgs: [{ jsonPath: '$.path', stringValue: 'f' }] } }],
    ]) {
      await assert.rejects(
        consume([{ candidates: [{ content: { role: 'model', parts } }] }], { label: 'fixture' }),
        (error) => {
          assert.equal(error.code, 'TRUNCATED_STREAM');
          return true;
        }
      );
    }
  });

  test(`Gemini ${name} stream without finishReason with several complete parallel calls ends normally`, async () => {
    const second = { functionCall: { name: 'read', args: { path: 'second' } } };
    const response = await consume([{ candidates: [{ content: { role: 'model', parts: [nativePart, second] } }] }], {
      label: 'fixture',
    });
    assert.equal(response.candidates[0].content.parts.length, 2);
  });

  for (const [label, chunks] of [
    ['text only', [{ candidates: [{ content: { parts: [{ text: 'half an answer' }] } }] }]],
    ['thoughts only', [{ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }]],
    ['a partial functionCall', [{ candidates: [{ content: { parts: [partialPart] } }] }]],
    ['an empty candidate', [{ candidates: [{ content: { parts: [] } }] }]],
  ]) {
    test(`Gemini ${name} stream without finishReason and with ${label} stays TRUNCATED_STREAM`, async () => {
      await assert.rejects(consume(chunks, { label: 'fixture' }), (error) => {
        assert.equal(error.code, 'TRUNCATED_STREAM');
        return true;
      });
    });
  }

  test(`Gemini ${name} native tool chunks remain replayable until stream completion`, async () => {
    const progress = [];
    await assert.rejects(
      consume([{ candidates: [{ content: { parts: [partialPart] } }] }], {
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
          { candidates: [{ content: { parts: [partialPart] } }] },
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
    consumeGeminiRestStreamResponse(
      new Response(`data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })}`),
      {
        label: 'fixture',
      }
    ),
    (error) => error.status === 503 && error.code === 'unavailable' && !error.truncatedStream
  );
});

test('Gemini REST first-chunk window follows the caller and names its phase', { timeout: 5000 }, async (t) => {
  const silent = new Response(new ReadableStream({ start() {} }));
  // The watchdog timer is unref'd; keep the loop alive while it runs.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(
    consumeGeminiRestStreamResponse(silent, { label: 'fixture', firstByteTimeoutMs: 25 }),
    (error) =>
      error.code === 'EGEMINITIMEOUT' &&
      error.timeoutPhase === 'first-chunk' &&
      /fixture first byte timed out after 25ms/.test(error.message)
  );
});
