import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as realFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const tempRoot = mkdtempSync(join(tmpdir(), 'mixdog-orphan-sweep-test-'));
const posix = (p) => p.replaceAll('\\', '/');

const execCalls = [];
let processRows = [];
let execError = null;
const EXEC_DELAY_MS = 40;
// Hold the process list open until the test releases it, so "the loop keeps
// turning while it is outstanding" does not depend on timer resolution
// (Windows coalesces short timers to ~15.6 ms, more so under load).
let holdExec = false;
let execHeld = null;

function rowsToStdout(rows) {
  if (process.platform === 'win32') {
    return rows.map((r) => JSON.stringify({ pid: r.pid, started: r.uptimeSec, args: r.args })).join('\r\n');
  }
  return rows.map((r) => `${r.pid} ${r.uptimeSec} ${r.args}`).join('\n');
}

mock.module('node:child_process', {
  namedExports: {
    spawn: realChildProcess.spawn,
    // Imported by the shared atomic writer's owner-only ACL helper (secret
    // writes only); the sweep never reaches it.
    execFileSync: realChildProcess.execFileSync,
    // The sweep must never use the blocking variant.
    spawnSync: () => {
      throw new Error('spawnSync must not be used by the orphan sweep');
    },
    execFile: (file, args, options, callback) => {
      execCalls.push({ file, args, options });
      const reply = () => {
        if (execError) callback(execError, '', '');
        else callback(null, rowsToStdout(processRows), '');
      };
      if (holdExec) execHeld = reply;
      else setTimeout(reply, EXEC_DELAY_MS);
      return { kill() {} };
    },
  },
});

// Hold the temp-root scan the same way, so the cleanup phase itself is shown
// not to block the loop (not only the process list before it).
let holdTempScan = false;
let tempScanHeld = null;
const { default: realFsPromisesDefault, ...realFsPromisesNamed } = realFsPromises;
mock.module('node:fs/promises', {
  defaultExport: realFsPromisesDefault,
  namedExports: {
    ...realFsPromisesNamed,
    readdir: (path, ...rest) => {
      if (!holdTempScan || path !== tempRoot) return realFsPromises.readdir(path, ...rest);
      return new Promise((resolve, reject) => {
        tempScanHeld = () => realFsPromises.readdir(path, ...rest).then(resolve, reject);
      });
    },
  },
});

const { sweepOrphanTempPostmasters } = await import('./process.mjs');

const OLD_PID = 910001;
const OWNED_PID = 910002;
const ALIVE_OWNER_PID = 910003;
const OFFICIAL_PID = 910004;

function pgArgs(root, name) {
  return `"${posix(root)}/${name}/data/runtime/bin/postgres" -D "${posix(root)}/${name}/data/pgdata"`;
}

function makeRoot(name, ageSec) {
  const dir = join(tempRoot, name);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(dir, when, when);
  return dir;
}

test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

test('sweep runs the process list and temp cleanup asynchronously with identical rules', async (t) => {
  // A failed assertion must not leave the hold engaged for the next test.
  t.after(() => {
    holdExec = false;
    holdTempScan = false;
  });
  const kills = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) return true;
    kills.push(pid);
    return true;
  });

  // Roots: abandoned (reaped + removed), live-owned (kept), young (kept by age),
  // unrelated name (never touched), plus a root owned by a live daemon.
  const abandoned = makeRoot('mixdog-headless-pristine-abandoned', 7200);
  const owned = makeRoot('mixdog-headless-pristine-owned', 7200);
  const young = makeRoot('mixdog-headless-pristine-young', 5);
  const unrelated = makeRoot('mixdog-other-dir', 7200);
  const aliveOwner = makeRoot('mixdog-headless-pristine-aliveowner', 7200);
  writeFileSync(join(aliveOwner, 'data', 'daemon-owner.json'), JSON.stringify({ pid: process.ppid }));

  processRows = [
    { pid: OLD_PID, uptimeSec: 7200, args: pgArgs(tempRoot, 'mixdog-headless-pristine-abandoned') },
    // Young postmaster (uptime below margin): kept, and protects its root.
    { pid: OWNED_PID, uptimeSec: 10, args: pgArgs(tempRoot, 'mixdog-headless-pristine-owned') },
    { pid: ALIVE_OWNER_PID, uptimeSec: 7200, args: pgArgs(tempRoot, 'mixdog-headless-pristine-aliveowner') },
    { pid: OFFICIAL_PID, uptimeSec: 7200, args: 'postgres -D "C:/Users/test/.mixdog/data/pgdata"' },
    { pid: process.pid, uptimeSec: 7200, args: pgArgs(tempRoot, 'mixdog-headless-pristine-abandoned') },
  ];

  let settled = false;
  holdExec = true;
  const pending = sweepOrphanTempPostmasters({ tempRoot }).finally(() => {
    settled = true;
  });
  // The process list is held open, so the sweep cannot finish until the test
  // releases it. Each awaited timer below can only resolve if the event loop
  // turns while the list is outstanding (a blocking list would have finished
  // the sweep, or thrown from the spawnSync mock, by now). This asserts the
  // ordering, not how many timers fit in a wall-clock window: timer counts
  // depend on timer resolution and scheduler load, not on the sweep.
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(execCalls.length, 1, 'the process list was requested');
  assert.equal(settled, false, 'sweep is still waiting on the async process list');

  // Release the list and hold the temp-root scan that starts the cleanup: the
  // same ordering check then covers the cleanup phase.
  holdTempScan = true;
  holdExec = false;
  execHeld();
  for (let turn = 0; turn < 200 && !tempScanHeld; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(tempScanHeld, 'the temp-root scan was requested');
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(settled, false, 'sweep is still waiting on the async temp-root scan');
  holdTempScan = false;
  tempScanHeld();
  const reaped = await pending;

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].file, process.platform === 'win32' ? 'powershell' : 'ps');
  assert.equal(execCalls[0].options.timeout, 15_000);
  // ALIVE_OWNER_PID is old enough to be an orphan but its owner file names a
  // live pid; OWNED_PID is too young; the official dir and this process are
  // never candidates. Only OLD_PID may be killed.
  assert.equal(reaped, 1);
  assert.deepEqual(kills, [OLD_PID]);

  assert.equal(existsSync(abandoned), false, 'abandoned pristine root removed');
  assert.equal(existsSync(owned), true, 'root of a live postmaster kept');
  assert.equal(existsSync(aliveOwner), true, 'root of a live postmaster kept');
  assert.equal(existsSync(young), true, 'young root kept by age margin');
  assert.equal(existsSync(unrelated), true, 'non-pristine dirs never touched');
});

test('a failed or timed-out process list is tolerated and cleans nothing', async (t) => {
  const kills = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal !== 0) kills.push(pid);
    return true;
  });
  const stale = makeRoot('mixdog-headless-pristine-stale-after-error', 7200);
  processRows = [{ pid: OLD_PID, uptimeSec: 7200, args: pgArgs(tempRoot, 'mixdog-headless-pristine-x') }];
  execError = Object.assign(new Error('timed out'), { killed: true, code: null });
  try {
    const reaped = await sweepOrphanTempPostmasters({ tempRoot });
    assert.equal(reaped, 0);
    assert.deepEqual(kills, []);
    // Same as the old status!==0 path: no rows, so the age-only root sweep still runs.
    assert.equal(existsSync(stale), false);
  } finally {
    execError = null;
  }
});
