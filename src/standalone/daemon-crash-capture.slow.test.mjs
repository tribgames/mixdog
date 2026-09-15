// Real V8 fatal errors, in separate processes: a simulated marker would prove
// nothing about the one failure mode that motivated this capture — a heap
// OOM abort that no JS hook in the daemon can observe.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { beginDaemonSpawnCapture } from './daemon-crash-capture.mjs';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';

const CAPTURE_MODULE = new URL('./daemon-crash-capture.mjs', import.meta.url).href;
const HEAP_CAP_ARGS = ['--max-old-space-size=32'];
const FATAL_TEXT = /FATAL ERROR|out of memory/i;

// Reports ready first, then waits for an explicit fixture gate before
// allocating past its own old-space cap: V8 prints the fatal report straight to
// fd 2 and aborts, with no JS hook in between. The gate replaces every guessed
// delay, so the crash is provably caused by what the test arranged — it cannot
// fire early and make a pre-launcher-exit abort look like the detached case.
// The gate is a fixture-only file inside the test's own temp directory.
const OOM_DAEMON = `
import { existsSync } from 'node:fs';

const gate = process.argv[2];
process.send?.({ type: 'ready' });
const poll = setInterval(() => {
  if (!existsSync(gate)) return;
  clearInterval(poll);
  const held = [];
  for (;;) held.push(new Array(1_000_000).fill(Math.random()));
}, 25);
// Safety net: never outlive a fixture that died before opening its gate.
setTimeout(() => process.exit(0), 120_000);
`;

function launcherSource() {
  return `
import { fork } from 'node:child_process';
import { writeSync } from 'node:fs';
import { beginDaemonSpawnCapture } from ${JSON.stringify(CAPTURE_MODULE)};

const [dataDir, entry, gate] = process.argv.slice(2);
const capture = beginDaemonSpawnCapture({ launcher: 'detached-test', dataDir });
const execArgv = ${JSON.stringify(HEAP_CAP_ARGS)};
const child = fork(entry, [gate], {
  execArgv,
  stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'],
  // Genuinely detached on EVERY platform, including win32: this fixture exists
  // to prove a daemon that outlives its launcher, so it must not stay tied to
  // the launcher's console/process group. Production detach policy lives in
  // daemonShouldDetach and is not touched by this fixture.
  detached: true,
  windowsHide: true,
});
capture.track(child, { detached: true, execArgv });
child.on('message', (message) => {
  if (message?.type !== 'ready') return;
  capture.noteReady();
  // Synchronous write: the handoff is on the pipe BEFORE this process exits,
  // never left in an unflushed async buffer.
  writeSync(1, JSON.stringify({
    capturePath: capture.capturePath,
    recordPath: capture.recordPath,
    pid: child.pid,
  }) + '\\n');
  try { child.disconnect(); } catch {}
  child.unref();
  // The launcher leaves while the daemon runs on, still waiting for the gate:
  // this is exactly where the old stderr pipe stopped existing.
  process.exit(0);
});
`;
}

