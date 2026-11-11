#!/usr/bin/env node
// openai-ws-connect.test.mjs (5 tests): the real `openHedged` (stuck-upgrade hedge, HTTP status ends the race, acquire deadline), the real
// `cachedLookup` (shared DNS resolution) and the real WebSocket pool `acquireWebSocket` / `releaseWebSocket` (sessionless sends share idle
// sockets) over fake sockets. The race timers run on the virtual clock: every step (`advanceMs`) is an input, a leg that never opens is a
// promise rejected only by its abort signal.
//   node benchmarks/rust-core/recorders/record-openai-ws-connect.mjs --tree <exact export of b6f10295a>
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-connect',
  net: false,
  entry: 'openai-ws-pool.mjs acquireWebSocket / releaseWebSocket (with openai-ws-connect.mjs openHedged inside, over the real ws client) against a loopback WebSocket server (lib/ws-world.mjs): a stuck upgrade is an upgrade request the server never answers; the hedge (3000 ms) and acquire deadline (15000 ms) run on the virtual clock, each step waiting for the dial it causes. The concurrent-lookup case opens 20 sockets through the provider with the dial honouring the client lookup function (world.honorLookup), so cachedLookup runs over the scripted dns.lookup. Not run: a live endpoint, a proxy.',
  compare: 'mixdog-ai providers::openai pool.rs (:178-230 sessionless sockets), transport/ws.rs connect (:280-288 lookup): serve each case\'s `input.answers` per upgrade request and compare the ordered `events` (dial, upgrade request with every header, response or refusal, closes), the clock steps and the outcome (entry or error whole).',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai WsPool::checkout (openai/pool.rs:178) and mixdog_ai::transport::ws::connect (transport/ws.rs:237). There is no hedge or acquire deadline and no shared DNS resolution in Rust (K1 G6, G15): work for the Rust side.",
  exclusions: ['the ONE scripted seam below the product in the concurrent-lookups-share-one-resolution case is node:dns `lookup`: it is replaced before the product loads, answers fixed addresses ([127.0.0.1 v4, ::1 v6]) and every call is recorded (hostname, options) in `result.resolverCalls`, in order; the operating system resolver is the outside world, like the socket; everything above it (cachedLookup, the pool, the ws client) is the product code', 'the server answers upgrade request n with input.answers[n-1] (null = never answered, absent = accepted); the 1006/terminate conventions are those of lib/ws-world.mjs'],
});
const P = 'agent/orchestrator/providers/';
// The product resolves names with node:dns `lookup` (bound at import). The recorder installs a SCRIPTED resolver before the product loads - never this PC's DNS: `localhost` answers the
// recorded addresses, every call is counted and recorded as an input of the case.
const SCRIPTED_ADDRESSES = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
const dnsCalls = [];
dns.lookup = (hostname, options, callback) => {
  dnsCalls.push({ hostname, options });
  process.nextTick(() => callback(null, SCRIPTED_ADDRESSES.map((a) => ({ ...a }))));
};
syncBuiltinESMExports();
const { cachedLookup, openHedged, _clearConnectCachesForTest } = await rec.P(`${P}openai-ws-connect.mjs`);
const { acquireWebSocket, releaseWebSocket, _clearWebSocketPoolForTest } = await rec.raw(`${P}openai-ws-pool.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-connect.test.mjs';

const world = await rec.wsWorld();
const AUTH = { type: 'openai-oauth', access_token: 'fixture-access-token', account_id: 'acct-fixture' };
const ACQUIRE = { auth: AUTH, poolKey: '', cacheKey: 'ws-connect-test', forceFresh: true };
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const upgrades = () => world.count((e) => e.event === 'upgrade-request');
const snapshot = () => world.trace.map((e) => ({ ...e }));
// The provider's real connect (acquireWebSocket -> openHedged over the real ws client) against the loopback server: the first upgrade request is
// left unanswered (a stuck upgrade); the hedge timer (3000 ms of the virtual clock) starts the next leg, which the server answers as the script says.
const hedgeCase = async (answers) => {
  world.reset({ refuse: (_req, n) => (n <= answers.length ? answers[n - 1] : null) });
  const race = settle(acquireWebSocket(ACQUIRE));
  await world.until(() => upgrades() >= 1, 'first upgrade request');
  await rec.clock.advance(3000, { what: 'hedge window', until: () => upgrades() >= 2 });
  const outcome = await race;
  if (outcome.value) {
    rec.describe(outcome.value.entry, { $connection: 'the provider client socket: a real WebSocket to the loopback server (its wire events are the ordered events)' });
    world.conns.at(-1)?.close?.(1000, 'recorder-end');
    await world.until((x) => x.some((e) => e.event === 'closed'), 'the recorder-end close handshake finished');
  }
  return { outcome, upgradeRequests: upgrades(), events: snapshot() };
};
await rec.run('stuck-upgrade-replaced-after-hedge-window', `${SRC}:46`, { hedgeMs: 3000, deadlineMs: 15000, answers: [null, 'accept'], advanceMs: [3000] }, () => hedgeCase([null, undefined]));
await rec.run('http-status-from-any-leg-ends-the-race', `${SRC}:64`, { hedgeMs: 3000, deadlineMs: 15000, answers: [null, { status: 429, headers: [['retry-after', '1']], bodyChunks: ['{"error":{"message":"slow down"}}'] }], advanceMs: [3000] }, () => hedgeCase([null, { status: 429, headers: [['retry-after', '1']], bodyChunks: ['{"error":{"message":"slow down"}}'] }]));
await rec.run('deadline-surfaces-acquire-timeout-when-no-leg-opens', `${SRC}:83`, { hedgeMs: 3000, deadlineMs: 15000, answers: 'every upgrade left unanswered', advanceMs: [3000, 3000, 3000, 3000, 3000] }, async () => {
  world.reset({ refuse: () => null });
  const race = settle(acquireWebSocket(ACQUIRE));
  await world.until(() => upgrades() >= 1, 'first upgrade request');
  for (let leg = 2; leg <= 5; leg += 1) await rec.clock.advance(3000, { what: `hedge leg ${leg}`, until: () => upgrades() >= leg });
  await rec.clock.advance(3000, { what: 'acquire deadline' });
  const outcome = await race;
  return { outcome, upgradeRequests: upgrades(), events: snapshot() };
});
// :94 - concurrent lookups for one host share a single resolution. The Node test calls cachedLookup 20 times; here 20 sockets are opened through the provider (acquireWebSocket -> the ws client ->
// the product DNS cache `cachedLookup` -> dns.lookup): the world honours the client's `lookup` function for this case, so the only scripted layer below the product is `dns.lookup` itself (fixed
// answers, every call recorded in order with its arguments); the 20 upgrade requests that reach the loopback server are the wire observation.
await rec.run('concurrent-lookups-share-one-resolution', `${SRC}:94`, { host: 'chatgpt.com', concurrent: 20, dnsLookupAnswer: SCRIPTED_ADDRESSES }, async () => {
  _clearConnectCachesForTest();
  _clearWebSocketPoolForTest();
  dnsCalls.length = 0;
  world.reset({});
  world.honorLookup = true;
  try {
    const sockets = await Promise.all(Array.from({ length: 20 }, () => settle(acquireWebSocket(ACQUIRE))));
    const resolverCalls = dnsCalls.map((c) => ({ ...c }));
    const opened = sockets.filter((s) => s.value).length;
    for (const s of sockets) if (s.value) rec.describe(s.value.entry, { $connection: 'the provider client socket (real WebSocket to the loopback server)' });
    for (const conn of world.conns) conn.close?.(1000, 'recorder-end');
    await world.until((x) => x.filter((e) => e.event === 'closed').length >= opened, 'every socket closed');
    return { resolverCalls, opened, errors: sockets.filter((s) => s.error).map((s) => s.error), dials: world.dials.map((d) => ({ ...d })), upgradeRequestEvents: world.trace.filter((e) => e.event === 'upgrade-request') };
  } finally {
    world.honorLookup = false;
  }
});
await rec.run('sessionless-sends-share-idle-sockets-no-owner-wait-no-chain', `${SRC}:112`, { args: { auth: { type: 'openai-direct', apiKey: 'fixture-key' }, poolKey: null, cacheKey: 'shared', codexHeaders: {} }, steps: ['two concurrent acquires', 'a.lastResponseId = resp-from-caller-a', 'release both keep', 'acquire again', 'acquire other cacheKey', 'release both without keep'] }, async () => {
  world.reset({});
  _clearWebSocketPoolForTest();
  try {
    const args = { auth: { type: 'openai-direct', apiKey: 'fixture-key' }, poolKey: null, cacheKey: 'shared', codexHeaders: {} };
    const [a, b] = await Promise.all([acquireWebSocket(args), acquireWebSocket(args)]);
    const first = { distinctEntries: a.entry !== b.entry, opened: upgrades() };
    a.entry.lastResponseId = 'resp-from-caller-a';
    releaseWebSocket({ entry: a.entry, poolKey: null, keep: true });
    releaseWebSocket({ entry: b.entry, poolKey: null, keep: true });
    const idle = { firstSocketReadyState: a.entry.socket.readyState };
    const reused = await acquireWebSocket(args);
    const second = { reused: reused.reused, opened: upgrades(), lastResponseId: reused.entry.lastResponseId };
    const otherKey = await acquireWebSocket({ ...args, cacheKey: 'other' });
    const third = { reused: otherKey.reused };
    releaseWebSocket({ entry: reused.entry, poolKey: null, keep: false });
    releaseWebSocket({ entry: otherKey.entry, poolKey: null, keep: false });
    await world.until((x) => x.filter((e) => e.event === 'closed').length >= 1, 'a socket closed after release without keep');
    return { first, idle, second, third, events: snapshot() };
  } finally {
    _clearWebSocketPoolForTest();
  }
});
await rec.finish();
