import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createSessionService } from './session-service.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function runtime({ reserveGate, resumeGate, dispose = async () => {}, readMessages } = {}) {
  let state = { sessionId: '', items: [], queued: [], busy: false };
  return {
    isWireSafe: true,
    getState: () => state,
    subscribe: () => () => {},
    async reserveSession(id) {
      if (reserveGate) await reserveGate.promise;
      state = { ...state, sessionId: id };
      return true;
    },
    async resume(id) {
      if (resumeGate) await resumeGate.promise;
      state = { ...state, sessionId: id };
      return true;
    },
    readModelMessages: readMessages || (() => ({ messageCount: 0, messages: [] })),
    dispose,
  };
}

test('a runtime acquired after service stop is disposed instead of registered', async (t) => {
  const created = deferred();
  const entered = deferred();
  let disposed = 0;
  const service = createSessionService({
    createSessionRuntime: () => { entered.resolve(); return created.promise; },
  });
  t.after(() => service.stop());
  const pending = service.createSession({ sessionId: 'sess_late_creation' });
  await entered.promise;
  await service.stop();
  created.resolve(runtime({ dispose: async () => { disposed += 1; } }));
  await assert.rejects(pending, /session service is closed/);
  assert.equal(disposed, 1);
  assert.equal(service.size, 0);
});

for (const action of ['reserve', 'resume']) {
  test(`service stop during ${action} cannot publish a newly usable session`, async (t) => {
    const gate = deferred();
    let disposed = 0;
    const frames = [];
    const service = createSessionService({
      createSessionRuntime: async () => runtime({
        ...(action === 'reserve' ? { reserveGate: gate } : { resumeGate: gate }),
        dispose: async () => { disposed += 1; },
      }),
      onFrame: (frame) => frames.push(frame),
    });
    t.after(() => service.stop());
    const pending = action === 'reserve'
      ? service.createSession({ sessionId: 'sess_late_reserve' })
      : service.materializeSession('sess_late_resume');
    await setImmediate();
    await service.stop();
    gate.resolve();
    await assert.rejects(pending, /session service is closed/);
    assert.equal(disposed, 1);
    assert.equal(service.size, 0);
    assert.equal(frames.some((frame) => frame.type === 'session-state'), false);
  });
}

test('disposal uses the owned address even when the runtime can no longer report state', async (t) => {
  let disposed = 0;
  const live = runtime({ dispose: async () => { disposed += 1; } });
  const service = createSessionService({ createSessionRuntime: async () => live });
  t.after(() => service.stop());
  await service.createSession({ sessionId: 'sess_unreadable_dispose' });
  live.getState = () => { throw new Error('runtime state unavailable'); };
  await service.stop();
  assert.equal(disposed, 1);
  assert.equal(service.size, 0);
});

test('an old asynchronous disposal cannot publish session-gone after a replacement is live', async (t) => {
  const disposalEntered = deferred();
  const disposalFinished = deferred();
  const frames = [];
  let created = 0;
  const service = createSessionService({
    createSessionRuntime: async () => runtime({
      dispose: ++created === 1
        ? async () => { disposalEntered.resolve(); await disposalFinished.promise; }
        : async () => {},
    }),
    onFrame: (frame) => frames.push(frame),
  });
  t.after(async () => { disposalFinished.resolve(); await service.stop(); });
  const id = 'sess_replaced_dispose';
  await service.createSession({ sessionId: id }, { clientToken: 'first' });
  const released = service.unsubscribeSession({ sessionId: id }, { clientToken: 'first' });
  await disposalEntered.promise;
  await service.createSession({ sessionId: id }, { clientToken: 'second' });
  disposalFinished.resolve();
  await released;
  assert.equal(frames.at(-1).type, 'session-state');
  assert.equal(service.size, 1);
});

test('concurrent explicit creation of one session address shares one runtime', async (t) => {
  const gate = deferred();
  let created = 0;
  const service = createSessionService({
    createSessionRuntime: async () => { created += 1; await gate.promise; return runtime(); },
  });
  t.after(() => service.stop());
  const first = service.createSession({ sessionId: 'sess_shared_create' }, { clientToken: 'first' });
  const second = service.createSession({ sessionId: 'sess_shared_create' }, { clientToken: 'second' });
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(created, 1);
  assert.equal(service.size, 1);
  assert.deepEqual(results.map((result) => result.sessionId), ['sess_shared_create', 'sess_shared_create']);
});

for (const malformed of [false, true]) {
  test(`live transcript ${malformed ? 'contract failures' : 'read errors'} cannot silently return stale disk messages`, async (t) => {
    const failure = new Error('live transcript read failed');
    let diskReads = 0;
    const service = createSessionService({
      createSessionRuntime: async () => runtime({
        readMessages: () => {
          if (malformed) return { messages: null };
          throw failure;
        },
      }),
      readStoredSession: async () => {
        diskReads += 1;
        return { messages: [{ role: 'assistant', content: 'stale' }] };
      },
    });
    t.after(() => service.stop());
    await service.createSession({ sessionId: 'sess_live_transcript' });
    await assert.rejects(
      service.readSession({ sessionId: 'sess_live_transcript', messageStart: 0 }),
      malformed ? /live session transcript is invalid/ : (error) => error === failure,
    );
    assert.equal(diskReads, 0);
  });
}

