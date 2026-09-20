import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createClientRegistry } from './client-registry.mjs';

// The attached-client registry on its own: registration and passive
// replacement, response-loss replay records and their TTL, SSE attachment
// frames, the client-grace self-shutdown timer, and pointer resolution.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEAD_PID = 2147483647;

function registry({
  clientGraceMs = 0,
  sweepMs = 1000,
  ttl = 60_000,
  onClientsEmpty = null,
  onClientRegistered = null,
} = {}) {
  const state = {
    clients: new Map(),
    registrationReplays: new Map(),
    pointerToken: null,
    everHadClient: false,
    closed: false,
    remoteAcquired: false,
    pinnedSessionId: null,
    stickyRemoteFrame: null,
  };
  const logs = [];
  const published = [];
  const reg = createClientRegistry({
    state,
    log: (line) => logs.push(line),
    clientGraceMs,
    sweepMs,
    onClientsEmpty,
    onClientRegistered,
    registrationReplayTtlMs: ttl,
    publishRemoteState: () => published.push(state.pointerToken),
  });
  return { reg, state, logs, published };
}

function fakeRes() {
  const res = new EventEmitter();
  res.head = null;
  res.writes = [];
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.head = { status, headers };
  };
  res.write = (chunk) => res.writes.push(chunk);
  res.end = () => {
    res.ended = true;
  };
  return res;
}

test('register records a live client; a passive replacement retires the old token and carries its state', () => {
  const registered = [];
  const { reg, state } = registry({ onClientRegistered: (info) => registered.push(info) });
  const a = reg.registerClient({ leadPid: process.pid, cwd: '/w', restoreSessionId: 'sess_1' });
  const client = state.clients.get(a);
  assert.equal(client.leadPid, process.pid);
  assert.equal(client.cwd, '/w');
  assert.equal(client.restoreSessionId, 'sess_1');
  assert.equal(client.sse, null);
  assert.deepEqual(registered, [{ token: a, leadPid: process.pid, cwd: '/w' }]);
  assert.equal(state.everHadClient, true);

  state.pointerToken = a;
  client.pendingRemoteStateFrame = 'frame-1';
  client.remoteSessionId = 'sess_1';
  const replace = {
    leadPid: process.pid,
    cwd: '/w',
    passive: true,
    replaceToken: a,
    registrationId: 'reg-1',
    restoreSessionId: 'sess_1',
  };
  const b = reg.registerClient(replace);
  assert.equal(state.clients.has(a), false);
  const fresh = state.clients.get(b);
  assert.equal(fresh.pendingRemoteStateFrame, 'frame-1');
  assert.equal(fresh.remoteSessionId, 'sess_1');
  assert.equal(fresh.restoreSessionId, 'sess_1');
  assert.equal(state.pointerToken, b);
  assert.equal(state.registrationReplays.get('reg-1').token, b);

  assert.equal(reg.registerClient(replace), b, 'the same registration id replays the fresh token');
  assert.equal(state.clients.size, 1);
  assert.throws(
    () => reg.registerClient({ ...replace, cwd: '/elsewhere' }),
    (err) => err.statusCode === 409
  );

  const other = reg.registerClient({ leadPid: 424242, passive: true, replaceToken: b });
  assert.equal(state.clients.has(b), true, 'replacement never crosses leadPid boundaries');
  assert.equal(state.clients.has(other), true);
  assert.deepEqual(
    reg.liveClients().map(([token]) => token),
    [b]
  );
  reg.stopTimers();
});

test('cancelReplacementRegistration honours only a fully matching identity; a stream or finished response clears the replay', () => {
  const { reg, state } = registry();
  const a = reg.registerClient({ leadPid: process.pid, cwd: '/w' });
  const identity = {
    leadPid: process.pid,
    cwd: '/w',
    passive: true,
    replaceToken: a,
    registrationId: 'reg-2',
    restoreSessionId: 'sess_2',
  };
  const b = reg.registerClient(identity);
  const cancel = {
    token: a,
    registrationId: 'reg-2',
    replaceToken: a,
    leadPid: process.pid,
    cwd: '/w',
    restoreSessionId: 'sess_2',
  };
  assert.equal(reg.cancelReplacementRegistration({ ...cancel, cwd: '/other' }), 'forbidden');
  assert.equal(reg.cancelReplacementRegistration({ ...cancel, registrationId: 'unknown' }), 'missing');
  assert.equal(reg.cancelReplacementRegistration(cancel), 'cancelled');
  assert.equal(state.clients.has(b), false);
  assert.equal(state.registrationReplays.size, 0);

  const a2 = reg.registerClient({ leadPid: process.pid, cwd: '/w' });
  const b2 = reg.registerClient({
    leadPid: process.pid,
    cwd: '/w',
    passive: true,
    replaceToken: a2,
    registrationId: 'reg-3',
  });
  reg.markRegistrationResponseFinished('reg-3', b2);
  assert.equal(state.registrationReplays.get('reg-3').responseFinished, true);
  assert.equal(reg.attachSse(b2, fakeRes()), true);
  assert.equal(state.registrationReplays.size, 0, 'a live stream proves the client learned its token');
  reg.stopTimers();
});

