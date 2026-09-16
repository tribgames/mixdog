import assert from 'node:assert/strict';
import childProcess, { execFile } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { runCommandHandler } from './handlers.mjs';
import { MAX_BUFFER_BYTES } from './constants.mjs';

const exec = promisify(execFile);
const handlersUrl = new URL('./handlers.mjs', import.meta.url).href;

function controlledChild(t, stdinError = null) {
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done(stdinError);
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit('close', 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return child;
}

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'asynchronous' : 'synchronous'} hooks tolerate an early-closing input pipe`, async () => {
    const source = `
      import { runCommandHandler } from ${JSON.stringify(handlersUrl)};
      const result = await runCommandHandler({
        type: 'command', command: process.execPath,
        args: ['-e', 'process.exit(0)'], async: ${asynchronous}, timeout: 2,
      }, { cwd: ${JSON.stringify(tmpdir())}, data: 'x'.repeat(2 * 1024 * 1024) }, 'Stop', null);
      await new Promise(resolve => setTimeout(resolve, 250));
      process.stdout.write(JSON.stringify(result));
    `;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', source], {
      timeout: 8_000,
      windowsHide: true,
    });
    assert.equal(JSON.parse(stdout).exitCode, 0);
  });
}

test('command output preserves UTF-8 characters split across stdout and stderr chunks', async (t) => {
  const child = controlledChild(t);
  const running = runCommandHandler(
    {
      type: 'command',
      command: 'fixture',
      args: [],
      timeout: 2,
    },
    { cwd: tmpdir() },
    'Stop',
    null
  );
  const stdout = '승인할 파일 🙂';
  const stderr = '정확한 오류 🚧';
  for (const byte of Buffer.from(stdout)) child.stdout.write(Buffer.from([byte]));
  for (const byte of Buffer.from(stderr)) child.stderr.write(Buffer.from([byte]));
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
  const result = await running;
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
});

test('a signal-terminated command is not reported as a successful hook', async () => {
  const result = await runCommandHandler(
    {
      type: 'command',
      command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      timeout: 2,
    },
    { cwd: tmpdir() },
    'Stop',
    null
  );
  assert.notEqual(result.exitCode, 0);
});

test('command capture retains the existing raw-byte cap', async (t) => {
  const child = controlledChild(t);
  const running = runCommandHandler(
    {
      type: 'command',
      command: 'fixture',
      args: [],
      timeout: 2,
    },
    { cwd: tmpdir() },
    'Stop',
    null
  );
  child.stdout.write(Buffer.alloc(MAX_BUFFER_BYTES - 1, 'x'));
  child.stdout.write(Buffer.from('넘'));
  child.stderr.write(Buffer.alloc(MAX_BUFFER_BYTES + 1, 'y'));
  child.emit('close', 0, null);
  const result = await running;
  assert.equal(result.stdout, 'x'.repeat(MAX_BUFFER_BYTES - 1));
  assert.equal(result.stderr, '');
});

test('a close event without an exit code cannot report success', async (t) => {
  const child = controlledChild(t);
  const running = runCommandHandler(
    {
      type: 'command',
      command: 'fixture',
      args: [],
      timeout: 2,
    },
    { cwd: tmpdir() },
    'Stop',
    null
  );
  child.emit('close', null, 'SIGTERM');
  const result = await running;
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /SIGTERM/);
});

test('an unexpected input I/O error is surfaced instead of being treated as a closed pipe', async (t) => {
  const reason = Object.assign(new Error('fixture input failure'), { code: 'EIO' });
  controlledChild(t, reason);
  const result = await runCommandHandler(
    {
      type: 'command',
      command: 'fixture',
      args: [],
      timeout: 2,
    },
    { cwd: tmpdir() },
    'Stop',
    null
  );
  assert.equal(result.exitCode, -1);
  assert.equal(result.spawnError, reason);
  assert.match(result.stderr, /fixture input failure/);
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'asynchronous' : 'synchronous'} command timeouts close their owned native child`, async (t) => {
    const original = childProcess.spawn;
    let child;
    let closed;
    t.mock.method(childProcess, 'spawn', (...args) => {
      child = original(...args);
      closed = new Promise((resolve) => child.once('close', resolve));
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => {
      if (child?.exitCode === null && child?.signalCode === null) child.kill();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const result = await runCommandHandler(
      {
        type: 'command',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        async: asynchronous,
        timeout: 0.05,
      },
      { cwd: tmpdir() },
      'Stop',
      null
    );
    if (asynchronous) assert.equal(result.async, true);
    else assert.equal(result.timedOut, true);
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('owned child remained alive')), 3_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}

test('Windows timeout cleanup does not target an already-closed child again', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const child = controlledChild(t);
  child.pid = 246810;
  const addressed = [];
  t.mock.method(childProcess, 'spawnSync', (_command, args) => {
    addressed.push(args);
    child.emit('close', 1, null);
    return { status: 0 };
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = runCommandHandler(
    {
      type: 'command',
      command: 'fixture',
      args: [],
      timeout: 0.01,
    },
    { cwd: tmpdir() },
    'Stop',
    null
  );
  t.mock.timers.tick(10);
  assert.equal((await running).timedOut, true);
  t.mock.timers.tick(2_000);
  assert.equal(addressed.length, 1);
});

test('a synchronous command observes caller cancellation and releases its abort listener', async (t) => {
  controlledChild(t);
  const controller = new AbortController();
  const reason = new Error('fixture command cancellation');
  const pending = runCommandHandler(
    {
      type: 'command',
      command: 'fixture',
      args: [],
      timeout: 2,
    },
    { cwd: tmpdir() },
    'PreToolUse',
    null,
    null,
    { signal: controller.signal }
  );
  controller.abort(reason);
  const result = await pending;
  assert.equal(result.exitCode, -1);
  assert.equal(result.spawnError, reason);
  assert.equal(result.timedOut, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
