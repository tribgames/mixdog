import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
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
  if (process.platform === 'win32') return `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}\r\n`;
  if (process.platform === 'linux') {
    return `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("whisper",pid=${pid},fd=3))\n`;
  }
  return '';
}

test('a replaced listener never receives audio and priority failure does not block readiness', {
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
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
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
    await manager.ensureReady(contract);
    assert.equal(await manager.transcribe(wav), 'first words');
    const { port } = JSON.parse(await fs.readFile(path.join(root, 'whisper-server.pid.json'), 'utf8'));
    // The port is now held by another process: every ownership query answers
    // with a foreign PID, through the asynchronous execFile path.
    const queries = [];
    t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
      queries.push(command);
      setImmediate(() => callback(null, ownershipQueryOutput(port, children[0].pid + 1), ''));
    });
    syncBuiltinESMExports();
    await assert.rejects(manager.transcribe(wav), /listener ownership could not be verified/);
    assert.equal(queries.length, 1, 'ownership is checked once per request via execFile');
    await assert.rejects(manager.transcribe(wav), /not READY/, 'the unverified child is torn down');
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
