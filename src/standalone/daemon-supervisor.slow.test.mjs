// The daemon supervisor (native/mixdog-supervisor) against a stand-in daemon
// that speaks the real link (daemon-supervisor-link.mjs): freeze recovery,
// bounded diagnostics, the daemon's lifetime bound to the supervisor, and a
// supervisor that keeps working once the launcher that started it is gone.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { forkDaemonCandidate } from '../session-runtime/services/daemon-candidate.mjs';
import { daemonCrashCaptureDir } from '../session-runtime/services/daemon-crash-capture.mjs';

// The suite builds the supervisor from this checkout (incremental: instant when
// current) and tests exactly that binary; MIXDOG_SUPERVISOR_BIN is pointed at it
// so the launcher code under test cannot pick an installed copy either.
const MANIFEST = fileURLToPath(new URL('../../native/mixdog-supervisor/Cargo.toml', import.meta.url));
const TARGET = fileURLToPath(new URL('../../native/mixdog-supervisor/target/', import.meta.url));
const EXE = `mixdog-supervisor${process.platform === 'win32' ? '.exe' : ''}`;
// The product build, and the suite's build of the same source with its
// instruments and seam (cargo feature "suite") in a target dir of its own.
for (const features of [[], ['--features', 'suite', '--target-dir', join(TARGET, 'suite')]]) {
  const built = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', MANIFEST, ...features], {
    stdio: 'inherit',
  });
  assert.equal(built.status, 0, `cargo build of native/mixdog-supervisor ${features.join(' ')} failed`);
}
const SUPERVISOR = join(TARGET, 'release', EXE);
const SUITE_SUPERVISOR = join(TARGET, 'suite', 'release', EXE);
process.env.MIXDOG_SUPERVISOR_BIN = SUPERVISOR;
const LINK = new URL('./daemon-supervisor-link.mjs', import.meta.url).href;
const LIMIT_MS = 2000;
// Ping interval (1 s) plus the diagnostics budget (2 s) plus scheduling slack.
const KILL_BOUND_MS = LIMIT_MS + 1000 + 2000 + 2000;

// Saturates the disk argv[1] is on: 48 concurrent 8 MiB writes at random
// places in a 512 MiB file, each followed by fdatasync.
const SATURATOR = `
const fs = require('node:fs');
const fd = fs.openSync(process.argv[1], 'w+');
const block = Buffer.alloc(8 << 20, 5);
const write = () =>
  fs.write(fd, block, 0, block.length, Math.floor(Math.random() * 64) * block.length, () => fs.fdatasync(fd, write));
for (let n = 0; n < 48; n += 1) write();
`;

// Another thread of the daemon writing protocol-shaped lines to fd 1: every
// plausible ping counter and ready, over and over.
const FORGER = `
const { writeSync } = require('node:fs');
setInterval(() => {
  let lines = '\\nready\\nready forged\\n';
  for (let n = 1; n <= 64; n += 1) lines += 'pong ' + n + ' forged\\n';
  writeSync(1, lines);
}, 20);
`;

// A child of the daemon that starts two of its own, a CPU burner and a writer
// of one byte every 200 ms, lists all pids in argv[1] and the burner's in
// argv[1].burner, then idles.
const HANDOFF = `
const { spawn } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const list = process.argv[1];
const burner = spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore', windowsHide: true });
const writer = spawn(
  process.execPath,
  ['-e', 'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "x"), 200)', list + '.trickle'],
  { stdio: 'ignore', windowsHide: true }
);
appendFileSync(list, burner.pid + '\\n' + writer.pid + '\\n');
writeFileSync(list + '.burner', String(burner.pid));
setInterval(() => {}, 2 ** 30);
`;
const COLD_MIB = 1024;

