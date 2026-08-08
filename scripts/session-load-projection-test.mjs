// Stored-session view seam. Parity contract with codex/claude-code/opencode
// session models: LISTING is index rows, a VISIBLE stored session is a disk
// projection, and a runtime materializes only on execution (submit/action).
// A viewer that subscribed while the session was cold must be adopted by the
// runtime the moment one materializes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-session-load-projection-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;

const { createSessionService } = await import('../src/standalone/session-service.mjs');

/** Stub session runtime that supports resume + submit, counting creations. */
function createStubRuntimeFactory(counter) {
  return async () => {
    counter.created += 1;
    let state = { sessionId: '', items: [], busy: false };
    const listeners = new Set();
    return {
      getState: () => state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async resume(id) {
        state = { ...state, sessionId: String(id), items: [{ id: `${id}-restored` }] };
        return true;
      },
      async submitAsync(text, options) {
        state = {
          ...state,
          items: [...state.items, { id: String(options?.id || 'submitted'), text: String(text) }],
        };
        for (const listener of [...listeners]) listener();
        return true;
      },
      async dispose() {},
    };
  };
}

function createProjectionService({ counter, frames, stored }) {
  return createSessionService({
    createSessionRuntime: createStubRuntimeFactory(counter),
    sessionExists: async (sessionId) => stored.has(sessionId),
    readStoredSession: async (sessionId) => stored.get(sessionId) || null,
    publishIntervalMs: 5,
    onFrame: (frame, targets) => {
      frames.push({ frame, targets: targets ? [...targets] : null });
    },
  });
}

function storedFixture() {
  return new Map([
    ['sess_stored_1', { sessionId: 'sess_stored_1', items: [{ id: 'stored-1' }], provider: 'stub' }],
    ['sess_stored_2', { sessionId: 'sess_stored_2', items: [{ id: 'stored-2' }], provider: 'stub' }],
  ]);
}

test('read/subscribe on a stored session are disk projections, not runtime loads', async () => {
  const counter = { created: 0 };
  const frames = [];
  const service = createProjectionService({ counter, frames, stored: storedFixture() });
  try {
    const read = await service.handleCall(
      'session.read',
      { sessionId: 'sess_stored_1' },
      { clientToken: 'viewer-a' },
    );
    assert.equal(read.projection, true);
    assert.equal(read.revision, 0);
    assert.equal(read.full.items.length, 1, 'projection carries the stored transcript');
    const subscribed = await service.handleCall(
      'session.subscribe',
      { sessionId: 'sess_stored_1' },
      { clientToken: 'viewer-a' },
    );
    assert.equal(subscribed.subscribed, true);
    assert.equal(subscribed.projection, true);
    assert.equal(counter.created, 0, 'no runtime materializes for a view');
    assert.equal(service.size, 0);
    assert.equal(service.status.pendingViewerSessions, 1);

    await assert.rejects(
      () => service.handleCall('session.subscribe', { sessionId: 'sess_missing' }, { clientToken: 'viewer-a' }),
      /session sess_missing is not available/,
    );
    assert.equal(counter.created, 0);
  } finally {
    await service.stop('test end');
  }
});

test('submit materializes exactly one runtime and adopts the pending viewer', async () => {
  const counter = { created: 0 };
  const frames = [];
  const service = createProjectionService({ counter, frames, stored: storedFixture() });
  try {
    await service.handleCall(
      'session.subscribe',
      { sessionId: 'sess_stored_1' },
      { clientToken: 'viewer-a' },
    );
    assert.equal(counter.created, 0);

    const submit = await service.handleCall(
      'session.submit',
      { sessionId: 'sess_stored_1', prompt: 'hello there' },
      { clientToken: 'submitter-b' },
    );
    assert.equal(submit.accepted, true);
    assert.equal(counter.created, 1, 'execution materializes the runtime');
    assert.equal(service.status.pendingViewerSessions, 0, 'pending viewer was adopted');

    const stateFrame = frames.find((row) =>
      row.frame.type === 'session-state' && row.frame.sessionId === 'sess_stored_1');
    assert.ok(stateFrame, 'materialization publishes a session-state frame');
    assert.ok(stateFrame.frame.full, 'the first materialized frame is a full snapshot');
    assert.ok(
      stateFrame.targets.includes('viewer-a'),
      'the adopted viewer receives live frames without re-subscribing',
    );
  } finally {
    await service.stop('test end');
  }
});

test('an unsubscribed pending viewer is never adopted', async () => {
  const counter = { created: 0 };
  const frames = [];
  const service = createProjectionService({ counter, frames, stored: storedFixture() });
  try {
    await service.handleCall(
      'session.subscribe',
      { sessionId: 'sess_stored_2' },
      { clientToken: 'viewer-c' },
    );
    await service.handleCall(
      'session.unsubscribe',
      { sessionId: 'sess_stored_2' },
      { clientToken: 'viewer-c' },
    );
    assert.equal(service.status.pendingViewerSessions, 0);

    await service.handleCall(
      'session.submit',
      { sessionId: 'sess_stored_2', prompt: 'late submit' },
      {},
    );
    assert.equal(counter.created, 1);
    for (const row of frames) {
      if (row.frame.sessionId !== 'sess_stored_2' || !row.targets) continue;
      assert.ok(!row.targets.includes('viewer-c'), 'dropped viewer receives no frames');
    }
  } finally {
    await service.stop('test end');
  }
});

test('embedders without a store reader keep the legacy load-on-read seam', async () => {
  const counter = { created: 0 };
  const service = createSessionService({
    createSessionRuntime: createStubRuntimeFactory(counter),
    sessionExists: async () => true,
    publishIntervalMs: 5,
    onFrame: () => {},
  });
  try {
    const result = await service.handleCall(
      'session.read',
      { sessionId: 'sess_legacy_1' },
      { clientToken: 'viewer-d' },
    );
    assert.equal(result.sessionId, 'sess_legacy_1');
    assert.equal(counter.created, 1, 'legacy embedders still load on read');
  } finally {
    await service.stop('test end');
  }
});
