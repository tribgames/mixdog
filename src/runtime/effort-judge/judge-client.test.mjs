import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the model refresh starts on the first judged turn, once, and not on import', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-judge-client-'));
  const saved = { dir: process.env.MIXDOG_EFFORT_JUDGE_DIR, data: process.env.MIXDOG_DATA_DIR };
  delete process.env.MIXDOG_EFFORT_JUDGE_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_EFFORT_JUDGE_DIR', saved.dir],
      ['MIXDOG_DATA_DIR', saved.data],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let installs = 0;
  t.mock.module('./model-install.mjs', {
    namedExports: {
      effortJudgeInstallCurrent: () => false,
      effortJudgeInstallStamped: () => false,
      installEffortJudgeModel: async () => {
        installs += 1;
        throw new Error('offline in test');
      },
    },
  });
  t.mock.method(process.stderr, 'write', () => true);
  const client = await import(`./judge-client.mjs?lazy=${Date.now()}`);
  assert.equal(installs, 0, 'importing the client downloads nothing');
  await client.judgeTurn({ request: 'first' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installs, 1, 'the first judged turn starts the refresh');
  await client.judgeTurn({ request: 'second' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installs, 1, 'later turns do not start another');
});

test('a judgment that missed its deadline holds the next request until the worker answers it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-queue-'));
  for (const file of ['model.onnx', 'tokenizer.json']) writeFileSync(join(dir, file), '');
  const saved = { dir: process.env.MIXDOG_EFFORT_JUDGE_DIR, timeout: process.env.MIXDOG_EFFORT_JUDGE_TIMEOUT_MS };
  process.env.MIXDOG_EFFORT_JUDGE_DIR = dir;
  process.env.MIXDOG_EFFORT_JUDGE_TIMEOUT_MS = '50';
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_EFFORT_JUDGE_DIR', saved.dir],
      ['MIXDOG_EFFORT_JUDGE_TIMEOUT_MS', saved.timeout],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const posted = [];
  let judge;
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      judge = this;
      setImmediate(() => this.emit('message', { type: 'ready' }));
    }
    postMessage(msg) {
      posted.push(msg);
    }
    unref() {}
    async terminate() {}
  }
  t.mock.module('node:worker_threads', { namedExports: { Worker: FakeWorker } });
  const client = await import(`./judge-client.mjs?queue=${Date.now()}`);
  const answer = (msg) => judge.emit('message', { type: 'result', id: msg.id, probs: [1, 0, 0, 0] });

  assert.deepEqual(await client.judgeTurn({ request: 'slow' }), { skipped: 'timeout' });
  const next = client.judgeTurn({ request: 'next' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted.length, 1, 'the next request waits while the worker is still busy');
  answer(posted[0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 2, 'the late answer frees the worker for the next request');
  answer(posted[1]);
  assert.deepEqual((await next).probs, [1, 0, 0, 0]);
});