// Appends its pid to `boots`, reports ready, and freezes its main thread for
// good once `trigger` appears ('stderr': with a worker writing 4 MiB to fd 2;
// 'forge': with a worker forging answers on fd 1 meanwhile; 'garbage': writes
// stray bytes to fd 1 instead; 'crash': exits with 7).
const STUB = `
import { appendFileSync, constants, existsSync, fsyncSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Worker } from 'node:worker_threads';
import { startSupervisorLink } from ${JSON.stringify(LINK)};
const [boots, trigger] = process.argv.slice(2);
appendFileSync(boots, process.pid + '\\n');
startSupervisorLink({ describe: () => 'stub=' + process.pid }).ready();
const poller = setInterval(() => {
  if (!existsSync(trigger)) return;
  const mode = readFileSync(trigger, 'utf8');
  rmSync(trigger, { force: true });
  if (mode === 'crash') process.exit(7);
  // 'deaf': the main thread idles in its event loop and no longer reads the
  // link; nothing else is scheduled, so nothing moves.
  if (mode === 'deaf') {
    clearInterval(poller);
    process.stdin.removeAllListeners('data');
    process.stdin.pause();
    setInterval(() => {}, 2 ** 30);
    return;
  }
  // 'stuckio': the main thread blocks in a synchronous read that never
  // completes (a named pipe nobody writes): the kernel wait a read or write
  // on a stalled disk sits in, held for as long as the test needs.
  if (mode === 'stuckio') {
    const name = ${JSON.stringify('\\\\.\\pipe\\mixdog-stuck-')} + process.pid;
    createServer().listen(name, () => readSync(openSync(name, 'r+'), Buffer.alloc(16)));
    return;
  }
  // 'diskwrite': synchronous 64 MiB writes, each fsync'd, to the disk the test saturates.
  if (mode === 'diskwrite') {
    const fd = openSync(trigger + '.w', 'w');
    const block = Buffer.alloc(64 << 20, 7);
    for (let n = 0; ; n += 1) {
      writeSync(fd, block, 0, block.length, (n % 8) * block.length);
      fsyncSync(fd);
    }
  }
  // 'pagein': random 4 KiB reads through a mapping of a file no cache holds
  // (the test makes it): every one a hard page-in from the saturated disk.
  if (mode === 'pagein') {
    const fd = openSync(trigger + '.cold', constants.O_RDONLY | constants.UV_FS_O_FILEMAP);
    const page = Buffer.alloc(4096);
    for (;;) readSync(fd, page, 0, 4096, Math.floor(Math.random() * ${COLD_MIB * 256}) * 4096);
  }
  // 'handoff': nothing answers while a child of the daemon runs HANDOFF.
  if (mode === 'handoff') {
    const relay = spawn(process.execPath, ['-e', ${JSON.stringify(HANDOFF)}, trigger + '.child'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    appendFileSync(trigger + '.child', relay.pid + '\\n');
  }
  if (mode === 'garbage') {
    // What else lands on fd 1: invalid UTF-8, an overlong line, a partial one.
    writeSync(1, Buffer.from([255, 10]));
    writeSync(1, Buffer.alloc(10_000, 0x62));
    writeSync(1, '\\n');
    writeSync(1, 'partial without newline');
    return;
  }
  // 'busy': the main thread stops answering for 3.5 s while a worker keeps
  // burning CPU, then answers again. 'spin': the main thread loops for ever.
  if (mode === 'busy') {
    const worker = new Worker('for (;;) {}', { eval: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
    worker.terminate();
    return;
  }
  // 'trickle': nothing answers while a worker appends one byte every 500 ms
  // (2 I/O operations a second). 'child': nothing answers while a child
  // process of the daemon burns CPU (it ends by itself after 20 s).
  if (mode === 'trickle') {
    new Worker(
      "const { workerData } = require('node:worker_threads'); const fs = require('node:fs');" +
        'setInterval(() => fs.appendFileSync(workerData, "x"), 500);',
      { eval: true, workerData: trigger + '.trickle' }
    );
  }
  if (mode === 'child') {
    const child = spawn(process.execPath, ['-e', 'const end = Date.now() + 20000; while (Date.now() < end) {}'], {
      stdio: 'ignore',
    });
    appendFileSync(trigger + '.child', child.pid + '\\n');
  }
  if (mode === 'spin') for (;;) {}
  // On a worker: a main thread blocked in a write to a full pipe waits in the
  // kernel like one writing to a stalled disk, and lives to the cap.
  if (mode === 'stderr') {
    new Worker("require('node:fs').writeSync(2, Buffer.alloc(4 << 20, 0x61))", { eval: true });
  }
  if (mode === 'forge') new Worker(${JSON.stringify(FORGER)}, { eval: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}, 50);
`;

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-supervisor-'));
  const paths = {
    root,
    stub: join(root, 'stub-daemon.mjs'),
    boots: join(root, 'boots.txt'),
    trigger: join(root, 'freeze'),
    log: join(root, 'daemon.log'),
  };
  writeFileSync(paths.stub, STUB);
  const pids = new Set();
  t.after(async () => {
    const orphans = `${paths.trigger}.child`;
    if (existsSync(orphans)) for (const pid of readFileSync(orphans, 'utf8').split('\n').filter(Boolean)) pids.add(Number(pid));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await waitFor(() => [...pids].every((pid) => !isPidAlive(pid)), 10_000);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const boots = () =>
    existsSync(paths.boots) ? readFileSync(paths.boots, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const supervisorArgs = ['--freeze-limit-ms', String(LIMIT_MS), '--log', paths.log, '--'];
  const daemonArgs = [process.execPath, paths.stub, paths.boots, paths.trigger];
  return {
    paths,
    boots,
    track: (pid) => pids.add(pid),
    /** The supervisor as a launcher would start it; resolves at its first "ready". */
    async start({ stderr = 'ignore', bin = SUPERVISOR, env = {} } = {}) {
      const child = spawn(bin, [...supervisorArgs, ...daemonArgs], {
        stdio: ['ignore', 'pipe', stderr],
        env: { ...process.env, ...env },
      });
      pids.add(child.pid);
      child.stderr?.pause();
      const lines = [];
      let pending = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        lines.push(...pending.split('\n').slice(0, -1));
        pending = pending.slice(pending.lastIndexOf('\n') + 1);
      });
      assert.ok(await waitFor(() => lines.includes('ready'), 20_000), `ready: ${lines.join(' | ')}`);
      for (const pid of boots()) pids.add(pid);
      return { child, lines };
    },
    /** Another process saturating the disk the fixture lives on until the test ends. */
    saturate() {
      const saturator = spawn(process.execPath, ['-e', SATURATOR, join(root, 'saturated')], {
        stdio: 'ignore',
        env: { ...process.env, UV_THREADPOOL_SIZE: '64' },
      });
      pids.add(saturator.pid);
    },
    script: () => [SUPERVISOR, [...supervisorArgs, ...daemonArgs]],
    freeze: (mode = 'idle') => writeFileSync(paths.trigger, mode),
    log: () => (existsSync(paths.log) ? readFileSync(paths.log, 'utf8') : ''),
  };
}

