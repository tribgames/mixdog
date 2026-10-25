import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { readSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { discoveryPid, probeDaemonPid, proveDaemonOwnerRecord, startOwnerLivenessListener } from './daemon-owner.mjs';
import { ensureDaemon, spawnDaemonCandidate } from './session-client.mjs';

// The real daemon in an isolated home, data dir and runtime root, on a 6 s
// lease (1 s beats, fenced at 4 s) so the tests need not wait out 60 s;
// `staleMs: null` keeps the production 60 s lease (10 s beats).
const STALE_MS = 6000;

function daemonFixture(t, { staleMs = STALE_MS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-heartbeat-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DAEMON_OWNER_STALE_MS: staleMs ? String(staleMs) : undefined,
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

// Keep the real daemon entry and HTTP probe. Only the contender's wall clock
// moves; a holder heartbeat can no longer erase the clock-jump condition.
// Record the actual liveness request so yielding on a fresh-looking record
// without probing the holder cannot satisfy the test.
function clockShiftedContender(fx, offsetMs, livenessPort) {
  const entry = join(fx.root, 'clock-shifted-contender.mjs');
  const probePath = join(fx.root, 'contender-probe.json');
  writeFileSync(
    entry,
    `
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const realNow = Date.now;
Date.now = () => realNow() + ${offsetMs};
const get = http.get;
http.get = function (options, ...args) {
  if (options.port === ${livenessPort} && options.path === '/health') {
    const owner = JSON.parse(readFileSync(${JSON.stringify(fx.ownerPath)}, 'utf8'));
    writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ owner, now: Date.now() }));
  }
  return get.call(this, options, ...args);
};
await import(${JSON.stringify(new URL('./daemon.mjs', import.meta.url).href)});
`
  );
  return { entry, probePath };
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
// held, as an antivirus or sync client holding the file would). The holder
// must fence itself — stop serving and exit — before its record turns stale
// and a contender may reclaim it.
test('a daemon that cannot refresh its lease stops before a contender may reclaim it', async (t) => {
  const fx = daemonFixture(t);
  const old = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  const oldPid = Number(old.pid);
  fx.track(oldPid);

  const lockPath = `${fx.ownerPath}.claim.lock`;
  mkdirSync(lockPath);
  // Kept fresh so the 5 s stale-lock sweep never frees it.
  const touch = setInterval(() => {
    const now = new Date();
    utimesSync(lockPath, now, now);
  }, 500);
  t.after(() => clearInterval(touch));

  let lastHeartbeat = Date.parse(fx.owner().heartbeatAt);
  let stoppedAt = 0;
  let unpublishedBeforeExit = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const record = readSingletonOwner(fx.ownerPath).owner;
    if (record?.pid === oldPid) lastHeartbeat = Date.parse(record.heartbeatAt);
    if (discoveryPid(fx.discoveryPath) !== oldPid) unpublishedBeforeExit = true;
    if (!isPidAlive(oldPid)) {
      stoppedAt = Date.now();
      break;
    }
    assert.ok(Date.now() - lastHeartbeat <= STALE_MS, 'the old daemon was still running on a reclaimable record');
    await delay(25);
  }
  assert.ok(stoppedAt, 'the old daemon fenced itself and exited');
  assert.ok(stoppedAt - lastHeartbeat < STALE_MS, `stopped ${stoppedAt - lastHeartbeat}ms after its last refresh`);
  assert.ok(unpublishedBeforeExit, 'its endpoint was unpublished');

  clearInterval(touch);
  rmSync(lockPath, { recursive: true, force: true });
  const contender = await ensureDaemon({ cwd: fx.root, attempts: 2, readyTimeoutMs: 30_000 });
  fx.track(contender.pid);
  assert.notEqual(Number(contender.pid), oldPid);
  assert.equal(fx.owner().pid, Number(contender.pid));
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

// A contender with a shifted clock must yield to a holder that answers health,
// even after the holder refreshes its heartbeat. Use the fixture's short lease
// to observe a real refresh, rather than racing the production 10 s heartbeat
// (which may also run early when the holder re-verifies after an event-loop stall).
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
    const { entry, probePath } = clockShiftedContender(fx, -shiftMs, Number(record.livenessPort));

    const logs = [];
    const candidate = await spawnDaemonCandidate({
      cwd: fx.root,
      entry,
      log: (line) => logs.push(line),
      timeoutMs: 30_000,
    });
    const summary = candidate.summary();
    fx.track(summary.pid);
    assert.equal(summary.exitCode, 0, logs.join('\n'));
    assert.match(summary.exitReason, new RegExp(`lost singleton claim to live peer pid=${holderPid}\\b`));
    const probe = JSON.parse(readFileSync(probePath, 'utf8'));
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
