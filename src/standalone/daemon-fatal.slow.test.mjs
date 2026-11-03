import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// The real daemon in an isolated home. A wrapper entry imports it, waits for
// the ready line in daemon.log, then ends the process the way the case needs.
const DAEMON_URL = pathToFileURL(join(import.meta.dirname, 'daemon.mjs')).href;
const WRAPPER = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The launcher's crash-capture sidecar this process would normally have.
const captureDir = join(process.env.MIXDOG_DATA_DIR, 'daemon-crash');
mkdirSync(captureDir, { recursive: true });
writeFileSync(
  join(captureDir, 'daemon-20260929-000000-1-aaaa.json'),
  JSON.stringify({
    kind: 'mixdog-daemon-crash-capture',
    launcher: 'session-client',
    launcherPid: 1,
    pid: process.pid,
    spawnedAt: '2026-09-29T00:00:00.000Z',
    ready: true,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
  })
);
await import(${JSON.stringify(DAEMON_URL)});
const read = () => {
  try {
    return readFileSync(process.env.FIXTURE_LOG, 'utf8');
  } catch {
    return '';
  }
};
while (!read().includes('[daemon] ready port=')) await new Promise((resolve) => setTimeout(resolve, 25));
const mode = process.env.FIXTURE_MODE;
if (mode === 'exit') {
  console.error('tail-marker');
  process.exit(3);
}
if (mode === 'term-fatal') {
  // A teardown is under way (it awaits real I/O) when the fatal error lands.
  process.emit('message', { type: 'shutdown' });
  Promise.reject(new Error('fixture fatal during teardown'));
}
if (mode === 'throw') setTimeout(() => { throw new Error('fixture fatal'); }, 0);
if (mode === 'benign') {
  Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
}
`;

function startDaemon(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-fatal-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  const entry = join(root, 'wrapper.mjs');
  writeFileSync(entry, WRAPPER);
  const logPath = join(dataDir, 'daemon.log');
  const env = {
    ...process.env,
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    HOME: home,
    USERPROFILE: home,
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    FIXTURE_LOG: logPath,
    FIXTURE_MODE: mode,
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(async () => {
    child.kill();
    await exited;
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const bounded = (promise) =>
    Promise.race([promise, delay(40_000).then(() => assert.fail('daemon did not exit in time'))]);
  return {
    child,
    exitCode: () => bounded(exited),
    daemonLog: () => read(logPath),
    crashLog: () => read(join(dataDir, 'crash.log')),
    exitRecord: () => JSON.parse(read(join(dataDir, 'daemon-crash', 'daemon-20260929-000000-1-aaaa.json'))),
  };
}

test('a synchronous process.exit keeps the log lines still queued', async (t) => {
  const daemon = startDaemon(t, 'exit');
  assert.equal(await daemon.exitCode(), 3);
  assert.match(daemon.daemonLog(), /tail-marker/);
});

test('an uncaught error runs the daemon shutdown and exits non-zero', async (t) => {
  const daemon = startDaemon(t, 'throw');
  assert.equal(await daemon.exitCode(), 1);
  const log = daemon.daemonLog();
  assert.match(log, /\[daemon\] uncaught exception: fixture fatal/);
  assert.match(log, /\[daemon\] shutting down \(fatal uncaught exception\)/);
  assert.match(daemon.crashLog(), /uncaught exception: Error: fixture fatal/);
});

test('a single benign transport rejection does not shut the daemon down', async (t) => {
  const daemon = startDaemon(t, 'benign');
  for (let i = 0; i < 400 && !daemon.crashLog().includes('ECONNRESET'); i += 1) await delay(50);
  assert.match(daemon.crashLog(), /ECONNRESET/);
  await delay(500);
  assert.equal(daemon.child.exitCode, null, 'daemon must survive one benign rejection');
  assert.doesNotMatch(daemon.daemonLog(), /shutting down/);
  daemon.child.send({ type: 'shutdown' });
  assert.equal(await daemon.exitCode(), 0);
  assert.match(daemon.daemonLog(), /shutting down \(IPC shutdown\)/);
});

test('a fatal error during a teardown already under way exits nonzero and records the error', async (t) => {
  const daemon = startDaemon(t, 'term-fatal');
  assert.equal(await daemon.exitCode(), 1);
  const log = daemon.daemonLog();
  assert.equal(log.match(/shutting down/g)?.length, 1, 'teardown is not restarted');
  assert.match(log, /shutting down \(IPC shutdown\)/);
  const exit = daemon.exitRecord().daemonExit;
  assert.equal(exit.code, 1);
  assert.match(exit.error, /fixture fatal during teardown/);
  assert.match(exit.reason, /IPC shutdown.*fatal/s);
});
