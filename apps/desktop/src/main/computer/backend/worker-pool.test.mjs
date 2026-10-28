import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { RESPONSE_MARKER } from './program.ts';
import { WINDOW_ARRIVALS_SESSION_ID } from '../shared/common.ts';

// macOS and Linux spawn the native backend: the pool names its binary before
// handing the spawn to these tests' fakes, which never run it.
process.env.MIXDOG_COMPUTER_BIN ||= 'mixdog-computer';

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only' };

function fakeChild(pid) {
  return Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
      return true;
    },
  });
}

/** A pool over fake workers; `launcher` answers each elevated launch spawn. */
async function fakePool(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-worker-pool-'));
  const workers = [];
  const spawns = [];
  const retired = [];
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
    maxWorkers: options.maxWorkers,
    onSessionRetired: (...args) => retired.push(args),
    spawnProcess: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      if (args.includes('-Command')) {
        const launcher = fakeChild(900 + spawns.length);
        options.launcher(launcher);
        return launcher;
      }
      const child = fakeChild(options.unstarted ? undefined : 100 + workers.length);
      workers.push(child);
      return child;
    },
  });
  // The pool's own polling timers are unref'd; keep the loop alive for them.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(async () => {
    clearInterval(keepAlive);
    for (const child of workers) {
      child.exitCode = 0;
      child.emit('exit', 0);
    }
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  });
  return { pool, directory, workers, spawns, retired };
}

const sentRequest = (child) => JSON.parse(child.stdin.read().toString());
const reply = (child, body) => child.stdout.write(`${RESPONSE_MARKER}${JSON.stringify(body)}\n`);

test('a request over the dispatch budget is refused before it reaches a worker', async (t) => {
  const { pool, workers } = await fakePool(t);
  await assert.rejects(pool.callPowerShell({ action: 'type', text: 'x'.repeat(16 * 1024 * 1024), session_id: 'a' }), {
    message: 'computer_capacity_exhausted: worker request budget exceeded; input was not dispatched',
  });
  assert.equal(workers.length, 0);
  const inFlight = [];
  for (let index = 0; index < 32; index++) {
    inFlight.push(pool.callPowerShell({ action: 'snapshot', session_id: 'a' }).catch((error) => error));
  }
  await assert.rejects(pool.callPowerShell({ action: 'snapshot', session_id: 'a' }), {
    message: 'computer_capacity_exhausted: worker request budget exceeded; input was not dispatched',
  });
  assert.equal(workers.length, 1);
  pool.retirePowerShell(workers[0], new Error('fixture cleanup'));
  for (const error of await Promise.all(inFlight)) assert.equal(error.message, 'fixture cleanup');
});

test('a background reply reporting unconfirmed cleanup latches until the user clears it', async (t) => {
  const { pool, workers } = await fakePool(t);
  for (const delivery of ['foreground', 'background']) {
    const pending = pool.callPowerShell({ action: 'click', session_id: delivery, delivery });
    const child = pool.powerShellBySession.get(delivery);
    const body = { id: sentRequest(child).id, ok: false, error: 'input_cleanup_unconfirmed: release failed' };
    // A reply on another worker never settles this request.
    if (workers.length > 1) reply(workers[0], body);
    reply(child, body);
    assert.deepEqual(await pending, body);
  }
  assert.equal(pool.hasUnconfirmedBackgroundInput('foreground'), false);
  assert.equal(pool.hasUnconfirmedBackgroundInput('background'), true);
  assert.equal(pool.hasUnconfirmedBackgroundInput(), true);
  pool.clearUnconfirmedBackgroundInput();
  assert.equal(pool.hasUnconfirmedBackgroundInput(), false);
});

test('a command timeout is clamped and retires the worker that missed it', async (t) => {
  const { pool, workers, retired } = await fakePool(t);
  await assert.rejects(pool.callPowerShell({ action: 'snapshot', session_id: 'a' }, 1), {
    message: 'computer_command_timeout: command exceeded 50ms; the input host was restarted',
  });
  assert.equal(pool.powerShellBySession.has('a'), false);
  assert.equal(pool.workerLastUsedAt.has('a'), false);
  assert.equal(workers[0].killed, true);
  assert.deepEqual(retired, [['a', workers[0], false]]);
});