test('a frozen daemon is killed after diagnostics and replaced exactly once', async (t) => {
  const fx = fixture(t);
  const { lines } = await fx.start();
  const [first] = fx.boots();
  assert.deepEqual(lines.slice(0, 2), [`spawned ${first}`, 'ready']);
  const frozenAt = Date.now();
  fx.freeze();
  assert.ok(await waitFor(() => !isPidAlive(first), KILL_BOUND_MS + 2000), 'the frozen daemon was killed');
  const killedAfterMs = Date.now() - frozenAt;
  assert.ok(killedAfterMs >= LIMIT_MS, `not before the limit (${killedAfterMs}ms)`);
  assert.ok(killedAfterMs <= KILL_BOUND_MS, `within the bound (${killedAfterMs}ms)`);
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), 'a replacement started');
  const [, second] = fx.boots();
  fx.track(second);
  assert.match(
    fx.log(),
    new RegExp(
      `\\[daemon\\] freeze supervisor: daemon pid=${first} left ping \\d+ unanswered for \\d+ms \\(limit ${LIMIT_MS}ms\\); its last answer, \\d+ms ago: stub=${first} — killing it`
    )
  );
  assert.match(fx.log(), new RegExp(`frozen daemon pid=${first} exited; replacement pid=${second} started`));
  assert.ok(await waitFor(() => lines.includes(`spawned ${second}`), 5000), 'the launcher hears of the replacement');
  // The replacement answers: no second kill, no third boot.
  await delay(LIMIT_MS + 2000);
  assert.ok(isPidAlive(second));
  assert.deepEqual(fx.boots(), [first, second]);
});

