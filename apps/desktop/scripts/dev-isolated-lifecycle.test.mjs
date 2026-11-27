import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';

import {
  createProcessGroup,
  detectSessionScratchDir,
  findPersistentOwnerPid,
  getProcessCreationTimeMs,
  isSameProcess,
  leaseBelongsToSession,
  resolveCallerSession,
  watchProcessExit,
} from './dev-isolated-job.mjs';
import { rewriteCdpJsonBody } from './dev-isolated-supervisor.mjs';
import {
  areBuildInputsFresh,
  assertFreshCoreBinary,
  DEFAULT_IDLE_MS,
  ensureInstance,
  findCargoGateScript,
  instanceProcessIds,
  isPidAlive,
  killInstanceProcesses,
  leaseIsStale,
  listInstances,
  readRuntimeIdleReleaseMs,
  recordNativeBuildInputs,
  resolveDevCore,
  resolveDevCoreBinary,
  RUNTIME_IDLE_RELEASE_SOURCE,
  stageInstanceCore,
  stopInstance,
  sweep,
  withEnsureLock,
} from './dev-isolated.mjs';

const isInside = (parent, path) => {
  const rel = relative(parent, path);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
};
const fixtureBase = isInside(join(homedir(), '.mixdog'), tmpdir()) ? homedir() : tmpdir();

async function tempRoot(t) {
  const root = await mkdtemp(join(fixtureBase, 'mixdog-iso-life-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('process matching normalizes Windows slashes and enforces minCreatedAt; never matches bare PID or image name', () => {
  const instanceDir =
    process.platform === 'win32' ? 'C:\\iso\\instances\\audit-123456' : '/iso/instances/audit-123456';
  const needle = `${instanceDir}${sep}`;
  const leaseStart = 10_000;
  const processes = [
    {
      pid: 201,
      ppid: 9999,
      created: 10_500,
      cmd:
        process.platform === 'win32'
          ? '"C:/iso/instances/audit-123456/profile/data/runtime/bin/postgres.exe" -D "C:/iso/instances/audit-123456/profile/data/pgdata"'
          : '/iso/instances/audit-123456/profile/data/runtime/bin/postgres -D /iso/instances/audit-123456/profile/data/pgdata',
    },
    { pid: 202, ppid: 201, created: 10_600, cmd: 'postgres.exe --forkbackend 1' },
    // Same instanceDir substring but created BEFORE the lease started: must never be killed.
    { pid: 203, ppid: 1, created: 9_000, cmd: `${instanceDir}${sep}old-process` },
    // Installed app's own core/postgres (no instanceDir on cmd line): must never be killed even if PID was recorded.
    { pid: 204, ppid: 1, created: 10_700, cmd: 'C:\\Users\\dev\\AppData\\Local\\Programs\\mixdog-desktop\\mixdogd.exe serve' },
    { pid: 301, ppid: 1, created: 10_800, cmd: 'C:/iso/instances/other-999999/profile/data/runtime/bin/postgres.exe' },
  ];
  assert.deepEqual(
    instanceProcessIds(processes, { needle, minCreatedAt: leaseStart }).sort((a, b) => a - b),
    [201, 202]
  );
});

test('killInstanceProcesses never kills a recorded daemon.json or postmaster.pid process outside instanceDir', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'safe-123456');
  const profile = join(instanceDir, 'profile');
  await mkdir(join(profile, 'runtime'), { recursive: true });
  await mkdir(join(profile, 'data', 'pgdata'), { recursive: true });
  const installedCorePid = 44444;
  const installedPgPid = 55555;
  await writeFile(join(profile, 'runtime', 'daemon.json'), JSON.stringify({ pid: installedCorePid }));
  await writeFile(join(profile, 'data', 'pgdata', 'postmaster.pid'), `${installedPgPid}\n`);
  const lease = { name: 'safe', instanceDir, profile, startedAt: new Date(10_000).toISOString() };
  const fakeProcesses = [
    { pid: installedCorePid, ppid: 1, created: 11_000, cmd: 'C:\\Programs\\mixdog-desktop\\mixdogd.exe serve' },
    { pid: installedPgPid, ppid: 1, created: 11_000, cmd: 'C:\\Programs\\mixdog-desktop\\postgres.exe -D C:\\Users\\dev\\.mixdog\\data\\pgdata' },
  ];
  const result = await killInstanceProcesses(lease, { list: () => fakeProcesses });
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.remaining, []);
});

test('DEFAULT_IDLE_MS matches runtime IDLE_RELEASE_MS (10 min) and readRuntimeIdleReleaseMs fails clearly if renamed', async (t) => {
  assert.equal(DEFAULT_IDLE_MS, 600_000);
  assert.equal(readRuntimeIdleReleaseMs(), 600_000);

  const fakeRepo = await tempRoot(t);
  const fakeFile = join(fakeRepo, RUNTIME_IDLE_RELEASE_SOURCE);
  await mkdir(join(fakeRepo, 'native', 'core', 'crates', 'mixdog-agent', 'src', 'agent_tool'), { recursive: true });
  await writeFile(fakeFile, 'pub const RENAMED_IDLE_MS: f64 = 420_000.0;\n');
  assert.throws(
    () => readRuntimeIdleReleaseMs(fakeRepo),
    /Could not find pub const IDLE_RELEASE_MS/i,
    'test must fail clearly when IDLE_RELEASE_MS is renamed'
  );
});