test('the window-arrivals reader starts only with a slot to spare and gives its slot to a session', async (t) => {
  const reader = { action: 'window_snapshot', session_id: WINDOW_ARRIVALS_SESSION_ID, read_only: true };
  const call = async (pool, request) => {
    try {
      return await pool.callPowerShell(request);
    } catch (error) {
      return error;
    }
  };

  const full = await fakePool(t);
  for (let index = 0; index < 7; index++) call(full.pool, { action: 'snapshot', session_id: `s${index}` });
  assert.match(String((await call(full.pool, reader)).message), /computer_reader_deferred/);
  assert.equal(full.workers.length, 7, 'the reader never took slot eight');
  call(full.pool, { action: 'snapshot', session_id: 's7' });
  assert.equal(full.workers.length, 8);
  assert.ok(full.pool.powerShellBySession.has('s7'));

  const shared = await fakePool(t);
  for (let index = 0; index < 6; index++) call(shared.pool, { action: 'snapshot', session_id: `s${index}` });
  const pendingRead = call(shared.pool, reader);
  const readerWorker = shared.pool.powerShellBySession.get(WINDOW_ARRIVALS_SESSION_ID);
  assert.ok(readerWorker, 'with headroom left, the reader starts');
  call(shared.pool, { action: 'snapshot', session_id: 's6' });
  call(shared.pool, { action: 'snapshot', session_id: 's7' });
  assert.equal(readerWorker.killed, true, 'the last slot went to the session');
  assert.ok(shared.pool.powerShellBySession.has('s7'));
  assert.equal(shared.pool.powerShellBySession.has(WINDOW_ARRIVALS_SESSION_ID), false);
  assert.match(String((await pendingRead).message), /computer_reader_yielded/);
  assert.match(String((await call(shared.pool, reader)).message), /computer_reader_deferred/);
});

test('each worker failure rejects its in-flight requests with the failure that ended it', async (t) => {
  const { pool, workers, retired } = await fakePool(t);
  const input = pool.callPowerShell({ action: 'click', session_id: 'a' });
  workers[0].stdin.emit('error', new Error('pipe closed'));
  await assert.rejects(input, { message: 'computer host input channel failed: pipe closed' });
  assert.deepEqual(retired, [['a', workers[0], true]]);

  const read = pool.callPowerShell({ action: 'snapshot', session_id: 'b' });
  workers[1].exitCode = 0;
  workers[1].emit('exit', 0);
  await assert.rejects(read, { message: 'computer host exited' });
  assert.deepEqual(retired[1], ['b', workers[1], false]);
  assert.deepEqual(pool.residentWorkerPids(), [100]);
});

test('a worker that never started frees its capacity slot', async (t) => {
  const { pool, workers } = await fakePool(t, { maxWorkers: 1, unstarted: true });
  const pending = pool.callPowerShell({ action: 'snapshot', session_id: 'a' });
  workers[0].emit('error', new Error('ENOENT'));
  await assert.rejects(pending, { message: 'computer host failed to start: ENOENT' });
  assert.ok(pool.ensurePowerShell('b'));
  assert.equal(workers.length, 2);
});

test('resident workers stay listed until their exit is observed', async (t) => {
  const { pool, workers } = await fakePool(t);
  pool.ensurePowerShell('a');
  assert.deepEqual(pool.residentWorkerPids(), [100]);
  assert.equal(await pool.waitForResidentWorkersExit(50), false);
  const stopped = pool.waitForResidentWorkersExit(5_000);
  workers[0].exitCode = 0;
  workers[0].emit('exit', 0);
  assert.equal(await stopped, true);
  assert.deepEqual(pool.residentWorkerPids(), []);
});

test('a Windows worker launches the published script with its own ledger', windowsOnly, async (t) => {
  const { pool, directory, workers, spawns } = await fakePool(t);
  pool.ensurePowerShell('a');
  const [{ command, args, options }] = spawns;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    pool.ensureHostScript(),
  ]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.MIXDOG_COMPUTER_HOST_CACHE, join(directory, 'host-cache'));
  assert.match(options.env.MIXDOG_COMPUTER_HOST_BUILD, /^[0-9a-f]{16}$/);
  assert.equal(options.env.MIXDOG_COMPUTER_INPUT_MARKER, pool.inputMarker);
  const ledger = options.env.MIXDOG_COMPUTER_INACTIVE_LEDGER;
  assert.match(ledger, /computer-inactive-[0-9a-f]{24}\.ledger$/);
  assert.equal(ledger.startsWith(directory), true);
  writeFileSync(ledger, '');
  workers[0].exitCode = 0;
  workers[0].emit('exit', 0);
  assert.deepEqual(pool.pendingInactiveLedgers(), [ledger]);
  pool.inactiveLedgersRecovered([ledger]);
  assert.deepEqual(pool.pendingInactiveLedgers(), []);
});