// A busy daemon is not a dead one: past the limit it is given more time while
// its process still works (CPU or I/O counters advance), up to the hard cap
// (2.5 x the limit by default); a daemon that does nothing is killed at the
// limit (the first test above) and one that spins for ever at the cap.
const CAP_MS = LIMIT_MS * 2.5;

test('a daemon that stops answering but keeps working is not killed before the cap', async (t) => {
  const fx = fixture(t);
  await fx.start();
  const [first] = fx.boots();
  fx.freeze('busy');
  // Past the limit, inside the cap, and the daemon answers again.
  await delay(LIMIT_MS + 1500);
  assert.ok(isPidAlive(first), 'still alive past the limit');
  assert.match(
    fx.log(),
    new RegExp(
      `daemon pid=${first} left ping \\d+ unanswered for \\d+ms \\(limit ${LIMIT_MS}ms\\) but is still alive, its (own|descendants') counters advance: own\\[cpu \\+\\d+ms.*giving it until \\d+ms \\(cap ${CAP_MS}ms\\)`
    ),
    'the extension is logged with the numbers'
  );
  await delay(LIMIT_MS * 2);
  assert.ok(isPidAlive(first), 'it answered again and was never killed');
  assert.deepEqual(fx.boots(), [first], 'never replaced');
  assert.doesNotMatch(fx.log(), /killing it/);
});

/** Freezes the daemon in `mode`, checks it is killed at the limit as stuck, and returns the log. */
async function assertStuckAtLimit(fx, mode) {
  const [first] = fx.boots();
  const frozenAt = Date.now();
  fx.freeze(mode);
  assert.ok(await waitFor(() => !isPidAlive(first), KILL_BOUND_MS + 2000), `${mode}: killed`);
  assert.ok(Date.now() - frozenAt <= KILL_BOUND_MS, `${mode}: at the limit (${Date.now() - frozenAt}ms)`);
  assert.match(
    fx.log(),
    /killing it and starting a replacement \(no progress, and its main thread waits on nothing the machine owes it: own\[cpu \+0ms, io \+0 ops \/ \+0 bytes, faults \+0\].* main thread\[[^\]]+ -> [^\]]+\]/
  );
  assert.doesNotMatch(fx.log(), /still alive/);
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), `${mode}: a replacement started`);
  fx.track(fx.boots()[1]);
  return fx.log();
}

test('(b) main thread blocked on a user-mode lock for ever: stuck, killed at the limit', async (t) => {
  const fx = fixture(t);
  await fx.start();
  const log = await assertStuckAtLimit(fx, 'idle');
  if (process.platform === 'win32') {
    assert.match(log, /main thread\[Waiting\/WrAlertByThreadId -> Waiting\/WrAlertByThreadId\]/);
  }
});

test('(d) an idle healthy daemon that just does not answer: stuck, killed at the limit', async (t) => {
  const fx = fixture(t);
  await fx.start();
  const log = await assertStuckAtLimit(fx, 'deaf');
  if (process.platform === 'win32') assert.match(log, /main thread\[Waiting\/WrQueue -> Waiting\/WrQueue\]/);
});

/** Freezes the daemon in `mode` and checks it lives to the cap, then dies at it. */
async function assertKeptUntilCap(fx, mode, reason) {
  const [first] = fx.boots();
  const frozenAt = Date.now();
  fx.freeze(mode);
  await delay(CAP_MS - 1000);
  assert.ok(isPidAlive(first), `${mode}: not killed before the cap`);
  assert.ok(await waitFor(() => !isPidAlive(first), 4000 + 2000 + 2000), `${mode}: killed at the cap`);
  const killedAfterMs = Date.now() - frozenAt;
  assert.ok(killedAfterMs >= CAP_MS - 200, `${mode}: not before the cap (${killedAfterMs}ms)`);
  assert.ok(killedAfterMs <= CAP_MS + 1000 + 2000 + 2000, `${mode}: at the cap (${killedAfterMs}ms)`);
  assert.match(fx.log(), new RegExp(`but is still alive, ${reason}`), 'the extension is logged with the numbers');
  assert.match(fx.log(), new RegExp(`hard cap ${CAP_MS}ms reached \\(${reason}\\)`));
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), 'a replacement started');
  fx.track(fx.boots()[1]);
}

