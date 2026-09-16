import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { embeddingWorkerExecArgv } from './embedding-provider.mjs';

test('embedding worker keeps safe Node flags but drops inherited isolate heap flags', () => {
  assert.deepEqual(
    embeddingWorkerExecArgv([
      '--max-old-space-size=512',
      '--max-semi-space-size=32',
      '--initial-old-space-size=128',
      '--input-type=module',
      '--trace-warnings',
      '--require',
      'loader.cjs',
    ]),
    ['--trace-warnings', '--require', 'loader.cjs']
  );
});

test('a cold embedding worker uses the saved dtype and reconfigures without loading a model', async () => {
  const worker = new Worker(new URL('./embedding-worker.mjs', import.meta.url), {
    env: { ...process.env, MIXDOG_EMBED_MODEL: 'Xenova/bge-m3' },
    workerData: { dtype: 'q8' },
    execArgv: embeddingWorkerExecArgv(),
  });
  let nextId = 0;
  const request = (action, args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('embedding control timed out'));
      }, 10_000);
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onMessage = (message) => {
        if (message.id !== id) return;
        cleanup();
        if (message.type === 'error') reject(new Error(message.message));
        else resolve(message);
      };
      function cleanup() {
        clearTimeout(timer);
        worker.off('error', onError);
        worker.off('message', onMessage);
      }
      worker.on('error', onError);
      worker.on('message', onMessage);
      worker.postMessage({ id, action, ...args });
    });
  try {
    assert.equal((await request('dispose')).dtype, 'q8');
    await request('configure', { dtype: 'fp16' });
    assert.equal((await request('dispose')).dtype, 'fp16');
  } finally {
    await worker.terminate();
  }
});
