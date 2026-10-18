import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  claimSingletonOwner,
  handoffSingletonOwner,
  readSingletonOwner,
  refreshSingletonOwner,
  refreshSingletonOwnerAsync,
} from './singleton-owner.mjs';

const MODULE_URL = new URL('./singleton-owner.mjs', import.meta.url).href;

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

/** Holds the async refresh in its record write — the claim lock taken, the
 *  record already read — until released. */
function stallRecordWrite(ownerPath) {
  const original = fsp.writeFile;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reached;
  const stalled = new Promise((resolve) => {
    reached = resolve;
  });
  fsp.writeFile = async (file, ...rest) => {
    if (typeof file === 'string' && file.startsWith(`${ownerPath}.`) && !file.includes('.claim.lock')) {
      reached();
      await gate;
    }
    return original(file, ...rest);
  };
  syncBuiltinESMExports();
  return {
    stalled,
    release: () => release(),
    restore() {
      fsp.writeFile = original;
      syncBuiltinESMExports();
    },
  };
}

/** A successor daemon's claim, from another process, proving the current
 *  record stale. */
function successorClaim(ownerPath) {
  const script = [
    `import { claimSingletonOwner } from ${JSON.stringify(MODULE_URL)};`,
    `const claim = claimSingletonOwner(${JSON.stringify(ownerPath)}, { kind: 'mixdog-daemon', isStale: () => true });`,
    'process.stdout.write(JSON.stringify({ owned: claim.owned }));',
  ].join('\n');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

/** Largest gap between 5 ms ticks while `run()` is awaited: how long the
 *  event loop was blocked at once. */
async function maxLoopGap(run) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    const result = await run();
    // A block that ends the run is never followed by a tick: count it too.
    return { result, maxGapMs: Math.max(max, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

test('the async refresh keeps the claim-lock verdicts of the sync one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  try {
    const ownerPath = join(root, 'data', 'daemon-owner.json');
    const owner = { kind: 'mixdog-daemon', pid: 4242, heartbeatAt: 'a' };
    // Missing record: recreated.
    assert.deepEqual(await refreshSingletonOwnerAsync(ownerPath, owner), { status: 'refreshed', owner });
    assert.deepEqual(readSingletonOwner(ownerPath).owner, owner);
    const next = { ...owner, heartbeatAt: 'b' };
    assert.equal((await refreshSingletonOwnerAsync(ownerPath, next)).status, 'refreshed');
    assert.equal(readSingletonOwner(ownerPath).owner.heartbeatAt, 'b');
    // Another pid's record is reported, never overwritten — by either path.
    const winner = { kind: 'mixdog-daemon', pid: 7 };
    writeFileSync(ownerPath, JSON.stringify(winner));
    assert.deepEqual(await refreshSingletonOwnerAsync(ownerPath, next), { status: 'superseded', owner: winner });
    assert.deepEqual(refreshSingletonOwner(ownerPath, next), { status: 'superseded', owner: winner });
    assert.deepEqual(readSingletonOwner(ownerPath).owner, winner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a held claim lock: the async refresh waits it out without blocking the loop, the sync one blocks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  try {
    const ownerPath = join(root, 'data', 'daemon-owner.json');
    mkdirSync(`${ownerPath}.claim.lock`, { recursive: true });
    const owner = { kind: 'mixdog-daemon', pid: 4242 };
    // An ownerless lock (an older version's directory) younger than 5 s is
    // waited out for the 500 ms claim window: busy.
    const async = await maxLoopGap(() => refreshSingletonOwnerAsync(ownerPath, owner));
    assert.deepEqual(async.result, { status: 'busy', owner: null });
    assert.ok(async.maxGapMs < 150, `async refresh blocked the loop for ${Math.round(async.maxGapMs)}ms`);
    const sync = await maxLoopGap(async () => refreshSingletonOwner(ownerPath, owner));
    assert.equal(sync.result.status, 'busy');
    assert.ok(
      sync.maxGapMs >= 400,
      `the sync refresh blocks for its whole retry window (${Math.round(sync.maxGapMs)}ms)`
    );
    // Neither takes (nor removes) a lock it did not get, nor writes the record.
    assert.equal(existsSync(`${ownerPath}.claim.lock`), true);
    assert.equal(readSingletonOwner(ownerPath).owner, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live holder's claim lock is never reclaimed, however old; a dead holder's and an old ownerless one are", async (t) => {
  const { ownerPath, lockPath } = ownerFixture(t);
  const owner = { kind: 'mixdog-daemon', pid: 4242 };
  const held = writeForeignLock(lockPath, liveProcess(t), 3_600_000);
  assert.deepEqual(await refreshSingletonOwnerAsync(ownerPath, owner), { status: 'busy', owner: null });
  assert.deepEqual(refreshSingletonOwner(ownerPath, owner), { status: 'busy', owner: null });
  assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: 4242 }).owned, false);
  assert.equal(handoffSingletonOwner(ownerPath, 4242, { pid: 4243 }).owned, false);
  assert.equal(readFileSync(lockPath, 'utf8'), held, 'the live holder keeps its lock');
  assert.equal(readSingletonOwner(ownerPath).owner, null, 'and nobody wrote the record');

  // Its holder dead: reclaimed at once, by either path.
  writeForeignLock(lockPath, await deadPid());
  assert.equal((await refreshSingletonOwnerAsync(ownerPath, owner)).status, 'refreshed');
  assert.equal(existsSync(lockPath), false);
  writeForeignLock(lockPath, await deadPid());
  assert.equal(refreshSingletonOwner(ownerPath, owner).status, 'refreshed');
  assert.equal(existsSync(lockPath), false);

  // An older version's bare lock directory names no holder: reclaimed once
  // older than 5 s, as those versions did.
  mkdirSync(lockPath);
  ageLock(lockPath, 6000);
  assert.equal((await refreshSingletonOwnerAsync(ownerPath, owner)).status, 'refreshed');
  assert.equal(existsSync(lockPath), false);
  mkdirSync(lockPath);
  ageLock(lockPath, 6000);
  assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: 4242 }).owned, true);
  assert.equal(existsSync(lockPath), false);
});

