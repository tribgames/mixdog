import assert from 'node:assert/strict';
import test from 'node:test';
import { registerNativeWebSearchUsageSink, reportNativeWebSearchUsage } from './native-web-search-usage.mjs';

const report = (ownerSessionId, inputTokens) =>
  reportNativeWebSearchUsage({ ownerSessionId, sessionId: `${ownerSessionId}:ws`, model: 'm', usage: { inputTokens } });

test('releasing overlapping registrations in any order removes only the releasing entry', () => {
  const a = [];
  const b = [];
  const releaseA = registerNativeWebSearchUsageSink('s1', (d) => a.push(d.deltaInput));
  const releaseB = registerNativeWebSearchUsageSink('s1', (d) => b.push(d.deltaInput));
  report('s1', 1);
  releaseA();
  report('s1', 2);
  releaseB();
  report('s1', 3);
  assert.deepEqual(a, []);
  assert.deepEqual(b, [1, 2]);
});

test('releasing the newer registration first leaves the older live and never revives a released one', () => {
  const a = [];
  const b = [];
  const releaseA = registerNativeWebSearchUsageSink('s2', (d) => a.push(d.deltaInput));
  const releaseB = registerNativeWebSearchUsageSink('s2', (d) => b.push(d.deltaInput));
  releaseB();
  report('s2', 1);
  releaseA();
  releaseA();
  report('s2', 2);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, []);
});

test('a rejecting async sink is contained', async () => {
  const release = registerNativeWebSearchUsageSink('s3', async () => {
    throw new Error('sink boom');
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => report('s3', 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    release();
  }
  assert.deepEqual(unhandled, []);
});