test('answers nothing but trickles I/O slowly: not killed before the cap', async (t) => {
  const fx = fixture(t);
  await fx.start();
  await assertKeptUntilCap(fx, 'trickle', 'its own counters advance');
});

test('answers nothing while a child of it works: not killed before the cap', async (t) => {
  const fx = fixture(t);
  await fx.start();
  await assertKeptUntilCap(fx, 'child', "its descendants' counters advance");
  assert.match(fx.log(), /tree\[[1-9]\d* procs, [1-9]\d* survived, [1-9]\d* advanced: cpu \+[1-9]\d*ms/, 'the child counted');
});

// Regression: the descendants' counters were summed, so one that exited took
// its work out of the sum and a survivor's progress read as none.
test('a descendant exits while another works: the survivor still counts', async (t) => {
  const fx = fixture(t);
  await fx.start();
  const [first] = fx.boots();
  fx.freeze('handoff');
  const extended = /still alive, its descendants' counters advance: own\[[^\]]*\] tree\[(\d+) procs, (\d+) survived/g;
  const burnerFile = `${fx.paths.trigger}.child.burner`;
  // Relay, burner and writer, all working, at a look.
  assert.ok(await waitFor(() => existsSync(burnerFile) && fx.log().match(extended), CAP_MS), fx.log());
  const burner = Number(readFileSync(burnerFile, 'utf8'));
  const seen = fx.log().length;
  const before = Number([...fx.log().matchAll(extended)].at(-1)[1]);
  process.kill(burner, 'SIGKILL');
  assert.ok(await waitFor(() => !isPidAlive(burner), 5000), 'the burner exited');
  // A later look: the burner, by far the most CPU, is gone, and every
  // process left was there before it; the writer moved.
  const later = () =>
    [...fx.log().slice(seen).matchAll(extended)].find(
      (match) => Number(match[1]) < before && match[1] === match[2]
    );
  assert.ok(await waitFor(later, LIMIT_MS + 3000), `extended after the exit: ${fx.log().slice(seen)}`);
  assert.ok(isPidAlive(first), 'not killed for the exit');
});

const OWN_ADVANCE = 'its own counters advance';
const MAIN_ON_MACHINE = 'its main thread waits in the kernel on the machine';

/** Starts the suite's saturator, then checks `mode` lives to the cap. */
async function assertSaturatedKeptUntilCap(t, mode, prepare = () => {}) {
  const fx = fixture(t);
  await fx.start();
  prepare(fx);
  fx.saturate();
  await delay(1000);
  await assertKeptUntilCap(fx, mode, `(${OWN_ADVANCE}|${MAIN_ON_MACHINE})`);
}

test('(a) synchronous writes to a saturated disk: alive or held by the machine, kept to the cap', async (t) => {
  await assertSaturatedKeptUntilCap(t, 'diskwrite');
});

test(
  '(a) hard page-ins from a saturated disk: alive or held by the machine, kept to the cap',
  { skip: process.platform !== 'win32' && 'the cold file is made with FILE_FLAG_NO_BUFFERING' },
  async (t) => {
    await assertSaturatedKeptUntilCap(t, 'pagein', (fx) => {
      const made = spawnSync(SUITE_SUPERVISOR, ['--cold-file', `${fx.paths.trigger}.cold`, String(COLD_MIB)], {
        encoding: 'utf8',
      });
      assert.equal(made.status, 0, made.stderr);
    });
  }
);

test(
  '(a) main thread held in a kernel transfer wait that does not complete: extended, then killed at the cap',
  { skip: process.platform !== 'win32' && 'no unprivileged way to hold a thread in state D here' },
  async (t) => {
    const fx = fixture(t);
    await fx.start();
    await assertKeptUntilCap(fx, 'stuckio', MAIN_ON_MACHINE);
    assert.match(fx.log(), /own\[cpu \+0ms, io \+0 ops \/ \+0 bytes, faults \+0\]/);
    assert.match(fx.log(), /main thread\[Waiting\/Executive -> Waiting\/Executive\]/);
  }
);

test('a daemon whose main thread spins for ever is killed at the cap', async (t) => {
  const fx = fixture(t);
  await fx.start();
  const [first] = fx.boots();
  const frozenAt = Date.now();
  fx.freeze('spin');
  await delay(CAP_MS - 1000);
  assert.ok(isPidAlive(first), 'burning CPU reads as progress: not killed before the cap');
  assert.ok(await waitFor(() => !isPidAlive(first), 4000 + 2000 + 2000), 'killed at the cap');
  const killedAfterMs = Date.now() - frozenAt;
  assert.ok(killedAfterMs >= CAP_MS - 200, `not before the cap (${killedAfterMs}ms)`);
  assert.match(fx.log(), /still alive, its own counters advance: own\[cpu \+[1-9]\d*ms/);
  assert.match(fx.log(), new RegExp(`hard cap ${CAP_MS}ms reached \\(its own counters advance\\)`));
  assert.doesNotMatch(fx.log(), new RegExp(MAIN_ON_MACHINE), '(c) spinning never reads as held by the machine');
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), 'a replacement started');
  fx.track(fx.boots()[1]);
});

