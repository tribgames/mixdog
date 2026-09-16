import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeGeminiSdkStream } from './gemini-stream.mjs';

const chunk = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'visible partial' }] } }],
};

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SDK stream did not settle')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('Gemini SDK releases an acquired generation when already cancelled', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before consume');
  controller.abort(reason);
  let stopped = false;
  let returned = false;
  let finalized = 0;
  const aggregate = Promise.withResolvers();
  const stream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      throw new Error('cancelled generation must not be read');
    },
    async return() {
      returned = true;
      return { done: true };
    },
  };
  // Observe the fixture too, so a failing pre-fix run cannot escape the test.
  aggregate.promise.catch(() => {});
  await assert.rejects(
    bounded(
      consumeGeminiSdkStream(
        {
          stream,
          response: aggregate.promise,
        },
        {
          signal: controller.signal,
          label: 'fixture',
          cancelGeneration(error) {
            stopped = error === reason;
            aggregate.reject(error);
          },
          textLeakGuard: {
            finalize() {
              finalized++;
            },
          },
        }
      )
    ),
    (error) => error === reason
  );
  assert.equal(stopped, true);
  assert.equal(returned, true);
  assert.equal(finalized, 1);
});

test('Gemini SDK cancellation from a text callback cannot strand the next read', async (t) => {
  const controller = new AbortController();
  const reason = new Error('cancel after visible text');
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let stopped = false;
  const text = [];
  const stream = (async function* () {
    try {
      yield chunk;
    } finally {
      await release.promise;
    }
  })();
  await assert.rejects(
    bounded(
      consumeGeminiSdkStream(
        {
          stream,
          response: Promise.resolve({}),
        },
        {
          signal: controller.signal,
          label: 'fixture',
          cancellationGraceMs: 5,
          cancelGeneration() {
            stopped = true;
          },
          onTextDelta(delta) {
            text.push(delta);
            controller.abort(reason);
          },
        }
      )
    ),
    (error) => error === reason
  );
  assert.equal(stopped, true);
  assert.deepEqual(text, ['visible partial']);
  assert.equal(reason.liveTextEmitted, true);
  assert.equal(reason.unsafeToRetry, true);
});

for (const cleanup of ['ready', 'failed', 'pending']) {
  test(`Gemini SDK consumption failure stops its generation with ${cleanup} cleanup`, async () => {
    const reason = new Error('fixture parser failure');
    let stopped = false;
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        throw reason;
      },
      async return() {
        if (cleanup === 'failed') throw new Error('fixture cleanup failure');
        if (cleanup === 'pending') await new Promise(() => {});
        return { done: true };
      },
    };
    await assert.rejects(
      bounded(
        consumeGeminiSdkStream(
          {
            stream,
            response: Promise.resolve({}),
          },
          {
            label: 'fixture',
            cancellationGraceMs: 5,
            cancelGeneration() {
              stopped = true;
            },
          }
        )
      ),
      (error) => error === reason
    );
    assert.equal(stopped, true);
  });
}

test('Gemini SDK cancellation interrupts a pending aggregate response', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel while awaiting aggregate');
  const aggregate = Promise.withResolvers();
  let stopped = false;
  const stream = (async function* () {})();
  const result = consumeGeminiSdkStream(
    {
      stream,
      get response() {
        setImmediate(() => controller.abort(reason));
        return aggregate.promise;
      },
    },
    {
      signal: controller.signal,
      label: 'fixture',
      cancelGeneration() {
        stopped = true;
      },
    }
  );
  await assert.rejects(bounded(result), (error) => error === reason);
  assert.equal(stopped, true);
});

test('Gemini SDK does not publish a received chunk after cancellation wins its delivery', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel before delivery');
  const text = [];
  const stream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
      return Promise.resolve({ value: chunk, done: false });
    },
    async return() {
      return { done: true };
    },
  };
  await assert.rejects(
    bounded(
      consumeGeminiSdkStream(
        {
          stream,
          response: Promise.resolve({}),
        },
        {
          signal: controller.signal,
          label: 'fixture',
          onTextDelta(delta) {
            text.push(delta);
          },
        }
      )
    ),
    (error) => error === reason
  );
  assert.deepEqual(text, []);
});

test('Gemini SDK first-byte timeout stops the request even when iterator cleanup hangs', async () => {
  const read = Promise.withResolvers();
  let stopped = false;
  const stream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return read.promise;
    },
    return() {
      return new Promise(() => {});
    },
  };
  await assert.rejects(
    bounded(
      consumeGeminiSdkStream(
        {
          stream,
          response: Promise.resolve({}),
        },
        {
          label: 'fixture',
          firstByteTimeoutMs: 5,
          cancellationGraceMs: 5,
          cancelGeneration() {
            stopped = true;
            read.resolve({ done: true });
          },
        }
      )
    ),
    (error) => error.code === 'EGEMINITIMEOUT'
  );
  assert.equal(stopped, true);
});
