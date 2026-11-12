// A real child host killed hard mid-request: the caller gets the documented
// error, this process lives on, and after the restart backoff the next request
// starts a fresh host and is answered.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('an embedding host killed mid-request rejects the call, and the next request after the backoff is answered by a fresh host', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-embed-kill-'));
  const helperUrl = new URL('../../shared/onnx-child-host.mjs', import.meta.url).href;
  const hostPath = join(dir, 'fake-embed-host.mjs');
  writeFileSync(
    hostPath,
    `import { parentPort } from ${JSON.stringify(helperUrl)};
parentPort.on('message', (msg) => {
  if (msg.text === 'hang') return;
  parentPort.postMessage({ id: msg.id, type: 'result', vector: [0.5, 0.25, 0.125], dims: 3, wallMs: 0, device: 'cpu', dtype: 'q8' });
});`
  );
  const real = await import('../../shared/onnx-child-host.mjs');
  const hosts = [];
  t.mock.module('../../shared/onnx-child-host.mjs', {
    namedExports: {
      ChildWorker: class extends real.ChildWorker {
        constructor(_path, options) {
          super(hostPath, options);
          hosts.push(this);
        }
      },
    },
  });
  const provider = await import(`./embedding-provider.mjs?kill=${Date.now()}`);
  t.after(async () => {
    await provider.shutdownEmbeddingProvider();
    rmSync(dir, { recursive: true, force: true });
  });

  const hanging = provider.embedText('hang');
  hanging.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const firstPid = hosts[0].pid;
  assert.notEqual(firstPid, process.pid);
  process.kill(firstPid, 'SIGKILL');
  await assert.rejects(hanging, /Worker exited with code/);
  assert.equal(process.kill(process.pid, 0), true, 'the daemon-side process is alive');

  await assert.rejects(provider.embedText('too soon'), /restart backoff/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(await provider.embedText('ok'), [0.5, 0.25, 0.125]);
  assert.equal(hosts.length, 2);
  assert.notEqual(hosts[1].pid, firstPid);
});
