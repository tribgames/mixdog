import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import {
  discoveryPid,
  probeDaemonPid,
  proveDaemonOwnerRecord,
  readDiscovery,
  startOwnerLivenessListener,
} from './daemon-owner.mjs';
import { ensureDaemon, spawnDaemonCandidate } from './session-client.mjs';
import { SESSION_PROTOCOL } from './session-wire.mjs';

// The real daemon in an isolated home, data dir and runtime root, on a 6 s
// record staleness (1 s heartbeats) so the tests need not wait out 60 s;
// `staleMs: null` keeps the production 60 s (10 s heartbeats).
// `freezeLimitMs` shortens the freeze watchdog's 120 s limit.
const STALE_MS = 6000;
const OWNER_MODULE = new URL('./daemon-owner.mjs', import.meta.url).href;
const SINGLETON_MODULE = new URL('../runtime/shared/singleton-owner.mjs', import.meta.url).href;

function daemonFixture(t, { staleMs = STALE_MS, freezeLimitMs = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-heartbeat-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DAEMON_OWNER_STALE_MS: staleMs ? String(staleMs) : undefined,
    MIXDOG_DAEMON_FREEZE_LIMIT_MS: freezeLimitMs ? String(freezeLimitMs) : undefined,
    HOME: home,
    USERPROFILE: home,
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  const previousExecArgv = process.execArgv;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // fork() inherits the runner's execArgv; the daemon must run as a plain script.
  process.execArgv = [];
  const pids = new Set();
  const timers = new Set();
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {}
      // Its cwd and open files keep the fixture busy on Windows until it is gone.
      for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await delay(50);
    }
    process.execArgv = previousExecArgv;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // Its helper processes release the fixture shortly after it exits.
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
  });
  const ownerPath = join(dataDir, 'daemon-owner.json');
  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
  return {
    root,
    ownerPath,
    logPath: join(dataDir, 'daemon.log'),
    discoveryPath: join(root, 'runtime', 'daemon.json'),
    owner: () => JSON.parse(readFileSync(ownerPath, 'utf8')),
    track: (pid) => pids.add(Number(pid)),
    // This test process stands in for the record's pid: alive, not a daemon.
    writeOwner: (fields) =>
      writeFileSync(ownerPath, JSON.stringify({ kind: 'mixdog-daemon', pid: process.pid, ...fields })),
    // ...and, for a still-booting owner, keeps its heartbeat fresh (atomically:
    // the daemon reads this record concurrently).
    keepBeating: (fields) => {
      const write = () =>
        writeJsonAtomicSync(ownerPath, { kind: 'mixdog-daemon', pid: process.pid, ...fields, heartbeatAt: iso() });
      write();
      timers.add(setInterval(write, 100));
    },
    iso,
  };
}

async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// This test process playing a booting holder: its liveness listener answers
// with this pid, exactly as the daemon's does from before its claim.
async function livenessPort(t) {
  const listener = await startOwnerLivenessListener({ pid: process.pid });
  t.after(() => listener.close());
  return listener.port;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

// A daemon from before the OS lock, as far as ownership goes: it takes no
// lock and claims by the record alone — proof, then claimSingletonOwner with
// daemonOwnerIsStale, the code path released daemons run (unchanged by the
// lock). Its wall clock may be shifted. Records the liveness request it makes,
// so yielding on a fresh-looking record without probing cannot pass for it.
async function preLockContender(fx, { offsetMs = 0 } = {}) {
  const entry = join(fx.root, `pre-lock-contender-${Date.now()}.mjs`);
  const probePath = `${entry}.probe.json`;
  writeFileSync(
    entry,
    `
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const realNow = Date.now;
Date.now = () => realNow() + ${offsetMs};
const get = http.get;
http.get = function (options, ...args) {
  if (options.path === '/health') {
    const owner = JSON.parse(readFileSync(${JSON.stringify(fx.ownerPath)}, 'utf8'));
    writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ owner, port: options.port, now: Date.now() }));
  }
  return get.call(this, options, ...args);
};
const { claimSingletonOwner } = await import(${JSON.stringify(SINGLETON_MODULE)});
const { daemonOwnerIsStale, proveDaemonOwnerRecord } = await import(${JSON.stringify(OWNER_MODULE)});
const ownerPath = ${JSON.stringify(fx.ownerPath)};
const proof = await proveDaemonOwnerRecord(ownerPath, { discoveryPath: ${JSON.stringify(fx.discoveryPath)} });
const claim = claimSingletonOwner(ownerPath, {
  kind: 'mixdog-daemon',
  meta: { heartbeatAt: new Date().toISOString() },
  isStale: (owner) => daemonOwnerIsStale(owner, { proof }),
});
process.stdout.write(JSON.stringify({ owned: claim.owned, ownerPid: Number(claim.owner?.pid) || 0, proof }));
`
  );
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, err);
  let probe = null;
  try {
    probe = JSON.parse(readFileSync(probePath, 'utf8'));
  } catch {}
  return { ...JSON.parse(out), probe };
}