test('rewriteCdpJsonBody rewrites only webSocketDebuggerUrl and devtoolsFrontendUrl, leaving page URL and title intact', () => {
  const payload = JSON.stringify([
    {
      id: '1',
      type: 'page',
      title: 'App on :51234',
      url: 'http://127.0.0.1:51234/home?ref=:51234',
      webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/page/1',
      devtoolsFrontendUrl: '/devtools/inspector.html?ws=127.0.0.1:51234/devtools/page/1',
    },
  ]);
  const rewritten = JSON.parse(rewriteCdpJsonBody(payload, 51234, 9555));
  assert.equal(rewritten[0].title, 'App on :51234');
  assert.equal(rewritten[0].url, 'http://127.0.0.1:51234/home?ref=:51234');
  assert.equal(rewritten[0].webSocketDebuggerUrl, 'ws://127.0.0.1:9555/devtools/page/1');
  assert.equal(rewritten[0].devtoolsFrontendUrl, '/devtools/inspector.html?ws=127.0.0.1:9555/devtools/page/1');

  // Single-object /json/version payload:
  const version = JSON.parse(
    rewriteCdpJsonBody(
      JSON.stringify({ Browser: 'Electron :51234', webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/browser/abc' }),
      51234,
      9555
    )
  );
  assert.equal(version.Browser, 'Electron :51234');
  assert.equal(version.webSocketDebuggerUrl, 'ws://127.0.0.1:9555/devtools/browser/abc');
});

test('recordNativeBuildInputs captures Cargo dep-info sources and compiled outputs', async (t) => {
  const root = await tempRoot(t);
  const crateDir = join(root, 'native', 'mixdog-main-native');
  const releaseDir = join(crateDir, 'target', 'release');
  const srcFile = join(crateDir, 'src', 'lib.rs');
  const outLib = join(releaseDir, 'mixdog_main_native.dll');
  await mkdir(join(crateDir, 'src'), { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(crateDir, 'Cargo.toml'), '[package]\nname="mixdog-main-native"\n');
  await writeFile(srcFile, 'pub fn a() {}\n');
  await writeFile(outLib, 'dll-bytes');
  await writeFile(join(releaseDir, 'mixdog_main_native.d'), `${outLib}: ${srcFile}\n`);

  const manifestPath = join(root, 'build-inputs.json');
  await recordNativeBuildInputs(manifestPath, { repo: root, platform: 'win32' });
  assert.equal(areBuildInputsFresh(manifestPath, { targets: ['native'] }).fresh, true);

  await writeFile(srcFile, 'pub fn a() { /* changed */ }\n');
  const check = areBuildInputsFresh(manifestPath, { targets: ['native'] });
  assert.equal(check.fresh, false);
  assert.equal(check.target, 'native');
});

test('leaseIsStale detects dead process OR reused PID (different creation time), never idle or age', async () => {
  const dead = await deadPid();
  const ancient = new Date(Date.now() - 10 * 3600_000).toISOString();
  const ownCreated = getProcessCreationTimeMs(process.pid);
  assert.equal(
    leaseIsStale({
      pid: process.pid,
      supervisorPid: process.pid,
      supervisorCreated: ownCreated,
      ownerPid: dead,
      sessionDir: '/missing/session',
      startedAt: ancient,
      lastUsedAt: ancient,
      idleMs: 1_000,
      ttlMs: 1_000,
    }),
    false,
    'live supervisor with matching creation time is never stale'
  );
  assert.equal(
    leaseIsStale({
      pid: process.pid,
      supervisorPid: process.pid,
      supervisorCreated: (ownCreated ?? 100_000) - 60_000,
      startedAt: new Date().toISOString(),
    }),
    true,
    'live PID with a different creation time (PID reuse after crash) must be treated as stale'
  );
  assert.equal(leaseIsStale({ pid: process.pid, supervisorPid: dead, startedAt: new Date().toISOString() }), true);
  assert.equal(leaseIsStale({ pid: dead, startedAt: new Date().toISOString() }), true);
  assert.equal(isSameProcess(process.pid, ownCreated), true);
  if (typeof ownCreated === 'number') {
    assert.equal(isSameProcess(process.pid, ownCreated - 1), false, 'exact creation-time match rejects even 1ms drift');
  }
});

test('areBuildInputsFresh tracks exact build-manifest files (including repo-root src/ and CHANGELOG) and glob dirs', async (t) => {
  const root = await tempRoot(t);
  const rootSrcFile = join(root, 'src', 'tui', 'themes', 'index.mjs');
  const changelogDir = join(root, 'changelog');
  const changelogKo = join(changelogDir, 'ko.md');
  await mkdir(join(root, 'src', 'tui', 'themes'), { recursive: true });
  await mkdir(changelogDir, { recursive: true });
  await writeFile(rootSrcFile, 'export const theme = 1;\n');
  await writeFile(changelogKo, '# ko\n');

  const { statSync } = await import('node:fs');
  const stSrc = statSync(rootSrcFile);
  const stKo = statSync(changelogKo);
  const manifestPath = join(root, 'build-inputs.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      main: { files: { [rootSrcFile]: { size: stSrc.size, mtimeMs: stSrc.mtimeMs } }, dirs: {} },
      preload: { files: {}, dirs: {} },
      renderer: {
        files: {
          [rootSrcFile]: { size: stSrc.size, mtimeMs: stSrc.mtimeMs },
          [changelogKo]: { size: stKo.size, mtimeMs: stKo.mtimeMs },
        },
        dirs: { [changelogDir]: ['ko.md'] },
      },
    })
  );

  assert.equal(areBuildInputsFresh(manifestPath, { targets: ['main', 'preload', 'renderer'] }).fresh, true);
  assert.equal(areBuildInputsFresh(manifestPath, { targets: ['main', 'preload', 'renderer', 'relay'] }).fresh, false);

  // Editing an input outside apps/desktop/src/ (root src/tui/themes/index.mjs) invalidates the build.
  await writeFile(rootSrcFile, 'export const theme = 2; // changed\n');
  const afterEdit = areBuildInputsFresh(manifestPath, { targets: ['main', 'preload', 'renderer'] });
  assert.equal(afterEdit.fresh, false);
  assert.equal(afterEdit.changedPath, rootSrcFile);

  // Refresh manifest, then add a new file to watched glob dir (changelog/ja.md) -> invalidates!
  const stSrc2 = statSync(rootSrcFile);
  await writeFile(
    manifestPath,
    JSON.stringify({
      main: { files: { [rootSrcFile]: { size: stSrc2.size, mtimeMs: stSrc2.mtimeMs } }, dirs: {} },
      preload: { files: {}, dirs: {} },
      renderer: {
        files: {
          [rootSrcFile]: { size: stSrc2.size, mtimeMs: stSrc2.mtimeMs },
          [changelogKo]: { size: stKo.size, mtimeMs: stKo.mtimeMs },
        },
        dirs: { [changelogDir]: ['ko.md'] },
      },
    })
  );
  assert.equal(areBuildInputsFresh(manifestPath, { targets: ['main', 'preload', 'renderer'] }).fresh, true);
  await writeFile(join(changelogDir, 'ja.md'), '# ja\n');
  const afterAdd = areBuildInputsFresh(manifestPath, { targets: ['main', 'preload', 'renderer'] });
  assert.equal(afterAdd.fresh, false);
  assert.equal(afterAdd.reason, 'dir-changed');
  assert.equal(afterAdd.changedPath, changelogDir);
});

test('withEnsureLock reclaims reused-PID stale lock immediately and never spins on refused /wait', async (t) => {
  const root = await tempRoot(t);
  const lockFile = join(root, 'locks', 'reused-pid.lock');
  await mkdir(join(root, 'locks'), { recursive: true });
  const ownCreated = getProcessCreationTimeMs(process.pid);
  // Stale lock whose PID matches a live process (process.pid) with an OLD creation time and dead port:
  await writeFile(
    lockFile,
    JSON.stringify({
      pid: process.pid,
      created: (ownCreated ?? 100_000) - 60_000,
      port: 1,
      token: 'stale',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  const reclaimed = await withEnsureLock(root, 'reused-pid', async () => 'acquired-after-reclaim');
  assert.equal(reclaimed, 'acquired-after-reclaim');

  // Same live holder (matching pid + created) with a refused /wait port: waits on exit event (or fails cleanly), never spins.
  const waiter = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 150)'], { stdio: 'ignore' });
  const waiterCreated = getProcessCreationTimeMs(waiter.pid);
  const liveLockFile = join(root, 'locks', 'refused-wait.lock');
  await writeFile(
    liveLockFile,
    JSON.stringify({
      pid: waiter.pid,
      created: waiterCreated,
      port: 1, // ECONNREFUSED
      token: 'dead-wait',
      startedAt: new Date().toISOString(),
    })
  );
  const afterWaiterExit = await withEnsureLock(root, 'refused-wait', async () => 'acquired-after-exit', {
    timeoutMs: 5_000,
  });
  assert.equal(afterWaiterExit, 'acquired-after-exit');
  assert.equal(isPidAlive(waiter.pid), false);

  // Live holder (like `capture`) releases the lock file while staying alive: waiter wakes on lock release, not process exit!
  const longLivedHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(longLivedHolder.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  });
  const holderCreated = getProcessCreationTimeMs(longLivedHolder.pid);
  const releaseLockFile = join(root, 'locks', 'release-while-alive.lock');
  await writeFile(
    releaseLockFile,
    JSON.stringify({
      pid: longLivedHolder.pid,
      created: holderCreated,
      port: 1, // /wait fails immediately
      token: 'holder-stays-alive',
      startedAt: new Date().toISOString(),
    })
  );
  setTimeout(() => {
    void rm(releaseLockFile, { force: true });
  }, 120);
  const acquiredWhileAlive = await withEnsureLock(root, 'release-while-alive', async () => 'acquired-on-release');
  assert.equal(acquiredWhileAlive, 'acquired-on-release');
  assert.equal(isPidAlive(longLivedHolder.pid), true, 'holder process stayed alive while lock release unblocked waiter');
});

test('withEnsureLock unlinks lockfile before /wait wakes and flushes reply cleanly', async (t) => {
  const root = await tempRoot(t);

  // /wait clients must receive a complete 200 reply only after the lockfile is unlinked (never RST or stale file).
  let enteredWaitHolder;
  const waitHolderEntered = new Promise((resolve) => {
    enteredWaitHolder = resolve;
  });
  let releaseWaitHolder;
  const waitHolderGate = new Promise((resolve) => {
    releaseWaitHolder = resolve;
  });

  const holderPromise = withEnsureLock(root, 'wait-order', async () => {
    enteredWaitHolder();
    await waitHolderGate;
    return 'done';
  });
  await waitHolderEntered;
  const waitLockFile = join(root, 'locks', 'wait-order.lock');
  const record = JSON.parse(await readFile(waitLockFile, 'utf8'));
  const waitOutcome = await new Promise((resolveWait, rejectWait) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: record.port,
        path: '/wait',
        method: 'GET',
        headers: { Authorization: `Bearer ${record.token}`, Connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.once('end', () => {
          resolveWait({
            statusCode: res.statusCode,
            complete: res.complete,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            lockExistsAtWake: existsSync(waitLockFile),
          });
        });
        res.once('error', rejectWait);
      }
    );
    req.once('error', rejectWait);
    req.end(() => releaseWaitHolder());
  });
  assert.equal(await holderPromise, 'done');
  assert.equal(waitOutcome.statusCode, 200);
  assert.equal(waitOutcome.complete, true);
  assert.deepEqual(waitOutcome.body, { ok: true });
  assert.equal(waitOutcome.lockExistsAtWake, false, 'lockfile must be removed before /wait responds');
});

