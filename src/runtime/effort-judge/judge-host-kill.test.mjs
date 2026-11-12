// A real child host killed hard mid-request: the caller gets the documented
// error, this process lives on, and the next call starts a fresh host.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('a judge host killed mid-request fails the call as "effort judge exited" and the next call is answered by a fresh host', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-kill-'));
  for (const file of ['model.onnx', 'tokenizer.json']) writeFileSync(join(dir, file), 'x');
  const helperUrl = new URL('../shared/onnx-child-host.mjs', import.meta.url).href;
  const hostPath = join(dir, 'fake-judge-host.mjs');
  writeFileSync(
    hostPath,
    `import { parentPort } from ${JSON.stringify(helperUrl)};
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
  if (msg.request === 'hang') return;
  parentPort.postMessage({ type: 'result', id: msg.id, probs: [0, 0, 1, 0], pid: process.pid });
});`
  );
  const saved = process.env.MIXDOG_EFFORT_JUDGE_DIR;
  process.env.MIXDOG_EFFORT_JUDGE_DIR = dir;
  const real = await import('../shared/onnx-child-host.mjs');
  const hosts = [];
  t.mock.module('../shared/onnx-child-host.mjs', {
    namedExports: {
      ChildWorker: class extends real.ChildWorker {
        constructor(_path, options) {
          super(hostPath, options);
          hosts.push(this);
        }
      },
    },
  });
  const client = await import(`./judge-client.mjs?kill=${Date.now()}`);
  // The client unrefs its host; the daemon's own work keeps the loop alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(async () => {
    await client.shutdownEffortJudge();
    clearInterval(keepAlive);
    if (saved === undefined) delete process.env.MIXDOG_EFFORT_JUDGE_DIR;
    else process.env.MIXDOG_EFFORT_JUDGE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const hanging = client.judgeTurn({ request: 'hang' });
  while (!client.effortJudgeReady()) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const firstPid = hosts[0].pid;
  assert.notEqual(firstPid, process.pid);
  process.kill(firstPid, 'SIGKILL');
  assert.deepEqual(await hanging, { skipped: 'effort judge exited' });
  assert.equal(process.kill(process.pid, 0), true, 'the daemon-side process is alive');

  // A cold start can outlast a judged turn's own wait on a loaded machine.
  client.prewarmEffortJudge();
  while (!client.effortJudgeReady()) await new Promise((resolve) => setTimeout(resolve, 20));
  const next = await client.judgeTurn({ request: 'ok' });
  assert.deepEqual(next.probs, [0, 0, 1, 0]);
  assert.equal(hosts.length, 2);
  assert.notEqual(hosts[1].pid, firstPid);
});