// The real daemon entry, whose main thread freezes (Atomics.wait: idle, no
// CPU) for the milliseconds written to `freeze()`'s request file.
function freezableDaemon(fx) {
  const entry = join(fx.root, 'freezable-daemon.mjs');
  const requestPath = join(fx.root, 'freeze-request');
  writeFileSync(
    entry,
    `
import { existsSync, readFileSync, rmSync } from 'node:fs';
const request = ${JSON.stringify(requestPath)};
setInterval(() => {
  if (!existsSync(request)) return;
  const ms = Number(readFileSync(request, 'utf8'));
  rmSync(request, { force: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}, 50).unref();
await import(${JSON.stringify(new URL('./daemon.mjs', import.meta.url).href)});
`
  );
  return {
    entry,
    freeze: async (ms) => {
      writeFileSync(requestPath, String(ms));
      assert.ok(await waitFor(() => !existsSync(requestPath), 5000), 'the daemon picked the freeze up');
    },
  };
}

function exitOf(candidate) {
  const { exitedAt, exitCode, exitSignal, exitReason } = candidate.summary();
  return exitedAt ? { exitCode, exitSignal, exitReason } : null;
}

// Regression: a daemon killed without its exit hooks leaves daemon-owner.json
// behind, and the OS reuses its pid. The live unrelated process used to read as
// the owner forever — launchers waited on it, candidates yielded to it, and the
// desktop failed every call with "daemon session endpoint is unavailable".
test('a reused pid whose heartbeat stopped is reclaimed by the spawned daemon', async (t) => {
  const fx = daemonFixture(t);
  // A crashed daemon's record: stamp an hour old, its liveness port long closed.
  fx.writeOwner({
    claimedAt: fx.iso(-3_600_000),
    heartbeatAt: fx.iso(-3_600_000),
    livenessPort: await closedPort(),
  });

  const discovery = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(discovery.pid);
  assert.ok(Number(discovery.pid) > 0 && Number(discovery.pid) !== process.pid);
  assert.equal(fx.owner().pid, Number(discovery.pid));
  assert.ok(Date.now() - Date.parse(fx.owner().heartbeatAt) < STALE_MS, 'the new owner beats');
});

// Community case: a crashed v1.1.2 daemon leaves an owner record without a
// heartbeat AND a daemon.json naming the same pid; the OS reuses the pid. The
// pid match used to read as a live owner forever and ensureDaemon kept waiting.
test('a legacy owner and daemon.json naming a reused pid with a dead endpoint are recovered', async (t) => {
  const fx = daemonFixture(t);
  const deadPort = await closedPort();
  mkdirSync(dirname(fx.discoveryPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    fx.discoveryPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: Date.parse('2020-01-01T00:00:00.000Z'),
      endpoints: { channel: { port: deadPort, token: 'old' }, session: { port: deadPort, token: 'old' } },
    })
  );
  fx.writeOwner({ claimedAt: '2020-01-01T00:00:00.000Z' });

  const discovery = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(discovery.pid);
  assert.ok(Number(discovery.pid) > 0 && Number(discovery.pid) !== process.pid);
  assert.equal(discoveryPid(fx.discoveryPath), Number(discovery.pid));
  assert.equal(fx.owner().pid, Number(discovery.pid));
  assert.ok(fx.owner().heartbeatAt, 'the new owner writes a heartbeat');
});

