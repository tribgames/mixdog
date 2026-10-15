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
  OWNER_PROBE_TIMEOUT_MS,
  createOwnerHeartbeat,
  daemonOwnerIsStale,
  daemonOwnerTimings,
  discoveryPid,
  probeDaemonPid,
  proveDaemonOwner,
  startOwnerLivenessListener,
} from './daemon-owner.mjs';
import { createSessionTransport } from './session-transport.mjs';

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

function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

function post(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { 'X-Mixdog-Daemon-Token': 'tok' } },
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
    req.end('{}');
  });
}

async function leasedTransport(t, heartbeat) {
  const transport = createSessionTransport({
    handleCall: async () => ({ ok: true }),
    serverToken: 'tok',
    admitWork: () => heartbeat.admit(),
  });
  const { port } = await transport.start();
  t.after(() => transport.stop());
  return port;
}

test('lease timings: 60 s stale, 10 s beats, fenced with the shutdown budget to spare', () => {
  const defaults = daemonOwnerTimings({});
  assert.deepEqual(defaults, {
    staleMs: DAEMON_OWNER_STALE_MS,
    heartbeatMs: 10_000,
    fenceMs: 40_000,
    tickMs: 250,
    stallMs: 1000,
  });
  assert.ok(defaults.fenceMs + 15_000 < defaults.staleMs);
  // A holder silent for a full probe has stalled long enough to re-verify.
  assert.ok(defaults.stallMs < OWNER_PROBE_TIMEOUT_MS);
  assert.deepEqual(daemonOwnerTimings({ MIXDOG_DAEMON_OWNER_STALE_MS: '600' }), {
    staleMs: 600,
    heartbeatMs: 100,
    fenceMs: 400,
    tickMs: 25,
    stallMs: 100,
  });
  assert.equal(daemonOwnerTimings({ MIXDOG_DAEMON_OWNER_STALE_MS: '1' }).staleMs, 600);
  assert.equal(daemonOwnerTimings({ MIXDOG_DAEMON_OWNER_STALE_MS: '600000' }).staleMs, DAEMON_OWNER_STALE_MS);
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
  const startedAt = performance.now();
  assert.deepEqual(await probeDaemonPid({ port, timeoutMs: 60 }), { pid: 0, timedOut: true });
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed < 250, `probe took ${Math.round(elapsed)}ms against a 60ms bound`);

  const owner = { pid: process.pid, livenessPort: port, heartbeatAt: at(-STALE - 1) };
  const prove = (options) => proveDaemonOwner(owner, { discoveryPath, now: NOW, staleMs: STALE, ...options });
  // Silent for the full probe timeout: dead. Cut short by a caller's deadline: unknown.
  assert.deepEqual(await prove({ timeoutMs: 60 }), { pid: process.pid, verdict: 'dead' });
  const budgeted = performance.now();
  assert.deepEqual(await prove({ timeoutMs: 2000, budgetMs: 60 }), { pid: process.pid, verdict: 'unknown' });
  assert.ok(performance.now() - budgeted < 250);
});

test('the heartbeat refreshes or recreates its own record and stops when another pid owns it', (t) => {
  const { ownerPath } = fixture(t);
  const owner = { kind: 'mixdog-daemon', pid: 4242, claimedAt: at(-3_600_000), heartbeatAt: at(-3_600_000) };
  writeFileSync(ownerPath, JSON.stringify(owner));
  let clock = NOW;
  let mono = 0;
  const beats = [];
  const superseded = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath,
    owner,
    heartbeatMs: 10_000,
    fenceMs: 40_000,
    tickMs: 250,
    stallMs: 1000,
    now: () => clock,
    monoNow: () => mono,
    onBeat: () => beats.push(clock),
    onSuperseded: (record) => superseded.push(record),
    onFenced: () => assert.fail('not fenced'),
  });

  assert.equal(heartbeat.beat(), 'refreshed');
  assert.deepEqual(readSingletonOwner(ownerPath).owner, { ...owner, heartbeatAt: at(0) });
  rmSync(ownerPath);
  clock += 10_000;
  mono += 10_000;
  assert.equal(heartbeat.beat(), 'refreshed');
  assert.deepEqual(readSingletonOwner(ownerPath).owner, { ...owner, heartbeatAt: at(10_000) });
  assert.deepEqual(beats, [NOW, NOW + 10_000]);

  const winner = { kind: 'mixdog-daemon', pid: 7, heartbeatAt: at(10_000) };
  writeFileSync(ownerPath, JSON.stringify(winner));
  assert.equal(heartbeat.beat(), 'superseded');
  assert.deepEqual(superseded, [winner]);
  assert.deepEqual(readSingletonOwner(ownerPath).owner, winner);
  assert.equal(heartbeat.admit(), false);
  // Stopped: later beats never touch the winner's record.
  assert.equal(heartbeat.beat(), null);
  assert.deepEqual(beats, [NOW, NOW + 10_000]);
});