test('findPersistentOwnerPid, detectSessionScratchDir, and session isolation', () => {
  const processes = [
    { pid: 100, ppid: 1, cmd: 'C:\\Program Files\\Mixdog\\Mixdog.exe serve' },
    { pid: 200, ppid: 100, cmd: '"pwsh.exe" -NoProfile -NonInteractive -Command "npm run dev:isolated"' },
    { pid: 300, ppid: 200, cmd: 'node.exe npm-cli.js run dev:isolated' },
    { pid: 400, ppid: 300, cmd: 'node.exe scripts/dev-isolated.mjs start' },
  ];
  assert.equal(findPersistentOwnerPid(processes, 400), 100);
  const scratch = detectSessionScratchDir({ TEMP: 'C:\\Users\\dev\\.mixdog\\data\\scratch\\s.b8af3d48f2ae1ace' });
  assert.equal(scratch?.sessionId, 's.b8af3d48f2ae1ace');
  assert.equal(detectSessionScratchDir({ TEMP: 'C:\\Windows\\Temp' }), null);

  const sessA = resolveCallerSession(
    { TEMP: 'C:\\Users\\dev\\.mixdog\\data\\scratch\\s.aaaa1111' },
    { processes, selfPid: 400 }
  );
  const sessB = resolveCallerSession(
    { TEMP: 'C:\\Users\\dev\\.mixdog\\data\\scratch\\s.bbbb2222' },
    { processes, selfPid: 400 }
  );
  assert.equal(sessA.defaultName, 'cap-s-aaaa1111');
  assert.equal(sessB.defaultName, 'cap-s-bbbb2222');
  const leaseA = { sessionId: sessA.sessionId, ownerPid: 100 };
  assert.equal(leaseBelongsToSession(leaseA, sessA), true);
  assert.equal(leaseBelongsToSession(leaseA, sessB), false, 'shared host PID never lets session B claim session A');
});