test('a reading the machine holds up never delays the cap', async (t) => {
  const fx = fixture(t);
  await fx.start({ bin: SUITE_SUPERVISOR, env: { MIXDOG_SUPERVISOR_STALL_READINGS: '1' } });
  const [first] = fx.boots();
  const frozenAt = Date.now();
  fx.freeze();
  assert.ok(await waitFor(() => !isPidAlive(first), CAP_MS + 1000 + 2000 + 2000), 'killed at the cap');
  const killedAfterMs = Date.now() - frozenAt;
  assert.ok(killedAfterMs >= CAP_MS - 1000, `not before the cap (${killedAfterMs}ms)`);
  assert.match(fx.log(), new RegExp(`hard cap ${CAP_MS}ms reached \\(a reading of the daemon is still on its way\\)`));
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), 'a replacement started');
  fx.track(fx.boots()[1]);
});

test('readings that never return are not piled up over replacements', async (t) => {
  const fx = fixture(t);
  await fx.start({ bin: SUITE_SUPERVISOR, env: { MIXDOG_SUPERVISOR_STALL_READINGS: '1' } });
  // Two daemons each leave one reading that never returns: both live to the cap.
  for (const nth of [1, 2]) {
    fx.track(fx.boots()[nth - 1]);
    fx.freeze();
    assert.ok(
      await waitFor(() => fx.boots().length === nth + 1, CAP_MS + 1000 + 2000 + 10_000),
      `replacement ${nth} started`,
    );
  }
  assert.doesNotMatch(fx.log(), /earlier readings never returned/);
  // The third is not read at all: no further thread is spent on a reading,
  // and a daemon that cannot be read gets no time past the limit.
  const third = fx.boots()[2];
  fx.track(third);
  const frozenAt = Date.now();
  fx.freeze();
  assert.ok(await waitFor(() => !isPidAlive(third), KILL_BOUND_MS + 2000), 'killed');
  const killedAfterMs = Date.now() - frozenAt;
  assert.ok(killedAfterMs < CAP_MS, `at the limit, not the cap (${killedAfterMs}ms)`);
  assert.match(fx.log(), /could not be read \(earlier readings never returned\)/);
  assert.ok(await waitFor(() => fx.boots().length === 4, 10_000), 'a replacement started');
  fx.track(fx.boots()[3]);
});

test('the product build has no instruments and ignores the seams', async (t) => {
  const probe = spawnSync(SUPERVISOR, ['--threads', String(process.pid), '1', '1'], { encoding: 'utf8' });
  assert.equal(probe.status, 2);
  assert.match(probe.stderr, /unknown argument --threads/);
  const fx = fixture(t);
  const starved = join(fx.paths.root, 'starved-machine');
  writeFileSync(starved, '30 0');
  // The old machine seam and the stalled-reading seam: neither saves a stuck daemon.
  await fx.start({ env: { MIXDOG_SUPERVISOR_STALL_READINGS: '1', MIXDOG_SUPERVISOR_MACHINE_FILE: starved } });
  await assertStuckAtLimit(fx, 'idle');
});

