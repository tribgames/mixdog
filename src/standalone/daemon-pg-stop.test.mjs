import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createDaemonPgStop } from './daemon-pg-stop.mjs';
import { IN_TREE_DAEMON_STOP_GRACE_MS, PG_FORCED_STOP_AT_MS } from './daemon-stop-budget.mjs';

// Shutdown time is driven by mocked timers and clock: no wall-clock waits.
function mockClock(t) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => mock.timers.reset());
}
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function harness() {
  const calls = [];
  const logs = [];
  const adapter = {
    shutdownOwnedPg: async (args) => {
      calls.push(args);
      return true;
    },
  };
  return { calls, logs, log: (line) => logs.push(line), loadAdapter: async () => adapter };
}

test('the forced stop sits just before the launcher kill, derived from its grace', () => {
  assert.ok(PG_FORCED_STOP_AT_MS < IN_TREE_DAEMON_STOP_GRACE_MS);
  assert.ok(PG_FORCED_STOP_AT_MS >= IN_TREE_DAEMON_STOP_GRACE_MS - 1_000);
});

test('slow but in-budget teardown: the ordered stop drains durable writes up to the fallback point', async (t) => {
  mockClock(t);
  const h = harness();
  const pgStop = createDaemonPgStop({ ...h, stopTimeoutMs: 6_000, forcedStopAtMs: 1_000 });
  mock.timers.tick(300); // earlier teardown steps
  await pgStop.finish();
  mock.timers.tick(800); // past the fallback point: it was disarmed
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].timeoutMs, 6_000);
  assert.equal(h.calls[0].drainMs, 700, 'drains until the fallback point');
  assert.deepEqual(h.logs, ['postgres stopped']);
});

test('a slow adapter load spends the drain budget instead of extending it past the fallback point', async (t) => {
  mockClock(t);
  const h = harness();
  const adapter = await h.loadAdapter();
  const loadAdapter = () => new Promise((resolve) => setTimeout(() => resolve(adapter), 150));
  const pgStop = createDaemonPgStop({ ...h, loadAdapter, stopTimeoutMs: 6_000, forcedStopAtMs: 100 });
  const finished = pgStop.finish();
  mock.timers.tick(150); // the load outlasts the whole budget
  await finished;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].drainMs, 0, 'no drain left once the fallback point has passed');
});

test('teardown past the fallback: PG stopped once without draining, logged once, finish joins it', async (t) => {
  mockClock(t);
  const h = harness();
  const pgStop = createDaemonPgStop({ ...h, stopTimeoutMs: 6_000, forcedStopAtMs: 200 });
  mock.timers.tick(400); // teardown still running when the fallback fires
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].drainMs, 0);
  await pgStop.finish();
  assert.equal(h.calls.length, 1, 'one stop');
  assert.equal(h.logs.filter((line) => /stopping postgres before the launcher's kill/.test(line)).length, 1);
  assert.equal(h.logs.filter((line) => line === 'postgres stopped').length, 1);
});