test('non-Windows refuses explicitly rather than half-working', () => {
  assert.throws(() => createProcessGroup({ platform: 'linux' }), /not supported/i);
  assert.throws(() => watchProcessExit(1234, () => {}, { platform: 'darwin' }), /not supported/i);
});

test('Linux /proc creation time parses comm with parens, rejects zombies, and withEnsureLock reclaims holder exit without Win32 watchExit', async (t) => {
  const procFiles = {
    '/proc/stat': 'cpu  1 2 3 4\nbtime 1700000000\nprocesses 42\n',
    // Field 22 (starttime) = 12345 ticks (123450 ms after btime); comm intentionally contains spaces and parens.
    '/proc/4321/stat':
      '4321 (node (worker 1)) S 100 4321 100 0 -1 4194304 1 0 0 0 10 5 0 0 20 0 1 0 12345 999999 0\n',
    '/proc/9999/stat':
      '9999 (defunct) Z 100 9999 100 0 -1 4194304 1 0 0 0 10 5 0 0 20 0 1 0 12345 999999 0\n',
  };
  const readText = (path) => {
    if (!(path in procFiles)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return procFiles[path];
  };
  const created = getProcessCreationTimeMs(4321, { platform: 'linux', readText });
  assert.equal(created, 1_700_000_000_000 + 123_450);
  assert.equal(getProcessCreationTimeMs(9999, { platform: 'linux', readText }), null, 'zombie process is not live');
  assert.equal(getProcessCreationTimeMs(8888, { platform: 'linux', readText }), null, 'missing process returns null');

  const root = await tempRoot(t);
  const lockFile = join(root, 'locks', 'linux-fallback.lock');
  await mkdir(join(root, 'locks'), { recursive: true });
  let holderAlive = true;
  await writeFile(
    lockFile,
    JSON.stringify({
      pid: 4321,
      created,
      port: 1,
      token: 'dead-wait',
      startedAt: new Date().toISOString(),
    })
  );
  setTimeout(() => {
    holderAlive = false;
  }, 80);
  const result = await withEnsureLock(root, 'linux-fallback', async () => 'acquired-on-linux-fallback', {
    timeoutMs: 2_000,
    platform: 'linux',
    alive: (pid) => (pid === process.pid ? true : pid === 4321 ? holderAlive : false),
    getCreated: (pid) => (pid === process.pid ? 1 : pid === 4321 && holderAlive ? created : null),
    watchExit: () => {
      throw new Error('not supported');
    },
  });
  assert.equal(result, 'acquired-on-linux-fallback');
});

test('findCargoGateScript reads cargo config, resolveDevCoreBinary checks staleness, and stageInstanceCore copies binary', async (t) => {
  const root = await tempRoot(t);
  const toolsDir = join(root, 'tools');
  const cargoHome = join(root, 'cargo-home');
  const repo = join(root, 'repo');
  const targetDir = join(root, 'pool-target');
  const exe = process.platform === 'win32' ? 'mixdogd.exe' : 'mixdogd';
  await mkdir(toolsDir, { recursive: true });
  await mkdir(cargoHome, { recursive: true });
  await mkdir(join(repo, 'native', 'core', 'crates', 'mixdog-cli', 'src'), { recursive: true });
  await mkdir(join(targetDir, 'debug'), { recursive: true });

  const gateFile = join(toolsDir, 'cargo-gate.ps1');
  await writeFile(gateFile, '# gate\n');
  await writeFile(
    join(cargoHome, 'config.toml'),
    `[build]\nrustc-wrapper = '${join(toolsDir, 'rustc-slot.exe')}'\n`
  );
  assert.equal(findCargoGateScript({}, { platform: 'win32', cargoHome }), gateFile);

  const srcFile = join(repo, 'native', 'core', 'crates', 'mixdog-cli', 'src', 'main.rs');
  await writeFile(srcFile, 'fn main() {}\n');
  const debugBin = join(targetDir, 'debug', exe);
  await writeFile(debugBin, 'fake-binary', { mode: 0o755 });
  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  await utimes(debugBin, past, past);
  await utimes(srcFile, now, now);

  // Default: warns with newerCount and build command without refusing capture.
  const warned = resolveDevCore({}, { repo, gatePath: gateFile, targetDir });
  assert.equal(warned.binary, debugBin);
  assert.ok(warned.staleWarning, 'stale binary produces a structured warning by default');
  assert.equal(warned.staleWarning.newerCount, 1);
  assert.match(
    warned.staleWarning.buildCommand,
    process.platform === 'win32' ? /cargo-gate\.ps1 build/i : /cargo build /i
  );
  assert.match(warned.staleWarning.message, /older than 1.*Rebuild with:/i);

  // Explicit --require-fresh-core refuses with the build command.
  assert.throws(
    () => resolveDevCoreBinary({}, { repo, gatePath: gateFile, targetDir, requireFreshCore: true }),
    /older than.*Rebuild with:/i,
    'refuses binary older than its Rust sources when requireFreshCore is true'
  );
  assert.throws(
    () => assertFreshCoreBinary(debugBin, { repo, gatePath: gateFile, platform: 'win32' }),
    /cargo-gate\.ps1 build/i
  );

  // Refresh binary mtime ahead of sources -> no warning and never auto-picks release.
  const future = new Date(Date.now() + 10_000);
  await utimes(debugBin, future, future);
  const fresh = resolveDevCore({}, { repo, gatePath: gateFile, targetDir });
  assert.equal(fresh.binary, debugBin);
  assert.equal(fresh.staleWarning, null);

  const releaseBin = join(repo, 'native', 'core', 'target', 'release', exe);
  assert.equal(
    resolveDevCoreBinary({}, { repo, gatePath: null, targetDir: null, canRun: (p) => p === releaseBin }),
    null,
    'never auto-picks release core'
  );

  // stageInstanceCore copies binary + sibling js-runtime.json into `<instanceDir>/core/`.
  await writeFile(join(targetDir, 'debug', 'js-runtime.json'), '{"program":"node"}\n');
  const instanceDir = join(root, 'instances', 'copy-test');
  const staged = await stageInstanceCore({ sourceExe: debugBin, instanceDir, repo });
  assert.equal(staged.stagedExe, join(instanceDir, 'core', exe));
  assert.equal(existsSync(staged.stagedExe), true);
  assert.equal(existsSync(join(instanceDir, 'core', 'js-runtime.json')), true);
});

test('createProcessGroup terminates child and grandchild together, supports release(pid), and watchProcessExit fires on exit', async (t) => {
  if (process.platform !== 'win32') return;
  const group = createProcessGroup();
  t.after(() => group.terminate());
  const parent = spawn(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(()=>{}, 1000);",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  assert.equal(group.assign(parent.pid), true);
  assert.ok(group.pids().includes(parent.pid));
  group.release(parent.pid);
  assert.equal(group.pids().includes(parent.pid), false, 'release removes pid from tracked list');
  const grandPid = await new Promise((resolve, reject) => {
    parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    parent.once('error', reject);
  });
  assert.ok(Number.isInteger(grandPid) && grandPid > 0);
  assert.equal(isPidAlive(parent.pid), true);
  assert.equal(isPidAlive(grandPid), true);

  const parentExited = new Promise((resolve) => parent.once('exit', resolve));
  const exited = new Promise((resolve) => watchProcessExit(parent.pid, resolve));
  group.terminate();
  await exited;
  await parentExited;
  assert.equal(isPidAlive(parent.pid), false);
  assert.equal(isPidAlive(grandPid), false);
});

test('ensureInstance enforces session isolation, checks build-input freshness, and serializes concurrent calls', async (t) => {
  const root = await tempRoot(t);
  const sessA = { sessionId: 's.aaaa1111', sessionDir: null, ownerPid: process.pid, selfPid: process.pid, defaultName: 'cap-s-aaaa1111' };
  const sessB = { sessionId: 's.bbbb2222', sessionDir: null, ownerPid: process.pid, selfPid: process.pid, defaultName: 'cap-s-bbbb2222' };
  const coreStamp = { path: 'C:\\fake\\mixdogd.exe', size: 100, mtimeMs: 1000 };
  const ownCreated = getProcessCreationTimeMs(process.pid);

  let touches = 0;
  let buildIsFresh = true;
  const startedAt = new Date().toISOString();
  let lastUsedAt = startedAt;
  const controlToken = 'test-secret-token';
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${controlToken}`);
    if (req.method === 'POST' && req.url === '/touch') {
      touches += 1;
      lastUsedAt = new Date().toISOString();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(
      JSON.stringify({
        ok: true,
        name: sessA.defaultName,
        supervisorPid: process.pid,
        appPid: process.pid,
        cdpPort: 9777,
        rendererPort: 10777,
        relayUrl: 'ws://127.0.0.1:45678',
        mode: 'capture',
        startedAt,
        lastUsedAt,
        idleMs: 420_000,
        idleExpiresAt: new Date(Date.now() + 420_000).toISOString(),
      })
    );
  });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  const controlPort = server.address().port;

  let startCalls = 0;
  let releaseFirstStart;
  const firstStartGate = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });
  const fakeStart = async (opts) => {
    startCalls += 1;
    const isFirst = startCalls === 1;
    if (isFirst) await firstStartGate;
    const instanceDir = join(root, 'instances', `${opts.name}-${startCalls}`);
    await mkdir(join(instanceDir, 'profile'), { recursive: true });
    await mkdir(join(root, 'leases'), { recursive: true });
    const lease = {
      name: opts.name,
      pid: process.pid,
      appCreated: ownCreated,
      supervisorPid: process.pid,
      supervisorCreated: ownCreated,
      ownerPid: opts.caller.ownerPid,
      sessionId: opts.caller.sessionId,
      cdpPort: 9777,
      rendererPort: 10777,
      relayUrl: opts.phoneRelay ? 'ws://127.0.0.1:45678' : 'off',
      mode: opts.hmr ? 'hmr' : 'capture',
      controlPort,
      controlToken,
      instanceDir,
      profile: join(instanceDir, 'profile'),
      startedAt,
      lastUsedAt,
      idleMs: 420_000,
      ttlMs: 3600_000,
      instanceConfig: {
        mode: opts.hmr ? 'hmr' : 'capture',
        phoneRelay: opts.phoneRelay,
        relay: opts.relay,
        copyAuth: opts.copyAuth,
        skipOnboarding: opts.skipOnboarding,
        configOverlay: null,
        passEnvSig: '',
        inspectMain: null,
      },
      buildInputsPath: join(instanceDir, 'build-inputs.json'),
      coreSourceStamp: coreStamp,
    };
    await writeFile(join(root, 'leases', `${opts.name}.json`), JSON.stringify(lease));
    return { ...lease, reused: false };
  };

  // Concurrent ensure calls by the same session: second waits on first and reuses it (only 1 start).
  const checkBuildInputs = () => ({ fresh: buildIsFresh });
  const p1 = ensureInstance({
    root,
    caller: sessA,
    phoneRelay: true,
    timeoutMs: 30,
    checkBuildInputs,
    coreSourceStamp: coreStamp,
    startFn: fakeStart,
  });
  const p2 = ensureInstance({
    root,
    caller: sessA,
    phoneRelay: true,
    timeoutMs: 30,
    checkBuildInputs,
    coreSourceStamp: coreStamp,
    startFn: fakeStart,
  });
  setTimeout(releaseFirstStart, 100);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(startCalls, 1, 'concurrent same-session ensures must build only once');
  assert.deepEqual([r1.reused, r2.reused].sort(), [false, true]);
  assert.equal(touches, 1);

  // Different session (sessB) must NOT reuse sessA's instance.
  const rB = await ensureInstance({
    root,
    caller: sessB,
    phoneRelay: true,
    checkBuildInputs,
    coreSourceStamp: coreStamp,
    startFn: fakeStart,
  });
  assert.equal(startCalls, 2, 'different session gets its own instance');
  assert.equal(rB.reused, false);
  assert.equal(rB.name, sessB.defaultName);

  // Build input changed: sessA must NOT reuse stale build; replaces its instance.
  buildIsFresh = false;
  const rA2 = await ensureInstance({
    root,
    caller: sessA,
    phoneRelay: true,
    checkBuildInputs,
    coreSourceStamp: coreStamp,
    startFn: fakeStart,
  });
  assert.equal(startCalls, 3, 'edited build input triggers fresh rebuild instead of stale reuse');
  assert.equal(rA2.reused, false);

  // Session-scoped sweep({ all: true }) stops only sessA's instance, leaving sessB intact.
  const sweptA = await sweep(root, { all: true, caller: sessA, list: () => [] });
  assert.deepEqual(
    sweptA.map((s) => s.name),
    [sessA.defaultName]
  );
  assert.deepEqual(await readdir(join(root, 'leases')), [`${sessB.defaultName}.json`]);

  // listInstances reports memory and omits controlToken.
  const listed = await listInstances(root, {
    list: () => [
      { pid: process.pid, ppid: 1, created: ownCreated, cmd: 'node', rssBytes: 0 },
      {
        pid: 5000,
        ppid: 1,
        created: Date.parse(startedAt) + 1000,
        cmd: `electron.exe ${join(rB.instanceDir, 'app', 'desktop')}`,
        rssBytes: 150 * 1024 * 1024,
      },
    ],
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'running');
  assert.equal(listed[0].processCount, 1);
  assert.equal(listed[0].memoryMB, 150);
  assert.equal('controlToken' in listed[0], false);

  await sweep(root, { all: true, allSessions: true, list: () => [] });
  assert.deepEqual(await readdir(join(root, 'leases')), []);
});

async function allocateFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const s = createServer();
    s.once('error', rejectPort);
    s.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });
}

async function spawnTestSupervisor(
  t,
  { root, name, idleMs = 60_000, ownerPid = null, sessionDir = null, mockCdp = false }
) {
  const instanceDir = join(root, 'instances', `${name}-test`);
  const appDir = join(instanceDir, 'app', 'desktop');
  const rendererDir = join(appDir, 'out', 'renderer');
  await mkdir(rendererDir, { recursive: true });
  await mkdir(join(instanceDir, 'profile'), { recursive: true });
  await mkdir(join(root, 'leases'), { recursive: true });
  await writeFile(join(rendererDir, 'index.html'), '<!doctype html><title>ok</title>');
  if (mockCdp) {
    const wsModule = join(import.meta.dirname, '..', 'node_modules', 'ws', 'index.js').replaceAll('\\', '\\\\');
    await writeFile(
      join(appDir, 'index.js'),
      `const http = require('node:http');
const { WebSocketServer } = require('${wsModule}');
const arg = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
const port = Number(arg.split('=')[1]);
const server = http.createServer((req, res) => {
  if (req.url === '/json/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', url: 'http://127.0.0.1/', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/1' }]));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (msg) => ws.send('echo:' + msg.toString()));
});
server.listen({ host: '127.0.0.1', port });
`
    );
  } else {
    await writeFile(
      join(appDir, 'index.js'),
      "const { spawn } = require('child_process'); spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }); setInterval(()=>{}, 1000);\n"
    );
  }
  const cdpPort = await allocateFreePort();
  const rendererPort = await allocateFreePort();

  const readyToken = 'ready-tok';
  let readyResolve;
  const readyPromise = new Promise((resolveReady) => {
    readyResolve = resolveReady;
  });
  const readyServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(200, { Connection: 'close' });
    res.end('ok');
    readyResolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((resolveListen) => readyServer.listen({ host: '127.0.0.1', port: 0 }, resolveListen));
  t.after(() => {
    readyServer.closeAllConnections?.();
    return new Promise((resolveClose) => readyServer.close(resolveClose));
  });
  const readyPort = readyServer.address().port;

  const startedAt = new Date().toISOString();
  const controlToken = 'sup-ctrl-token';
  const configPath = join(instanceDir, 'supervisor-config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      root,
      name,
      instanceDir,
      profile: join(instanceDir, 'profile'),
      appDir,
      desktopDir: appDir,
      cdpPort,
      rendererPort,
      mode: 'capture',
      relayMode: 'off',
      relayUrl: 'off',
      idleMs,
      ttlMs: 300_000,
      ownerPid,
      sessionDir,
      sessionId: sessionDir ? 's.test1234' : null,
      controlToken,
      devProfileDir: join(root, 'dev-profile'),
      electronExecPath: process.execPath,
      logPath: join(instanceDir, 'launcher.log'),
      startedAt,
      env: { ...process.env },
    })
  );
  const leaseFile = join(root, 'leases', `${name}.json`);
  await writeFile(
    leaseFile,
    JSON.stringify({
      name,
      startedAt,
      ttlMs: 300_000,
      idleMs,
      lastUsedAt: startedAt,
      cdpPort,
      rendererPort,
      instanceDir,
      profile: join(instanceDir, 'profile'),
      controlToken,
      ownerPid,
      sessionDir,
    })
  );

  const supervisorScript = join(import.meta.dirname, 'dev-isolated-supervisor.mjs');
  const child = spawn(
    process.execPath,
    [
      supervisorScript,
      '--config',
      configPath,
      '--ready-port',
      String(readyPort),
      '--ready-token',
      readyToken,
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  t.after(() => {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  });
  const ready = await readyPromise;
  assert.equal(ready.error, undefined, `supervisor start error: ${ready.error}`);
  assert.ok(Number.isInteger(ready.appPid) && ready.appPid > 0);
  return { child, ready, exited, instanceDir, leaseFile, controlToken, startedAt, cdpPort };
}

test('real supervisor proxies CDP, pauses idle while any CDP client is attached, and starts idle on disconnect', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempRoot(t);
  const { ready, exited, instanceDir, leaseFile, controlToken, cdpPort } = await spawnTestSupervisor(t, {
    root,
    name: 'cdp-observed',
    idleMs: 600,
    mockCdp: true,
  });

  // Wait for the mock CDP server behind the proxy to come up via HTTP /json/list.
  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).catch(() => null);
    if (res?.ok) {
      targets = await res.json();
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(Array.isArray(targets) && targets.length === 1);
  assert.equal(
    targets[0].webSocketDebuggerUrl,
    `ws://127.0.0.1:${cdpPort}/devtools/page/1`,
    'proxy rewrites webSocketDebuggerUrl to the public cdpPort'
  );

  // Connect directly to CDP WebSocket without calling /touch: must pause idle past idleMs (600ms).
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const echoed = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
    ws.send('ping');
  });
  assert.equal(echoed, 'echo:ping');

  await new Promise((r) => setTimeout(r, 950));
  const statusWhileOpen = await fetch(`http://127.0.0.1:${ready.controlPort}/status`, {
    headers: { Authorization: `Bearer ${controlToken}` },
  }).then((r) => r.json());
  assert.equal(statusWhileOpen.activeCdpClients, 1);
  assert.equal(statusWhileOpen.idlePaused, true);
  assert.equal(statusWhileOpen.idleExpiresAt, null);
  assert.equal(isPidAlive(ready.appPid), true, 'instance must remain alive while CDP client is attached');

  // Disconnect CDP client -> idle countdown starts from disconnect and tears down cleanly.
  const closedAt = Date.now();
  ws.close();
  const code = await exited;
  const elapsedAfterClose = Date.now() - closedAt;
  assert.equal(code, 0);
  assert.ok(elapsedAfterClose >= 450, `expected idle wait after disconnect, got ${elapsedAfterClose}ms`);
  assert.equal(isPidAlive(ready.appPid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(leaseFile), false);
});

test('real supervisor persists lastUsedAt on /touch and shuts down cleanly on /stop', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempRoot(t);
  const { ready, exited, instanceDir, leaseFile, controlToken, startedAt } = await spawnTestSupervisor(t, {
    root,
    name: 'touch-persist',
    idleMs: 60_000,
  });
  await new Promise((r) => setTimeout(r, 25));
  const res = await fetch(`http://127.0.0.1:${ready.controlPort}/touch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${controlToken}` },
  });
  assert.equal(res.status, 200);
  const status = await res.json();
  const diskLease = JSON.parse(await readFile(leaseFile, 'utf8'));
  assert.equal(diskLease.lastUsedAt, status.lastUsedAt, '/touch must persist lastUsedAt to lease file');
  assert.ok(Date.parse(diskLease.lastUsedAt) >= Date.parse(startedAt));

  const stopRes = await fetch(`http://127.0.0.1:${ready.controlPort}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${controlToken}` },
  });
  assert.equal(stopRes.status, 200);
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(isPidAlive(ready.appPid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(leaseFile), false);
});