test("the supervisor's unit tests pass", () => {
  const run = spawnSync('cargo', ['test', '--locked', '--release', '--manifest-path', MANIFEST], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /test result: ok\. [1-9]\d* passed; 0 failed/);
});

// Regression: the reader stopped at the first non-UTF-8 byte, every later
// answer was lost, and a healthy daemon was killed and replaced over and over.
test('stray output on the daemon stdout never costs an answer', async (t) => {
  const fx = fixture(t);
  await fx.start();
  const [first] = fx.boots();
  fx.freeze('garbage');
  await delay(LIMIT_MS * 2 + 2000);
  assert.ok(isPidAlive(first), 'still answering');
  assert.deepEqual(fx.boots(), [first], 'never replaced');
});

// Regression: any writer to fd 1 could answer a ping or announce ready, and a
// worker forging `pong <n>` kept a frozen main thread "alive" past the limit.
test('answers forged by another thread never keep a frozen main thread alive', async (t) => {
  const fx = fixture(t);
  const { lines } = await fx.start();
  const [first] = fx.boots();
  const readies = () => lines.filter((line) => line === 'ready').length;
  const frozenAt = Date.now();
  fx.freeze('forge');
  assert.ok(await waitFor(() => !isPidAlive(first), KILL_BOUND_MS + 2000), 'the frozen daemon was killed');
  assert.ok(Date.now() - frozenAt <= KILL_BOUND_MS, `within the bound (${Date.now() - frozenAt}ms)`);
  // The replacement may already have announced itself; forged readies would
  // outnumber the boots (the forger writes them every 20 ms).
  assert.ok(readies() <= fx.boots().length, `no forged ready reached the launcher (${readies()})`);
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), 'one replacement started');
  fx.track(fx.boots()[1]);
  assert.ok(await waitFor(() => readies() === 2, 10_000), 'the replacement announced itself');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(readies(), 2, 'one ready per boot');
});

test('the kill is bounded even when the diagnostics output blocks', async (t) => {
  const fx = fixture(t);
  // A stderr pipe nobody reads: the daemon's 4 MiB write fills it and blocks
  // (on a worker), and so does the supervisor's diagnostic line.
  await fx.start({ stderr: 'pipe' });
  const [first] = fx.boots();
  const frozenAt = Date.now();
  fx.freeze('stderr');
  assert.ok(await waitFor(() => !isPidAlive(first), KILL_BOUND_MS + 2000), 'the frozen daemon was killed');
  assert.ok(Date.now() - frozenAt <= KILL_BOUND_MS, `within the bound (${Date.now() - frozenAt}ms)`);
  assert.match(fx.log(), new RegExp(`freeze supervisor: daemon pid=${first} left ping`), 'the log line went first');
  assert.ok(await waitFor(() => fx.boots().length === 2, 10_000), 'one replacement started');
  fx.track(fx.boots()[1]);
});

test('a daemon frozen when its supervisor is killed dies with it', async (t) => {
  const fx = fixture(t);
  const { child } = await fx.start();
  const [daemonPid] = fx.boots();
  fx.freeze();
  await delay(300);
  child.kill('SIGKILL');
  assert.ok(await waitFor(() => !isPidAlive(daemonPid), 5000), 'the frozen daemon did not outlive its supervisor');
  assert.deepEqual(fx.boots(), [daemonPid], 'nothing replaced it');
});

