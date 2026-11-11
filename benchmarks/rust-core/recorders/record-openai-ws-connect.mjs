#!/usr/bin/env node
// openai-ws-connect.test.mjs (5 tests): the real `openHedged` (stuck-upgrade hedge, HTTP status ends the race, acquire deadline), the real
// `cachedLookup` (shared DNS resolution) and the real WebSocket pool `acquireWebSocket` / `releaseWebSocket` (sessionless sends share idle
// sockets) over fake sockets. The race timers run on the virtual clock: every step (`advanceMs`) is an input, a leg that never opens is a
// promise rejected only by its abort signal.
//   node benchmarks/rust-core/recorders/record-openai-ws-connect.mjs --tree <exact export of b6f10295a>
import { EventEmitter } from 'node:events';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-connect',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-connect.mjs openHedged({ hedgeMs, deadlineMs, deadlineError, openLeg }) / cachedLookup(host, opts, cb), openai-ws-pool.mjs acquireWebSocket / releaseWebSocket with _setOpenSocketForTest opening fake sockets. `legs` log every openLeg call (the abort state of each leg is read after the race settled).',
  compare: 'mixdog-ai providers::openai (adapter.rs:476-523 one dial, pool.rs:178-230 sessionless sockets, transport/ws.rs:280-288 lookup): feed `input` (hedgeMs, deadlineMs, the scripted legs, the virtual-clock steps) and compare `result` / `error` and the recorded leg and socket states. K1 gaps G6 (no hedge, no acquire deadline) and G15 (shared DNS) are OPEN in the core, so the first three cases and the DNS case are expected to differ.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai WsPool::checkout (openai/pool.rs:178) and mixdog_ai::transport::ws::connect (transport/ws.rs:237). There is no hedge or acquire deadline and no shared DNS resolution in Rust (K1 G6, G15): work for the Rust side.",
  exclusions: ['the DNS case resolves `localhost` through the host resolver: the addresses are the recording host\'s'],
});
const P = 'agent/orchestrator/providers/';
const { cachedLookup, openHedged, _clearConnectCachesForTest } = await rec.P(`${P}openai-ws-connect.mjs`);
const { acquireWebSocket, releaseWebSocket, _clearWebSocketPoolForTest, _setOpenSocketForTest } = await rec.P(`${P}openai-ws-pool.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-connect.test.mjs';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}
const stuckLeg = (signals) => ({ externalSignal }) => new Promise((_, reject) => {
  signals.push(externalSignal);
  externalSignal.addEventListener('abort', () => reject(externalSignal.reason), { once: true });
});
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

await rec.run('stuck-upgrade-replaced-after-hedge-window', `${SRC}:46`, { hedgeMs: 30, deadlineMs: 5000, legs: ['stuck (opens only if never aborted)', 'opens at once'], advanceMs: [30] }, async () => {
  const signals = [];
  const winner = { socket: new FakeSocket() };
  let legs = 0;
  const race = settle(openHedged({ hedgeMs: 30, deadlineMs: 5000, deadlineError: () => new Error('deadline'), openLeg: (args) => { legs += 1; return legs === 1 ? stuckLeg(signals)(args) : Promise.resolve(winner); } }));
  await rec.clock.advance(30);
  const outcome = await race;
  return { opened: outcome.value === winner ? 'the winner of leg 2' : outcome, legs, stuckLegAborted: signals[0].aborted };
});
await rec.run('http-status-from-any-leg-ends-the-race', `${SRC}:64`, { hedgeMs: 20, deadlineMs: 5000, legs: ['stuck', 'rejects with httpStatus 429'], advanceMs: [20] }, async () => {
  const signals = [];
  let legs = 0;
  const limited = Object.assign(new Error('429'), { httpStatus: 429 });
  const race = settle(openHedged({ hedgeMs: 20, deadlineMs: 5000, deadlineError: () => new Error('deadline'), openLeg: (args) => { legs += 1; return legs === 1 ? stuckLeg(signals)(args) : Promise.reject(limited); } }));
  await rec.clock.advance(20);
  const outcome = await race;
  return { rejectedWithTheLegError: outcome.error === limited, error: outcome.error, legs, stuckLegAborted: signals[0].aborted };
});
await rec.run('deadline-surfaces-acquire-timeout-when-no-leg-opens', `${SRC}:83`, { hedgeMs: 20, deadlineMs: 90, legs: ['every leg stuck'], advanceMs: [90] }, async () => {
  const signals = [];
  const timeout = Object.assign(new Error('acquire timeout'), { code: 'EWSACQUIRETIMEOUT' });
  const race = settle(openHedged({ hedgeMs: 20, deadlineMs: 90, deadlineError: () => timeout, openLeg: stuckLeg(signals) }));
  await rec.clock.advance(90);
  const outcome = await race;
  return { rejectedWithTheDeadlineError: outcome.error === timeout, error: outcome.error, legs: signals.length, everyLegAborted: signals.every((signal) => signal.aborted) };
});
await rec.run('concurrent-lookups-share-one-resolution', `${SRC}:94`, { host: 'localhost', concurrent: 20 }, async () => {
  _clearConnectCachesForTest();
  const results = await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve, reject) => cachedLookup('localhost', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))))));
  const single = await new Promise((resolve, reject) => cachedLookup('localhost', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family }))));
  return { allSameArrayInstance: results.every((addresses) => addresses === results[0]), addresses: results[0], single, singleIsFirstAddress: single.address === results[0][0].address };
});
await rec.run('sessionless-sends-share-idle-sockets-no-owner-wait-no-chain', `${SRC}:112`, { args: { auth: { type: 'openai-direct', apiKey: 'k' }, poolKey: null, cacheKey: 'shared', codexHeaders: {} }, steps: ['two concurrent acquires', 'a.lastResponseId = resp-from-caller-a', 'release both keep', 'acquire again', 'acquire other cacheKey', 'release both without keep'] }, async () => {
  const opened = [];
  _clearWebSocketPoolForTest();
  _setOpenSocketForTest(async () => {
    const socket = new FakeSocket();
    opened.push(socket);
    return { socket };
  });
  try {
    const args = { auth: { type: 'openai-direct', apiKey: 'k' }, poolKey: null, cacheKey: 'shared', codexHeaders: {} };
    const [a, b] = await Promise.all([acquireWebSocket(args), acquireWebSocket(args)]);
    const first = { distinctEntries: a.entry !== b.entry, opened: opened.length };
    a.entry.lastResponseId = 'resp-from-caller-a';
    releaseWebSocket({ entry: a.entry, poolKey: null, keep: true });
    releaseWebSocket({ entry: b.entry, poolKey: null, keep: true });
    const idle = { firstSocketReadyState: opened[0].readyState };
    const reused = await acquireWebSocket(args);
    const second = { reused: reused.reused, opened: opened.length, lastResponseId: reused.entry.lastResponseId };
    const otherKey = await acquireWebSocket({ ...args, cacheKey: 'other' });
    const third = { reused: otherKey.reused };
    releaseWebSocket({ entry: reused.entry, poolKey: null, keep: false });
    releaseWebSocket({ entry: otherKey.entry, poolKey: null, keep: false });
    return { first, idle, second, third, readyStates: opened.map((socket) => socket.readyState) };
  } finally {
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest();
  }
});
await rec.finish();