test("a stalled async refresh keeps the claim lock and never overwrites a successor's record", async (t) => {
  const { ownerPath, lockPath } = ownerFixture(t);
  const mine = { kind: 'mixdog-daemon', pid: process.pid, heartbeatAt: 'old' };
  writeFileSync(ownerPath, JSON.stringify(mine));

  // Stalled past the stale age, lock held: a successor's claim cannot take it.
  let stall = stallRecordWrite(ownerPath);
  try {
    const refresh = refreshSingletonOwnerAsync(ownerPath, { ...mine, heartbeatAt: 'new' });
    await stall.stalled;
    ageLock(lockPath, 60_000);
    assert.equal(successorClaim(ownerPath).owned, false, "a successor never takes a live holder's lock");
    stall.release();
    assert.equal((await refresh).status, 'refreshed');
  } finally {
    stall.restore();
  }
  assert.equal(readSingletonOwner(ownerPath).owner.heartbeatAt, 'new');
  assert.equal(existsSync(lockPath), false);

  // A record another pid wrote while the refresh stalled (a writer that went
  // around the lock): reported, never overwritten.
  const successor = { kind: 'mixdog-daemon', pid: liveProcess(t), heartbeatAt: 'successor' };
  stall = stallRecordWrite(ownerPath);
  try {
    const refresh = refreshSingletonOwnerAsync(ownerPath, { ...mine, heartbeatAt: 'newer' });
    await stall.stalled;
    writeFileSync(ownerPath, JSON.stringify(successor));
    stall.release();
    assert.deepEqual(await refresh, { status: 'superseded', owner: successor });
  } finally {
    stall.restore();
  }
  assert.deepEqual(readSingletonOwner(ownerPath).owner, successor);
  assert.deepEqual(
    readdirSync(dirname(ownerPath)).filter((name) => name.endsWith('.tmp')),
    [],
    'its staged write is removed'
  );
});

/** Between the claim path's stat of an old bare lock directory and its
 *  removal, a contender replaces that directory with its own live,
 *  owner-named lock. Patches the first stat of `lockPath` that finds a
 *  directory: `statSync` (sync) or `fs/promises.stat` (async). */