test('the lease runs in monotonic time: an expired lease fences instead of renewing', () => {
  let mono = 0;
  let failing = true;
  const refreshes = [];
  const fenced = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    fenceMs: 40_000,
    tickMs: 250,
    stallMs: 1000,
    // The wall clock jumping around changes nothing for the holder.
    now: () => NOW + (refreshes.length % 2 ? 3_600_000 : -3_600_000),
    monoNow: () => mono,
    refresh: (_path, record) => {
      refreshes.push(mono);
      if (failing) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      return { status: 'refreshed', owner: record };
    },
    onSuperseded: () => assert.fail('not superseded'),
    onFenced: (info) => fenced.push(info),
  });
  for (const offset of [10_000, 20_000, 30_000, 39_999]) {
    mono = offset;
    assert.equal(heartbeat.beat(), 'failed');
  }
  assert.deepEqual(fenced, []);
  // One success renews the lease from that beat.
  failing = false;
  assert.equal(heartbeat.beat(), 'refreshed');
  // An overdue beat (the loop stalled past the lease) must not renew it.
  mono = 39_999 + 40_000;
  const calls = refreshes.length;
  assert.equal(heartbeat.beat(), 'fenced');
  assert.equal(refreshes.length, calls, 'no renewal attempted on an expired lease');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].sinceMs, 40_000);
  assert.equal(heartbeat.admit(), false);
  assert.equal(heartbeat.beat(), null);
  assert.equal(fenced.length, 1);
});

test('after a stall nothing is admitted until a refresh re-verifies the record', () => {
  let mono = 0;
  let status = 'refreshed';
  const refreshes = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    fenceMs: 40_000,
    tickMs: 250,
    stallMs: 1000,
    monoNow: () => mono,
    refresh: (_path, record) => {
      refreshes.push(mono);
      return { status, owner: status === 'superseded' ? { pid: 7 } : record };
    },
    onSuperseded: () => {},
    onFenced: () => assert.fail('not fenced'),
  });
  mono = 500;
  assert.equal(heartbeat.admit(), true);
  assert.deepEqual(refreshes, [], 'no stall, no refresh');
  // 3 s without a turn: re-verify first; a busy claim lock refuses the work.
  mono = 3500;
  status = 'busy';
  assert.equal(heartbeat.admit(), false);
  assert.deepEqual(refreshes, [3500]);
  // Retried at most once per tick, refusing meanwhile.
  mono = 3600;
  assert.equal(heartbeat.admit(), false);
  assert.deepEqual(refreshes, [3500]);
  mono = 3750;
  status = 'refreshed';
  assert.equal(heartbeat.admit(), true);
  assert.deepEqual(refreshes, [3500, 3750]);
  mono = 3800;
  assert.equal(heartbeat.admit(), true);
  // A stall during which a contender took the record: refused for good.
  mono = 9000;
  status = 'superseded';
  assert.equal(heartbeat.admit(), false);
  assert.equal(heartbeat.state, 'superseded');
  mono = 9500;
  assert.equal(heartbeat.admit(), false);
});

test('event-loop stall past the lease: fenced on resume, never renewed, requests refused', async (t) => {
  const refreshes = [];
  const fenced = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: new Date().toISOString() },
    heartbeatMs: 100,
    fenceMs: 400,
    tickMs: 25,
    stallMs: 100,
    refresh: (_path, record) => {
      refreshes.push(performance.now());
      return { status: 'refreshed', owner: record };
    },
    onSuperseded: () => assert.fail('not superseded'),
    onFenced: (info) => fenced.push(info),
  });
  t.after(() => heartbeat.stop());
  const port = await leasedTransport(t, heartbeat);
  heartbeat.start();
  await delay(250);
  assert.ok(refreshes.length >= 1, 'beating before the stall');
  assert.equal((await post(port, '/client/register')).status !== 503, true);

  const stalledAt = performance.now();
  const pending = post(port, '/call');
  busyWait(700);
  const response = await pending;
  assert.equal(response.status, 503);
  assert.match(response.body, /daemon owner lease is not held/);
  assert.equal(fenced.length, 1);
  assert.deepEqual(
    refreshes.filter((when) => when >= stalledAt),
    [],
    'the overdue beat fenced instead of renewing'
  );
  const later = await post(port, '/client/register');
  assert.equal(later.status, 503);
  assert.equal(heartbeat.state, 'fenced');
});