test('real supervisor shuts down unit and cleans files on idle timeout', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempRoot(t);
  const { ready, exited, instanceDir, leaseFile } = await spawnTestSupervisor(t, {
    root,
    name: 'idle-auto',
    idleMs: 250,
  });
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(isPidAlive(ready.appPid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(leaseFile), false);
});

test('real supervisor shuts down unit and cleans files when owner process exits', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempRoot(t);
  const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(owner.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  });
  const { ready, exited, instanceDir, leaseFile } = await spawnTestSupervisor(t, {
    root,
    name: 'owner-auto',
    idleMs: 60_000,
    ownerPid: owner.pid,
  });
  assert.equal(isPidAlive(ready.appPid), true);
  owner.kill('SIGKILL');
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(isPidAlive(ready.appPid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(leaseFile), false);
});

test('real supervisor shuts down unit and cleans files when session scratch dir is removed', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempRoot(t);
  const sessionDir = join(root, 'scratch', 's.deadbeef');
  await mkdir(sessionDir, { recursive: true });
  const { ready, exited, instanceDir, leaseFile } = await spawnTestSupervisor(t, {
    root,
    name: 'session-auto',
    idleMs: 60_000,
    sessionDir,
  });
  assert.equal(isPidAlive(ready.appPid), true);
  await rm(sessionDir, { recursive: true, force: true });
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(isPidAlive(ready.appPid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(leaseFile), false);
});

