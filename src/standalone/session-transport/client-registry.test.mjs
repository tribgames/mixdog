import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientRegistry } from './client-registry.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// No process owns this pid on any supported platform's default pid range.
const DEAD_PID = 4_000_000;

function harness(overrides = {}) {
  const log = [];
  const events = { registered: [], dropped: [], empty: 0 };
  const registry = createClientRegistry({
    log: (line) => log.push(line),
    nowMs: () => 1_000,
    clientGraceMs: 30,
    sweepMs: 20,
    onClientsEmpty: () => {
      events.empty += 1;
    },
    onClientRegistered: (info) => events.registered.push(info),
    onClientDropped: (token, reason) => events.dropped.push({ token, reason }),
    ...overrides,
  });
  return { registry, log, events };
}

test('register records identity, notifies, and replays the same registration id', () => {
  const { registry, events } = harness();
  try {
    const body = { leadPid: process.pid, cwd: 'C:/work', registrationId: 'reg-1', clientKind: 'desktop', revision: 2 };
    const token = registry.register(body);
    assert.equal(registry.register(body), token, 'same identity replays the token');
    assert.equal(registry.clients.size, 1);
    assert.deepEqual(registry.clients.get(token).pending, new Map());
    assert.equal(registry.clients.get(token).lastSeen, 1_000);
    assert.deepEqual(events.registered, [
      { token, leadPid: process.pid, cwd: 'C:/work', lifecycle: true, clientKind: 'desktop' },
    ]);
    assert.throws(
      () => registry.register({ ...body, cwd: 'D:/other' }),
      (error) => error.statusCode === 409 && /identity mismatch/.test(error.message)
    );
    registry.forgetReplaysFor(token);
    const fresh = registry.register(body);
    assert.notEqual(fresh, token, 'a forgotten replay creates a fresh client');
    assert.equal(registry.lifecycleClientCount(), 2);
  } finally {
    registry.close();
  }
});

test('dropping the last lifecycle client arms the grace timer once and signals shutdown', async () => {
  const { registry, events, log } = harness();
  try {
    const token = registry.register({ leadPid: process.pid, cwd: null });
    registry.register({ leadPid: process.pid, cwd: null, lifecycle: false });
    registry.dropClient(token, 'test drop');
    assert.deepEqual(events.dropped, [{ token, reason: 'test drop' }]);
    assert.equal(registry.lifecycleClientCount(), 0, 'the non-lifecycle client does not hold the daemon');
    registry.maybeArmGrace('sweep');
    await sleep(80);
    assert.equal(events.empty, 1, 'one grace timer fires even when re-armed by the sweep');
    assert.ok(log.some((line) => line.includes('signalling shutdown')));
  } finally {
    registry.close();
  }
});

test('the sweep drops clients whose lead pid is gone and a new lifecycle client cancels grace', async () => {
  const { registry, events } = harness();
  try {
    const dead = registry.register({ leadPid: DEAD_PID, cwd: null });
    await sleep(50);
    assert.deepEqual(events.dropped, [{ token: dead, reason: 'lead pid gone' }]);
    registry.register({ leadPid: process.pid, cwd: null });
    await sleep(60);
    assert.equal(events.empty, 0, 'a live lifecycle client keeps the daemon up');
  } finally {
    registry.close();
  }
});

test('close ends every stream, forgets replays and never fires grace afterwards', async () => {
  const { registry, events } = harness();
  let ended = 0;
  const token = registry.register({ leadPid: process.pid, cwd: null, registrationId: 'reg-close' });
  registry.clients.get(token).sse = {
    end: () => {
      ended += 1;
    },
  };
  registry.close();
  assert.equal(ended, 1);
  assert.equal(registry.clients.size, 0);
  await sleep(60);
  assert.equal(events.empty, 0);
});
