import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  beginDaemonSpawnCapture,
  daemonCaptureBootState,
  daemonCrashCaptureDir,
  pruneDaemonCrashCaptures,
  CRASH_CAPTURE_KEEP_BOOTS,
} from './daemon-crash-capture.mjs';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';

const RECORD_KEYS = [
  'detached',
  'error',
  'exitCode',
  'exitSignal',
  'exitedAt',
  'heapFlags',
  'kind',
  'launcher',
  'launcherPid',
  'pid',
  'ready',
  'readyAt',
  'spawnedAt',
  'stderrBytes',
  'stderrFile',
  'uptimeMs',
];

// Writes to fd 2 before the ready handshake, then — only once the fixture opens
// its gate, which it does after the launcher has processed ready — writes one
// more line and exits with a known code. The gate makes "late stderr, strictly
// after ready" deterministic instead of a raced delay.
const STUB_DAEMON = `
import { existsSync } from 'node:fs';

const gate = process.argv[2];
process.stderr.write('boot line one\\n');
process.stderr.write('boot line two\\n');
process.send?.({ type: 'ready' });
const poll = setInterval(() => {
  if (gate && !existsSync(gate)) return;
  clearInterval(poll);
  process.stderr.write('post ready native line\\n');
  process.exit(7);
}, 25);
setTimeout(() => process.exit(0), 60_000);
`;

async function waitFor(check, { timeoutMs = 15_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(intervalMs);
  }
}

/** Every wait on a child process is deadline-bounded: a stuck fixture must
 *  fail the test, never hang the run. */
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