function workspace(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const children = new Set();
  // ONE cleanup hook, so ordering never depends on hook registration: every
  // fixture child is reaped AND confirmed gone before its unique temp
  // directory is removed.
  t.after(async () => {
    for (const pid of children) {
      if (!isPidAlive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    for (const pid of children) await waitFor(() => !isPidAlive(pid), { timeoutMs: 15_000 });
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    watch(pid) { if (pid) children.add(pid); },
    // Fixture children run INSIDE the temp directory, so a V8 fatal report or
    // core dump can never land in the repository.
    fork(entry, args = [], options = {}) {
      const child = fork(entry, args, { cwd: root, ...options });
      if (child.pid) children.add(child.pid);
      return child;
    },
    spawn(command, args, options = {}) {
      const child = spawn(command, args, { cwd: root, ...options });
      if (child.pid) children.add(child.pid);
      return child;
    },
  };
}

/** Every wait on a child is deadline-bounded: a stuck fixture fails loudly
 *  instead of hanging the run. */
function within(promise, ms, what) {
  let timer = null;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, bound]).finally(() => { if (timer) clearTimeout(timer); });
}

function readyMessage(child) {
  return new Promise((resolve) => {
    child.on('message', (message) => { if (message?.type === 'ready') resolve(message); });
  });
}

async function waitFor(check, { timeoutMs = 60_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(intervalMs);
  }
}

test('a real heap-OOM abort after ready is captured with its exit signal', async (t) => {
  const fixture = workspace(t, 'mixdog-crash-oom-');
  const root = fixture.root;
  const entry = join(root, 'oom-daemon.mjs');
  writeFileSync(entry, OOM_DAEMON);
  const gate = join(root, 'oom-gate');
  const logs = [];
  const capture = beginDaemonSpawnCapture({
    launcher: 'test',
    dataDir: root,
    log: (line) => logs.push(line),
  });
  const child = fixture.fork(entry, [gate], {
    execArgv: HEAP_CAP_ARGS,
    stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'],
  });
  capture.track(child, { detached: false, execArgv: HEAP_CAP_ARGS });
  await within(readyMessage(child), 30_000, 'the OOM fixture to report ready');
  capture.noteReady();
  child.disconnect();
  child.unref();
  // Only now does the fatal allocation begin.
  writeFileSync(gate, 'go');
  await within(once(child, 'exit'), 60_000, 'the OOM fixture to abort');

  const captured = readFileSync(capture.capturePath, 'utf8');
  assert.match(captured, FATAL_TEXT, 'the native fatal report reached the capture file');
  const record = JSON.parse(readFileSync(capture.recordPath, 'utf8'));
  assert.equal(record.ready, true, 'the crash is correlated to a daemon that had reached ready');
  assert.equal(record.pid, child.pid);
  assert.deepEqual(record.heapFlags, HEAP_CAP_ARGS);
  assert.ok(record.stderrBytes > 0);
  assert.ok(
    record.exitSignal !== null || (record.exitCode !== null && record.exitCode !== 0),
    `an abort is recorded as a signal or a non-zero code (${JSON.stringify(record)})`,
  );
  const exitLine = logs.find((line) => line.startsWith('daemon exit '));
  assert.match(exitLine, new RegExp(`pid=${child.pid}\\b`));
  assert.match(exitLine, /ready=1/);
});

test('a heap-OOM abort survives in the file after its detached launcher exited', async (t) => {
  const fixture = workspace(t, 'mixdog-crash-oom-detached-');
  const root = fixture.root;
  const entry = join(root, 'oom-daemon.mjs');
  writeFileSync(entry, OOM_DAEMON);
  const launcherScript = join(root, 'detached-launcher.mjs');
  writeFileSync(launcherScript, launcherSource());
  const gate = join(root, 'oom-gate');

  const launcher = fixture.spawn(process.execPath, [launcherScript, root, entry, gate], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  launcher.stdout.setEncoding('utf8');
  launcher.stderr.setEncoding('utf8');
  launcher.stdout.on('data', (chunk) => { stdout += chunk; });
  launcher.stderr.on('data', (chunk) => { stderr += chunk; });
  const [launcherCode] = await within(once(launcher, 'exit'), 30_000, 'the detached launcher to exit');
  assert.equal(launcherCode, 0, `launcher exited cleanly: ${stderr}`);

  const line = stdout.trim().split('\n').pop();
  const handoff = JSON.parse(line || '{}');
  fixture.watch(handoff.pid);
  assert.ok(handoff.capturePath && handoff.pid, `launcher published its capture: ${stdout}`);
  // Whatever the daemon already wrote is the diagnosis when an assertion below
  // fails: never report "not alive" without the native text behind it.
  const capturedText = () => {
    try { return readFileSync(handoff.capturePath, 'utf8').slice(-4_000); }
    catch (error) { return `<unreadable: ${error?.message || error}>`; }
  };
  // The daemon is still alive and still waiting: the abort provably happens
  // AFTER its launcher is gone, not before.
  assert.ok(
    isPidAlive(handoff.pid),
    `the daemon outlived the launcher that spawned it;`
    + ` capture=${JSON.stringify(capturedText())} launcherStderr=${stderr}`,
  );
  assert.equal(
    FATAL_TEXT.test(capturedText()),
    false,
    'nothing fatal was written while the launcher was still running',
  );
  writeFileSync(gate, 'go');

  const captured = await waitFor(() => {
    if (!existsSync(handoff.capturePath)) return null;
    const text = readFileSync(handoff.capturePath, 'utf8');
    return FATAL_TEXT.test(text) ? text : null;
  });
  assert.ok(
    captured,
    `the orphaned daemon still wrote its fatal report into the capture file;`
    + ` capture=${JSON.stringify(capturedText())}`,
  );
  await waitFor(() => !isPidAlive(handoff.pid));

  const record = JSON.parse(readFileSync(handoff.recordPath, 'utf8'));
  assert.equal(record.ready, true);
  assert.equal(record.pid, handoff.pid);
  assert.equal(record.detached, true);
  // Honest limit: nobody was left to observe the exit, so the code/signal is
  // absent while the fatal text itself is not.
  assert.equal(record.exitedAt, null);
});
