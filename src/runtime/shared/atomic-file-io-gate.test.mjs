import assert from 'node:assert/strict';
import test from 'node:test';

import { _fileIoGateForTest } from './atomic-file.mjs';

const gate = _fileIoGateForTest();

// One gated write that takes `wallMs` of wall time, `loopBusyMs` of which the
// loop was busy running other work (simulated; no real sleep).
function createSimulation() {
  const clock = { t: 0, busy: 0 };
  gate.setClock({ now: () => clock.t, loopActiveMs: () => clock.busy });
  gate.reset();
  return async function write(wallMs, loopBusyMs = 0) {
    await gate.run(async () => {
      clock.t += wallMs;
      clock.busy += loopBusyMs;
    });
    // The gate settles its accounting in its own finally.
    await new Promise((resolve) => setImmediate(resolve));
  };
}

test.afterEach(() => {
  gate.setClock(null);
  gate.reset();
});

test('writes slow only through event-loop lag never lower the limit', async () => {
  const write = createSimulation();
  for (let i = 0; i < 20; i += 1) {
    await write(1_000, 990);
    assert.ok(gate.limit() >= gate.startLimit, `limit ${gate.limit()} after lag-only write ${i}`);
  }
});

test('writes whose I/O itself is slow lower the limit, never below the floor', async () => {
  const write = createSimulation();
  await write(400, 0);
  assert.equal(gate.limit(), Math.max(gate.floor, Math.ceil(gate.startLimit / 2)));
  // Slow I/O inside a busy loop still counts by its excess over the lag.
  for (let i = 0; i < 10; i += 1) await write(1_500, 1_000);
  assert.equal(gate.limit(), gate.floor);
});

// Fast writes it takes to climb from `from` to `to`: four per slot of the limit, per step.
function fastWritesToClimb(from, to) {
  let writes = 0;
  for (let limit = from; limit < to; limit += 1) writes += limit * 4;
  return writes;
}

test('the limit recovers to its start once the slowness ends, a step per run of fast writes', async () => {
  const write = createSimulation();
  for (let i = 0; i < 5; i += 1) await write(400, 0);
  assert.equal(gate.limit(), gate.floor);
  const needed = fastWritesToClimb(gate.floor, gate.startLimit);
  for (let i = 0; i < needed - 1; i += 1) await write(5, 0);
  assert.ok(gate.limit() < gate.startLimit, 'one fast write short of the start');
  await write(5, 0);
  assert.equal(gate.limit(), gate.startLimit);
});

test('a write the busy loop may explain restores the start limit but never raises it further', async () => {
  const write = createSimulation();
  // 400 ms of wall time, 390 ms of it with the loop busy: a fast disk behind
  // the loop, or a slow one the loop hid.
  for (let i = 0; i < 200; i += 1) await write(400, 390);
  assert.equal(gate.limit(), gate.startLimit, 'no evidence: the start limit holds');
  for (let i = 0; i < 5; i += 1) await write(400, 0);
  assert.equal(gate.limit(), gate.floor);
  for (let i = 0; i < 200; i += 1) await write(400, 390);
  assert.equal(gate.limit(), gate.startLimit, 'back to the start, not above it');
});

test('a slow write between fast ones restarts the climb', async () => {
  const write = createSimulation();
  for (let i = 0; i < 5; i += 1) await write(400, 0);
  const needed = fastWritesToClimb(gate.floor, gate.floor + 1);
  for (let i = 0; i < needed - 1; i += 1) await write(5, 0);
  await write(100, 0);
  for (let i = 0; i < needed - 1; i += 1) await write(5, 0);
  assert.equal(gate.limit(), gate.floor);
});
