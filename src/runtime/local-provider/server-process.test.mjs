import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLocalServerProcess } from './server-process.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const children = [];
  const manager = createLocalServerProcess({
    portFn: async () => 54321,
    fetchFn: async () => new Response('ok'),
    pollMs: 1,
    stopTimeoutMs: 20,
    spawnFn(_file, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.args = args;
      child.kills = [];
      child.kill = (signal = 'SIGTERM') => {
        child.kills.push(signal);
        queueMicrotask(() => child.emit('exit', null, signal));
        return true;
      };
      children.push(child);
      return child;
    },
    ...options,
  });
  const spec = {
    key: 'test-model-path', modelId: 'test-model', executable: 'not-executed',
    cwd: '.', args: (port, key) => ['--port', String(port), '--api-key', key],
  };
  return { manager, children, spec };
}

test('one ready process is shared and unexpected exits retain bounded redacted diagnostics', async () => {
  const { manager, children, spec } = fixture();
  try {
    const [first, second] = await Promise.all([manager.ensure(spec), manager.ensure(spec)]);
    assert.equal(first.baseURL, second.baseURL);
    assert.equal(children.length, 1);
    assert.equal(manager.status().running, true);
    children[0].stderr.emit('data', `${'x'.repeat(20_000)}\nkey=${first.apiKey}\nGPU failure`);
    children[0].emit('exit', 7, null);
    const failed = manager.status();
    assert.equal(failed.running, false);
    assert.equal(failed.activeModel, null);
    assert.equal(failed.lastExit.exitCode, 7);
    assert.equal(failed.lastExit.expected, false);
    assert.ok(failed.lastExit.log.length <= 16_384);
    assert.match(failed.lastError, /GPU failure/);
    assert.equal(JSON.stringify(failed).includes(first.apiKey), false);
    await manager.ensure(spec);
    assert.equal(children.length, 2);
    assert.equal(manager.status().lastExit.exitCode, 7);
    assert.equal(manager.status().lastError, null);
  } finally {
    await manager.stop();
  }
});

test('loading and queued cancellation return promptly without starting abandoned work', async () => {
  const probe = deferred();
  let loading = true;
  const { manager, children, spec } = fixture({
    fetchFn: async (_url, { signal }) => {
      if (!loading) return new Response('ok');
      probe.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const queuedController = new AbortController();
  const first = manager.ensure(spec, { signal: controller.signal });
  await probe.promise;
  assert.equal(manager.status().starting, true);
  assert.equal(manager.status().running, false);
  const queued = manager.ensure(spec, { signal: queuedController.signal });
  const firstFailure = assert.rejects(first, /cancel loading/);
  const queuedFailure = assert.rejects(queued, /cancel queued/);
  queuedController.abort(new Error('cancel queued'));
  controller.abort(new Error('cancel loading'));
  await Promise.all([firstFailure, queuedFailure]);
  await manager.stop();
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  assert.equal(manager.status().lastExit.expected, true);
  assert.equal(manager.status().lastError, null);
  loading = false;
  await manager.ensure(spec);
  await manager.stop();
  assert.equal(children.length, 2);
});

test('an already cancelled request does not allocate a port or launch a process', () => {
  const { manager, children, spec } = fixture({
    portFn: () => assert.fail('port allocation must not run'),
  });
  assert.throws(() => manager.ensure(spec, { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  assert.equal(children.length, 0);
});

test('startup timeout stops the child and retains its loading log', async () => {
  const { manager, children, spec } = fixture({
    startTimeoutMs: 20,
    fetchFn: async () => {
      children[0].stderr.emit('data', 'still loading\n');
      return new Response('loading', { status: 503 });
    },
  });
  await assert.rejects(manager.ensure(spec), /did not become ready:.*still loading/s);
  assert.equal(manager.status().running, false);
  assert.match(manager.status().lastError, /still loading/);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
});

test('stop interrupts loading and queued starts without waiting for readiness', async () => {
  const loading = deferred();
  const { manager, children, spec } = fixture({
    fetchFn: async (_url, { signal }) => {
      loading.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const first = manager.ensure(spec);
  const firstFailed = assert.rejects(first, /cancelled by stop/);
  await loading.promise;
  const queued = manager.ensure(spec);
  const queuedFailed = assert.rejects(queued, /cancelled by stop/);
  await manager.stop();
  await Promise.all([firstFailed, queuedFailed]);
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  assert.equal(manager.status().starting, false);
  assert.equal(manager.status().running, false);
  assert.equal(manager.status().lastError, null);
});

test('launch preparation chooses one GPU and a failed resource check never spawns a child', async () => {
  let environment;
  const { manager, children, spec } = fixture({
    spawnFn(_file, _args, options) {
      environment = options.env;
      const child = new EventEmitter();
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
      return child;
    },
  });
  const gpu = { uuid: 'GPU-bbbbbbbb', name: 'chosen GPU' };
  await manager.ensure({ ...spec, prepare: async () => ({ gpu, env: { CUDA_VISIBLE_DEVICES: gpu.uuid } }) });
  assert.equal(environment.CUDA_VISIBLE_DEVICES, gpu.uuid);
  assert.equal(manager.status().gpu.uuid, gpu.uuid);
  await manager.stop();
  const failed = fixture();
  await assert.rejects(failed.manager.ensure({ ...failed.spec, prepare: async () => { throw new Error('insufficient VRAM'); } }), /insufficient VRAM/);
  assert.equal(failed.children.length, 0);
  assert.match(failed.manager.status().lastError, /insufficient VRAM/);
});
