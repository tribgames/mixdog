import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import {
  DAEMON_OWNER_STALE_MS,
  OWNER_LOCK_OWNERSHIP,
  createOwnerRecordKeeper,
  daemonOwnerIsStale,
  daemonOwnerTimings,
  discoveryPid,
  ownerRecordYieldsToLock,
  probeDaemonPid,
  proveDaemonOwner,
  startOwnerLivenessListener,
} from './daemon-owner.mjs';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const STALE = 60_000;
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-daemon-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { discoveryPath: join(root, 'daemon.json'), ownerPath: join(root, 'daemon-owner.json') };
}

// A /health endpoint answering `pid`, or a closed port when pid is null.
async function healthEndpoint(t, pid) {
  const tokens = [];
  const server = http.createServer((req, res) => {
    tokens.push(req.headers['x-mixdog-daemon-token']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  if (pid === null) await new Promise((resolve) => server.close(resolve));
  else t.after(() => server.close());
  return { port, tokens };
}

// A /health that never finishes: one byte every 10 ms keeps the socket active.
async function tricklingEndpoint(t) {
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
  return server.address().port;
}

test('record timings: 60 s stale, six heartbeats per threshold; the env may only shorten it', () => {
  assert.deepEqual(daemonOwnerTimings({}), { staleMs: DAEMON_OWNER_STALE_MS, heartbeatMs: 10_000 });
  assert.deepEqual(daemonOwnerTimings({ MIXDOG_DAEMON_OWNER_STALE_MS: '600' }), { staleMs: 600, heartbeatMs: 100 });
  assert.equal(daemonOwnerTimings({ MIXDOG_DAEMON_OWNER_STALE_MS: '1' }).staleMs, 600);
  assert.equal(daemonOwnerTimings({ MIXDOG_DAEMON_OWNER_STALE_MS: '600000' }).staleMs, DAEMON_OWNER_STALE_MS);
});

test('a lock holder replaces a lock-format record at once, and a pre-lock record only when stale', () => {
  const yields = (owner, proof) => ownerRecordYieldsToLock(owner, { proof, now: NOW, staleMs: STALE });
  // Beating, its port unprobed: a pre-lock daemon's would stand, a lock holder's
  // writer is gone (this process holds the lock it held).
  const fresh = { pid: 4242, claimedAt: at(-1000), heartbeatAt: at(-1000), livenessPort: 5555 };
  assert.equal(yields({ ...fresh, ownership: OWNER_LOCK_OWNERSHIP }, null), true);
  assert.equal(yields(fresh, null), false);
  assert.equal(yields(fresh, { pid: 4242, verdict: 'dead' }), false, 'a fresh pre-lock heartbeat stands');
  const stale = { ...fresh, heartbeatAt: at(-STALE - 1) };
  assert.equal(yields(stale, { pid: 4242, verdict: 'live' }), false, 'a pre-lock holder that answers stands');
  assert.equal(yields(stale, { pid: 4242, verdict: 'dead' }), true);
  // An unknown marker is not the lock's.
  assert.equal(yields({ ...fresh, ownership: 'lease' }, null), false);
});

test('a leased record is reclaimable only when stale-looking AND its liveness port failed a probe', () => {
  const stale = (owner, proof) => daemonOwnerIsStale(owner, { proof, now: NOW, staleMs: STALE });
  const old = { pid: 4242, claimedAt: at(-3_600_000), heartbeatAt: at(-STALE - 1), livenessPort: 5555 };
  // Fresh heartbeat (a slow boot): never, whatever the probe said.
  assert.equal(stale({ ...old, heartbeatAt: at(-10_000) }, { pid: 4242, verdict: 'dead' }), false);
  // Reused pid: stopped beating, nothing answers.
  assert.equal(stale(old, { pid: 4242, verdict: 'dead' }), true);
  // A holder answering with its own pid keeps it, however the clocks moved.
  assert.equal(stale(old, { pid: 4242, verdict: 'live' }), false);
  assert.equal(stale({ ...old, heartbeatAt: at(STALE + 1) }, { pid: 4242, verdict: 'live' }), false);
  // Staleness alone never: no failed probe, no reclaim.
  assert.equal(stale(old, { pid: 4242, verdict: 'unpublished' }), false);
  assert.equal(stale(old, { pid: 4242, verdict: 'unknown' }), false);
  assert.equal(stale(old, null), false);
  assert.equal(stale(old, { pid: 7, verdict: 'dead' }), false);
});

test('a heartbeat record without a liveness port (intermediate builds) is judged like a legacy one', () => {
  const stale = (owner, proof) => daemonOwnerIsStale(owner, { proof, now: NOW, staleMs: STALE });
  const portless = { pid: 4242, claimedAt: at(-3_600_000), heartbeatAt: at(-1000) };
  assert.equal(stale(portless, { pid: 4242, verdict: 'dead' }), true);
  assert.equal(stale(portless, { pid: 4242, verdict: 'live' }), false);
  assert.equal(stale(portless, { pid: 4242, verdict: 'unpublished' }), true);
  assert.equal(stale({ ...portless, claimedAt: at(-5_000) }, { pid: 4242, verdict: 'unpublished' }), false);
  assert.equal(stale({ ...portless, livenessPort: 'x' }, { pid: 4242, verdict: 'dead' }), true);
});

test('the owner liveness listener answers /health with the pid it was started for', async (t) => {
  const listener = await startOwnerLivenessListener({ pid: 4242 });
  t.after(() => listener.close());
  assert.ok(listener.port > 0);
  assert.deepEqual(await probeDaemonPid({ port: listener.port, timeoutMs: 2000 }), { pid: 4242, timedOut: false });
  await listener.close();
  assert.deepEqual(await probeDaemonPid({ port: listener.port, timeoutMs: 2000 }), { pid: 0, timedOut: false });
});

test('a record without a heartbeat is judged only by the proof for its pid', () => {
  const owner = { pid: 4242, claimedAt: '2020-01-01T00:00:00.000Z' };
  const stale = (record, proof) => daemonOwnerIsStale(record, { proof, now: NOW, staleMs: STALE });
  assert.equal(stale(owner, { pid: 4242, verdict: 'dead' }), true);
  assert.equal(stale(owner, { pid: 4242, verdict: 'live' }), false);
  assert.equal(stale(owner, { pid: 4242, verdict: 'unknown' }), false);
  assert.equal(stale(owner, { pid: 4242, verdict: 'unpublished' }), true);
  assert.equal(stale({ pid: 4242, claimedAt: at(-5_000) }, { pid: 4242, verdict: 'unpublished' }), false);
  assert.equal(stale(owner, null), false);
});

test('the proof probes the liveness port, else the endpoint daemon.json publishes for the pid', async (t) => {
  const { discoveryPath } = fixture(t);
  const prove = (owner, options = {}) =>
    proveDaemonOwner(owner, { discoveryPath, now: NOW, staleMs: STALE, timeoutMs: 2000, ...options });
  const live = await healthEndpoint(t, process.pid);
  const closed = await healthEndpoint(t, null);
  const other = await healthEndpoint(t, process.pid + 1);
  const beating = { pid: process.pid, livenessPort: live.port, heartbeatAt: at(-STALE - 1) };

  // Fresh heartbeat: nothing to prove, nothing probed.
  assert.equal(await prove({ ...beating, heartbeatAt: at(-1000) }), null);
  // Stale-looking either way (clock jumped forward or back), but the holder answers.
  assert.deepEqual(await prove(beating), { pid: process.pid, verdict: 'live' });
  assert.deepEqual(await prove({ ...beating, heartbeatAt: at(STALE + 1) }), { pid: process.pid, verdict: 'live' });
  assert.deepEqual(await prove({ ...beating, livenessPort: closed.port }), { pid: process.pid, verdict: 'dead' });
  assert.deepEqual(await prove({ ...beating, livenessPort: other.port }), { pid: process.pid, verdict: 'dead' });
  // No port: judged like a legacy record (nothing published yet).
  assert.deepEqual(await prove({ ...beating, livenessPort: undefined }), { pid: process.pid, verdict: 'unpublished' });

  // Legacy (v1.1.2) record: only daemon.json can name its endpoint.
  const legacy = { pid: process.pid, claimedAt: '2020-01-01T00:00:00.000Z' };
  const publish = (port) =>
    writeFileSync(discoveryPath, JSON.stringify({ pid: process.pid, endpoints: { session: { port, token: 'tok' } } }));
  assert.deepEqual(await prove(legacy), { pid: process.pid, verdict: 'unpublished' });
  // Community case: the leftover daemon.json names the reused pid, nothing listens.
  publish(closed.port);
  assert.equal(discoveryPid(discoveryPath), process.pid);
  assert.deepEqual(await prove(legacy), { pid: process.pid, verdict: 'dead' });
  publish(other.port);
  assert.deepEqual(await prove(legacy), { pid: process.pid, verdict: 'dead' });
  publish(live.port);
  assert.deepEqual(await prove(legacy), { pid: process.pid, verdict: 'live' });
  assert.deepEqual(live.tokens.slice(-1), ['tok']);
  // A beating record without its own port falls back to the published one.
  assert.deepEqual(await prove({ ...beating, livenessPort: undefined }), { pid: process.pid, verdict: 'live' });
  assert.equal(await prove({ pid: 0 }), null);
});

test('a trickling health response is cut off by total duration, and a short budget proves nothing', async (t) => {
  const { discoveryPath } = fixture(t);
  const port = await tricklingEndpoint(t);
  // The endpoint trickles forever, so resolving at all proves the total-duration cut-off.
  assert.deepEqual(await probeDaemonPid({ port, timeoutMs: 60 }), { pid: 0, timedOut: true });

  const owner = { pid: process.pid, livenessPort: port, heartbeatAt: at(-STALE - 1) };
  const prove = (options) => proveDaemonOwner(owner, { discoveryPath, now: NOW, staleMs: STALE, ...options });
  // Silent for the full probe timeout: dead. Cut short by a caller's deadline: unknown.
  assert.deepEqual(await prove({ timeoutMs: 60 }), { pid: process.pid, verdict: 'dead' });
  assert.deepEqual(await prove({ timeoutMs: 2000, budgetMs: 60 }), { pid: process.pid, verdict: 'unknown' });
});

test('the probe is given the smaller of the probe timeout and the caller budget', async (t) => {
  const { discoveryPath } = fixture(t);
  const owner = { pid: process.pid, livenessPort: 4242, heartbeatAt: at(-STALE - 1) };
  const seen = [];
  const probe = async ({ timeoutMs }) => {
    seen.push(timeoutMs);
    return { pid: 0, timedOut: true };
  };
  const prove = (options) => proveDaemonOwner(owner, { discoveryPath, now: NOW, staleMs: STALE, probe, ...options });
  assert.deepEqual(await prove({ timeoutMs: 2000, budgetMs: 60 }), { pid: process.pid, verdict: 'unknown' });
  assert.deepEqual(await prove({ timeoutMs: 2000, budgetMs: 5000 }), { pid: process.pid, verdict: 'dead' });
  assert.deepEqual(await prove({ timeoutMs: 2000 }), { pid: process.pid, verdict: 'dead' });
  assert.deepEqual(seen, [60, 2000, 2000]);
});

test('the record keeper refreshes or recreates its own record and stops when another pid owns it', async (t) => {
  const { ownerPath } = fixture(t);
  const owner = { kind: 'mixdog-daemon', pid: 4242, ownership: OWNER_LOCK_OWNERSHIP, heartbeatAt: at(-3_600_000) };
  writeFileSync(ownerPath, JSON.stringify(owner));
  let clock = NOW;
  const beats = [];
  const superseded = [];
  const keeper = createOwnerRecordKeeper({
    ownerPath,
    owner,
    heartbeatMs: 10_000,
    now: () => clock,
    onBeat: () => beats.push(clock),
    onSuperseded: (record) => superseded.push(record),
    onLockLost: () => assert.fail('the lock is intact'),
  });

  // The refresh is asynchronous: a beat answers 'pending' and settles.
  assert.equal(keeper.beat(), 'pending');
  assert.equal(await keeper.settled(), 'refreshed');
  assert.deepEqual(readSingletonOwner(ownerPath).owner, { ...owner, heartbeatAt: at(0) });
  rmSync(ownerPath);
  clock += 10_000;
  keeper.beat();
  assert.equal(await keeper.settled(), 'refreshed');
  assert.deepEqual(readSingletonOwner(ownerPath).owner, { ...owner, heartbeatAt: at(10_000) });
  // A restarted liveness listener's port is written at once.
  keeper.update({ livenessPort: 6000 });
  assert.equal(await keeper.settled(), 'refreshed');
  assert.equal(readSingletonOwner(ownerPath).owner.livenessPort, 6000);
  assert.deepEqual(beats, [NOW, NOW + 10_000, NOW + 10_000]);

  // A pre-lock daemon took the record over.
  const winner = { kind: 'mixdog-daemon', pid: 7, heartbeatAt: at(10_000) };
  writeFileSync(ownerPath, JSON.stringify(winner));
  keeper.beat();
  assert.equal(await keeper.settled(), 'superseded');
  assert.deepEqual(superseded, [winner]);
  assert.equal(keeper.state, 'superseded');
  // Stopped: later beats never touch the winner's record.
  assert.equal(keeper.beat(), null);
  assert.deepEqual(readSingletonOwner(ownerPath).owner, winner);
  assert.equal(beats.length, 3);
});

test('no refresh outcome over any span of time stops the keeper: ownership is the lock', async () => {
  const outcomes = ['busy', new Error('EPERM: operation not permitted, rename'), 'busy'];
  const logs = [];
  const keeper = createOwnerRecordKeeper({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    // The wall clock jumping around changes nothing either.
    now: () => NOW + (logs.length % 2 ? 3_600_000 : -3_600_000),
    refresh: (_path, record) => {
      const outcome = outcomes.shift() ?? 'refreshed';
      if (outcome instanceof Error) throw outcome;
      return { status: outcome, owner: record };
    },
    log: (line) => logs.push(line),
    onSuperseded: () => assert.fail('not superseded'),
    onLockLost: () => assert.fail('the lock is intact'),
  });
  for (const expected of ['busy', 'failed', 'busy', 'refreshed']) {
    keeper.beat();
    assert.equal(await keeper.settled(), expected);
    assert.equal(keeper.state, 'active');
  }
  assert.deepEqual(logs, [
    'owner record refresh skipped: claim lock busy',
    'owner record refresh failed: EPERM: operation not permitted, rename',
    'owner record refresh skipped: claim lock busy',
  ]);
});

// A refresh the test settles by hand: `next(status)` answers the oldest one
// (once it has started) and counts it; `started()` counts every one started.
function manualRefresh() {
  const waiting = [];
  let started = 0;
  return {
    started: () => started,
    refresh: (_path, record) => {
      started += 1;
      return new Promise((resolve) =>
        waiting.push((status) => resolve({ status, owner: status === 'superseded' ? { pid: 7 } : record }))
      );
    },
    next: async (status) => {
      while (!waiting.length) await delay(0);
      waiting.shift()(status);
      await delay(0);
    },
  };
}

// Reproduced: a stalled holder whose record a pre-lock daemon took over (and
// whose claim lock it still held) answered /client/register with 200.
test('after a stall nothing is admitted until a refresh started after it re-verifies the record', async () => {
  let mono = 0;
  const manual = manualRefresh();
  const superseded = [];
  const keeper = createOwnerRecordKeeper({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    tickMs: 250,
    stallMs: 1000,
    monoNow: () => mono,
    refresh: manual.refresh,
    onSuperseded: (record) => superseded.push(record),
    onLockLost: () => assert.fail('the lock is intact'),
  });
  // Turns keep coming: admitted, nothing refreshed.
  for (mono = 250; mono <= 2000; mono += 250) assert.equal(keeper.admit(), true);
  assert.equal(manual.started(), 0);

  // A refresh is in flight when the loop stalls: it may have read the record
  // before a takeover, so it re-verifies nothing.
  keeper.beat();
  mono += 5000;
  assert.equal(keeper.admit(), false);
  assert.equal(keeper.verifying, true);
  const admitted = keeper.admitAsync();
  await manual.next('refreshed');
  assert.equal(manual.started(), 2, 'a second refresh, started after the stall');
  assert.equal(keeper.verifying, true);
  await manual.next('refreshed');
  assert.equal(await admitted, true);
  assert.equal(keeper.admit(), true);

  // A contender mid-claim holds the claim lock: refused (retry later), not served.
  mono += 3000;
  const busy = keeper.admitAsync();
  await manual.next('busy');
  assert.equal(await busy, false);
  assert.equal(keeper.verifying, true);
  assert.equal(keeper.state, 'active');
  // Retried every tick; the contender's record is found: stopped for good.
  mono += 250;
  keeper.tick();
  await manual.next('superseded');
  assert.equal(manual.started(), 4);
  assert.deepEqual(superseded, [{ pid: 7 }]);
  assert.equal(keeper.state, 'superseded');
  assert.equal(keeper.admit(), false);
  assert.equal(await keeper.admitAsync(), false);
});

// Probe: the verifying refresh started at 1,500 ms and was answered at 3,500
// ms, a second stall in between with no turn seen: admitAsync said true and
// the stall was cleared unverified.
test('a second stall while the verifying refresh runs needs another refresh started after it', async () => {
  let mono = 0;
  const manual = manualRefresh();
  const keeper = createOwnerRecordKeeper({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    stallMs: 1000,
    monoNow: () => mono,
    refresh: manual.refresh,
    onSuperseded: () => assert.fail('not superseded'),
    onLockLost: () => assert.fail('the lock is intact'),
  });
  mono = 1500;
  let answered = null;
  void keeper.admitAsync().then((value) => {
    answered = value;
  });
  await delay(0);
  assert.equal(manual.started(), 1, 'the verifying refresh started at 1,500 ms');
  mono = 3500;
  await manual.next('refreshed');
  assert.equal(answered, null, 'not admitted on a refresh older than the latest stall');
  assert.equal(keeper.verifying, true);
  assert.equal(manual.started(), 2, 'a refresh started after the second stall');
  await manual.next('refreshed');
  assert.equal(answered, true);
  assert.equal(keeper.verifying, false);
});

test('a lock file deleted or replaced at its path stops the keeper before it writes again', async () => {
  let intact = true;
  const refreshes = [];
  const lost = [];
  const keeper = createOwnerRecordKeeper({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    refresh: (_path, record) => {
      refreshes.push(record);
      return { status: 'refreshed', owner: record };
    },
    lockIntact: () => intact,
    onSuperseded: () => assert.fail('not superseded'),
    onLockLost: () => lost.push(true),
  });
  keeper.beat();
  assert.equal(await keeper.settled(), 'refreshed');
  intact = false;
  assert.equal(keeper.beat(), 'lock-lost');
  assert.deepEqual(lost, [true]);
  assert.equal(keeper.state, 'lock-lost');
  assert.equal(keeper.beat(), null);
  assert.equal(refreshes.length, 1);
});

