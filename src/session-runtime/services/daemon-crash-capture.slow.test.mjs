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
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';

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

// A process's end is the OS signalling its process object, which comes only
// after the kernel closed every handle it held — its working directory
// included. A pid probe is no substitute on Windows: `process.kill(pid, 0)`
// reads GetExitCodeProcess, which carries the exit code as soon as termination
// BEGINS, while the dying process still pins its cwd and an rmdir of that
// directory fails EBUSY. libuv's child 'exit' is the signalled handle.
function exitOf(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    // A spawn that failed has no process to wait for and may never emit 'exit'.
    child.once('error', () => {
      if (!child.pid) resolve();
    });
  });
}

// Takes a handle to a live pid, reports `held`, then returns once the OS
// signals that handle.
const holdPidScript = (pid) => `try { $p = [Diagnostics.Process]::GetProcessById(${pid}); $null = $p.Handle } catch { [Console]::Error.WriteLine($_); exit 1 }
[Console]::Out.WriteLine('held')
$p.WaitForExit()`;

function workspace(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // Every fixture process as { end, abort }: `end()` stops it and settles on
  // its real end (see exitOf), never on a pid probe — or throws when that end
  // cannot be observed; `abort()` terminates whatever is left of it, observer
  // included, once removal is no longer on the table.
  const ends = [];
  // ONE cleanup hook, so ordering never depends on hook registration: every
  // fixture process is stopped AND confirmed gone before its unique temp
  // directory is removed.
  t.after(async () => {
    try {
      await within(Promise.all(ends.map((entry) => entry.end())), 15_000, 'every fixture process to exit');
    } catch (error) {
      // No observed end, no removal: the directory stays, but nothing the
      // fixture started may outlive the test.
      await Promise.all(ends.map((entry) => entry.abort()));
      throw error;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const own = (child) => {
    const exited = exitOf(child);
    const end = () => {
      child.kill('SIGKILL');
      return exited;
    };
    ends.push({ end, abort: end });
    return child;
  };
  return {
    root,
    // A pid this process did not spawn — the detached daemon, whose parent
    // (the launcher) is gone — has no 'exit' here. `held` settles to true once
    // its end is observable; await it while the process provably still runs,
    // so the pid cannot have been reused.
    watch(pid) {
      if (!pid) return null;
      const stop = () => {
        if (!isPidAlive(pid)) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      };
      if (process.platform !== 'win32') {
        // POSIX keeps an orphan signalable until init reaps it, which is after
        // the kernel released its files and cwd: a failed probe is its end.
        const exited = async () => {
          if (!(await waitFor(() => !isPidAlive(pid)))) throw new Error(`pid ${pid} is still alive`);
        };
        ends.push({
          end: async () => {
            stop();
            await exited();
          },
          abort: stop,
        });
        return { held: Promise.resolve(true), exited };
      }
      // Windows: a waiter holds a real handle to it and exits when the OS
      // signals that handle. It runs outside the root, so the directory never
      // depends on the waiter's own end.
      const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const waiter = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', holdPidScript(pid)], {
        cwd: tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const waiterExit = exitOf(waiter);
      let err = '';
      const held = new Promise((resolve) => {
        let out = '';
        waiter.stdout.setEncoding('utf8');
        waiter.stderr.setEncoding('utf8');
        waiter.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('held')) resolve(true);
        });
        waiter.stderr.on('data', (chunk) => {
          err += chunk;
        });
        // 'close' follows every byte of its output, so a late `held` still wins.
        waiter.once('close', () => resolve(`waiter ended without a handle on pid ${pid}: ${err}`));
      });
      const exited = async () => {
        await waiterExit;
        if (waiter.exitCode !== 0) throw new Error(`waiter on pid ${pid} exited ${waiter.exitCode}: ${err}`);
      };
      // The waiter is never killed: its exit is the daemon's end only once it
      // holds the handle. So the daemon is killed after that, and a waiter that
      // never held one leaves the end unobserved — cleanup then fails instead
      // of removing the directory.
      ends.push({
        end: async () => {
          const holding = await held;
          stop();
          if (holding !== true) throw new Error(holding);
          await exited();
        },
        // Safe only here: once removal is off, the waiter's exit authorizes nothing.
        abort: () => {
          stop();
          waiter.kill('SIGKILL');
          return waiterExit;
        },
      });
      return { held, exited };
    },
    // Fixture children run INSIDE the temp directory, so a V8 fatal report or
    // core dump can never land in the repository.
    fork(entry, args = [], options = {}) {
      return own(fork(entry, args, { cwd: root, ...options }));
    },
    spawn(command, args, options = {}) {
      return own(spawn(command, args, { cwd: root, ...options }));
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
  return Promise.race([promise, bound]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function readyMessage(child) {
  return new Promise((resolve) => {
    child.on('message', (message) => {
      if (message?.type === 'ready') resolve(message);
    });
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
    `an abort is recorded as a signal or a non-zero code (${JSON.stringify(record)})`
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
  launcher.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  launcher.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [launcherCode] = await within(once(launcher, 'exit'), 30_000, 'the detached launcher to exit');
  assert.equal(launcherCode, 0, `launcher exited cleanly: ${stderr}`);

  const line = stdout.trim().split('\n').pop();
  const handoff = JSON.parse(line || '{}');
  const daemon = fixture.watch(handoff.pid);
  assert.ok(handoff.capturePath && handoff.pid, `launcher published its capture: ${stdout}`);
  // Whatever the daemon already wrote is the diagnosis when an assertion below
  // fails: never report "not alive" without the native text behind it.
  const capturedText = () => {
    try {
      return readFileSync(handoff.capturePath, 'utf8').slice(-4_000);
    } catch (error) {
      return `<unreadable: ${error?.message || error}>`;
    }
  };
  // The daemon is still alive and still waiting: the abort provably happens
  // AFTER its launcher is gone, not before.
  assert.ok(
    isPidAlive(handoff.pid),
    `the daemon outlived the launcher that spawned it;` +
      ` capture=${JSON.stringify(capturedText())} launcherStderr=${stderr}`
  );
  assert.equal(
    FATAL_TEXT.test(capturedText()),
    false,
    'nothing fatal was written while the launcher was still running'
  );
  assert.equal(
    await within(daemon.held, 30_000, 'a handle on the daemon'),
    true,
    'the daemon is held before its gate opens'
  );
  writeFileSync(gate, 'go');

  const captured = await waitFor(() => {
    if (!existsSync(handoff.capturePath)) return null;
    const text = readFileSync(handoff.capturePath, 'utf8');
    return FATAL_TEXT.test(text) ? text : null;
  });
  assert.ok(
    captured,
    `the orphaned daemon still wrote its fatal report into the capture file;` +
      ` capture=${JSON.stringify(capturedText())}`
  );
  await within(daemon.exited(), 60_000, 'the orphaned daemon to exit');

  const record = JSON.parse(readFileSync(handoff.recordPath, 'utf8'));
  assert.equal(record.ready, true);
  assert.equal(record.pid, handoff.pid);
  assert.equal(record.detached, true);
  // Honest limit: nobody was left to observe the exit, so the code/signal is
  // absent while the fatal text itself is not.
  assert.equal(record.exitedAt, null);
});
