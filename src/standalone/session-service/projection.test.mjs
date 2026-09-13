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
    runtime: { getState: () => { throw new Error('state unavailable'); } },
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
