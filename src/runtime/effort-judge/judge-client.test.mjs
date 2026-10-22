import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      invalidateDamagedEffortJudgeInstall: async () => [],
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

function prewarmHarness(t, { model = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-prewarm-'));
  if (model) for (const file of ['model.onnx', 'tokenizer.json']) writeFileSync(join(dir, file), 'x');
  const saved = process.env.MIXDOG_EFFORT_JUDGE_DIR;
  process.env.MIXDOG_EFFORT_JUDGE_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_EFFORT_JUDGE_DIR;
    else process.env.MIXDOG_EFFORT_JUDGE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const spawned = [];
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      spawned.push(this);
    }
    postMessage() {}
    unref() {}
    async terminate() {}
  }
  t.mock.module('node:worker_threads', { namedExports: { Worker: FakeWorker } });
  return { spawned };
}

test('prewarm starts the judge worker once when the model is installed, without waiting for the load', async (t) => {
  const { spawned } = prewarmHarness(t);
  const client = await import(`./judge-client.mjs?prewarm=${Date.now()}`);
  assert.equal(spawned.length, 0, 'importing the client spawns nothing');
  assert.equal(client.prewarmEffortJudge(), true);
  assert.equal(spawned.length, 1);
  assert.equal(client.effortJudgeReady(), false, 'the call returns before the model has loaded');
  assert.equal(client.prewarmEffortJudge(), true);
  assert.equal(spawned.length, 1, 'a worker that is loading or loaded is reused');
  spawned[0].emit('message', { type: 'ready' });
  assert.equal(client.effortJudgeReady(), true);
});

test('prewarm spawns nothing when the model is missing', async (t) => {
  const { spawned } = prewarmHarness(t, { model: false });
  const client = await import(`./judge-client.mjs?prewarm-missing=${Date.now()}`);
  assert.equal(client.prewarmEffortJudge(), false);
  assert.equal(spawned.length, 0);
});

test('prewarm spawns nothing on an unsupported platform', async (t) => {
  const { spawned } = prewarmHarness(t);
  t.mock.module('../shared/onnx-runtime-support.mjs', { namedExports: { onnxRuntimeSupported: () => false } });
  const client = await import(`./judge-client.mjs?prewarm-unsupported=${Date.now()}`);
  assert.equal(client.prewarmEffortJudge(), false);
  assert.equal(spawned.length, 0);
});

