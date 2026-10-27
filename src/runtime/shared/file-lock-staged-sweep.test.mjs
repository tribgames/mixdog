import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { sweepStagedLockFiles, withFileLock, withFileLockSync } from './file-lock.mjs';

test('taking a lock never waits for the staged-file sweep of a crowded directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const old = new Date(Date.now() - 5 * 60_000);
  const staged = (lock) => {
    const path = join(dir, `${lock}.${deadPid}.0123456789abcdef.tmp`);
    writeFileSync(path, `${deadPid} 0 token\n`);
    utimesSync(path, old, old);
    return path;
  };
  // Listing the directory takes 400 ms, as for a profile directory with many files.
  const SLOW_MS = 400;
  const listSync = fs.readdirSync;
  const listAsync = fsp.readdir;
  fs.readdirSync = function (...args) {
    const until = Date.now() + SLOW_MS;
    while (Date.now() < until);
    return listSync.apply(this, args);
  };
  fsp.readdir = async function (...args) {
    await delay(SLOW_MS);
    return listAsync.apply(this, args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readdirSync = listSync;
    fsp.readdir = listAsync;
    syncBuiltinESMExports();
  });
  const syncStale = staged('sync.lock');
  const asyncStale = staged('async.lock');

  let startedAt = Date.now();
  assert.equal(
    withFileLockSync(join(dir, 'sync.lock'), () => 'entered'),
    'entered'
  );
  assert.ok(Date.now() - startedAt < SLOW_MS, 'the synchronous lock did not list the directory');

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  t.after(() => clearInterval(timer));
  startedAt = Date.now();
  assert.equal(await withFileLock(join(dir, 'async.lock'), async () => 'entered'), 'entered');
  assert.ok(Date.now() - startedAt < SLOW_MS, 'the asynchronous lock did not wait for the listing');

  // The sweeps still run, beside the locks, and the timer kept running through them.
  const deadline = Date.now() + 5_000;
  while (existsSync(syncStale) || existsSync(asyncStale)) {
    assert.ok(Date.now() < deadline, 'the stale staged files were swept');
    await delay(20);
  }
  assert.ok(ticks >= 10, `timers ran ${ticks} times while the directory was listed`);
});

test('a stale staged owner record of a dead process is swept once per lock path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A pid that certainly exited: a child that already ran to completion.
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const lockPath = join(dir, 'store.json.lock');
  const old = new Date(Date.now() - 5 * 60_000);
  const file = (name, stale) => {
    const path = join(dir, name);
    writeFileSync(path, `${deadPid} 0 token\n`);
    if (stale) utimesSync(path, old, old);
    return path;
  };
  const deadStale = file(`store.json.lock.${deadPid}.0123456789abcdef.tmp`, true);
  const deadGuard = file(`store.json.lock.reclaim.${deadPid}.0123456789abcdef.tmp`, true);
  const deadFresh = file(`store.json.lock.${deadPid}.fedcba9876543210.tmp`, false);
  const liveStale = file(`store.json.lock.${process.pid}.0123456789abcdef.tmp`, true);
  const otherLock = file(`other.json.lock.${deadPid}.0123456789abcdef.tmp`, true);
  const unrelated = file('store.json.lock.backup.tmp', true);

  assert.equal(await sweepStagedLockFiles(lockPath), 2);
  assert.equal(existsSync(deadStale), false);
  assert.equal(existsSync(deadGuard), false);
  for (const kept of [deadFresh, liveStale, otherLock, unrelated]) assert.equal(existsSync(kept), true);
  // Once per lock path per process: a later stale file waits for the next process.
  const later = file(`store.json.lock.${deadPid}.1111111111111111.tmp`, true);
  assert.equal(await sweepStagedLockFiles(lockPath), 0);
  assert.equal(existsSync(later), true);
});
