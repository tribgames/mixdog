import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { acquireDaemonOwnerLock, daemonOwnerLockPath } from './daemon-owner-lock.mjs';

const LOCK_URL = new URL('./daemon-owner-lock.mjs', import.meta.url).href;

// The lock path, and `closing(fn)`: run before the directory is removed (a
// held lock file cannot be deleted on Windows).
function lockFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-lock-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { lockPath: daemonOwnerLockPath(join(root, 'data')), closing: (fn) => closers.push(fn) };
}

// Another process trying the lock: reports whether it got it, then holds
// whatever it got until it is killed.
function contender({ lockPath, closing }) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { acquireDaemonOwnerLock } = await import(${JSON.stringify(LOCK_URL)});
globalThis.lock = await acquireDaemonOwnerLock(${JSON.stringify(lockPath)});
process.stdout.write(JSON.stringify({ held: globalThis.lock.held }) + '\\n');
setInterval(() => {}, 60_000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  closing(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  const verdict = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const end = out.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    exited.then(({ code }) => reject(new Error(`contender exited ${code} before answering: ${stderr}`)));
  });
  return { child, verdict, exited, stderr: () => stderr };
}

test('a held lock refuses every other process, and a SIGKILLed holder frees it at once', async (t) => {
  const fx = lockFixture(t);
  const { lockPath } = fx;
  const holder = contender(fx);
  assert.deepEqual(await holder.verdict, { held: true });
  assert.equal((await acquireDaemonOwnerLock(lockPath)).held, false);
  const second = contender(fx);
  assert.deepEqual(await second.verdict, { held: false });
  // The experimental-feature warning never reaches a candidate's stderr.
  assert.doesNotMatch(holder.stderr(), /ExperimentalWarning/);

  holder.child.kill('SIGKILL');
  await holder.exited;
  // No stale period, no probe: the kernel released it with the process.
  const next = await acquireDaemonOwnerLock(lockPath);
  fx.closing(() => next.release());
  assert.equal(next.held, true);
});

// The daemon hosts tools that may open any file in the data dir. Closing any
// descriptor of a file drops the process's POSIX record locks on it — with
// the fcntl lock SQLite takes on Linux, the readFileSync below handed
// ownership to the next contender.
test('the holder opening, reading and closing the lock file (as a hosted Read tool would) keeps the lock', async (t) => {
  const fx = lockFixture(t);
  const lock = await acquireDaemonOwnerLock(fx.lockPath);
  fx.closing(() => lock.release());
  assert.equal(lock.held, true);
  readFileSync(fx.lockPath);
  closeSync(openSync(fx.lockPath, 'r+'));
  assert.deepEqual(await contender(fx).verdict, { held: false });
  assert.equal(lock.intact(), true);
});

test('simultaneous acquisitions leave exactly one holder', async (t) => {
  const fx = lockFixture(t);
  const racers = Array.from({ length: 4 }, () => contender(fx));
  const verdicts = await Promise.all(racers.map((racer) => racer.verdict));
  assert.equal(verdicts.filter((verdict) => verdict.held).length, 1, JSON.stringify(verdicts));
});

// On Linux the lock was a name derived from the lock file's bytes alone: two
// data dirs with equal files (empty ones earlier builds left, a copy) shared
// one machine-wide name, and the second install could never own its own.
test('data dirs whose lock files hold equal bytes (empty, or copied) are locked independently', async (t) => {
  for (const seed of ['empty', 'copied']) {
    const first = lockFixture(t);
    const second = lockFixture(t);
    if (seed === 'empty') {
      mkdirSync(dirname(first.lockPath), { recursive: true });
      mkdirSync(dirname(second.lockPath), { recursive: true });
      writeFileSync(first.lockPath, '');
      writeFileSync(second.lockPath, '');
    }
    const holder = contender(first);
    assert.deepEqual(await holder.verdict, { held: true }, seed);
    if (seed === 'copied') {
      mkdirSync(dirname(second.lockPath), { recursive: true });
      copyFileSync(first.lockPath, second.lockPath);
    }
    const lock = await acquireDaemonOwnerLock(second.lockPath);
    second.closing(() => lock.release?.());
    assert.equal(lock.held, true, `${seed}: the other data dir's holder does not block this one`);
  }
});

test('racing daemons on an empty legacy lock file replace it once and leave exactly one holder', async (t) => {
  const fx = lockFixture(t);
  mkdirSync(dirname(fx.lockPath), { recursive: true });
  writeFileSync(fx.lockPath, '');
  const racers = Array.from({ length: 4 }, () => contender(fx));
  const verdicts = await Promise.all(racers.map((racer) => racer.verdict));
  assert.equal(verdicts.filter((verdict) => verdict.held).length, 1, JSON.stringify(verdicts));
  // Linux keeps its secret there; elsewhere the file is the lock itself.
  if (process.platform === 'linux') assert.match(readFileSync(fx.lockPath, 'utf8'), /^[0-9a-f]{64}$/);
});

test('one process holds it once; release frees it; intact() follows the locked file at its path', async (t) => {
  const { lockPath, closing } = lockFixture(t);
  const lock = await acquireDaemonOwnerLock(lockPath);
  closing(() => lock.release());
  assert.equal(lock.held, true);
  assert.equal((await acquireDaemonOwnerLock(lockPath)).held, false, 'a second connection is refused');
  assert.equal(lock.intact(), true);
  let removed = true;
  try {
    rmSync(lockPath);
  } catch {
    // Windows refuses to delete a file SQLite holds open.
    removed = false;
  }
  // A new holder could now take the lock: on Linux the name a new lock file
  // derives differs, elsewhere it is another file.
  assert.equal(existsSync(lockPath), !removed);
  assert.equal(lock.intact(), !removed, 'a deleted lock file is reported, a refused deletion is not');
  if (removed) return;
  lock.release();
  const again = await acquireDaemonOwnerLock(lockPath);
  closing(() => again.release());
  assert.equal(again.held, true);
});