test('real supervisor terminates capture browser tree and resumes idle when capture owner is killed without /browser/release', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await tempRoot(t);
  const { ready, exited, instanceDir, leaseFile, controlToken } = await spawnTestSupervisor(t, {
    root,
    name: 'browser-owner-killed',
    idleMs: 450,
  });

  // Spawn a fake capture owner process and a fake capture browser process with a grandchild.
  const captureOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const fakeBrowser = spawn(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000);",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  t.after(() => {
    for (const p of [captureOwner, fakeBrowser]) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
  const grandPid = await new Promise((resolve, reject) => {
    fakeBrowser.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    fakeBrowser.once('error', reject);
  });
  t.after(() => {
    try {
      process.kill(grandPid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });

  const assignRes = await fetch(`http://127.0.0.1:${ready.controlPort}/browser/assign`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: fakeBrowser.pid, ownerPid: captureOwner.pid }),
  });
  assert.equal(assignRes.status, 200);
  assert.equal((await assignRes.json()).assigned, true);

  // While capture browser + owner run, idle shutdown stays paused past idleMs (450ms).
  await new Promise((r) => setTimeout(r, 700));
  const statusBusy = await fetch(`http://127.0.0.1:${ready.controlPort}/status`, {
    headers: { Authorization: `Bearer ${controlToken}` },
  }).then((r) => r.json());
  assert.equal(statusBusy.idlePaused, true);
  assert.deepEqual(statusBusy.browsers, [fakeBrowser.pid]);

  // Kill the capture owner mid-run WITHOUT sending /browser/release:
  // supervisor must terminate fakeBrowser + grandchild immediately and then shut down on idle timeout!
  captureOwner.kill('SIGKILL');
  const browserGone = new Promise((resolve) => fakeBrowser.once('exit', resolve));
  await browserGone;
  assert.equal(isPidAlive(grandPid), false, 'browser grandchild must terminate with its sub-job');

  const code = await exited;
  assert.equal(code, 0);
  assert.equal(isPidAlive(ready.appPid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(leaseFile), false);
});