test('prewarm retries a failed load no sooner than the load retry interval', async (t) => {
  const { spawned } = prewarmHarness(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const client = await import(`./judge-client.mjs?prewarm-retry=${Date.now()}`);
  assert.equal(client.prewarmEffortJudge(), true);
  spawned[0].emit('message', { type: 'load-error', message: 'broken model' });
  spawned[0].emit('exit', 1);
  t.mock.timers.tick(59_999);
  assert.equal(client.prewarmEffortJudge(), false, 'still inside the retry interval');
  assert.equal(spawned.length, 1);
  t.mock.timers.tick(1);
  assert.equal(client.prewarmEffortJudge(), true);
  assert.equal(spawned.length, 2);
});

// A stamped install in the default data dir whose worker fails to load; `bad`
// is what the hash re-verification reports.
// `gate` holds the first install until released; `installError` fails every install.
async function loadErrorHarness(t, bad, { gate = null, installError = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-judge-repair-'));
  const dir = join(root, 'models', 'effort-judge');
  mkdirSync(dir, { recursive: true });
  for (const file of ['model.onnx', 'tokenizer.json']) writeFileSync(join(dir, file), 'x');
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
  const state = { stamped: true, verifies: 0, installs: [], events: [] };
  let gated = gate;
  t.mock.module('./model-install.mjs', {
    namedExports: {
      effortJudgeInstallCurrent: () => state.stamped,
      effortJudgeInstallStamped: () => state.stamped,
      invalidateDamagedEffortJudgeInstall: async () => {
        state.events.push('verify');
        state.verifies += 1;
        if (bad.length) state.stamped = false;
        return bad;
      },
      installEffortJudgeModel: async (installDir) => {
        state.events.push('install-start');
        state.installs.push(installDir);
        const hold = gated;
        gated = null;
        if (hold) await hold;
        if (installError) throw installError;
        state.stamped = true;
        state.events.push('install-end');
      },
    },
  });
  const spawned = [];
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      spawned.push(this);
    }
    postMessage() {}
    unref() {}
    async terminate() {}
  }
  t.mock.module('node:worker_threads', { namedExports: { Worker: FakeWorker } });
  t.mock.method(process.stderr, 'write', () => true);
  const client = await import(`./judge-client.mjs?repair=${Date.now()}-${Math.random()}`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { client, spawned, state, dir, settle };
}

test('a load error with damaged files drops the stamp, reinstalls and lets the next load retry at once', async (t) => {
  const { client, spawned, state, dir, settle } = await loadErrorHarness(t, ['model.onnx']);
  assert.equal(client.prewarmEffortJudge(), true);
  spawned[0].emit('message', { type: 'load-error', message: 'Protobuf parsing failed' });
  assert.equal(client.effortJudgeLastError(), 'Protobuf parsing failed', 'status carries the reason');
  await settle();
  assert.equal(state.verifies, 1);
  assert.deepEqual(state.installs, [dir]);
  assert.equal(client.effortJudgeLastError(), 'Protobuf parsing failed', 'the reason stays until a load succeeds');
  assert.equal(client.prewarmEffortJudge(), true, 'no 60 s back-off after the files were replaced');
  assert.equal(spawned.length, 2);
  spawned[1].emit('message', { type: 'ready' });
  assert.equal(client.effortJudgeLastError(), '');
});

test('a load error with matching hashes reinstalls nothing and keeps the back-off', async (t) => {
  const { client, spawned, state, settle } = await loadErrorHarness(t, []);
  assert.equal(client.prewarmEffortJudge(), true);
  spawned[0].emit('message', { type: 'load-error', message: 'unsupported opset' });
  spawned[0].emit('exit', 1);
  await settle();
  assert.equal(state.verifies, 1);
  assert.deepEqual(state.installs, []);
  assert.equal(client.prewarmEffortJudge(), false, 'still inside the retry interval');
  assert.equal(spawned.length, 1);
});

test('repeated load errors with matching hashes verify each time, never reinstall, and keep the back-off', async (t) => {
  const { client, spawned, state, settle } = await loadErrorHarness(t, []);
  assert.equal(client.prewarmEffortJudge(), true);
  for (let n = 1; n <= 3; n += 1) {
    spawned[0].emit('message', { type: 'load-error', message: 'unsupported opset' });
    await settle();
    assert.equal(state.verifies, n);
  }
  assert.deepEqual(state.installs, []);
  assert.equal(client.effortJudgeInstalling(), false);
  assert.equal(client.effortJudgeLastError(), 'unsupported opset');
  spawned[0].emit('exit', 1);
  assert.equal(client.prewarmEffortJudge(), false, 'the back-off still applies');
  assert.equal(spawned.length, 1);
});

test('a repair that fails offline keeps the back-off and the reason, and a later load error tries again', async (t) => {
  const { client, spawned, state, settle } = await loadErrorHarness(t, ['model.onnx'], {
    installError: new Error('offline in test'),
  });
  const writes = [];
  t.mock.method(process.stderr, 'write', (text) => writes.push(String(text)) > 0);
  assert.equal(client.prewarmEffortJudge(), true);
  spawned[0].emit('message', { type: 'load-error', message: 'Protobuf parsing failed' });
  spawned[0].emit('exit', 1);
  await settle();
  assert.equal(state.installs.length, 1);
  assert.ok(writes.some((text) => text.includes('model repair failed: offline in test')));
  assert.equal(client.effortJudgeInstalling(), false, 'the install slot is released');
  assert.equal(client.effortJudgeLastError(), 'Protobuf parsing failed');
  assert.equal(client.prewarmEffortJudge(), false, 'no model, nothing to start');
  spawned[0].emit('message', { type: 'load-error', message: 'Protobuf parsing failed' });
  await settle();
  assert.equal(state.installs.length, 2);
});

test('a load error during an install waits for it, then verifies, so it never removes the stamp the install wrote', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { client, spawned, state, settle } = await loadErrorHarness(t, ['model.onnx'], { gate });
  assert.equal(client.prewarmEffortJudge(), true);
  state.stamped = false; // an update is replacing the files
  const install = client.installEffortJudge();
  await settle();
  assert.deepEqual(state.events, ['install-start']);
  spawned[0].emit('message', { type: 'load-error', message: 'Protobuf parsing failed' });
  await settle();
  assert.deepEqual(state.events, ['install-start'], 'verification waits for the install in flight');
  release();
  await install;
  await settle();
  assert.deepEqual(state.events, ['install-start', 'install-end', 'verify', 'install-start', 'install-end']);
  assert.equal(state.stamped, true, 'the repair reinstall restored the stamp');
  assert.equal(client.effortJudgeInstalling(), false);
});

test('a judgment that missed its deadline holds the next request until the worker answers it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-queue-'));
  for (const file of ['model.onnx', 'tokenizer.json']) writeFileSync(join(dir, file), 'x');
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
