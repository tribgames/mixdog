#!/usr/bin/env node
// openai-ws-connect.test.mjs (5 tests): the real `openHedged` (stuck-upgrade hedge, HTTP status ends the race, acquire deadline), the real
// `cachedLookup` (shared DNS resolution) and the real WebSocket pool `acquireWebSocket` / `releaseWebSocket` (sessionless sends share idle
// sockets) over fake sockets. The race timers run on the virtual clock: every step (`advanceMs`) is an input, a leg that never opens is a
// promise rejected only by its abort signal.
//   node benchmarks/rust-core/recorders/record-openai-ws-connect.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-connect',
  net: false,
  entry: 'openai-ws-pool.mjs acquireWebSocket / releaseWebSocket (with openai-ws-connect.mjs openHedged inside, over the real ws client) against a loopback WebSocket server (lib/ws-world.mjs): a stuck upgrade is an upgrade request the server never answers; the hedge (3000 ms) and acquire deadline (15000 ms) run on the virtual clock, each step waiting for the dial it causes. cachedLookup is called directly (the host resolver). Not run: a live endpoint, a proxy.',
  compare: 'mixdog-ai providers::openai pool.rs (:178-230 sessionless sockets), transport/ws.rs connect (:280-288 lookup): serve each case\'s `input.answers` per upgrade request and compare the ordered `events` (dial, upgrade request with every header, response or refusal, closes), the clock steps and the outcome (entry or error whole).',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai WsPool::checkout (openai/pool.rs:178) and mixdog_ai::transport::ws::connect (transport/ws.rs:237). There is no hedge or acquire deadline and no shared DNS resolution in Rust (K1 G6, G15): work for the Rust side.",
  exclusions: ['the server answers upgrade request n with input.answers[n-1] (null = never answered, absent = accepted); the 1006/terminate conventions are those of lib/ws-world.mjs', 'the DNS case resolves `localhost` through the host resolver: the addresses are the recording host\'s'],
});
const P = 'agent/orchestrator/providers/';
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
await rec.run('concurrent-lookups-share-one-resolution', `${SRC}:94`, { host: 'localhost', concurrent: 20 }, async () => {
  _clearConnectCachesForTest();
  const results = await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve, reject) => cachedLookup('localhost', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))))));
  const single = await new Promise((resolve, reject) => cachedLookup('localhost', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family }))));
  return { allSameArrayInstance: results.every((addresses) => addresses === results[0]), addresses: results[0], single, singleIsFirstAddress: single.address === results[0][0].address };
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