function workspace(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const children = new Set();
  const captures = new Set();
  // ONE cleanup hook, so ordering is never a matter of hook registration:
  // descriptors are dropped and fixture children are reaped BEFORE their unique
  // temp directory is removed.
  t.after(async () => {
    for (const capture of captures) {
      try {
        capture.release();
      } catch {}
    }
    for (const pid of children) {
      if (!isPidAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    for (const pid of children) await waitFor(() => !isPidAlive(pid), { timeoutMs: 10_000 });
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    /** Captures whose launcher never forks still hold a descriptor. */
    own(capture) {
      captures.add(capture);
      return capture;
    },
    // Fixture children run INSIDE the temp directory: a native crash artifact
    // (core dump, report) must never land in the repository.
    fork(entry, args = [], options = {}) {
      const child = fork(entry, args, { cwd: root, ...options });
      if (child.pid) children.add(child.pid);
      return child;
    },
  };
}

function stubEntry(root) {
  const entry = join(root, 'stub-daemon.mjs');
  writeFileSync(entry, STUB_DAEMON);
  return entry;
}

function countLines(rows, needle) {
  return rows.filter((row) => row.includes(needle)).length;
}

function deadRecord(pid = 999_999_999) {
  return {
    kind: 'mixdog-daemon-crash-capture',
    pid,
    launcherPid: 999_999_998,
    exitedAt: '2026-09-15T06:49:00.000Z',
  };
}

function bootStems(dir) {
  return [
    ...new Set(
      readdirSync(dir)
        .filter((name) => /^daemon-\d{8}-\d{6}-\d+-[0-9a-f]{4}\.(err\.log|json)$/.test(name))
        .map((name) => name.replace(/\.(err\.log|json)$/, ''))
    ),
  ];
}

function writeBoot(dir, stem, { bytes = 1024, record = null, mtimeMs }) {
  const files = [join(dir, `${stem}.err.log`)];
  writeFileSync(files[0], Buffer.alloc(bytes, 'x'));
  if (record) {
    files.push(join(dir, `${stem}.json`));
    writeFileSync(files[1], JSON.stringify(record));
  }
  const at = new Date(mtimeMs);
  for (const file of files) utimesSync(file, at, at);
}

test('a daemon that dies after ready leaves its fd 2 text and exit code on disk', async (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-');
  const root = fixture.root;
  const logs = [];
  const capture = beginDaemonSpawnCapture({
    launcher: 'test',
    dataDir: root,
    log: (line) => logs.push(line),
  });
  assert.equal(typeof capture.stderrStdio, 'number');
  const execArgv = ['--max-old-space-size=64'];
  const gate = join(root, 'stub-gate');
  const child = fixture.fork(stubEntry(root), [gate], {
    execArgv,
    stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'],
    env: { ...process.env, MIXDOG_TEST_SECRET: 'daemon-capture-secret-value' },
  });
  capture.track(child, { detached: false, execArgv });
  await within(readyMessage(child), 15_000, 'stub ready');
  capture.noteReady();
  child.disconnect();
  child.unref();
  // Strictly after ready: the post-ready write cannot happen before this.
  writeFileSync(gate, 'go');
  await within(once(child, 'exit'), 15_000, 'stub exit');

  const captured = readFileSync(capture.capturePath, 'utf8');
  assert.match(captured, /boot line one/);
  assert.match(captured, /post ready native line/);

  const raw = readFileSync(capture.recordPath, 'utf8');
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
  assert.equal(record.kind, 'mixdog-daemon-crash-capture');
  assert.equal(record.pid, child.pid);
  assert.equal(record.ready, true);
  assert.equal(record.exitCode, 7);
  assert.equal(record.exitSignal, null);
  assert.ok(record.stderrBytes > 0);
  assert.ok(record.spawnedAt && record.readyAt && record.exitedAt);
  assert.ok(Number.isFinite(record.uptimeMs) && record.uptimeMs >= 0);
  assert.deepEqual(record.heapFlags, ['--max-old-space-size=64']);
  // No environment or argument dump: only the heap flags that explain an OOM.
  assert.equal(raw.includes('daemon-capture-secret-value'), false);
  assert.equal(raw.includes('MIXDOG_TEST_SECRET'), false);

  // Every captured line reaches the launcher log exactly once across the
  // ready and exit drains, and the exit is correlated to pid/ready state.
  assert.equal(countLines(logs, 'boot line one'), 1);
  assert.equal(countLines(logs, 'boot line two'), 1);
  assert.equal(countLines(logs, 'post ready native line'), 1);
  const exitLine = logs.find((line) => line.startsWith('daemon exit '));
  assert.ok(exitLine, 'the launcher logs one correlated exit line');
  assert.match(exitLine, new RegExp(`pid=${child.pid}\\b`));
  assert.match(exitLine, /code=7 signal=- ready=1 uptimeMs=\d+ stderrBytes=\d+/);
});

test('a capture that cannot be opened falls back to the stderr pipe without losing boot lines', async (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-fallback-');
  const root = fixture.root;
  // A FILE where the capture directory must be: mkdir fails, capture degrades.
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const logs = [];
  const capture = beginDaemonSpawnCapture({
    launcher: 'test',
    dir: blocked,
    log: (line) => logs.push(line),
  });
  assert.equal(capture.stderrStdio, 'pipe');
  assert.equal(capture.capturePath, null);
  const gate = join(root, 'stub-gate');
  const child = fixture.fork(stubEntry(root), [gate], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  capture.track(child, { detached: false, execArgv: [] });
  await within(readyMessage(child), 15_000, 'stub ready');
  capture.noteReady();
  child.disconnect();
  child.stderr.unref();
  // Released only after the launcher processed ready, so this line is provably
  // late: a mirror cut at the IPC handshake would lose it.
  writeFileSync(gate, 'go');
  await within(once(child, 'exit'), 15_000, 'stub exit');
  // Pipe delivery outlives both the handshake and the exit event.
  await within(capture.whenDrained(), 15_000, 'fallback stderr drain');
  assert.equal(countLines(logs, 'daemon crash capture unavailable'), 1);
  assert.equal(countLines(logs, 'boot line one'), 1);
  assert.equal(countLines(logs, 'boot line two'), 1);
  assert.equal(
    countLines(logs, 'post ready native line'),
    1,
    'a native fd 2 line after ready is still mirrored while the launcher lives'
  );
  assert.match(
    logs.find((line) => line.startsWith('daemon exit ')),
    /code=7 signal=- ready=1/
  );
});

test('a losing contender leaves no capture file behind', async (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-loser-');
  const root = fixture.root;
  const entry = join(root, 'loser.mjs');
  writeFileSync(entry, 'process.exit(0);\n');
  const logs = [];
  const capture = beginDaemonSpawnCapture({
    launcher: 'test',
    dataDir: root,
    log: (line) => logs.push(line),
  });
  const child = fixture.fork(entry, [], { stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'] });
  capture.track(child, { detached: false, execArgv: [] });
  await within(once(child, 'exit'), 15_000, 'contender exit');
  assert.deepEqual(readdirSync(daemonCrashCaptureDir({ dataDir: root })), []);
  assert.match(
    logs.find((line) => line.startsWith('daemon exit ')),
    /code=0 signal=- ready=0/
  );
});

test('an asynchronous spawn failure is persisted in the sidecar', async (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-spawn-error-');
  const root = fixture.root;
  const logs = [];
  const capture = beginDaemonSpawnCapture({
    launcher: 'test',
    dataDir: root,
    log: (line) => logs.push(line),
  });
  // A missing exec path fails asynchronously: 'error' fires and 'exit' never does.
  const child = fixture.fork(stubEntry(root), [], {
    execPath: join(root, 'no-such-node-binary'),
    stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'],
  });
  capture.track(child, { detached: false, execArgv: [] });
  const [error] = await within(once(child, 'error'), 15_000, 'spawn error');
  assert.ok(error, 'the fixture reproduced an asynchronous spawn failure');
  const recorded = await waitFor(
    () => {
      try {
        const value = JSON.parse(readFileSync(capture.recordPath, 'utf8'));
        return value.error ? value : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 10_000 }
  );
  assert.ok(recorded, 'the spawn failure reached the sidecar');
  assert.equal(recorded.pid, null);
  assert.ok(recorded.exitedAt, 'a boot that never spawned is terminal, not "launching"');
  assert.equal(recorded.stderrFile, null, 'the empty raw capture is dropped, the record is kept');
  // A terminal record must not keep protecting itself from retention.
  assert.equal(daemonCaptureBootState({ recordPath: capture.recordPath }), 'completed');
});

test('a colliding boot identity never adopts or overwrites existing evidence', (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-collision-');
  const root = fixture.root;
  const dir = daemonCrashCaptureDir({ dataDir: root });
  mkdirSync(dir, { recursive: true });
  const fixedNow = Date.UTC(2026, 8, 15, 6, 48, 59);
  const stemAt = (suffix) => `daemon-20260915-064859-${process.pid}-${suffix}`;
  const takenRaw = join(dir, `${stemAt('aaaa')}.err.log`);
  const takenRecord = join(dir, `${stemAt('cccc')}.json`);
  writeFileSync(takenRaw, 'FATAL ERROR: earlier crash evidence\n');
  writeFileSync(takenRecord, JSON.stringify(deadRecord()));

  const nonces = ['aaaa', 'cccc', 'bbbb'];
  let index = 0;
  const capture = fixture.own(
    beginDaemonSpawnCapture({
      launcher: 'test',
      dataDir: root,
      prune: false,
      now: () => fixedNow,
      nonce: () => nonces[Math.min(index++, nonces.length - 1)],
    })
  );
  assert.equal(capture.stem, stemAt('bbbb'), 'a taken identity is skipped, not reused');
  assert.equal(readFileSync(takenRaw, 'utf8'), 'FATAL ERROR: earlier crash evidence\n');
  assert.equal(JSON.parse(readFileSync(takenRecord, 'utf8')).pid, deadRecord().pid);
  assert.equal(
    existsSync(join(dir, `${stemAt('cccc')}.err.log`)),
    false,
    'the probe for a sidecar-owned identity leaves nothing behind'
  );
  assert.equal(statSync(capture.capturePath).size, 0, 'the new capture starts empty');
});

test('an exhausted identity search degrades to the pipe instead of overwriting evidence', (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-collision-exhausted-');
  const root = fixture.root;
  const dir = daemonCrashCaptureDir({ dataDir: root });
  mkdirSync(dir, { recursive: true });
  const fixedNow = Date.UTC(2026, 8, 15, 6, 48, 59);
  const taken = join(dir, `daemon-20260915-064859-${process.pid}-aaaa.err.log`);
  writeFileSync(taken, 'FATAL ERROR: earlier crash evidence\n');
  const logs = [];
  const capture = fixture.own(
    beginDaemonSpawnCapture({
      launcher: 'test',
      dataDir: root,
      prune: false,
      now: () => fixedNow,
      nonce: () => 'aaaa',
      log: (line) => logs.push(line),
    })
  );
  assert.equal(capture.stderrStdio, 'pipe', 'boot diagnostics still have a sink');
  assert.equal(capture.capturePath, null);
  assert.equal(capture.stem, null);
  assert.equal(countLines(logs, 'daemon crash capture unavailable'), 1);
  assert.equal(readFileSync(taken, 'utf8'), 'FATAL ERROR: earlier crash evidence\n');
});

test('retention keeps an active daemon capture untouched and bounds completed boots', (t) => {
  const { root } = workspace(t, 'mixdog-crash-capture-prune-');
  const dir = daemonCrashCaptureDir({ dataDir: root });
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let index = 0; index < 6; index += 1) {
    writeBoot(dir, `daemon-20260915-06480${index}-1234-ab0${index}`, {
      bytes: 1024,
      mtimeMs: now - (10 - index) * 60_000,
      record:
        index === 0
          ? { kind: 'mixdog-daemon-crash-capture', pid: process.pid, launcherPid: process.pid, exitedAt: null }
          : deadRecord(),
    });
  }
  writeFileSync(join(dir, 'notes.txt'), 'operator note');

  const result = pruneDaemonCrashCaptures({ dir, keepBoots: 2, keepBytes: 1024 * 1024 });
  const names = new Set(readdirSync(dir));
  assert.ok(names.has('daemon-20260915-064805-1234-ab05.err.log'), 'newest completed boot kept');
  assert.ok(names.has('daemon-20260915-064804-1234-ab04.err.log'), 'second newest completed boot kept');
  assert.ok(names.has('daemon-20260915-064800-1234-ab00.err.log'), 'a live daemon keeps its capture');
  assert.equal(names.has('daemon-20260915-064803-1234-ab03.err.log'), false);
  assert.equal(names.has('daemon-20260915-064801-1234-ab01.json'), false);
  assert.equal(result.activeBoots, 1);
  assert.equal(result.keptBoots, 2, 'the budget counts completed boots only');
  assert.ok(names.has('notes.txt'), 'unrelated files are never pruned');
});

test('the newest completed crash capture is trimmed to its tail, never deleted', (t) => {
  const { root } = workspace(t, 'mixdog-crash-capture-trim-');
  const dir = daemonCrashCaptureDir({ dataDir: root });
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const stem = 'daemon-20260915-064805-1234-ff05';
  const rawPath = join(dir, `${stem}.err.log`);
  const recordPath = join(dir, `${stem}.json`);
  // One capture that alone blows the whole byte budget, with the fatal report
  // where V8 always puts it: at the very end.
  writeFileSync(
    rawPath,
    Buffer.concat([Buffer.alloc(300 * 1024, 'x'), Buffer.from('FATAL ERROR: Reached heap limit Allocation failed\n')])
  );
  writeFileSync(recordPath, JSON.stringify(deadRecord()));
  const at = new Date(now - 60_000);
  utimesSync(rawPath, at, at);
  utimesSync(recordPath, at, at);

  const result = pruneDaemonCrashCaptures({
    dir,
    keepBoots: 8,
    keepBytes: 64 * 1024,
    tailBytes: 32 * 1024,
  });
  assert.equal(result.removed, 0, 'the newest crash evidence is never deleted');
  assert.equal(result.trimmed, 1);
  assert.ok(existsSync(recordPath), 'its sidecar is kept with the tail');
  const raw = readFileSync(rawPath, 'utf8');
  assert.match(raw, /FATAL ERROR: Reached heap limit/);
  assert.match(raw, /^\[capture trimmed: dropped \d+ earlier byte\(s\)\]/);
  assert.ok(statSync(rawPath).size <= 32 * 1024 + 128, 'the retained tail is bounded');
});

test('retention drops the oldest completed boots once the byte budget is spent', (t) => {
  const { root } = workspace(t, 'mixdog-crash-capture-bytes-');
  const dir = daemonCrashCaptureDir({ dataDir: root });
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    writeBoot(dir, `daemon-20260915-06480${index}-4321-cd0${index}`, {
      bytes: 30 * 1024,
      mtimeMs: now - (10 - index) * 60_000,
      record: deadRecord(),
    });
  }
  pruneDaemonCrashCaptures({ dir, keepBoots: 10, keepBytes: 64 * 1024, tailBytes: 1024 * 1024 });
  const remaining = readdirSync(dir);
  const bytes = remaining.reduce((total, name) => total + statSync(join(dir, name)).size, 0);
  const raws = remaining.filter((name) => name.endsWith('.err.log'));
  assert.equal(raws.length, 2);
  assert.ok(bytes <= 64 * 1024, `retained bytes stay bounded (${bytes})`);
  assert.ok(raws.includes('daemon-20260915-064803-4321-cd03.err.log'), 'the newest boot survives');
});

test('a restart prunes to the completed budget while its own active capture stays outside it', (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-restart-');
  const root = fixture.root;
  const dir = daemonCrashCaptureDir({ dataDir: root });
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index).padStart(2, '0');
    writeBoot(dir, `daemon-20260915-0648${suffix}-5555-ef${suffix}`, {
      bytes: 2048,
      mtimeMs: now - (60 - index) * 60_000,
      record: deadRecord(),
    });
  }
  const capture = fixture.own(beginDaemonSpawnCapture({ launcher: 'test', dataDir: root }));
  const afterSpawn = bootStems(dir);
  assert.ok(afterSpawn.includes(capture.stem), 'the in-flight boot survives its own prune');
  assert.equal(
    afterSpawn.filter((stem) => stem !== capture.stem).length,
    CRASH_CAPTURE_KEEP_BOOTS,
    'completed boots are held to the documented budget, the active boot is extra'
  );

  // Closing the boot folds it into the completed budget on the next restart,
  // where it is the newest crash and therefore the one that must survive.
  capture.noteExit({ code: 1, signal: null });
  const next = fixture.own(beginDaemonSpawnCapture({ launcher: 'test', dataDir: root }));
  const afterRestart = bootStems(dir).filter((stem) => stem !== next.stem);
  assert.equal(afterRestart.length, CRASH_CAPTURE_KEEP_BOOTS);
  assert.ok(afterRestart.includes(capture.stem), 'the newest completed crash survives the restart');
});

test('a launch in progress is never pruned by a concurrent launcher', (t) => {
  const fixture = workspace(t, 'mixdog-crash-capture-concurrent-');
  const root = fixture.root;
  const dir = daemonCrashCaptureDir({ dataDir: root });
  // Two launchers race: each opened fd 2, neither has published a child pid.
  const first = fixture.own(beginDaemonSpawnCapture({ launcher: 'a', dataDir: root }));
  const second = fixture.own(beginDaemonSpawnCapture({ launcher: 'b', dataDir: root }));
  const pressured = pruneDaemonCrashCaptures({ dir, keepBoots: 1, keepBytes: 64 * 1024 });
  assert.equal(pressured.removed, 0);
  assert.equal(pressured.activeBoots, 2);
  assert.ok(existsSync(first.capturePath) && existsSync(second.capturePath));

  // A raw capture whose sidecar has not landed yet, and a sidecar caught
  // mid-write, are both UNKNOWN — never "safe to delete", at ANY age. Aging
  // them out would be the bug: a live daemon whose metadata was damaged would
  // lose the very file it is still writing its fatal report into.
  const orphan = 'daemon-20260915-064859-4242-beef';
  writeFileSync(join(dir, `${orphan}.err.log`), 'partial boot output\n');
  const corrupt = 'daemon-20260915-064858-4242-dead';
  writeFileSync(join(dir, `${corrupt}.err.log`), 'x');
  writeFileSync(join(dir, `${corrupt}.json`), '{ "pid": ');
  const old = new Date(Date.now() - 6 * 60 * 60_000);
  for (const name of [`${corrupt}.err.log`, `${corrupt}.json`, `${orphan}.err.log`]) {
    utimesSync(join(dir, name), old, old);
  }
  // Debris from an interrupted atomic sidecar write is reclaimed only when its
  // writer pid is provably gone; an OLD temp from a live writer is left alone.
  const deadWriterTemp = join(dir, '.daemon-20260915-064858-999999998-dead.json.abcdef.tmp');
  const liveWriterTemp = join(dir, `.daemon-20260915-064859-${process.pid}-beef.json.123456.tmp`);
  writeFileSync(deadWriterTemp, '{');
  writeFileSync(liveWriterTemp, '{');
  utimesSync(liveWriterTemp, old, old);
  // A completed boot newer than all of them, so nothing survives merely by
  // being the newest crash on disk.
  writeBoot(dir, 'daemon-20260915-064900-4242-cafe', {
    bytes: 512,
    mtimeMs: Date.now(),
    record: deadRecord(),
  });

  const result = pruneDaemonCrashCaptures({ dir, keepBoots: 1, keepBytes: 64 * 1024 });
  assert.ok(existsSync(join(dir, `${corrupt}.err.log`)), 'an old unreadable sidecar stays protected');
  assert.ok(existsSync(join(dir, `${orphan}.err.log`)), 'an old sidecar-less capture stays protected');
  assert.equal(result.unknownBoots, 2, 'unknown boots are reported, never pruned');
  assert.equal(result.activeBoots, 2);
  assert.equal(result.removed, 0);
  assert.equal(existsSync(deadWriterTemp), false, 'debris from a dead writer is reclaimed');
  assert.ok(existsSync(liveWriterTemp), 'a temp whose writer still lives is left alone');
  assert.ok(existsSync(first.capturePath) && existsSync(second.capturePath));
});