// Fault injection: every refresh of the owner record fails (the claim lock is
// held, as an antivirus or sync client holding the file would). Under the
// lease the holder fenced itself; holding the OS lock it keeps serving, and a
// contender still yields to it however stale its record grows.
test('a daemon that cannot refresh its record keeps serving, and a contender still yields to its lock', async (t) => {
  const fx = daemonFixture(t);
  const holder = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  const holderPid = Number(holder.pid);
  fx.track(holderPid);

  const lockPath = `${fx.ownerPath}.claim.lock`;
  mkdirSync(lockPath);
  // Kept fresh so the 5 s stale-lock sweep never frees it.
  const touch = setInterval(() => {
    const now = new Date();
    utimesSync(lockPath, now, now);
  }, 500);
  t.after(() => clearInterval(touch));
  const lastHeartbeat = Date.parse(fx.owner().heartbeatAt);
  // Past the 6 s staleness (and the 4 s the lease fenced at).
  await delay(STALE_MS + 1500);
  assert.ok(isPidAlive(holderPid), 'still running');
  assert.ok(Date.now() - Date.parse(fx.owner().heartbeatAt) > STALE_MS, 'its record went stale');
  assert.equal(Date.parse(fx.owner().heartbeatAt), lastHeartbeat);

  const logs = [];
  const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
  const summary = candidate.summary();
  fx.track(summary.pid);
  assert.equal(summary.exitCode, 0, logs.join('\n'));
  assert.match(summary.exitReason, new RegExp(`lost singleton claim to live peer pid=${holderPid}\\b`));

  clearInterval(touch);
  rmSync(lockPath, { recursive: true, force: true });
  const again = await ensureDaemon({ cwd: fx.root, attempts: 1, readyTimeoutMs: 10_000 });
  assert.equal(Number(again.pid), holderPid, 'the same daemon serves');
  assert.equal(discoveryPid(fx.discoveryPath), holderPid);
});

// A main thread frozen below the watchdog limit loses nothing: the lock keeps
// a new contender out, and the watchdog thread answers the liveness probe a
// pre-lock daemon makes once the record looks stale.
test('a daemon frozen below the freeze limit keeps ownership; new and pre-lock contenders yield', async (t) => {
  const fx = daemonFixture(t, { freezeLimitMs: 25_000 });
  const daemon = freezableDaemon(fx);
  const holder = await spawnDaemonCandidate({ cwd: fx.root, entry: daemon.entry, log: () => {}, timeoutMs: 30_000 });
  const holderPid = Number(holder.summary().pid);
  fx.track(holderPid);
  assert.ok(holder.summary().ready, 'the holder booted');
  const frozenAt = Date.now();
  await daemon.freeze(12_000);

  const logs = [];
  const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
  const summary = candidate.summary();
  fx.track(summary.pid);
  assert.equal(summary.exitCode, 0, logs.join('\n'));
  assert.match(summary.exitReason, new RegExp(`lost singleton claim to live peer pid=${holderPid}\\b`));

  // Past the 6 s staleness without a heartbeat: the pre-lock daemon probes.
  await delay(Math.max(0, frozenAt + STALE_MS + 1000 - Date.now()));
  const preLock = await preLockContender(fx);
  assert.ok(Date.now() - frozenAt < 12_000, 'decided while the holder was still frozen');
  assert.equal(preLock.owned, false);
  assert.equal(preLock.ownerPid, holderPid);
  assert.deepEqual(preLock.proof, { pid: holderPid, verdict: 'live' });
  assert.equal(preLock.probe.port, Number(fx.owner().livenessPort));
  assert.equal(fx.owner().pid, holderPid);

  // Thawed: still the one daemon, serving.
  const again = await ensureDaemon({ cwd: fx.root, attempts: 1, readyTimeoutMs: 20_000 });
  assert.equal(Number(again.pid), holderPid);
  assert.ok(isPidAlive(holderPid));
  // daemon.log exists once anything was logged after ready.
  assert.doesNotMatch(existsSync(fx.logPath) ? readFileSync(fx.logPath, 'utf8') : '', /freeze watchdog:/);
});