test('an unflushed registration replay expires and drops the client; a finished response keeps it', async () => {
  const { reg, state, logs } = registry({ ttl: 30 });
  const a = reg.registerClient({ leadPid: process.pid, cwd: '/w' });
  const b = reg.registerClient({
    leadPid: process.pid,
    cwd: '/w',
    passive: true,
    replaceToken: a,
    registrationId: 'reg-4',
  });
  const c = reg.registerClient({ leadPid: process.pid, cwd: '/w', passive: true, registrationId: 'reg-5' });
  reg.markRegistrationResponseFinished('reg-5', c);
  await sleep(80);
  assert.equal(state.clients.has(b), false);
  assert.equal(state.clients.has(c), true);
  assert.equal(state.registrationReplays.size, 0);
  assert.ok(logs.some((line) => line.includes('unflushed registration replay expired')));
  reg.stopTimers();
});

test('attachSse flushes the pending frame, replays the sticky badge only to the pointer, and stream loss arms grace', async () => {
  const fired = [];
  const { reg, state, logs, published } = registry({ clientGraceMs: 20, onClientsEmpty: () => fired.push(1) });
  const a = reg.registerClient({ leadPid: process.pid, cwd: '/w' });
  const b = reg.registerClient({ leadPid: process.pid, cwd: '/w' });
  state.pointerToken = a;
  state.clients.get(a).pendingRemoteStateFrame = 'pending-frame';
  state.stickyRemoteFrame = 'sticky';

  const res = fakeRes();
  assert.equal(reg.attachSse(a, res), true);
  assert.equal(res.head.status, 200);
  assert.match(res.head.headers['Content-Type'], /text\/event-stream/);
  assert.deepEqual(res.writes, [': attached\n\n', 'data: pending-frame\n\n', 'data: sticky\n\n']);
  assert.equal(state.clients.get(a).sse, res);
  assert.equal(state.clients.get(a).pendingRemoteStateFrame, null);

  const res2 = fakeRes();
  reg.attachSse(b, res2);
  assert.deepEqual(res2.writes, [': attached\n\n']);
  assert.equal(reg.attachSse('nope', fakeRes()), false);

  res.emit('close');
  assert.equal(state.clients.get(a).sse, null);
  await sleep(50);
  assert.deepEqual(fired, [], 'stream loss alone never shuts the daemon down');

  reg.dropClient(a, 'test');
  reg.dropClient(b, 'test');
  assert.equal(state.pointerToken, null);
  assert.equal(published.length, 2);
  assert.equal(res2.ended, true, 'dropping a client ends its stream');
  await sleep(60);
  assert.deepEqual(fired, [1]);
  assert.ok(logs.some((line) => line.includes('client grace elapsed')));
  reg.stopTimers();
});

test('resolveTarget returns the live pointer client and clears a dead or unknown one', () => {
  const { reg, state, logs } = registry();
  const a = reg.registerClient({ leadPid: process.pid, cwd: '/w' });
  state.pointerToken = a;
  assert.equal(reg.resolveTarget(), state.clients.get(a));

  state.pointerToken = 'ghost';
  assert.equal(reg.resolveTarget(), null);
  assert.equal(state.pointerToken, null);

  const dead = reg.registerClient({ leadPid: DEAD_PID, cwd: '/w' });
  state.pointerToken = dead;
  assert.equal(reg.resolveTarget(), null);
  assert.equal(state.clients.has(dead), false);
  assert.ok(logs.some((line) => line.includes('pid dead (notify-time)')));
  reg.stopTimers();
});
