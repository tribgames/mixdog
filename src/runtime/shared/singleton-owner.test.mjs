import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  claimSingletonOwner,
  handoffSingletonOwner,
  readSingletonOwner,
} from './singleton-owner.mjs';

function ownerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ownerPath = join(root, 'data', 'daemon-owner.json');
  mkdirSync(dirname(ownerPath), { recursive: true });
  return { ownerPath, lockPath: `${ownerPath}.claim.lock` };
}

/** A live process other than this one, alive until the test ends. */
function liveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child.pid;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

function ageLock(lockPath, ageMs) {
  const when = new Date(Date.now() - ageMs);
  utimesSync(lockPath, when, when);
}

/** Another process's acquisition, in the claim lock's format (pid, time, token). */
function writeForeignLock(lockPath, pid, ageMs = 0) {
  writeFileSync(lockPath, `${pid} ${Date.now() - ageMs} other-acquisition-token\n`);
  ageLock(lockPath, ageMs);
  return readFileSync(lockPath, 'utf8');
}

test("a live holder's claim lock is never reclaimed, however old; a dead holder's and an old ownerless one are", async (t) => {
  const { ownerPath, lockPath } = ownerFixture(t);
  const owner = { kind: 'mixdog-daemon', pid: 4242 };
  const held = writeForeignLock(lockPath, liveProcess(t), 3_600_000);
  assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: 4242 }).owned, false);
  assert.equal(handoffSingletonOwner(ownerPath, 4242, { pid: 4243 }).owned, false);
  assert.equal(readFileSync(lockPath, 'utf8'), held, 'the live holder keeps its lock');
  assert.equal(readSingletonOwner(ownerPath).owner, null, 'and nobody wrote the record');

  // Its holder dead: reclaimed at once.
  writeForeignLock(lockPath, await deadPid());
  assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: 4242 }).owned, true);
  assert.equal(existsSync(lockPath), false);
  rmSync(ownerPath);

  // An older version's bare lock directory names no holder: reclaimed once
  // older than 5 s, as those versions did.
  mkdirSync(lockPath);
  ageLock(lockPath, 6000);
  assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: 4242 }).owned, true);
  assert.equal(existsSync(lockPath), false);
});

/** Between the claim path's stat of an old bare lock directory and its
 *  removal, a contender replaces that directory with its own live,
 *  owner-named lock. Patches the first `statSync` of `lockPath` that finds a
 *  directory. */
function swapLegacyLockAfterStat(lockPath, holderPid) {
  const original = fs.statSync;
  const swap = { replacement: null };
  const replaceIfLegacy = (path, info) => {
    if (swap.replacement === null && path === lockPath && info?.isDirectory()) {
      rmdirSync(lockPath);
      swap.replacement = writeForeignLock(lockPath, holderPid, 3_600_000);
    }
    return info;
  };
  fs.statSync = (path, ...rest) => replaceIfLegacy(path, original(path, ...rest));
  syncBuiltinESMExports();
  swap.restore = () => {
    fs.statSync = original;
    syncBuiltinESMExports();
  };
  return swap;
}

test('an old bare lock directory swapped for a live lock between the stat and the removal is never deleted', (t) => {
  const holder = liveProcess(t);
  const { ownerPath, lockPath } = ownerFixture(t);
  mkdirSync(lockPath);
  ageLock(lockPath, 6000);
  const swap = swapLegacyLockAfterStat(lockPath, holder);
  let result;
  try {
    result = claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon' });
  } finally {
    swap.restore();
  }
  assert.ok(swap.replacement, 'the swap ran between the stat and the removal');
  assert.deepEqual(result, { owned: false, owner: null }, 'the live holder is waited out');
  assert.equal(readFileSync(lockPath, 'utf8'), swap.replacement, 'the replacement lock survives');
  assert.equal(readSingletonOwner(ownerPath).owner, null, 'nothing wrote the record');
});

test('claimSingletonOwner creates a missing data directory on first boot', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  try {
    const ownerPath = join(root, 'fresh', 'data', 'daemon-owner.json');
    const claim = claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon' });
    assert.equal(claim.owned, true);
    assert.equal(readSingletonOwner(ownerPath).owner.pid, process.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
