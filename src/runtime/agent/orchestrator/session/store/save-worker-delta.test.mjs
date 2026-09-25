// Delta handoff to the save worker: many concurrent sessions keep the delta
// path (no count cap, no full transcript copy per save), delta saves write the
// same bytes a full save writes, and a torn-down session frees its baselines.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-save-delta-'));
process.env.MIXDOG_DATA_DIR = root;
// Structural gate for the read-only worker base probe.
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';

const { saveSessionAsync } = await import('../store.mjs');
const { forgetSessionSaveBaseline, _hasSessionSaveBaseline, _probeWorkerDeltaBaseForTest } = await import(
  './save-worker.mjs'
);
const { createTeardown } = await import('../../../../../session-runtime/lifecycle/teardown.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

// Every write payload handed to the worker, and every structuredClone input.
const posted = [];
const originalPost = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...rest) {
  if (message && message.reqId !== undefined) posted.push(message);
  return originalPost.call(this, message, ...rest);
};
const clones = [];
const originalClone = globalThis.structuredClone;
globalThis.structuredClone = (value, options) => {
  clones.push(value);
  return originalClone(value, options);
};

test.after(async () => {
  Worker.prototype.postMessage = originalPost;
  globalThis.structuredClone = originalClone;
  // A landed save publishes its summary row through a deferred index flush
  // that writes the index, its lock and temp files into this data dir.
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

const now = Date.now();
function makeSession(id, count) {
  return {
    id,
    owner: 'user',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${id} message ${index}`,
      meta: { index },
    })),
  };
}
const diskBytes = (id) => readFileSync(join(root, 'sessions', `${id}.json`), 'utf8');
// How many transcript messages one structuredClone call copied.
const clonedMessages = (value) =>
  Array.isArray(value) ? value.length : Array.isArray(value?.messages) ? value.messages.length : 0;

test('12 concurrent sessions keep the delta path after their first save', async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => makeSession(`sess_delta_many_${index}`, 200));
  await Promise.all(sessions.map((session) => saveSessionAsync(session)));
  for (let round = 0; round < 3; round += 1) {
    posted.length = 0;
    clones.length = 0;
    for (const session of sessions) {
      session.messages = [
        ...session.messages,
        { role: 'user', content: `round ${round} ask` },
        { role: 'assistant', content: `round ${round} answer` },
      ];
    }
    await Promise.all(sessions.map((session) => saveSessionAsync(session)));
    assert.equal(posted.length, 12, 'one write per session, no full retry after a delta miss');
    for (const message of posted) {
      assert.equal(message.session, undefined, `${message.id} posted no full snapshot`);
      assert.equal(message.delta?.tailMessages.length, 2, `${message.id} posted only the appended tail`);
    }
    const largest = Math.max(0, ...clones.map(clonedMessages));
    assert.ok(largest <= 2, `no structuredClone copied the transcript (largest copy: ${largest} messages)`);
  }
  for (const session of sessions) {
    assert.equal(_hasSessionSaveBaseline(session.id), true);
    assert.equal(JSON.parse(diskBytes(session.id)).messages.length, 206);
  }
});

test('the parent keeps no copy of the transcript, full sends included', async () => {
  const session = makeSession('sess_delta_no_copy', 300);
  clones.length = 0;
  await saveSessionAsync(session); // first save: full
  for (let round = 0; round < 3; round += 1) {
    session.messages = [...session.messages.slice(1), { role: 'assistant', content: `prefix change ${round}` }];
    await saveSessionAsync(session); // prefix change: full
  }
  const largest = Math.max(0, ...clones.map(clonedMessages));
  assert.equal(largest, 0, `no structuredClone copied any message (largest copy: ${largest})`);
  assert.equal(JSON.parse(diskBytes('sess_delta_no_copy')).messages.length, 300);
});

test('delta saves write the bytes a full save writes, across edits and the periodic resync', async () => {
  const id = 'sess_delta_bytes';
  const session = makeSession(id, 30);
  const kinds = [];
  const save = async () => {
    posted.length = 0;
    session.updatedAt += 1;
    await saveSessionAsync(session);
    assert.equal(posted.length, 1);
    kinds.push(posted[0].delta ? 'delta' : 'full');
  };
  const append = (label) => {
    session.messages = [...session.messages, { role: 'assistant', content: label, meta: { label } }];
  };
  const replaceAt = (index, label) => {
    session.messages = session.messages.slice();
    session.messages[index] = { ...session.messages[index], content: label };
  };
  await save(); // save 1: full
  for (let turn = 2; turn <= 30; turn += 1) {
    // An IN-PLACE edit of a settled message: deltas never ship it, the
    // periodic resync (save 27, after 25 deltas) does.
    if (turn === 10) session.messages[0].meta.index = 'edited in place';
    append(`turn ${turn}`);
    await save();
  }
  replaceAt(5, 'edited earlier message'); // prefix change → full, unchanged messages reused
  await save();
  append('after edit');
  await save();
  replaceAt(session.messages.length - 1, 'edited last message');
  append('after second edit');
  await save();
  for (let turn = 0; turn < 3; turn += 1) {
    append(`tail ${turn}`);
    await save();
  }
  assert.deepEqual(
    kinds.map((kind, index) => (kind === 'full' ? index + 1 : null)).filter(Boolean),
    [1, 27, 31, 33],
    'full on first save, the resync and each prefix edit; deltas otherwise'
  );
  const afterDeltas = diskBytes(id);
  assert.equal(JSON.parse(afterDeltas).messages[0].meta.index, 'edited in place', 'the resync shipped the edit');

  // The same state written through a FULL snapshot.
  assert.equal(forgetSessionSaveBaseline(id), true);
  posted.length = 0;
  await saveSessionAsync(session);
  assert.ok(posted[0].session, 'a forgotten baseline sends a full snapshot');
  assert.equal(diskBytes(id), afterDeltas, 'on-disk bytes are identical to a full save');
});

test('runtime teardown frees the session save baselines', async () => {
  const id = 'sess_delta_dispose';
  const session = makeSession(id, 3);
  await saveSessionAsync(session);
  assert.equal(_hasSessionSaveBaseline(id), true);
  assert.equal(await _probeWorkerDeltaBaseForTest(id), true);

  const noop = () => {};
  const state = { session };
  const teardown = createTeardown(
    {
      getSession: () => state.session,
      setSession: (value) => {
        state.session = value;
      },
      getMcpScopeId: () => 'scope-1',
      setCloseRequested: noop,
      getMemoryModPromise: () => null,
      setMemoryModPromise: noop,
      hooks: { dispatch: noop, flushRules: noop },
      hookCommonPayload: (payload) => payload,
      mgr: { closeSession: () => true, abortSessionTurn: () => true },
      statusRoutes: { clearGatewaySessionRoute: noop },
      channels: { stop: () => Promise.resolve() },
      agentTool: { closeAll: noop },
      mcpClient: { disconnectAll: noop },
      warmupTimers: {},
      prewarmTimers: {},
      flushAllConfigSavesAsync: async () => {},
      withTeardownDeadline: async (work) => await work,
      closePatchRuntimeIfLoaded: () => null,
      closeNativeToolTransports: noop,
      stopSelfUpdateBootCheck: noop,
      invalidateContextStatusCache: noop,
      notificationListeners: new Set(),
      clearRuntimeNotifications: noop,
      goalRuntime: { close: noop },
      disposeSessionTitles: noop,
      disposeInternalTools: noop,
      disposeGlobalExtensionSubscription: noop,
      abortActiveTurns: () => false,
      getReservedSessionId: () => null,
    },
    { ingestSessionIntoMemory: async () => {}, closeSurfaceSession: () => true, cancelBackgroundTasks: noop }
  );
  await teardown.close('idle and unwatched', { keepBackgroundWork: true });
  assert.equal(_hasSessionSaveBaseline(id), false, 'the parent baseline is gone');
  assert.equal(await _probeWorkerDeltaBaseForTest(id), false, 'and so is the worker base');
});

test('closing a session or unloading a finished one frees its save baselines', async () => {
  const { closeSession, unloadSessionRuntime } = await import('../manager/session-close.mjs');
  // A canonical close drops the caller's session handle before any runtime
  // dispose runs, so the manager close itself must release the baselines.
  const closedId = 'sess_delta_closed';
  await saveSessionAsync(makeSession(closedId, 3));
  assert.equal(_hasSessionSaveBaseline(closedId), true);
  assert.equal(closeSession(closedId, 'test-close', { tombstone: true }), true);
  assert.equal(_hasSessionSaveBaseline(closedId), false, 'the parent baseline is gone after close');
  assert.equal(await _probeWorkerDeltaBaseForTest(closedId), false, 'and so is the worker base');

  // A finished worker is unloaded, not closed, and must not keep its baselines.
  const unloadedId = 'sess_delta_unloaded';
  await saveSessionAsync(makeSession(unloadedId, 3));
  assert.equal(unloadSessionRuntime(unloadedId, 'test-unload'), true);
  assert.equal(_hasSessionSaveBaseline(unloadedId), false, 'the parent baseline is gone after unload');
  assert.equal(await _probeWorkerDeltaBaseForTest(unloadedId), false, 'and so is the worker base');
});