test('freeze recovery keeps working after the launcher that started the supervisor exited', async (t) => {
  const fx = fixture(t);
  const [command, args] = fx.script();
  const launcher = join(fx.paths.root, 'launcher.mjs');
  // Detached like the real launchers; reports the supervisor pid, then exits.
  writeFileSync(
    launcher,
    `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.on('data', (chunk) => {
  if (!String(chunk).includes('ready')) return;
  process.stdout.write(String(child.pid));
  process.exit(0);
});
`
  );
  const run = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  run.stdout.on('data', (chunk) => {
    out += chunk;
  });
  assert.equal(await new Promise((resolve) => run.once('exit', resolve)), 0);
  const supervisorPid = Number(out);
  fx.track(supervisorPid);
  const [first] = fx.boots();
  fx.track(first);
  assert.ok(isPidAlive(supervisorPid) && isPidAlive(first), 'both outlive the launcher');
  fx.freeze();
  assert.ok(await waitFor(() => fx.boots().length === 2, KILL_BOUND_MS + 5000), 'a replacement started');
  fx.track(fx.boots()[1]);
  assert.ok(!isPidAlive(first));
});

// The lifeline is what binds a daemon to its supervisor where the OS has no
// parent-death signal (macOS); its watcher is exercised here on any OS.
test('the lifeline kills a daemon whose main thread is frozen once its writer is gone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lifeline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, 'lifeline-daemon.mjs');
  writeFileSync(
    entry,
    `import { startSupervisorLink } from ${JSON.stringify(LINK)};
startSupervisorLink();
setTimeout(() => {
  process.stdout.write('frozen\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}, 200);
`
  );
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    env: { ...process.env, MIXDOG_DAEMON_SUPERVISED: '1', MIXDOG_DAEMON_LIFELINE_FD: '3' },
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  await delay(200);
  assert.equal(child.exitCode, null, 'alive while the lifeline is held');
  child.stdio[3].destroy();
  const outcome = await Promise.race([exited, delay(5000, 'timeout')]);
  assert.notEqual(outcome, 'timeout', 'the frozen process died at the lifeline EOF');
  if (process.platform !== 'win32') assert.equal(outcome.signal, 'SIGKILL');
});

// Regression: the capture stayed bound to the first daemon's pid, so a
// replacement's crash was recorded against the boot the supervisor had killed.
test("the launcher's capture records each replacement against its own pid", async (t) => {
  const fx = fixture(t);
  const dataDir = join(fx.paths.root, 'data');
  const entry = join(fx.paths.root, 'capture-daemon.mjs');
  // The stub, reading its paths from the environment the launcher passes on.
  writeFileSync(
    entry,
    `process.argv.push(process.env.TEST_BOOTS, process.env.TEST_TRIGGER);
await import(${JSON.stringify(pathToFileURL(fx.paths.stub).href)});
`
  );
  const candidate = await forkDaemonCandidate({
    launcher: 'test',
    entry,
    cwd: fx.paths.root,
    env: {
      ...process.env,
      MIXDOG_DAEMON_FREEZE_LIMIT_MS: String(LIMIT_MS),
      TEST_BOOTS: fx.paths.boots,
      TEST_TRIGGER: fx.paths.trigger,
    },
    execArgv: [],
    dataDir,
    log: () => {},
    timeoutMs: 20_000,
  });
  const [first] = fx.boots();
  fx.track(first);
  assert.equal(candidate.summary().pid, first);
  assert.ok(candidate.summary().ready);
  fx.freeze();
  assert.ok(await waitFor(() => fx.boots().length === 2, KILL_BOUND_MS + 5000), 'a replacement started');
  const [, second] = fx.boots();
  fx.track(second);
  assert.ok(await waitFor(() => candidate.summary().pid === second && candidate.summary().ready, 10_000));
  fx.freeze('crash');
  assert.ok(await waitFor(() => candidate.summary().exitedAt !== null, 10_000), 'the replacement exit was seen');
  assert.equal(candidate.summary().pid, second);
  assert.equal(candidate.summary().exitCode, 7);
  const records = readdirSync(daemonCrashCaptureDir({ dataDir }))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(daemonCrashCaptureDir({ dataDir }), name), 'utf8')));
  const replaced = records.find((record) => record.pid === first);
  assert.ok(replaced, JSON.stringify(records));
  assert.equal(replaced.ready, true);
  assert.match(replaced.exitReason, new RegExp(`killed by its supervisor.*replacement pid=${second}`));
  const crashed = records.find((record) => record.pid === second);
  assert.equal(crashed.exitCode, 7);
  assert.equal(crashed.ready, true);
});
