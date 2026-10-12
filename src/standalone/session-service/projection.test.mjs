import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionProjection } from './projection.mjs';

function fixture(overrides = {}) {
  const frames = [];
  const logs = [];
  const externalViewEntries = new Map();
  const projection = createSessionProjection({
    sessionsById: new Map(),
    externalViewEntries,
    pendingViewers: new Map([['sess_external', new Set(['viewer'])]]),
    externalSessionActions: new Set(),
    revisionEpoch: 0,
    publishIntervalMs: 1,
    onFrame: (frame) => frames.push(frame),
    log: (line) => logs.push(line),
    isClosed: () => false,
    addSubscriber() {},
    adoptPendingViewers() {},
    updateEntryBusy() {},
    releaseProjection() {},
    startEvictionSweep() {},
    onSessionLive() {},
    ...overrides,
  });
  return { projection, frames, logs, externalViewEntries };
}

test('late external state cannot create a view or publish after service closure', () => {
  const f = fixture({ isClosed: () => true });
  f.projection.publishExternalSessionState({
    sessionId: 'sess_external',
    snapshot: { sessionId: 'sess_external', items: [], queued: [] },
  });
  assert.equal(f.externalViewEntries.size, 0);
  assert.deepEqual(f.frames, []);
});

test('a failed runtime state read is logged without throwing again from the error reporter', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const entry = {
    runtime: {
      getState: () => {
        throw new Error('state unavailable');
      },
    },
    addressedSessionId: 'sess_unavailable',
    indexedSessionId: 'sess_unavailable',
    subscribers: new Set(['viewer']),
    disposed: false,
    timer: null,
  };
  f.projection.schedulePublish(entry);
  assert.doesNotThrow(() => t.mock.timers.tick(1));
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.logs, ['publish failed session=sess_unavailable: state unavailable']);
});

test('an addressed-id mismatch serves the last snapshot, logs once, and leaves other sessions readable', () => {
  const f = fixture();
  const snap = (sessionId) => ({ sessionId, items: [], queued: [] });
  const make = (id, state) => ({
    runtime: { getState: () => state, isWireSafe: true },
    addressedSessionId: id,
    indexedSessionId: id,
    publishedSnapshot: snap(id),
    revision: 5,
    subscribers: new Set(['viewer']),
    disposed: false,
    timer: null,
  });
  const bad = make('sess_a', snap('sess_heir'));
  const good = make('sess_b', snap('sess_b'));
  const before = bad.publishedSnapshot;
  const views = [bad, good, bad].map((entry) => f.projection.advance(entry));
  assert.equal(views[0].changed, false);
  assert.equal(views[0].snapshot, before);
  assert.equal(views[0].revision, 5);
  assert.equal(views[2].snapshot, before);
  assert.equal(views[1].snapshot.sessionId, 'sess_b');
  assert.deepEqual(f.logs.length, 1);
  assert.match(f.logs[0], /sess_a changed its durable address to sess_heir/);
});

test('a mismatched entry no longer makes the publish path report a failure', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const entry = {
    runtime: { getState: () => ({ sessionId: 'sess_heir', items: [], queued: [] }), isWireSafe: true },
    addressedSessionId: 'sess_a',
    indexedSessionId: 'sess_a',
    publishedSnapshot: { sessionId: 'sess_a', items: [], queued: [] },
    revision: 1,
    subscribers: new Set(['viewer']),
    disposed: false,
    timer: null,
  };
  for (let i = 0; i < 3; i += 1) {
    entry.timer = null;
    f.projection.schedulePublish(entry);
    t.mock.timers.tick(5);
  }
  assert.deepEqual(f.frames, []);
  assert.equal(f.logs.filter((line) => line.startsWith('publish failed')).length, 0);
});

test('a retention-cleared entry on an address mismatch never serves the other conversation, and other sessions still sync', () => {
  const f = fixture();
  const snap = (sessionId) => ({ sessionId, items: [], queued: [] });
  const make = (id, state, published) => ({
    runtime: { getState: () => state, isWireSafe: true },
    addressedSessionId: id,
    indexedSessionId: id,
    publishedSnapshot: published,
    revision: 5,
    subscribers: new Set(['viewer']),
    disposed: false,
    timer: null,
  });
  const cleared = make('sess_a', snap('sess_b'), undefined);
  const good = make('sess_c', snap('sess_c'), undefined);
  const steps = [cleared, good].map((entry) => f.projection.advance(entry));
  assert.equal(steps[0].changed, false);
  assert.equal(steps[0].unavailable, true);
  assert.equal(steps[0].snapshot, null);
  const body = f.projection.bodyForClient(steps[0], null);
  assert.deepEqual(body, { revision: 5, unavailable: true });
  assert.equal('full' in body, false);
  assert.equal(steps[1].changed, true);
  assert.equal(steps[1].snapshot.sessionId, 'sess_c');
});