test('service shutdown releases pending viewers of cold stored sessions', async (t) => {
  const service = createSessionService({
    createSessionRuntime: async () => { throw new Error('cold views must not create runtimes'); },
    readStoredSession: async (sessionId) => ({ sessionId, items: [], queued: [] }),
  });
  t.after(() => service.stop());
  await service.subscribeSession({ sessionId: 'sess_cold_view' }, { clientToken: 'viewer' });
  assert.equal(service.status.pendingViewerSessions, 1);
  await service.stop();
  assert.equal(service.status.pendingViewerSessions, 0);
});

for (const releasingView of [false, true]) {
  test(`service stop waits for disposal already started by ${releasingView ? 'view release' : 'another stop'}`, async (t) => {
    const entered = deferred();
    const finished = deferred();
    let disposed = 0;
    const service = createSessionService({
      createSessionRuntime: async () => runtime({
        dispose: async () => {
          disposed += 1;
          entered.resolve();
          await finished.promise;
        },
      }),
    });
    t.after(async () => { finished.resolve(); await service.stop(); });
    const sessionId = 'sess_wait_for_disposal';
    const viewer = { clientToken: 'viewer' };
    await service.createSession({ sessionId }, viewer);
    const retiring = releasingView
      ? service.unsubscribeSession({ sessionId }, viewer)
      : service.stop();
    await entered.promise;
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    try {
      await setImmediate();
      assert.equal(stopped, false);
    } finally {
      finished.resolve();
      await Promise.all([retiring, stopping]);
    }
    assert.equal(disposed, 1);
  });
}

for (const method of ['readSession', 'subscribeSession']) {
  test(`${method} rejects after closure without reading or retaining a cold view`, async () => {
    let reads = 0;
    const service = createSessionService({
      createSessionRuntime: async () => runtime(),
      readStoredSession: async (sessionId) => {
        reads += 1;
        return { sessionId, items: [], queued: [] };
      },
    });
    await service.stop();
    await assert.rejects(
      service[method]({ sessionId: 'sess_closed_view' }, { clientToken: 'viewer' }),
      /session service is closed/,
    );
    assert.equal(reads, 0);
    assert.equal(service.status.pendingViewerSessions, 0);
  });

  test(`${method} cannot confirm a cold view whose read outlives service shutdown`, async () => {
    const entered = deferred();
    const finished = deferred();
    const service = createSessionService({
      createSessionRuntime: async () => runtime(),
      readStoredSession: async (sessionId) => {
        entered.resolve();
        await finished.promise;
        return { sessionId, items: [], queued: [] };
      },
    });
    const pending = service[method](
      { sessionId: 'sess_late_cold_view' },
      { clientToken: 'viewer' },
    );
    const rejected = assert.rejects(pending, /session service is closed/);
    await entered.promise;
    await service.stop();
    finished.resolve();
    await rejected;
    assert.equal(service.status.pendingViewerSessions, 0);
  });
}

test('a live transcript read cannot return an active projection after its owner is disposed', async () => {
  const entered = deferred();
  const finished = deferred();
  const service = createSessionService({
    createSessionRuntime: async () => runtime({
      readMessages: async () => {
        entered.resolve();
        await finished.promise;
        return { messageCount: 1, messages: [{ role: 'assistant', content: 'finished' }] };
      },
    }),
  });
  await service.createSession({ sessionId: 'sess_late_history' });
  const pending = service.readSession({ sessionId: 'sess_late_history', messageStart: 0 });
  const rejected = assert.rejects(pending, /session service is closed/);
  await entered.promise;
  await service.stop();
  finished.resolve();
  await rejected;
});

test('a queued addressed action cannot start after service closure', async () => {
  let calls = 0;
  const live = runtime();
  live.getTheme = () => { calls += 1; return 'dark'; };
  const service = createSessionService({ createSessionRuntime: async () => live });
  await service.createSession({ sessionId: 'sess_queued_action' });
  const pending = service.readSession({ sessionId: 'sess_queued_action', action: 'getTheme' });
  const rejected = assert.rejects(pending, /session service is closed/);
  await service.stop();
  await rejected;
  assert.equal(calls, 0);
});

test('an action finishing after shutdown cannot republish its retired session', async () => {
  const entered = deferred();
  const finished = deferred();
  const frames = [];
  const live = runtime();
  live.getTheme = async () => {
    entered.resolve();
    await finished.promise;
    return 'dark';
  };
  const service = createSessionService({
    createSessionRuntime: async () => live,
    onFrame: (frame) => frames.push(frame),
  });
  await service.createSession({ sessionId: 'sess_late_action' }, { clientToken: 'viewer' });
  const pending = service.readSession({ sessionId: 'sess_late_action', action: 'getTheme' });
  const rejected = assert.rejects(pending, /session service is closed/);
  await entered.promise;
  await service.stop();
  const stoppedFrames = frames.length;
  finished.resolve();
  await rejected;
  assert.equal(frames.length, stoppedFrames);
});
