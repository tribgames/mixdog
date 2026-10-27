import assert from 'node:assert/strict';
import test from 'node:test';

import { createIceService, requestIceServers } from '../../../relay/lib/ice-legs.mjs';
import { turnConfigFromEnv, verifyTurnCredential } from '../../../relay/lib/turn-credentials.mjs';
import { MAX_ICE_SERVERS, MAX_ICE_URLS } from '../shared/remote-webrtc.ts';
import {
  ICE_ALLOCATION_LIFETIME_MS,
  bindRemoteIceServers,
  createRemoteIceServers,
  refreshMarginMs,
  resolveRemoteIceServers,
} from './remote-ice-servers.ts';
import { createRelayConnectionCaps } from './remote-relay-capabilities.ts';
import { createRelayControlRequests } from './remote-relay-control.ts';

const SECRET = 'd'.repeat(64);
const STUN = 'stun:relay.example.com:3478';
const START = 1_000_000;
const DAY_MS = 86_400_000;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** What the relay sends (the relay's own handler, so the wire shape this module
 *  reads is the one the relay writes). `nowMs` is the RELAY's clock at issue;
 *  `issueLimit: 1` makes the second answer a rate-limit refusal. */
function relayAnswer({ paired = true, nowMs = START, issueLimit = 100, again = false } = {}) {
  const sent = [];
  const config = turnConfigFromEnv({
    TURN_AUTH_SECRET: SECRET,
    TURN_HOST: 'relay.example.com',
    TURN_TLS_PORT: '5349',
    TURN_ISSUE_LIMIT: String(issueLimit),
  });
  const leg = {
    ice: createIceService(config, { now: () => nowMs, log: () => {} }),
    store: { listClients: () => (paired ? [{ id: 'phone' }] : []) },
    deviceId: 'device-a',
    socket: {},
    sendJson: (_socket, payload) => sent.push(payload),
  };
  requestIceServers(leg, { requestId: id(1) });
  if (again) requestIceServers(leg, { requestId: id(2) });
  return sent.at(-1);
}

/** Two clocks the test moves independently. `advance` is time passing;
 *  `suspend` is the machine asleep (wall moves, monotonic does not); `setWall`
 *  is someone changing the system clock. */
function clocks() {
  const state = { monotonic: 5_000, wall: START };
  return {
    clock: { monotonicMs: () => state.monotonic, wallMs: () => state.wall },
    advance: (ms) => {
      state.monotonic += ms;
      state.wall += ms;
    },
    suspend: (ms) => {
      state.wall += ms;
    },
    setWall: (delta) => {
      state.wall += delta;
    },
  };
}