function exitLauncher(code, stdout) {
  return (launcher) =>
    setImmediate(() => {
      if (stdout) launcher.stdout.write(stdout);
      setImmediate(() => {
        launcher.exitCode = code;
        launcher.emit('exit', code);
      });
    });
}

test('a declined elevation confirms the stop and returns its slots', windowsOnly, async (t) => {
  const { pool, spawns } = await fakePool(t, { maxWorkers: 4, launcher: exitLauncher(1223) });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(pool.callPowerShellElevated({ action: 'click', session_id: 'a' }), {
      message: 'privileged_worker_cancelled: UAC consent was declined',
    });
  }
  assert.equal(spawns.filter((spawn) => spawn.args.includes('-Command')).length, 2);
  assert.deepEqual(pool.elevatedSessionIds(), []);
  assert.ok(pool.ensurePowerShell('b'));
});

test('elevation needs room for its launcher and worker beside the residents', windowsOnly, async (t) => {
  const { pool, spawns } = await fakePool(t, { maxWorkers: 3, launcher: exitLauncher(1223) });
  await assert.rejects(pool.callPowerShellElevated({ action: 'click', session_id: 'a' }), {
    message: 'computer_capacity_exhausted: 3 workers are still live; release an idle session before retrying',
  });
  assert.equal(spawns.length, 1);
});

test('elevated admission retires the window-arrivals reader for the three slots it needs', windowsOnly, async (t) => {
  const { pool, workers, spawns } = await fakePool(t, { launcher: exitLauncher(1223) });
  for (const sessionId of ['a', 's1', 's2', 's3', 's4']) pool.ensurePowerShell(sessionId);
  pool
    .callPowerShell({ action: 'window_snapshot', session_id: WINDOW_ARRIVALS_SESSION_ID, read_only: true })
    .catch(() => {});
  const reader = pool.powerShellBySession.get(WINDOW_ARRIVALS_SESSION_ID);
  assert.equal(workers.length, 6, 'six residents, the reader among them');
  // Past admission, the declined consent is the only refusal left.
  await assert.rejects(pool.callPowerShellElevated({ action: 'click', session_id: 'a' }), {
    message: 'privileged_worker_cancelled: UAC consent was declined',
  });
  assert.equal(reader.killed, true);
  assert.equal(pool.powerShellBySession.has(WINDOW_ARRIVALS_SESSION_ID), false);
  assert.equal(spawns.filter((spawn) => spawn.args.includes('-Command')).length, 1);
});

test('an unconfirmed elevated stop blocks input until its launcher is proven gone', windowsOnly, async (t) => {
  const { pool } = await fakePool(t, { launcher: exitLauncher(0) });
  await assert.rejects(pool.callPowerShellElevated({ action: 'click', session_id: 'a' }), {
    message: 'privileged_worker_unavailable: elevated worker returned no response',
  });
  assert.deepEqual(pool.elevatedSessionIds(), ['a']);
  assert.throws(() => pool.ensurePowerShell('b'), /^Error: privileged_worker_cleanup_unconfirmed:/);
  // No launcher identity was reported, so nothing can prove the worker gone.
  assert.equal(await pool.releaseUnconfirmedElevated(), false);
  assert.deepEqual(pool.elevatedSessionIds(), ['a']);
  assert.deepEqual(pool.pendingInactiveLedgers(), []);
});

test('a verified-gone elevated worker releases its session and slots', windowsOnly, async (t) => {
  // PID 4294967 is never a live process, so its identity verifies as gone.
  const { pool } = await fakePool(t, {
    maxWorkers: 4,
    launcher: exitLauncher(0, 'MIXDOG_ELEVATED_WORKER:4294967:1\n'),
  });
  await assert.rejects(pool.callPowerShellElevated({ action: 'click', session_id: 'a' }), {
    message: 'privileged_worker_unavailable: elevated worker returned no response',
  });
  assert.equal(await pool.releaseUnconfirmedElevated(), true);
  assert.deepEqual(pool.elevatedSessionIds(), []);
  assert.ok(pool.ensurePowerShell('b'));
  assert.ok(pool.ensurePowerShell('c'));
});
