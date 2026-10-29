import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('managed server transcribes and restarts while the preferred port stays occupied', {
  timeout: 45_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-whisper-test-'));
  const foreign = net.createServer((socket) => socket.end());
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const occupied = foreign.address().port;
  const previousPort = process.env.MIXDOG_WHISPER_SERVER_PORT;
  const previousIdle = process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS;
  process.env.MIXDOG_WHISPER_SERVER_PORT = String(occupied);
  process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = '0';
  const children = [];
  const fixture = fileURLToPath(new URL('./fixtures/whisper-server-fixture.mjs', import.meta.url));
  const serverCmd = path.join(root, 'runtime', 'bin', 'whisper-server.exe');
  await fs.mkdir(path.dirname(serverCmd), { recursive: true });
  const wav = path.join(root, 'sample.wav');
  await fs.writeFile(wav, 'first audio');
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, serverCmd);
    const child = spawn(process.execPath, [fixture, ...args], options);
    children.push(child);
    return child;
  });
  const priorities = [];
  t.mock.method(os, 'setPriority', (pid, priority) => {
    priorities.push([pid, priority]);
  });
  syncBuiltinESMExports();
  const manager = await import('./whisper-server.mjs');
  const contract = { serverCmd, modelPath: path.join(root, 'model.bin'), threadCount: 1 };
  try {
    await Promise.all([manager.ensureReady(contract), manager.ensureReady(contract)]);
    assert.equal(children.length, 1, 'concurrent requests share one child');
    assert.deepEqual(priorities, [[children[0].pid, os.constants.priority.PRIORITY_ABOVE_NORMAL]]);
    assert.equal(await manager.transcribe(wav), 'first words');
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'whisper-server.pid.json'), 'utf8'));
    assert.notEqual(metadata.port, occupied);
    assert.equal(metadata.pid, children[0].pid);
    await manager.stopVoiceWhisperServer();
    await assert.rejects(fs.access(path.join(root, 'whisper-server.pid.json')), { code: 'ENOENT' });
    await manager.ensureReady(contract);
    assert.equal(children.length, 2);
    assert.equal(await manager.transcribe(wav), 'first words');
    assert.equal(foreign.listening, true, 'unrelated listener survives both starts');
  } finally {
    await manager.stopVoiceWhisperServer();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await new Promise((resolve) => foreign.close(resolve));
    if (previousPort === undefined) delete process.env.MIXDOG_WHISPER_SERVER_PORT;
    else process.env.MIXDOG_WHISPER_SERVER_PORT = previousPort;
    if (previousIdle === undefined) delete process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS;
    else process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = previousIdle;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The ownership query output a listener held by `pid` produces on this platform.
function ownershipQueryOutput(port, pid) {
  if (process.platform === 'win32') return `${pid}\r\n`;
  if (process.platform === 'linux') {
    return `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("whisper",pid=${pid},fd=3))\n`;
  }
  return '';
}

test('ownership is proven once per child, not per request, and again for a restarted child', {
  timeout: 45_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-whisper-owner-'));
  const previousIdle = process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS;
  process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = '0';
  const children = [];
  const fixture = fileURLToPath(new URL('./fixtures/whisper-server-fixture.mjs', import.meta.url));
  const serverCmd = path.join(root, 'runtime', 'bin', 'whisper-server.exe');
  await fs.mkdir(path.dirname(serverCmd), { recursive: true });
  const wav = path.join(root, 'sample.wav');
  await fs.writeFile(wav, 'first audio');
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (_command, args, options) => {
    const child = spawn(process.execPath, [fixture, ...args], options);
    children.push(child);
    return child;
  });
  t.mock.method(os, 'setPriority', () => {
    throw new Error('access denied');
  });
  syncBuiltinESMExports();
  const manager = await import('./whisper-server.mjs');
  const contract = { serverCmd, modelPath: path.join(root, 'model.bin'), threadCount: 1 };
  try {
    // Every ownership query answers that the newest child owns the port.
    const queries = [];
    t.mock.method(childProcess, 'execFile', (command, _args, _options, callback) => {
      queries.push(command);
      const port = Number(JSON.parse(readFileSync(path.join(root, 'whisper-server.pid.json'), 'utf8')).port);
      const child = children[children.length - 1];
      setImmediate(() => callback(null, ownershipQueryOutput(port, child.pid), ''));
    });
    syncBuiltinESMExports();
    await manager.ensureReady(contract);
    assert.equal(queries.length, 1, 'readiness proves ownership once');
    assert.equal(await manager.transcribe(wav), 'first words');
    assert.equal(await manager.transcribe(wav), 'first words');
    assert.equal(queries.length, 1, 'transcribe on a live child does not query again');
    await manager.stopVoiceWhisperServer();
    await manager.ensureReady(contract);
    assert.equal(children.length, 2);
    assert.equal(queries.length, 2, 'a restarted child is proven again');
    assert.equal(await manager.transcribe(wav), 'first words');
    assert.equal(queries.length, 2);
  } finally {
    await manager.stopVoiceWhisperServer();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    if (previousIdle === undefined) delete process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS;
    else process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = previousIdle;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an unexpected child exit never lets a foreign listener rebinding the port receive audio', {
  timeout: 90_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-whisper-exit-'));
  const previousIdle = process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS;
  process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = '0';
  const children = [];
  const fixture = fileURLToPath(new URL('./fixtures/whisper-server-fixture.mjs', import.meta.url));
  const serverCmd = path.join(root, 'runtime', 'bin', 'whisper-server.exe');
  await fs.mkdir(path.dirname(serverCmd), { recursive: true });
  const wav = path.join(root, 'sample.wav');
  await fs.writeFile(wav, 'first audio');
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (_command, args, options) => {
    const child = spawn(process.execPath, [fixture, ...args], options);
    children.push(child);
    return child;
  });
  t.mock.method(os, 'setPriority', () => {});
  const queries = [];
  t.mock.method(childProcess, 'execFile', (command, _args, _options, callback) => {
    queries.push(command);
    const port = Number(JSON.parse(readFileSync(path.join(root, 'whisper-server.pid.json'), 'utf8')).port);
    const child = children[children.length - 1];
    setImmediate(() => callback(null, ownershipQueryOutput(port, child.pid), ''));
  });
  let releaseRead = null;
  const realRead = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...rest) =>
    releaseRead && file === wav
      ? new Promise((resolve) => {
          releaseRead = () => resolve(Buffer.from('first audio'));
        })
      : realRead(file, ...rest)
  );
  syncBuiltinESMExports();
  const manager = await import('./whisper-server.mjs');
  const contract = { serverCmd, modelPath: path.join(root, 'model.bin'), threadCount: 1 };
  let received = 0;
  let foreign = null;
  const currentPort = async () =>
    Number(JSON.parse(await fs.readFile(path.join(root, 'whisper-server.pid.json'), 'utf8')).port);
  const killChild = async (child) => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  };
  const rebindForeign = async (port) => {
    foreign = net.createServer((socket) => socket.on('data', (data) => (received += data.length)));
    await new Promise((resolve, reject) => {
      foreign.once('error', reject);
      foreign.listen(port, '127.0.0.1', resolve);
    });
  };
  const closeForeign = async () => {
    if (foreign) await new Promise((resolve) => foreign.close(resolve));
    foreign = null;
  };
  try {
    // Exit while the audio read is still pending.
    await manager.ensureReady(contract);
    let port = await currentPort();
    releaseRead = () => {};
    const pending = manager.transcribe(wav);
    const outcome = assert.rejects(pending, /ownership could not be verified|aborted|exited|not READY/);
    await killChild(children[0]);
    await rebindForeign(port);
    releaseRead();
    await outcome;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(received, 0, 'foreign listener got no audio (exit during read)');
    await closeForeign();
    releaseRead = null;

    // Exit before a transcribe starts.
    await manager.ensureReady(contract);
    assert.equal(children.length, 2);
    assert.equal(queries.length, 2, 'the replacement child is proven again');
    port = await currentPort();
    await killChild(children[1]);
    await rebindForeign(port);
    await assert.rejects(manager.transcribe(wav), /not READY/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(received, 0, 'foreign listener got no audio (exit before request)');

    // The next start proves ownership again (the foreign listener still holds the old port).
    await manager.ensureReady(contract);
    assert.equal(children.length, 3);
    assert.equal(queries.length, 3);
    assert.notEqual(await currentPort(), port);
    assert.equal(await manager.transcribe(wav), 'first words');
    assert.equal(received, 0);
  } finally {
    await manager.stopVoiceWhisperServer();
    await closeForeign();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    if (previousIdle === undefined) delete process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS;
    else process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = previousIdle;
    await fs.rm(root, { recursive: true, force: true });
  }
});