function registerClient({ port, token }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(
      JSON.stringify({ protocol: SESSION_PROTOCOL, leadPid: process.pid, cwd: process.cwd(), lifecycle: false })
    );
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/client/register',
        method: 'POST',
        agent: false,
        headers: { 'X-Mixdog-Daemon-Token': token, 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// Reproduced: a pre-lock daemon took the record over while this holder's main
// thread was frozen (its liveness unanswered) and still held the claim lock;
// thawed, the holder answered /client/register with 200.
test('a holder thawing from a freeze serves nothing until its record is re-verified, and stops if it was taken', async (t) => {
  const fx = daemonFixture(t);
  const daemon = freezableDaemon(fx);
  const holder = await spawnDaemonCandidate({ cwd: fx.root, entry: daemon.entry, log: () => {}, timeoutMs: 30_000 });
  const holderPid = Number(holder.summary().pid);
  fx.track(holderPid);
  assert.ok(holder.summary().ready, 'the holder booted');
  const discovery = readDiscovery(fx.discoveryPath);
  assert.equal(discovery.pid, holderPid);
  const control = await registerClient(discovery);
  assert.equal(control.status, 200, control.body);

  const frozenAt = Date.now();
  await daemon.freeze(3000);
  // The pre-lock contender's claim: its record (this live process standing
  // in), written under the claim lock it keeps holding.
  const claimLock = `${fx.ownerPath}.claim.lock`;
  mkdirSync(claimLock);
  const touch = setInterval(() => {
    const now = new Date();
    utimesSync(claimLock, now, now);
  }, 500);
  t.after(() => clearInterval(touch));
  fx.writeOwner({ claimedAt: fx.iso(), heartbeatAt: fx.iso() });
  await delay(Math.max(0, frozenAt + 3500 - Date.now()));

  const refused = await registerClient(discovery);
  assert.equal(refused.status, 503, refused.body);
  assert.equal(JSON.parse(refused.body).code, 'EDAEMON_RETRY_LATER');
  assert.equal(fx.owner().pid, process.pid, 'the record was left alone');

  // The claim lock released, the re-verification finds the other owner.
  clearInterval(touch);
  rmSync(claimLock, { recursive: true, force: true });
  assert.ok(await waitFor(() => exitOf(holder) !== null, 20_000), 'the superseded holder stopped');
  assert.match(exitOf(holder).exitReason, new RegExp(`owner claim superseded by pid=${process.pid}\\b`));
  assert.equal(fx.owner().pid, process.pid);
});

test('a daemon frozen past the freeze limit is killed with diagnostics and the next one takes over at once', async (t) => {
  const fx = daemonFixture(t, { freezeLimitMs: 3000 });
  const daemon = freezableDaemon(fx);
  const holder = await spawnDaemonCandidate({ cwd: fx.root, entry: daemon.entry, log: () => {}, timeoutMs: 30_000 });
  const holderPid = Number(holder.summary().pid);
  fx.track(holderPid);
  assert.ok(holder.summary().ready, 'the holder booted');
  await daemon.freeze(120_000);

  assert.ok(await waitFor(() => exitOf(holder) !== null, 30_000), 'the frozen daemon was killed');
  const exit = exitOf(holder);
  if (process.platform === 'win32') assert.equal(exit.exitCode, 1);
  else assert.equal(exit.exitSignal, 'SIGKILL');
  assert.match(exit.exitReason, /^freeze watchdog: main thread made no progress for \d+ms/);
  assert.match(readFileSync(fx.logPath, 'utf8'), /\[daemon\] freeze watchdog: main thread made no progress/);

  // The kernel released the lock: the next start owns at once, nothing waited out.
  const startedAt = Date.now();
  const next = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(next.pid);
  assert.notEqual(Number(next.pid), holderPid);
  assert.equal(fx.owner().pid, Number(next.pid));
  assert.ok(Date.now() - startedAt < STALE_MS * 3, `took over in ${Date.now() - startedAt}ms`);
});

test('two daemons started at once leave exactly one owner', async (t) => {
  const fx = daemonFixture(t);
  const candidates = await Promise.all(
    [0, 1].map(() => spawnDaemonCandidate({ cwd: fx.root, log: () => {}, timeoutMs: 30_000 }))
  );
  const summaries = candidates.map((candidate) => candidate.summary());
  for (const summary of summaries) fx.track(summary.pid);
  const winners = summaries.filter((summary) => summary.ready);
  assert.equal(winners.length, 1, JSON.stringify(summaries));
  const loser = summaries.find((summary) => !summary.ready);
  assert.equal(loser.exitCode, 0);
  assert.match(loser.exitReason, /lost singleton claim to live peer/);
  assert.equal(fx.owner().pid, Number(winners[0].pid));
  assert.equal(discoveryPid(fx.discoveryPath), Number(winners[0].pid));
});

// SIGKILL runs no exit hook: the record still names the dead holder. Even a
// record that looks live — its pid reused by a running process, its heartbeat
// fresh — gives way at once: it is a lock holder's, and the lock is free.
test('after kill -9 of the holder the next start owns at once, whatever its record looks like', async (t) => {
  const fx = daemonFixture(t, { staleMs: null });
  const first = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  const firstPid = Number(first.pid);
  fx.track(firstPid);
  const record = fx.owner();
  assert.equal(record.ownership, 'os-lock');
  assert.ok(Date.parse(record.processStartedAt) > 0);
  process.kill(firstPid, 'SIGKILL');
  assert.ok(await waitFor(() => !isPidAlive(firstPid)));
  // The pid reused by this (live) test process, heartbeat fresh.
  writeJsonAtomicSync(fx.ownerPath, { ...record, pid: process.pid, heartbeatAt: fx.iso() });

  const logs = [];
  const startedAt = Date.now();
  const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
  const summary = candidate.summary();
  fx.track(summary.pid);
  assert.ok(summary.ready, logs.join('\n'));
  assert.ok(Date.now() - startedAt < 30_000);
  assert.equal(fx.owner().pid, Number(summary.pid));
  assert.equal(fx.owner().ownership, 'os-lock');
});

test('an owner still booting after more than 60 s keeps its claim while it beats', async (t) => {
  const fx = daemonFixture(t);
  // Claimed an hour ago, nothing published yet, heartbeat fresh.
  fx.keepBeating({ claimedAt: fx.iso(-3_600_000), livenessPort: await livenessPort(t) });

  const logs = [];
  const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
  const summary = candidate.summary();
  fx.track(summary.pid);
  assert.equal(summary.exitCode, 0, logs.join('\n'));
  assert.match(summary.exitReason, new RegExp(`lost singleton claim to live peer pid=${process.pid}\\b`));
  assert.equal(fx.owner().pid, process.pid);

  // The launcher waits on it instead of spawning a contender.
  await assert.rejects(ensureDaemon({ cwd: fx.root, attempts: 1, readyTimeoutMs: 800 }), (error) => {
    assert.match(error.message, new RegExp(`^daemon owner: pid=${process.pid} `, 'm'));
    assert.match(error.message, /^no daemon candidate was spawned/m);
    return true;
  });
});

test('a running daemon re-publishes a deleted daemon.json and no second daemon starts', async (t) => {
  const fx = daemonFixture(t);
  const first = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(first.pid);
  rmSync(fx.discoveryPath);

  const logs = [];
  const again = await ensureDaemon({
    cwd: fx.root,
    attempts: 2,
    readyTimeoutMs: 10_000,
    log: (line) => logs.push(line),
  });
  assert.equal(Number(again.pid), Number(first.pid));
  assert.equal(again.port, first.port);
  assert.ok(!logs.some((line) => line.startsWith('spawning daemon candidate')), logs.join('\n'));
  assert.equal(discoveryPid(fx.discoveryPath), Number(first.pid));
  assert.equal(fx.owner().pid, Number(first.pid));
});

test('a running daemon stops serving once its owner record names another live pid', async (t) => {
  const fx = daemonFixture(t);
  const daemon = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  const daemonPid = Number(daemon.pid);
  fx.track(daemonPid);
  fx.keepBeating({ claimedAt: fx.iso() });

  assert.ok(await waitFor(() => !isPidAlive(daemonPid)), 'the superseded daemon exited');
  assert.notEqual(discoveryPid(fx.discoveryPath), daemonPid);
  assert.equal(fx.owner().pid, process.pid);
});

// A pre-lock contender with a shifted clock must yield to a holder that
// answers health, even after the holder refreshes its heartbeat. (A new
// contender never gets that far: the lock refuses it first, as asserted too.)
// Use the fixture's short staleness to observe a real refresh, rather than
// racing the production 10 s heartbeat.
for (const [direction, shiftMs] of [
  ['forward', -61_000],
  ['backward', 61_000],
]) {
  test(`a wall-clock jump ${direction} never lets a contender reclaim a holder that answers`, async (t) => {
    const fx = daemonFixture(t);
    const holder = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
    const holderPid = Number(holder.pid);
    fx.track(holderPid);
    const record = fx.owner();
    assert.deepEqual(await probeDaemonPid({ port: Number(record.livenessPort), timeoutMs: 2000 }), {
      pid: holderPid,
      timedOut: false,
    });
    assert.notEqual(Number(record.livenessPort), Number(holder.port), 'its own listener, not the session port');
    assert.ok(
      await waitFor(() => fx.owner().heartbeatAt !== record.heartbeatAt),
      'the real holder refreshed its heartbeat'
    );

    const logs = [];
    const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
    const summary = candidate.summary();
    fx.track(summary.pid);
    assert.equal(summary.exitCode, 0, logs.join('\n'));
    assert.match(summary.exitReason, new RegExp(`lost singleton claim to live peer pid=${holderPid}\\b`));

    const preLock = await preLockContender(fx, { offsetMs: -shiftMs });
    assert.equal(preLock.owned, false);
    assert.equal(preLock.ownerPid, holderPid);
    const { probe } = preLock;
    assert.ok(probe, 'the pre-lock contender probed the holder');
    assert.equal(probe.port, Number(record.livenessPort));
    const ageMs = probe.now - Date.parse(probe.owner.heartbeatAt);
    assert.equal(Math.sign(ageMs), Math.sign(-shiftMs), 'the probe observed the requested clock-jump direction');
    assert.ok(Math.abs(ageMs) > STALE_MS, 'the contender probed a stale-looking heartbeat');
    assert.notEqual(probe.owner.heartbeatAt, record.heartbeatAt, 'the contender saw a renewed heartbeat');
    assert.deepEqual(
      { ...fx.owner(), heartbeatAt: record.heartbeatAt },
      record,
      'heartbeat renewal preserves the entire owner identity'
    );
    assert.ok(isPidAlive(holderPid));
    const again = await ensureDaemon({ cwd: fx.root, attempts: 1, readyTimeoutMs: 10_000 });
    assert.equal(Number(again.pid), holderPid);
  });

  // The same jump while the holder is still booting: claimed, its liveness
  // listener up, nothing published (no daemon.json, no session endpoint). A
  // stale-looking stamp with nothing else to probe used to be reclaimable.
  test(`a wall-clock jump ${direction} during boot never lets a contender take over`, async (t) => {
    const fx = daemonFixture(t, { staleMs: null });
    const booting = {
      kind: 'mixdog-daemon',
      pid: process.pid,
      claimedAt: fx.iso(),
      heartbeatAt: fx.iso(shiftMs),
      livenessPort: await livenessPort(t),
    };
    writeJsonAtomicSync(fx.ownerPath, booting);

    const logs = [];
    const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
    const summary = candidate.summary();
    fx.track(summary.pid);
    assert.equal(summary.exitCode, 0, logs.join('\n'));
    assert.match(summary.exitReason, new RegExp(`lost singleton claim to live peer pid=${process.pid}\\b`));
    assert.deepEqual(fx.owner(), booting);
    assert.equal(discoveryPid(fx.discoveryPath), 0, 'nothing published over the booting holder');
    // The launcher waits for the booting holder instead of spawning a contender.
    await assert.rejects(ensureDaemon({ cwd: fx.root, attempts: 1, readyTimeoutMs: 800 }), (error) => {
      assert.match(error.message, new RegExp(`^daemon owner: pid=${process.pid} `, 'm'));
      assert.match(error.message, /^no daemon candidate was spawned/m);
      return true;
    });
  });
}

test('ensureDaemon bounds every probe by its deadline, even against a trickling endpoint', async (t) => {
  const fx = daemonFixture(t);
  const timers = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 10);
    timers.add(timer);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  mkdirSync(dirname(fx.discoveryPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    fx.discoveryPath,
    JSON.stringify({ pid: process.pid, endpoints: { channel: { port, token: 't' }, session: { port, token: 't' } } })
  );
  fx.writeOwner({ claimedAt: fx.iso(-3_600_000), heartbeatAt: fx.iso(-3_600_000), livenessPort: port });

  // The endpoint trickles forever, so rejecting at all proves the deadline cut the probe off.
  const budgets = [];
  await assert.rejects(
    ensureDaemon({
      cwd: fx.root,
      attempts: 0,
      readyTimeoutMs: 400,
      proveOwner: (ownerPath, options) => {
        budgets.push(options.budgetMs);
        return proveDaemonOwnerRecord(ownerPath, options);
      },
    }),
    (error) => error.message.startsWith('daemon session endpoint is unavailable')
  );
  // The owner proof receives what is left of the 400 ms deadline, not a fresh default.
  assert.ok(budgets.length >= 1);
  assert.ok(
    budgets.every((budget) => budget >= 1 && budget <= 400),
    `forwarded budgets ${budgets}`
  );
});