test('a short stall re-verifies before serving: refused if the record was taken, served if not', async (t) => {
  const { ownerPath } = fixture(t);
  const run = async (takeOver) => {
    const owner = { kind: 'mixdog-daemon', pid: 4242, heartbeatAt: new Date().toISOString() };
    writeFileSync(ownerPath, JSON.stringify(owner));
    const superseded = [];
    const heartbeat = createOwnerHeartbeat({
      ownerPath,
      owner,
      heartbeatMs: 100,
      fenceMs: 5000,
      tickMs: 25,
      stallMs: 100,
      onSuperseded: (record) => superseded.push(record),
      onFenced: () => assert.fail('not fenced'),
    });
    t.after(() => heartbeat.stop());
    const port = await leasedTransport(t, heartbeat);
    heartbeat.start();
    await delay(150);
    const pending = post(port, '/call');
    busyWait(150);
    // A contender reclaims while this holder cannot answer (its probe timed out).
    if (takeOver) writeFileSync(ownerPath, JSON.stringify({ kind: 'mixdog-daemon', pid: 7, heartbeatAt: new Date().toISOString() }));
    busyWait(150);
    return { response: await pending, superseded, heartbeat };
  };

  const taken = await run(true);
  assert.equal(taken.response.status, 503);
  assert.match(taken.response.body, /daemon owner lease is not held/);
  assert.deepEqual(
    taken.superseded.map((record) => record.pid),
    [7]
  );
  assert.equal(readSingletonOwner(ownerPath).owner.pid, 7, 'the winner record is never overwritten');

  const kept = await run(false);
  assert.notEqual(kept.response.status, 503);
  assert.equal(kept.heartbeat.state, 'active');
  assert.equal(readSingletonOwner(ownerPath).owner.pid, 4242);
});

test('the fence fires on its own tick when refreshes keep failing (no request needed)', async (t) => {
  const fenced = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: new Date().toISOString() },
    heartbeatMs: 30,
    fenceMs: 100,
    tickMs: 10,
    stallMs: 1000,
    refresh: () => ({ status: 'busy', owner: null }),
    onSuperseded: () => assert.fail('not superseded'),
    onFenced: (info) => fenced.push(info),
  });
  t.after(() => heartbeat.stop());
  heartbeat.start();
  for (let i = 0; i < 40 && fenced.length === 0; i += 1) await delay(25);
  assert.equal(fenced.length, 1);
});

test('one long block is reported once with the describeStall detail, and still forces re-verify', () => {
  let mono = 0;
  const logs = [];
  const windows = [];
  const refreshes = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    fenceMs: 40_000,
    tickMs: 250,
    stallMs: 1000,
    monoNow: () => mono,
    log: (line) => logs.push(line),
    describeStall: (from, to) => {
      windows.push([from, to]);
      return 'spans: session.read#abcd1234 3000ms';
    },
    refresh: (_path, record) => {
      refreshes.push(mono);
      return { status: 'busy', owner: record };
    },
    onSuperseded: () => {},
    onFenced: () => assert.fail('not fenced'),
  });
  mono = 3500;
  // Observed by the tick and by two requests at the same instant: one report.
  heartbeat.tick();
  assert.equal(heartbeat.admit(), false);
  assert.equal(heartbeat.admit(), false);
  const stalls = logs.filter((line) => line.startsWith('event loop stalled'));
  assert.equal(stalls.length, 1);
  assert.equal(
    stalls[0],
    'event loop stalled 3500ms — owner lease must be re-verified before serving | spans: session.read#abcd1234 3000ms'
  );
  assert.deepEqual(windows, [[0, 3500]]);
  assert.equal(refreshes.length >= 1, true, 'lease re-verify still attempted');
  // A later, separate block is a new report over its own window only.
  mono = 6000;
  heartbeat.tick();
  assert.deepEqual(windows, [[0, 3500], [3500, 6000]]);
});

test('a throwing describeStall never disturbs the stall report or the lease', () => {
  let mono = 0;
  const logs = [];
  const heartbeat = createOwnerHeartbeat({
    ownerPath: 'unused',
    owner: { pid: 4242, heartbeatAt: at(0) },
    heartbeatMs: 10_000,
    fenceMs: 40_000,
    tickMs: 250,
    stallMs: 1000,
    monoNow: () => mono,
    log: (line) => logs.push(line),
    describeStall: () => {
      throw new Error('boom');
    },
    refresh: (_path, record) => ({ status: 'refreshed', owner: record }),
    onSuperseded: () => {},
    onFenced: () => assert.fail('not fenced'),
  });
  mono = 2000;
  assert.equal(heartbeat.admit(), true);
  assert.deepEqual(logs, ['event loop stalled 2000ms — owner lease must be re-verified before serving']);
});
