import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const tempRoot = mkdtempSync(join(tmpdir(), 'mixdog-orphan-sweep-test-'));
const posix = (p) => p.replaceAll('\\', '/');

const execCalls = [];
let processRows = [];
let execError = null;
const EXEC_DELAY_MS = 40;

function rowsToStdout(rows) {
  if (process.platform === 'win32') {
    return rows.map((r) => JSON.stringify({ pid: r.pid, started: r.uptimeSec, args: r.args })).join('\r\n');
  }
  return rows.map((r) => `${r.pid} ${r.uptimeSec} ${r.args}`).join('\n');
}

mock.module('node:child_process', {
  namedExports: {
    spawn: realChildProcess.spawn,
    // The sweep must never use the blocking variant.
    spawnSync: () => {
      throw new Error('spawnSync must not be used by the orphan sweep');
    },
    execFile: (file, args, options, callback) => {
      execCalls.push({ file, args, options });
      setTimeout(() => {
        if (execError) callback(execError, '', '');
        else callback(null, rowsToStdout(processRows), '');
      }, EXEC_DELAY_MS);
      return { kill() {} };
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
  const pending = sweepOrphanTempPostmasters({ tempRoot }).then((value) => {
    settled = true;
    return value;
  });
  // The event loop keeps turning while the process list is outstanding.
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, EXEC_DELAY_MS / 2));
  assert.equal(settled, false, 'sweep is still waiting on the async process list');
  assert.ok(ticks >= 2, `event loop kept running during the sweep (ticks=${ticks})`);
  const reaped = await pending;
  clearInterval(ticker);

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
