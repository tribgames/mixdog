import assert from 'node:assert/strict';
import test from 'node:test';

import { WAKE_GAP_MS, WAKE_POLL_MS, watchWake } from './wake-check.ts';

function rig() {
  let at = 1_000;
  let tick = () => undefined;
  const checks = [];
  const online = new Set();
  const stop = watchWake({
    check: () => checks.push(at),
    now: () => at,
    setInterval: (run) => {
      tick = run;
      return 'timer';
    },
    clearInterval: () => (tick = () => undefined),
    events: { addEventListener: (_t, run) => online.add(run), removeEventListener: (_t, run) => online.delete(run) },
  });
  return {
    checks,
    online,
    stop,
    pass: (ms) => {
      at += ms;
      return tick();
    },
  };
}

test('a clock that jumps far past the poll interval (a machine that slept) asks the core; an ordinary tick does not', () => {
  const r = rig();
  r.pass(WAKE_POLL_MS);
  r.pass(WAKE_POLL_MS + 50);
  assert.deepEqual(r.checks, []);
  r.pass(WAKE_POLL_MS + WAKE_GAP_MS + 1);
  assert.equal(r.checks.length, 1);
  r.pass(WAKE_POLL_MS);
  assert.equal(r.checks.length, 1, 'the next ordinary tick is not another wake');
});

test('the network coming back asks the core, and stopping ends both', () => {
  const r = rig();
  for (const run of r.online) run();
  assert.equal(r.checks.length, 1);
  r.stop();
  assert.equal(r.online.size, 0);
});
