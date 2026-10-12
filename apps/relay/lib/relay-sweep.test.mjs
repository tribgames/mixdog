import assert from 'node:assert/strict';
import test from 'node:test';

import { sweepLegs } from '../server.mjs';

function leg(extra = {}) {
  const socket = {
    isAlive: true,
    pings: 0,
    terminated: false,
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated = true;
    },
    close() {},
    ...extra,
  };
  return socket;
}

test('a leg that never answers its ping is terminated on the next sweep', () => {
  const dead = leg();
  const wss = { clients: new Set([dead]) };
  sweepLegs(wss);
  assert.equal(dead.pings, 1);
  assert.equal(dead.terminated, false);
  sweepLegs(wss);
  assert.equal(dead.terminated, true);
});

test('a leg draining a queue, or paused by backpressure, gets extra windows before it is cut', () => {
  for (const busy of [{ bufferedAmount: 4096 }, { legPausedUplink: true }, { legPausedIngress: true }]) {
    const slow = leg(busy);
    const wss = { clients: new Set([slow]) };
    sweepLegs(wss);
    sweepLegs(wss);
    sweepLegs(wss);
    assert.equal(slow.terminated, false, JSON.stringify(busy));
    sweepLegs(wss);
    assert.equal(slow.terminated, true, `${JSON.stringify(busy)} is still bounded`);
  }
});

test('answering a ping restores the full grace for the next stall', () => {
  const slow = leg({ bufferedAmount: 10 });
  const wss = { clients: new Set([slow]) };
  sweepLegs(wss);
  sweepLegs(wss);
  slow.isAlive = true; // pong arrived
  sweepLegs(wss);
  sweepLegs(wss);
  sweepLegs(wss);
  assert.equal(slow.terminated, false);
});
