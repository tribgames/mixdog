// The daemon supervisor (native/mixdog-supervisor) against a stand-in daemon
// that speaks the real link (daemon-supervisor-link.mjs): freeze recovery,
// bounded diagnostics, the daemon's lifetime bound to the supervisor, and a
// supervisor that keeps working once the launcher that started it is gone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { forkDaemonCandidate, installedSupervisorBinary } from '../session-runtime/services/daemon-candidate.mjs';
import { daemonCrashCaptureDir } from '../session-runtime/services/daemon-crash-capture.mjs';

// The binary the launcher itself would start, so a source build is what CI tests.
const SUPERVISOR = installedSupervisorBinary(tmpdir());
assert.ok(SUPERVISOR, 'build the supervisor first: npm run build:supervisor:test');
const LINK = new URL('./daemon-supervisor-link.mjs', import.meta.url).href;
const LIMIT_MS = 2000;
// Ping interval (1 s) plus the diagnostics budget (2 s) plus scheduling slack.
const KILL_BOUND_MS = LIMIT_MS + 1000 + 2000 + 2000;

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

// Appends its pid to `boots`, reports ready, and freezes its main thread for
// good once `trigger` appears ('stderr': after a 4 MiB write to fd 2 first;
// 'forge': with a worker forging answers on fd 1 meanwhile; 'garbage': writes
// stray bytes to fd 1 instead; 'crash': exits with 7).
const STUB = `
import { appendFileSync, existsSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { startSupervisorLink } from ${JSON.stringify(LINK)};
const [boots, trigger] = process.argv.slice(2);
appendFileSync(boots, process.pid + '\\n');
startSupervisorLink({ describe: () => 'stub=' + process.pid }).ready();
setInterval(() => {
  if (!existsSync(trigger)) return;
  const mode = readFileSync(trigger, 'utf8');
  rmSync(trigger, { force: true });
  if (mode === 'crash') process.exit(7);
  if (mode === 'garbage') {
    // What else lands on fd 1: invalid UTF-8, an overlong line, a partial one.
    writeSync(1, Buffer.from([255, 10]));
    writeSync(1, Buffer.alloc(10_000, 0x62));
    writeSync(1, '\\n');
    writeSync(1, 'partial without newline');
    return;
  }
  if (mode === 'stderr') writeSync(2, Buffer.alloc(4 << 20, 0x61));
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
    async start({ stderr = 'ignore' } = {}) {
      const child = spawn(SUPERVISOR, [...supervisorArgs, ...daemonArgs], { stdio: ['ignore', 'pipe', stderr] });
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
  // A stderr pipe nobody reads: the daemon's 4 MiB write fills it and blocks,
  // and so does the supervisor's diagnostic line.
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
