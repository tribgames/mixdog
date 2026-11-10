// A terminal call the core never answers fails on the phone as Node's page failed it (apps/mobile/fixtures/call-timeout/golden.json,
// recorded by benchmarks/rust-core/recorders/record-call-timeout.mjs from Node's call deadline): the connection is probed when Node probed it,
// and the call fails when Node's failed, with Node's error text. Time is a clock that moves only to the next timer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adapter as terminalAdapter } from './remote-protocol-terminal.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/call-timeout/golden.json', import.meta.url), 'utf8'));

test("a core call that is never answered fails with Node's text after Node's probe", async (t) => {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  globalThis.window = {
    setTimeout: (callback, ms) => (timers.set(nextTimer, { at: clock + ms, callback }), nextTimer++),
    clearTimeout: (id) => void timers.delete(id),
  };
  const realNow = Date.now;
  Date.now = () => clock;
  t.after(() => {
    Date.now = realNow;
    delete globalThis.window;
  });
  const steps = [];
  let sentAt = null;
  // The core: the request leaves (its frame is handed on) and no answer ever comes.
  const client = {
    call: (_method, _params, options) => {
      sentAt = clock;
      options?.sent?.(Promise.resolve());
      return new Promise(() => {});
    },
  };
  const host = { ctx: { phone: {} }, client: () => client, declareLane() {} };
  const router = createProtocolRouter([terminalAdapter], {
    host,
    started: async () => {},
    synced: async () => {},
    probe: () => steps.push({ probe: clock - sentAt }),
    silentSince: () => false,
  });
  let failure = null;
  router.call('termProfiles', []).catch((error) => (failure = { error: error.message, at: clock - sentAt }));
  // The call reaches the core and its frame leaves before any timer is due.
  for (let turn = 0; turn < 100 && sentAt === null; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(sentAt, null, `the call had not reached the core after 100 turns; timers pending: ${timers.size}`);
  await new Promise((resolve) => setImmediate(resolve));
  // Node's deadline fires a handful of timers (golden.steps); a timer that keeps re-arming itself is a failure, not a longer wait.
  const ROUNDS = 100;
  for (let round = 0; failure === null && timers.size > 0; round += 1) {
    if (round === ROUNDS) {
      const pending = [...timers.values()].map((timer) => `at ${timer.at - sentAt} ms`).join(', ');
      assert.fail(`the call had not failed after ${ROUNDS} timer rounds; still pending: ${pending}; probes so far: ${JSON.stringify(steps)}`);
    }
    const [id, next] = [...timers].reduce((a, b) => (b[1].at < a[1].at ? b : a));
    timers.delete(id);
    clock = next.at;
    next.callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waits = golden.steps.filter((step) => 'wait' in step).reduce((sum, step) => sum + step.wait, 0);
  assert.deepEqual(
    { steps, failure },
    { steps: golden.steps.filter((step) => 'probe' in step), failure: { error: golden.error, at: waits } }
  );
});