function harness({ answers = [relayAnswer()] } = {}) {
  const time = clocks();
  const calls = [];
  const queue = [...answers];
  const servers = createRemoteIceServers({
    clock: time.clock,
    request: () => {
      calls.push(true);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  });
  return { servers, time, calls };
}

const turnEntry = (list) => list.find((server) => server.username);

test('the margin is derived: one coturn allocation lifetime, capped at half the credential life', () => {
  assert.equal(ICE_ALLOCATION_LIFETIME_MS, 3_600_000);
  assert.equal(refreshMarginMs(DAY_MS), 3_600_000);
  assert.equal(refreshMarginMs(7_200_000), 3_600_000);
  assert.equal(refreshMarginMs(1_200_000), 600_000);
});

test('STUN and TURN (udp, tcp, tls) come from the relay, with a verifiable fresh credential', async () => {
  const { servers, calls } = harness();
  const list = await servers.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(list[0], { urls: [STUN] });
  const turn = turnEntry(list);
  assert.deepEqual(turn.urls, [
    'turn:relay.example.com:3478?transport=udp',
    'turn:relay.example.com:3478?transport=tcp',
    'turns:relay.example.com:5349?transport=tcp',
  ]);
  assert.equal(
    verifyTurnCredential({ secret: SECRET, username: turn.username, credential: turn.credential, nowMs: START }),
    true
  );
});

test('a credential is cached until the margin before it expires, then renewed', async () => {
  const { servers, time, calls } = harness({
    answers: [relayAnswer(), relayAnswer({ nowMs: START + DAY_MS - 3_600_000 })],
  });
  const first = await servers.resolve();
  time.advance(DAY_MS - 3_600_000 - 1);
  assert.deepEqual(await servers.resolve(), first);
  assert.equal(calls.length, 1, 'served from cache one millisecond before the margin');
  time.advance(1);
  const renewed = await servers.resolve();
  assert.equal(calls.length, 2, 'refreshed at the margin');
  assert.notEqual(turnEntry(renewed).username, turnEntry(first).username);
});

test('the lifetime is what the relay says remains after flooring the expiry, to the millisecond', async () => {
  // Issued 999 ms into a second: the credential lives 86 399 001 ms, not 86 400 000.
  const answer = relayAnswer({ nowMs: START + 999 });
  assert.equal(answer.remainingMs, DAY_MS - 999);
  const { servers, time, calls } = harness({ answers: [answer, new Error('relay unreachable')] });
  const first = await servers.resolve();
  const refreshAfter = DAY_MS - 999 - 3_600_000;
  time.advance(refreshAfter - 1);
  assert.deepEqual(await servers.resolve(), first);
  assert.equal(calls.length, 1);
  time.advance(1);
  assert.deepEqual(await servers.resolve(), first, 'refresh attempted (and failed); the credential is still valid');
  assert.equal(calls.length, 2);
  // Valid to its real end: the last millisecond before DAY_MS - 999 serves it, the next does not.
  time.advance(3_600_000 - 1);
  assert.deepEqual(await servers.resolve(), first);
  time.advance(1);
  assert.deepEqual(await servers.resolve(), [{ urls: [STUN] }], 'the flooring cost 999 ms of validity');
});

test('setting the PC clock back cannot extend a credential', async () => {
  const { servers, time, calls } = harness({ answers: [relayAnswer(), new Error('relay unreachable')] });
  const first = await servers.resolve();
  time.advance(DAY_MS - 3_600_000 - 1);
  time.setWall(-12 * 3_600_000);
  assert.deepEqual(await servers.resolve(), first);
  assert.equal(calls.length, 1);
  time.advance(1);
  await servers.resolve();
  assert.equal(calls.length, 2, 'the monotonic clock still reaches the refresh point');
  // And the credential's end is the monotonic one too: a day after issue,
  // though the wall clock says half a day is still left.
  time.advance(3_600_000);
  assert.deepEqual(await servers.resolve(), [{ urls: [STUN] }]);
});

test('time the machine spends asleep or a clock moved forward ages a credential at least as much', async () => {
  const slept = harness({ answers: [relayAnswer(), new Error('relay unreachable')] });
  const first = await slept.servers.resolve();
  slept.time.advance(1_000);
  slept.time.suspend(DAY_MS - 3_600_000 - 1_000 - 1);
  assert.deepEqual(await slept.servers.resolve(), first, 'one millisecond short of the margin on the wall clock');
  assert.equal(slept.calls.length, 1);
  slept.time.suspend(1);
  await slept.servers.resolve();
  assert.equal(slept.calls.length, 2, 'the wall clock reached the refresh point while the monotonic one had not');
  slept.time.suspend(3_600_000);
  assert.deepEqual(await slept.servers.resolve(), [{ urls: [STUN] }], 'and expiry follows the wall clock too');
});

test('a failed refresh keeps serving the credential only while it is still valid, then falls back to STUN', async () => {
  const { servers, time, calls } = harness({ answers: [relayAnswer(), new Error('Relay device request timed out.')] });
  const first = await servers.resolve();
  time.advance(DAY_MS - 3_600_000);
  assert.deepEqual(await servers.resolve(), first, 'refresh failed; the unexpired credential is still handed out');
  assert.equal(calls.length, 2);
  time.advance(3_600_000);
  assert.deepEqual(await servers.resolve(), [{ urls: [STUN] }]);
  assert.equal(JSON.stringify(await servers.resolve()).includes('credential'), false);
});

test('invalidate (OS suspend/resume) drops the cached credential and any rate-limit wait', async () => {
  const cached = harness({ answers: [relayAnswer(), relayAnswer({ nowMs: START + 2_000 })] });
  const first = await cached.servers.resolve();
  cached.servers.invalidate();
  const second = await cached.servers.resolve();
  assert.equal(cached.calls.length, 2);
  assert.notEqual(turnEntry(second).username, turnEntry(first).username);

  const limited = harness({ answers: [relayAnswer({ issueLimit: 1, again: true }), relayAnswer()] });
  assert.deepEqual(await limited.servers.resolve(), [{ urls: [STUN] }]);
  limited.servers.invalidate();
  assert.equal(turnEntry(await limited.servers.resolve()) !== undefined, true, 'the wait was counted across a sleep');
});

test('a sleep that both clocks undercount (monotonic paused, wall set back) is caught by the OS event', async () => {
  const { servers, time, calls } = harness({ answers: [relayAnswer(), relayAnswer({ nowMs: START + 2_000 })] });
  const first = await servers.resolve();
  time.suspend(DAY_MS); // asleep for a day: the wall clock moves, the monotonic one does not
  time.setWall(-DAY_MS); // and the wall clock is then set back
  assert.deepEqual(await servers.resolve(), first, 'the clocks alone see no time pass');
  assert.equal(calls.length, 1);
  servers.invalidate(); // powerMonitor said the machine slept
  const renewed = await servers.resolve();
  assert.equal(calls.length, 2);
  assert.notEqual(turnEntry(renewed).username, turnEntry(first).username);
});

test('an answer still pending when the machine suspends is worthless when it lands', async () => {
  const time = clocks();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const servers = createRemoteIceServers({
    clock: time.clock,
    request: () => {
      calls += 1;
      return calls === 1 ? gate : Promise.resolve(relayAnswer({ nowMs: START + 9 }));
    },
  });
  const pending = servers.resolve();
  servers.invalidate(); // suspend
  release(relayAnswer()); // the answer from before the sleep arrives after wake
  assert.deepEqual(await pending, [], 'no credential is handed out, and none is cached');
  const next = await servers.resolve();
  assert.equal(calls, 2, 'the next caller asks afresh');
  assert.equal(turnEntry(next) !== undefined, true);
});

test('an answer that lands after its life (no event reported a sleep) is checked against the clocks before it is returned', async () => {
  const lands = async (afterMs) => {
    const time = clocks();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const servers = createRemoteIceServers({
      clock: time.clock,
      request: () => {
        calls += 1;
        return calls === 1 ? gate : Promise.resolve(relayAnswer({ nowMs: START + 9 }));
      },
    });
    const pending = servers.resolve();
    time.advance(afterMs);
    release(relayAnswer());
    return { result: await pending, servers, next: () => servers.resolve(), calls: () => calls };
  };
  const refreshAfter = DAY_MS - 3_600_000;
  const fresh = await lands(refreshAfter - 1);
  assert.equal(turnEntry(fresh.result) !== undefined, true, 'one millisecond inside the servable window');
  assert.equal(fresh.calls(), 1);
  const stale = await lands(refreshAfter);
  assert.deepEqual(
    stale.result,
    [{ urls: [STUN] }],
    'at the margin the credential is dropped; its STUN URL is not secret'
  );
  assert.equal(turnEntry(await stale.next()) !== undefined, true, 'and it was not cached: the next caller asks afresh');
  assert.equal(stale.calls(), 2);
  const expired = await lands(DAY_MS + 1);
  assert.deepEqual(expired.result, [{ urls: [STUN] }]);
});

test('when the relay cannot issue the list degrades to STUN, then to empty, and never throws', async () => {
  const unpaired = harness({ answers: [relayAnswer({ paired: false })] });
  assert.deepEqual(await unpaired.servers.resolve(), [{ urls: [STUN] }]);

  const offline = harness({ answers: [new Error('Relay is not connected.')] });
  assert.deepEqual(await offline.servers.resolve(), []);

  const throwing = createRemoteIceServers({
    request: () => {
      throw new TypeError('synchronous failure');
    },
  });
  assert.deepEqual(await throwing.resolve(), []);
});

test("the only wait is the one the relay names: a rate limit's retryAfterMs, from the monotonic or the wall clock", async () => {
  const limited = relayAnswer({ issueLimit: 1, again: true });
  assert.equal(limited.error, 'rate-limited');
  assert.ok(limited.retryAfterMs > 0);
  const { servers, time, calls } = harness({ answers: [limited, relayAnswer()] });
  assert.deepEqual(await servers.resolve(), [{ urls: [STUN] }]);
  assert.equal(calls.length, 1);
  time.advance(limited.retryAfterMs - 1);
  time.setWall(-DAY_MS);
  assert.deepEqual(await servers.resolve(), [{ urls: [STUN] }]);
  assert.equal(calls.length, 1, 'no request inside the wait, whatever the wall clock says');
  time.advance(1);
  assert.equal(turnEntry(await servers.resolve()) !== undefined, true);
  assert.equal(calls.length, 2, 'asked again as soon as the relay said it would answer');

  const slept = harness({ answers: [limited, relayAnswer()] });
  await slept.servers.resolve();
  slept.time.suspend(limited.retryAfterMs);
  await slept.servers.resolve();
  assert.equal(slept.calls.length, 2, 'time asleep counts towards the wait');
});

test('refusals and failures that name no wait are not held back', async () => {
  // Unpaired: the state can change at any moment (a phone pairs), and the answer is cheap.
  const unpaired = harness({ answers: [relayAnswer({ paired: false }), relayAnswer()] });
  assert.deepEqual(await unpaired.servers.resolve(), [{ urls: [STUN] }]);
  assert.equal(turnEntry(await unpaired.servers.resolve()) !== undefined, true);
  assert.equal(unpaired.calls.length, 2);
  // Rate-limited without a retryAfterMs: nothing to follow, nothing invented.
  const { retryAfterMs: _wait, ...bare } = relayAnswer({ issueLimit: 1, again: true });
  const noWait = harness({ answers: [bare, relayAnswer()] });
  await noWait.servers.resolve();
  assert.equal(turnEntry(await noWait.servers.resolve()) !== undefined, true);
  assert.equal(noWait.calls.length, 2);
  // A timeout: the next caller asks again.
  const timeout = harness({ answers: [new Error('timed out'), relayAnswer()] });
  assert.deepEqual(await timeout.servers.resolve(), []);
  assert.equal(turnEntry(await timeout.servers.resolve()) !== undefined, true);
  assert.equal(timeout.calls.length, 2);
});

test('a relay that offers no issuance is not a failure: asked again next time, nothing served', async () => {
  const { servers, calls } = harness({ answers: [null] });
  assert.deepEqual(await servers.resolve(), []);
  assert.deepEqual(await servers.resolve(), []);
  assert.equal(calls.length, 2);
});

test('malformed answers are refused whole', async () => {
  const good = relayAnswer();
  const turn = good.servers[1];
  const bad = [
    { ...good, ok: false },
    { ...good, ttlSeconds: 0 },
    { ...good, ttlSeconds: '86400' },
    { ...good, remainingMs: undefined },
    { ...good, remainingMs: 0 },
    { ...good, remainingMs: -1 },
    { ...good, remainingMs: '86400000' },
    { ...good, remainingMs: Number.POSITIVE_INFINITY },
    { ...good, remainingMs: DAY_MS + 1 },
    { ...good, servers: [] },
    { ...good, servers: 'turn:x' },
    { ...good, servers: [{ urls: ['http://example.com'] }] },
    { ...good, servers: [{ urls: 'stun:x:3478' }] },
    { ...good, servers: [{ urls: [turn.urls[0]] }] },
    { ...good, servers: [{ urls: [turn.urls[0]], username: turn.username }] },
    { ...good, servers: [{ urls: [STUN], username: 'u', credential: 'c' }, turn] },
    { ...good, servers: [{ urls: [STUN] }, { ...turn, credential: '' }] },
    { ...good, servers: Array.from({ length: MAX_ICE_SERVERS + 1 }, () => ({ urls: [STUN] })) },
    { ...good, servers: [{ urls: Array.from({ length: MAX_ICE_URLS + 1 }, () => STUN) }] },
    { ...good, servers: [null, turn] },
  ];
  for (const answer of bad) {
    const { servers } = harness({ answers: [answer] });
    assert.deepEqual(await servers.resolve(), [], JSON.stringify(answer).slice(0, 120));
  }
  // The contract's own maxima are accepted.
  const maxima = {
    ...good,
    servers: Array.from({ length: MAX_ICE_SERVERS }, () => ({
      urls: Array.from({ length: MAX_ICE_URLS }, () => STUN),
    })),
  };
  assert.equal((await harness({ answers: [maxima] }).servers.resolve()).length, MAX_ICE_SERVERS);
});

test('concurrent callers share one request and each get their own copy', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const servers = createRemoteIceServers({
    request: async () => {
      requests += 1;
      await gate;
      return relayAnswer();
    },
  });
  const [a, b] = [servers.resolve(), servers.resolve()];
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(requests, 1);
  assert.deepEqual(first, second);
  first[0].urls.push('stun:evil.example:1');
  turnEntry(first).credential = 'tampered';
  assert.deepEqual(await servers.resolve(), second);
});