function swapLegacyLockAfterStat(lockPath, holderPid, mode) {
  const target = mode === 'sync' ? fs : fsp;
  const name = mode === 'sync' ? 'statSync' : 'stat';
  const original = target[name];
  const swap = { replacement: null };
  const replaceIfLegacy = (path, info) => {
    if (swap.replacement === null && path === lockPath && info?.isDirectory()) {
      rmdirSync(lockPath);
      swap.replacement = writeForeignLock(lockPath, holderPid, 3_600_000);
    }
    return info;
  };
  target[name] =
    mode === 'sync'
      ? (path, ...rest) => replaceIfLegacy(path, original(path, ...rest))
      : async (path, ...rest) => replaceIfLegacy(path, await original(path, ...rest));
  syncBuiltinESMExports();
  swap.restore = () => {
    target[name] = original;
    syncBuiltinESMExports();
  };
  return swap;
}

test('an old bare lock directory swapped for a live lock between the stat and the removal is never deleted', async (t) => {
  const holder = liveProcess(t);
  const owner = { kind: 'mixdog-daemon', pid: process.pid };
  const cases = [
    [
      'async refresh',
      'async',
      (ownerPath) => refreshSingletonOwnerAsync(ownerPath, owner),
      { status: 'busy', owner: null },
    ],
    ['sync refresh', 'sync', (ownerPath) => refreshSingletonOwner(ownerPath, owner), { status: 'busy', owner: null }],
    [
      'sync claim',
      'sync',
      (ownerPath) => claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon' }),
      { owned: false, owner: null },
    ],
  ];
  for (const [label, mode, run, expected] of cases) {
    const { ownerPath, lockPath } = ownerFixture(t);
    mkdirSync(lockPath);
    ageLock(lockPath, 6000);
    const swap = swapLegacyLockAfterStat(lockPath, holder, mode);
    let result;
    try {
      result = await run(ownerPath);
    } finally {
      swap.restore();
    }
    assert.ok(swap.replacement, `${label}: the swap ran between the stat and the removal`);
    assert.deepEqual(result, expected, `${label}: the live holder is waited out`);
    assert.equal(readFileSync(lockPath, 'utf8'), swap.replacement, `${label}: the replacement lock survives`);
    assert.equal(readSingletonOwner(ownerPath).owner, null, `${label}: nothing wrote the record`);
  }
});

test('a refresh whose claim lock was replaced while it stalled leaves the replacement in place', async (t) => {
  const { ownerPath, lockPath } = ownerFixture(t);
  const mine = { kind: 'mixdog-daemon', pid: process.pid, heartbeatAt: 'old' };
  writeFileSync(ownerPath, JSON.stringify(mine));
  const holder = liveProcess(t);
  let replacement;
  const stall = stallRecordWrite(ownerPath);
  try {
    const refresh = refreshSingletonOwnerAsync(ownerPath, { ...mine, heartbeatAt: 'new' });
    await stall.stalled;
    // Removed under it (an older version reclaims on age alone) and taken by
    // another live process.
    rmSync(lockPath, { force: true });
    replacement = writeForeignLock(lockPath, holder);
    stall.release();
    await refresh;
  } finally {
    stall.restore();
  }
  assert.equal(readFileSync(lockPath, 'utf8'), replacement, 'the late release left the replacement lock alone');
  assert.deepEqual(await refreshSingletonOwnerAsync(ownerPath, mine), { status: 'busy', owner: null });
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

test('a live-pid owner record the caller proves stale is reported and reclaimed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  try {
    const ownerPath = join(root, 'data', 'daemon-owner.json');
    mkdirSync(join(root, 'data'), { recursive: true });
    // The test runner's own pid: alive, and not the claimant's.
    const reused = { kind: 'mixdog-daemon', pid: process.pid, claimedAt: '2020-01-01T00:00:00.000Z' };
    writeFileSync(ownerPath, JSON.stringify(reused));
    const claimant = process.pid + 1;

    assert.deepEqual(readSingletonOwner(ownerPath), { owner: reused, alive: true, stale: false });
    assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: claimant }).owned, false);

    const isStale = (owner) => owner.claimedAt === reused.claimedAt;
    assert.deepEqual(readSingletonOwner(ownerPath, { isStale }), { owner: reused, alive: false, stale: true });
    const claim = claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: claimant, isStale });
    assert.equal(claim.owned, true);
    assert.equal(readSingletonOwner(ownerPath).owner.pid, claimant);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
