import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, test } from 'node:test';

import { cachedLookup, openHedged, _clearConnectCachesForTest } from './openai-ws-connect.mjs';
import {
  acquireWebSocket,
  releaseWebSocket,
  _clearWebSocketPoolForTest,
  _setOpenSocketForTest,
} from './openai-ws-pool.mjs';

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

// The race timers are unref'd (a real socket keeps the process alive); the
// fake legs here own no handle, so hold the loop open for the suite.
let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 1_000);
});
after(() => clearInterval(keepAlive));

function stuckLeg(signals) {
  return ({ externalSignal }) =>
    new Promise((_, reject) => {
      signals.push(externalSignal);
      externalSignal.addEventListener('abort', () => reject(externalSignal.reason), { once: true });
    });
}

test('a stuck upgrade is replaced after the hedge window; the stuck leg is cancelled', async () => {
  const signals = [];
  const winner = { socket: new FakeSocket() };
  let legs = 0;
  const startedAt = Date.now();
  const opened = await openHedged({
    hedgeMs: 30,
    deadlineMs: 5_000,
    deadlineError: () => new Error('deadline'),
    openLeg: (args) => {
      legs += 1;
      return legs === 1 ? stuckLeg(signals)(args) : Promise.resolve(winner);
    },
  });
  assert.equal(opened, winner);
  assert.equal(legs, 2);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(signals[0].aborted, true);
});

test('an HTTP status from any leg ends the race unchanged', async () => {
  const signals = [];
  let legs = 0;
  const limited = Object.assign(new Error('429'), { httpStatus: 429 });
  await assert.rejects(
    openHedged({
      hedgeMs: 20,
      deadlineMs: 5_000,
      deadlineError: () => new Error('deadline'),
      openLeg: (args) => {
        legs += 1;
        return legs === 1 ? stuckLeg(signals)(args) : Promise.reject(limited);
      },
    }),
    (err) => err === limited
  );
  assert.equal(signals[0].aborted, true);
});

test('the deadline surfaces the acquire timeout when no leg opens', async () => {
  const signals = [];
  const timeout = Object.assign(new Error('acquire timeout'), { code: 'EWSACQUIRETIMEOUT' });
  await assert.rejects(
    openHedged({ hedgeMs: 20, deadlineMs: 90, deadlineError: () => timeout, openLeg: stuckLeg(signals) }),
    (err) => err === timeout
  );
  assert.ok(signals.length >= 2);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('concurrent lookups for one host share a single resolution', async () => {
  _clearConnectCachesForTest();
  const results = await Promise.all(
    Array.from(
      { length: 20 },
      () =>
        new Promise((resolve, reject) =>
          cachedLookup('localhost', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
        )
    )
  );
  assert.ok(results.every((addresses) => addresses === results[0]));
  const single = await new Promise((resolve, reject) =>
    cachedLookup('localhost', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })))
  );
  assert.equal(single.address, results[0][0].address);
});

test('sessionless sends share idle sockets without owner waits or a carried chain', async (t) => {
  const opened = [];
  _clearWebSocketPoolForTest();
  _setOpenSocketForTest(async () => {
    const socket = new FakeSocket();
    opened.push(socket);
    return { socket };
  });
  t.after(() => {
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest();
  });
  const args = { auth: { type: 'openai-direct', apiKey: 'k' }, poolKey: null, cacheKey: 'shared', codexHeaders: {} };
  const [a, b] = await Promise.all([acquireWebSocket(args), acquireWebSocket(args)]);
  assert.notEqual(a.entry, b.entry);
  assert.equal(opened.length, 2);
  a.entry.lastResponseId = 'resp-from-caller-a';
  releaseWebSocket({ entry: a.entry, poolKey: null, keep: true });
  releaseWebSocket({ entry: b.entry, poolKey: null, keep: true });
  assert.equal(opened[0].readyState, 1);

  const reused = await acquireWebSocket(args);
  assert.equal(reused.reused, true);
  assert.equal(opened.length, 2);
  assert.equal(reused.entry.lastResponseId, null);

  const otherKey = await acquireWebSocket({ ...args, cacheKey: 'other' });
  assert.equal(otherKey.reused, false);
  releaseWebSocket({ entry: reused.entry, poolKey: null, keep: false });
  releaseWebSocket({ entry: otherKey.entry, poolKey: null, keep: false });
  assert.equal(opened[0].readyState === 3 || opened[1].readyState === 3, true);
});