test('resolveRemoteIceServers reads the bound relay client and is empty without one', async () => {
  assert.deepEqual(await resolveRemoteIceServers(), []);
  const bound = createRemoteIceServers({ request: () => Promise.resolve(relayAnswer()) });
  const unbind = bindRemoteIceServers(bound);
  assert.equal(turnEntry(await resolveRemoteIceServers()) !== undefined, true);
  const replacement = createRemoteIceServers({ request: () => Promise.resolve(relayAnswer()) });
  const unbindReplacement = bindRemoteIceServers(replacement);
  unbind();
  assert.equal(
    turnEntry(await resolveRemoteIceServers()) !== undefined,
    true,
    'a stale client cannot detach its successor'
  );
  unbindReplacement();
  assert.deepEqual(await resolveRemoteIceServers(), []);
});

test('the relay leg: ice-servers answers settle the request whole, and `ice: 1` is a per-connection capability', async () => {
  const sent = [];
  const control = createRelayControlRequests({ sendEnvelope: (payload) => sent.push(payload), connected: () => true });
  const pending = control.request('ice-servers-request');
  assert.equal(sent[0].type, 'ice-servers-request');
  const refusal = { type: 'ice-servers', requestId: sent[0].requestId, ok: false, error: 'not-paired', stun: [STUN] };
  assert.equal(control.settle(refusal), true);
  assert.deepEqual(await pending, refusal);

  const caps = createRelayConnectionCaps({
    clientCount: () => 0,
    broadcastEncrypted: () => {},
    rebindNativePush: () => {},
  });
  assert.equal(caps.relayIce(), false);
  caps.handleRelayCapabilities({ type: 'relay-capabilities', ice: 1 });
  assert.equal(caps.relayIce(), true);
  caps.handleRelayCapabilities({ type: 'relay-capabilities' });
  assert.equal(caps.relayIce(), false);
  caps.handleRelayCapabilities({ type: 'relay-capabilities', ice: 1 });
  caps.resetRelayConnectionCaps();
  assert.equal(caps.relayIce(), false);
});
