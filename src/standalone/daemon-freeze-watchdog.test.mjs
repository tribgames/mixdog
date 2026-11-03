import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { probeDaemonPid } from './daemon-owner.mjs';
import { acquireDaemonOwnerLock } from './daemon-owner-lock.mjs';
import {
  DAEMON_FREEZE_LIMIT_MS,
  STALL_LOG_MS,
  createFreezeJudge,
  createFreezeWatchdog,
  freezeWatchdogTimings,
} from './daemon-freeze-watchdog.mjs';

const WATCHDOG_URL = new URL('./daemon-freeze-watchdog.mjs', import.meta.url).href;
const LOCK_URL = new URL('./daemon-owner-lock.mjs', import.meta.url).href;

function freezeMain(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A worker standing in for the real one: `body` runs after it reports ready
// with `port` (plus its slot number, when `perSlot`).
function workerSource(body, port = 4242, { perSlot = false } = {}) {
  return new URL(
    `data:text/javascript,${encodeURIComponent(
      `import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({ type: 'ready', livenessPort: ${port} + (${perSlot} ? workerData.slot : 0) });
${body}`
    )}`
  );
}

test('timings: 120 s by default, ticking every second; tests may shorten the limit', () => {
  assert.deepEqual(freezeWatchdogTimings({}), {
    limitMs: DAEMON_FREEZE_LIMIT_MS,
    tickMs: 1000,
    pulseMs: 250,
    suspendGapMs: 5000,
  });
  assert.equal(DAEMON_FREEZE_LIMIT_MS, 120_000);
  assert.deepEqual(freezeWatchdogTimings({ MIXDOG_DAEMON_FREEZE_LIMIT_MS: '3000' }), {
    limitMs: 3000,
    tickMs: 150,
    pulseMs: 150,
    suspendGapMs: 2000,
  });
  assert.equal(freezeWatchdogTimings({ MIXDOG_DAEMON_FREEZE_LIMIT_MS: '1' }).limitMs, 500);
  assert.equal(freezeWatchdogTimings({ MIXDOG_DAEMON_FREEZE_LIMIT_MS: 'x' }).limitMs, DAEMON_FREEZE_LIMIT_MS);
});

test('the judge counts only time between regular watchdog ticks; any progress resets it', () => {
  const judge = createFreezeJudge({ suspendGapMs: 5000 });
  assert.equal(judge.observe(0, 1n), 0);
  for (let t = 1000; t <= 60_000; t += 1000) assert.equal(judge.observe(t, 1n), t);
  assert.equal(judge.observe(61_000, 2n), 0, 'the main thread made progress');
  assert.equal(judge.observe(62_000, 2n), 1000);
  // Ticks delayed but regular still count in full.
  assert.equal(judge.observe(66_500, 2n), 5500);
});

test('a whole-process suspend (laptop sleep) is never counted as a main-thread freeze', () => {
  const judge = createFreezeJudge({ suspendGapMs: 5000 });
  judge.observe(0, 7n);
  assert.equal(judge.observe(1000, 7n), 1000);
  // Both threads stopped for 10 minutes: the clock advanced, no watchdog tick
  // ran, the counter could not move. Far past the 120 s limit, yet nothing counts.
  assert.equal(judge.observe(601_000, 7n), 1000);
  // On resume the main thread runs again and resets it.
  assert.equal(judge.observe(602_000, 8n), 0);
  // A main thread still frozen after the resume is counted from there on.
  assert.equal(judge.observe(603_000, 8n), 1000);
});

test('the main-thread pulse reports one stall per gap over the threshold', async (t) => {
  const stalls = [];
  const watchdog = createFreezeWatchdog({
    ...freezeWatchdogTimings({}),
    pulseMs: 50,
    logPath: 'unused',
    workerUrl: workerSource('setInterval(() => {}, 60_000);'),
    onStall: (from, to) => {
      stalls.push(to - from);
      throw new Error('attribution failed');
    },
  });
  t.after(() => watchdog.stop());
  assert.equal(await watchdog.start(), 4242);
  await delay(120);
  assert.deepEqual(stalls, []);
  freezeMain(STALL_LOG_MS + 200);
  await delay(120);
  assert.equal(stalls.length, 1, `stalls ${stalls}`);
  assert.ok(stalls[0] > STALL_LOG_MS);
});

// The freeze bound must always hold: a worker that keeps crashing is never
// left down (it was, after three exits, for the rest of the daemon's life).
test('crashing watchdog workers are restarted indefinitely with capped backoff, each with its new port', async (t) => {
  const logs = [];
  const ports = [];
  const watchdog = createFreezeWatchdog({
    ...freezeWatchdogTimings({}),
    logPath: 'unused',
    workerUrl: workerSource("setTimeout(() => { throw new Error('watchdog bug'); }, 20);", 5150, { perSlot: true }),
    restartDelayMs: 10,
    restartMaxDelayMs: 40,
    log: (line) => logs.push(line),
    onLivenessPort: (port) => ports.push(port),
    onUnrecoverable: () => assert.fail('each restart came up'),
  });
  t.after(() => watchdog.stop());
  assert.ok([5150, 5151].includes(await watchdog.start()));
  const delaysOf = (slot) =>
    logs
      .map((line) => new RegExp(`^freeze watchdog worker ${slot} exited \\(code 1\\) — restarting in (\\d+)ms$`).exec(line)?.[1])
      .filter(Boolean)
      .map(Number);
  for (let i = 0; i < 300 && Math.min(delaysOf(0).length, delaysOf(1).length) < 7; i += 1) await delay(20);
  for (const slot of [0, 1]) assert.deepEqual(delaysOf(slot).slice(0, 7), [10, 20, 40, 40, 40, 40, 40], `worker ${slot}`);
  // The port the record should name followed the workers coming and going.
  assert.ok(ports.includes(5150) && ports.includes(5151), JSON.stringify(ports));
  assert.ok(ports.every((port) => port === null || port === 5150 || port === 5151));
});

test('a watchdog that cannot come back within maxDownMs asks the daemon to stop, once', async (t) => {
  const logs = [];
  const unrecoverable = [];
  const watchdog = createFreezeWatchdog({
    ...freezeWatchdogTimings({}),
    logPath: 'unused',
    // Dies before it ever reports ready.
    workerUrl: new URL(`data:text/javascript,${encodeURIComponent("throw new Error('cannot start');")}`),
    restartDelayMs: 10,
    restartMaxDelayMs: 40,
    maxDownMs: 400,
    readyTimeoutMs: 100,
    log: (line) => logs.push(line),
    onUnrecoverable: (downMs) => unrecoverable.push(downMs),
  });
  t.after(() => watchdog.stop());
  assert.equal(await watchdog.start(), null);
  for (let i = 0; i < 100 && unrecoverable.length === 0; i += 1) await delay(20);
  assert.equal(unrecoverable.length, 1);
  assert.ok(unrecoverable[0] >= 390, `after ${unrecoverable[0]}ms`);
  assert.ok(logs.some((line) => /^freeze watchdog not running for \d+ms/.test(line)));
  assert.equal(watchdog.running, false);
  await delay(300);
  assert.equal(unrecoverable.length, 1, 'asked once');
});

// A ready after readyTimeoutMs was dropped: the record kept the main-thread
// fallback's port for good.
test('a watchdog worker ready after the start timed out still announces its liveness port', async (t) => {
  const ports = [];
  const watchdog = createFreezeWatchdog({
    ...freezeWatchdogTimings({}),
    logPath: 'unused',
    workerUrl: new URL(
      `data:text/javascript,${encodeURIComponent(
        `import { parentPort } from 'node:worker_threads';
setTimeout(() => parentPort.postMessage({ type: 'ready', livenessPort: 4343 }), 300);
setInterval(() => {}, 60_000);`
      )}`
    ),
    readyTimeoutMs: 50,
    onLivenessPort: (port) => ports.push(port),
  });
  t.after(() => watchdog.stop());
  assert.equal(await watchdog.start(), null);
  assert.equal(watchdog.running, false);
  for (let i = 0; i < 100 && ports.length === 0; i += 1) await delay(20);
  assert.deepEqual(ports, [4343]);
  assert.equal(watchdog.running, true);
});

// A process holding the owner lock with the real watchdog, whose main thread
// freezes (Atomics.wait: idle, no CPU) for as long as stdin asks — or, asked
// `stderr`, blocks writing to its stderr pipe, which this side then never
// reads (`readStderr: false`).
function frozenHolder(t, { root, limitMs, readStderr = true }) {
  const lockPath = join(root, 'daemon-owner.lock');
  const logPath = join(root, 'daemon.log');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { writeSync } = await import('node:fs');
const { createFreezeWatchdog, freezeWatchdogTimings } = await import(${JSON.stringify(WATCHDOG_URL)});
const { acquireDaemonOwnerLock } = await import(${JSON.stringify(LOCK_URL)});
globalThis.lock = await acquireDaemonOwnerLock(${JSON.stringify(lockPath)});
const watchdog = createFreezeWatchdog({
  ...freezeWatchdogTimings(),
  logPath: ${JSON.stringify(logPath)},
  dataDir: ${JSON.stringify(root)},
  getWork: () => ({ activeCalls: 2, busySessions: 1 }),
});
const port = await watchdog.start();
process.stdout.write(JSON.stringify({ held: globalThis.lock.held, port }) + '\\n');
process.stdin.on('data', (chunk) => {
  if (String(chunk).trim() === 'stderr') writeSync(2, Buffer.alloc(16 << 20, 0x2e));
  const ms = Number(String(chunk).trim());
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  process.stdout.write(JSON.stringify({ woke: ms }) + '\\n');
});`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MIXDOG_DAEMON_FREEZE_LIMIT_MS: String(limitMs) } }
  );
  const lines = [];
  const waiters = [];
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    for (let end = out.indexOf('\n'); end >= 0; end = out.indexOf('\n')) {
      lines.push(JSON.parse(out.slice(0, end)));
      out = out.slice(end + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  let stderr = '';
  if (readStderr) {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
  }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  const nextLine = async (count) => {
    while (lines.length < count) {
      const more = new Promise((resolve) => waiters.push(resolve));
      const outcome = await Promise.race([more.then(() => null), exited]);
      if (outcome && lines.length < count) throw new Error(`holder exited ${JSON.stringify(outcome)}: ${stderr}`);
    }
    return lines[count - 1];
  };
  return { child, lockPath, logPath, exited, nextLine, stderr: () => stderr };
}

test('a frozen main thread keeps its lock below the limit; past it the process is killed with diagnostics', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-freeze-watchdog-'));
  const limitMs = 3000;
  const holder = frozenHolder(t, { root, limitMs });
  // After the holder's own cleanup: its open lock file pins the directory.
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const ready = await holder.nextLine(1);
  assert.equal(ready.held, true);
  assert.ok(ready.port > 0);

  // Frozen for less than the limit: the worker still answers liveness probes
  // with the holder's pid, the lock still refuses a contender, and it wakes.
  holder.child.stdin.write('1200\n');
  await delay(300);
  assert.deepEqual(await probeDaemonPid({ port: ready.port, timeoutMs: 2000 }), {
    pid: holder.child.pid,
    timedOut: false,
  });
  assert.equal((await acquireDaemonOwnerLock(holder.lockPath)).held, false);
  assert.deepEqual(await holder.nextLine(2), { woke: 1200 });

  // Frozen past the limit: killed, non-zero, diagnostics first.
  const frozenAt = Date.now();
  holder.child.stdin.write('60000\n');
  const exit = await holder.exited;
  const elapsedMs = Date.now() - frozenAt;
  if (process.platform === 'win32') assert.deepEqual(exit, { code: 1, signal: null });
  else assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  assert.ok(elapsedMs >= limitMs - 200 && elapsedMs < 30_000, `killed after ${elapsedMs}ms`);
  const log = readFileSync(holder.logPath, 'utf8');
  assert.match(
    log,
    /\[daemon\] freeze watchdog: main thread made no progress for \d+ms of watched time \(limit 3000ms,/
  );
  assert.match(log, /in-flight at last progress: activeCalls=2 queuedCalls=0 busySessions=1/);
  assert.match(log, /JS stack cannot be captured from the watchdog thread/);
  assert.match(holder.stderr(), /freeze watchdog: main thread made no progress/);
  // The kernel released the lock with the process.
  const next = await acquireDaemonOwnerLock(holder.lockPath);
  next.release?.();
  assert.equal(next.held, true);
});

// Reproduced: a watchdog worker died and the main thread froze before it
// could restart one; with nothing left off the main thread, that freeze was
// never ended. Here worker 0 (and a single worker, as before) dies once it
// sees the main thread frozen; the redundant worker 1 still ends the process.
test('a freeze that begins while a watchdog worker is down is still ended', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-freeze-watchdog-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const logPath = join(root, 'daemon.log');
  const workerEntry = join(root, 'crashing-watchdog-worker.mjs');
  writeFileSync(
    workerEntry,
    `import { workerData } from 'node:worker_threads';
if (workerData.slot !== 1) {
  const beats = new BigInt64Array(workerData.buffer, 0, 2);
  let last = Atomics.load(beats, 0);
  let since = Date.now();
  setInterval(() => {
    const now = Atomics.load(beats, 0);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since > 150) {
      throw new Error('watchdog worker crashed during the freeze');
    }
  }, 20);
}
await import(${JSON.stringify(new URL('./daemon-freeze-watchdog-worker.mjs', import.meta.url).href)});
`
  );
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { pathToFileURL } = await import('node:url');
const { createFreezeWatchdog, freezeWatchdogTimings } = await import(${JSON.stringify(WATCHDOG_URL)});
const watchdog = createFreezeWatchdog({
  ...freezeWatchdogTimings(),
  logPath: ${JSON.stringify(logPath)},
  dataDir: ${JSON.stringify(root)},
  workerUrl: pathToFileURL(${JSON.stringify(workerEntry)}),
  // Nothing on the main thread runs again: no restart, no shutdown.
  restartDelayMs: 60_000,
});
await watchdog.start();
process.stdout.write('ready\\n');
setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000), 100);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MIXDOG_DAEMON_FREEZE_LIMIT_MS: '500' } }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    exited.then((exit) => reject(new Error(`exited before ready ${JSON.stringify(exit)}: ${stderr}`)));
  });
  const frozenAt = Date.now();
  const exit = await Promise.race([exited, delay(10_000).then(() => 'still running')]);
  assert.notEqual(exit, 'still running', `the frozen process was not ended: ${stderr}`);
  if (process.platform === 'win32') assert.deepEqual(exit, { code: 1, signal: null });
  else assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  assert.ok(Date.now() - frozenAt < 10_000);
  assert.match(readFileSync(logPath, 'utf8'), /freeze watchdog: main thread made no progress/);
});

// A synchronous diagnostic write to a stderr pipe nobody reads blocked the
// watchdog for good, and with it the kill. Here the main thread itself is
// frozen that way, as a hung disk or pipe would freeze it.
test('diagnostics that block never hold the kill back', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-freeze-watchdog-'));
  const limitMs = 2000;
  const holder = frozenHolder(t, { root, limitMs, readStderr: false });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const ready = await holder.nextLine(1);
  assert.equal(ready.held, true);

  const frozenAt = Date.now();
  holder.child.stdin.write('stderr\n');
  const exit = await Promise.race([holder.exited, delay(30_000).then(() => 'still running')]);
  const elapsedMs = Date.now() - frozenAt;
  assert.notEqual(exit, 'still running', 'the frozen process was killed');
  if (process.platform === 'win32') assert.deepEqual(exit, { code: 1, signal: null });
  else assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  // The limit, then at most the 2 s diagnostics deadline (plus scheduling).
  assert.ok(elapsedMs < limitMs + 2000 + 5000, `killed after ${elapsedMs}ms`);
  // What could be written was.
  assert.match(readFileSync(holder.logPath, 'utf8'), /\[daemon\] freeze watchdog: main thread made no progress/);
});
