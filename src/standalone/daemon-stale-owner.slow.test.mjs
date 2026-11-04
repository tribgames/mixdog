// The real daemon under its real supervisor, in an isolated home, data dir and
// runtime root: the OS lock alone decides ownership, the owner record only
// names the holder, and a frozen daemon is replaced by its supervisor.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { acquireDaemonOwnerLock, daemonOwnerLockPath } from './daemon-owner-lock.mjs';
import { discoveryPid } from './daemon-owner.mjs';
import { ensureDaemon, spawnDaemonCandidate } from './session-client.mjs';

// `freezeLimitMs` shortens the supervisor's 120 s freeze limit.
function daemonFixture(t, { freezeLimitMs = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-owner-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
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
  // The launcher passes its execArgv on; the daemon must run as a plain script.
  process.execArgv = [];
  const pids = new Set();
  t.after(async () => {
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
  return {
    root,
    dataDir,
    ownerPath,
    logPath: join(dataDir, 'daemon.log'),
    discoveryPath: join(root, 'runtime', 'daemon.json'),
    owner: () => JSON.parse(readFileSync(ownerPath, 'utf8')),
    track: (pid) => pids.add(Number(pid)),
    // This test process stands in for the record's pid: alive, not a daemon.
    writeOwner: (fields) =>
      writeFileSync(ownerPath, JSON.stringify({ kind: 'mixdog-daemon', pid: process.pid, ...fields })),
  };
}

async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
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

// Regression: a daemon killed without its exit hooks leaves daemon-owner.json
// behind, and the OS reuses its pid. The live unrelated process used to read as
// the owner forever — launchers waited on it and the desktop failed every call
// with "daemon session endpoint is unavailable". The lock is free: spawn.
test('a record naming a reused pid gives way: the lock is free', async (t) => {
  const fx = daemonFixture(t);
  fx.writeOwner({ claimedAt: new Date(Date.now() - 3_600_000).toISOString() });

  const discovery = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(discovery.pid);
  assert.ok(Number(discovery.pid) > 0 && Number(discovery.pid) !== process.pid);
  assert.equal(fx.owner().pid, Number(discovery.pid));
});

// A crashed daemon leaves an owner record AND a daemon.json naming the same
// pid; the OS reuses the pid. Its endpoint does not answer, the lock is free.
test('an owner record and daemon.json naming a reused pid with a dead endpoint are recovered', async (t) => {
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
});

test('a daemon frozen past the freeze limit is replaced by its supervisor; reconnecting clients find one daemon', async (t) => {
  const fx = daemonFixture(t, { freezeLimitMs: 3000 });
  const daemon = freezableDaemon(fx);
  const holder = await spawnDaemonCandidate({ cwd: fx.root, entry: daemon.entry, log: () => {}, timeoutMs: 30_000 });
  const holderPid = Number(holder.summary().pid);
  fx.track(holderPid);
  assert.ok(holder.summary().ready, 'the holder booted');
  assert.equal(discoveryPid(fx.discoveryPath), holderPid);
  await daemon.freeze(120_000);

  assert.ok(await waitFor(() => !isPidAlive(holderPid), 15_000), 'the frozen daemon was killed');
  assert.match(
    readFileSync(fx.logPath, 'utf8'),
    new RegExp(`\\[daemon\\] freeze supervisor: daemon pid=${holderPid} left ping \\d+ unanswered`)
  );
  // The supervisor's replacement takes the lock the kernel released and
  // publishes; two clients reconnecting at once attach to it alone.
  const [a, b] = await Promise.all([
    ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 }),
    ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 }),
  ]);
  fx.track(a.pid);
  fx.track(b.pid);
  assert.equal(Number(a.pid), Number(b.pid));
  assert.notEqual(Number(a.pid), holderPid);
  assert.match(
    readFileSync(fx.logPath, 'utf8'),
    new RegExp(`frozen daemon pid=${holderPid} exited; replacement pid=${a.pid} started`),
    'the one serving daemon is the supervisor replacement'
  );
  assert.equal(fx.owner().pid, Number(a.pid));
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

// SIGKILL runs no exit hook: the record still names the dead holder, and even
// a record naming a live process gives way at once — the lock is free.
test('after kill -9 of the holder the next start owns at once, whatever its record says', async (t) => {
  const fx = daemonFixture(t);
  const first = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  const firstPid = Number(first.pid);
  fx.track(firstPid);
  const record = fx.owner();
  assert.ok(Date.parse(record.processStartedAt) > 0);
  process.kill(firstPid, 'SIGKILL');
  assert.ok(await waitFor(() => !isPidAlive(firstPid)));
  fx.writeOwner({ ...record, pid: process.pid });

  const logs = [];
  const startedAt = Date.now();
  const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: (line) => logs.push(line), timeoutMs: 30_000 });
  const summary = candidate.summary();
  fx.track(summary.pid);
  assert.ok(summary.ready, logs.join('\n'));
  assert.ok(Date.now() - startedAt < 30_000);
  assert.equal(fx.owner().pid, Number(summary.pid));
});

// A claim lock an older build left held by a live process used to make the
// record write give up, and the daemon served under the dead holder's record
// (what checkpoint recovery and the pg orphan sweep read).
test('the lock holder writes its owner record whatever claim lock is left on disk', async (t) => {
  const fx = daemonFixture(t);
  writeFileSync(`${fx.ownerPath}.claim.lock`, `${process.pid} ${Date.now()} foreign-token\n`);
  fx.writeOwner({ claimedAt: '2020-01-01T00:00:00.000Z' });

  const candidate = await spawnDaemonCandidate({ cwd: fx.root, log: () => {}, timeoutMs: 30_000 });
  const summary = candidate.summary();
  fx.track(summary.pid);
  assert.ok(summary.ready);
  assert.equal(fx.owner().pid, Number(summary.pid));
});

// The lock held (here by this test process) with nothing published is a
// daemon booting: the launcher waits for it instead of spawning a contender.
test('a held lock with nothing published is waited on, never contended', async (t) => {
  const fx = daemonFixture(t);
  const lock = await acquireDaemonOwnerLock(daemonOwnerLockPath(fx.dataDir));
  assert.ok(lock.held);
  fx.writeOwner({ claimedAt: new Date().toISOString() });

  try {
    await assert.rejects(ensureDaemon({ cwd: fx.root, attempts: 1, readyTimeoutMs: 800 }), (error) => {
      assert.match(error.message, new RegExp(`^daemon owner: pid=${process.pid} `, 'm'));
      assert.match(error.message, /^no daemon candidate was spawned/m);
      return true;
    });
  } finally {
    // Before the fixture's cleanup: the open lock file keeps its dir busy on Windows.
    lock.release();
  }
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

  // The endpoint trickles forever, so rejecting in time proves the deadline cut the probe off.
  const startedAt = Date.now();
  await assert.rejects(
    ensureDaemon({ cwd: fx.root, attempts: 0, readyTimeoutMs: 400 }),
    (error) => error.message.startsWith('daemon session endpoint is unavailable')
  );
  assert.ok(Date.now() - startedAt < 3000, `gave up after ${Date.now() - startedAt}ms`);
});
