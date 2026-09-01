import test from 'node:test';
import assert from 'node:assert/strict';
import {
  performance,
  attachSession,
  createSessionApiA,
  createSessionApiB,
  appendTuiSteeringPersist,
  drainTuiSteeringPersist,
  createStubSessionRuntime,
  withDaemon,
  waitFor,
} from './_shared.mjs';


test('session submit ACK does not wait for auto-clear and remains reclaimable', async () => {
  const clearGate = Promise.withResolvers();
  let enqueued = 0;
  const queued = [];
  let state = { busy: false, commandBusy: false };
  const api = createSessionApiA({
    runtime: { abort: () => true },
    nextId: () => 'generated-id',
    flags: {},
    pending: [],
    listeners: new Set(),
    getState: () => state,
    getPublishedState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    routeState: () => ({}),
    autoClearBeforeSubmit: () => clearGate.promise,
    enqueue: (text, options) => {
      enqueued += 1;
      queued.push({ text, id: options.id });
      return true;
    },
    restoreQueued: (_current, selectedId) => {
      const index = queued.findIndex((entry) => entry.id === selectedId);
      if (index < 0) return {
        count: 0, ids: [], text: '', pastedImages: null, pastedTexts: null,
      };
      const [entry] = queued.splice(index, 1);
      return {
        count: 1,
        ids: [entry.id],
        text: entry.text,
        pastedImages: null,
        pastedTexts: null,
      };
    },
  });

  const submitting = api.submitAsync('recover before busy', {
    id: 'actual-session-idle-1',
  });
  assert.equal(await submitting, true, 'queue intake ACKs before compaction settles');
  assert.equal(enqueued, 1);
  const restored = api.abort({
    restorePrompt: true,
    submissionId: 'actual-session-idle-1',
  });
  assert.equal(restored.aborted, false);
  assert.equal(restored.restoreText, 'recover before busy');
  assert.deepEqual(restored.restoredSubmissionIds, ['actual-session-idle-1']);

  clearGate.resolve();
  assert.equal(queued.length, 0, 'targeted abort reclaims the acknowledged queue entry');
});

test('persisted steering keeps the desktop submission identity across recovery', async () => {
  const sessionId = `steering-recovery-${Date.now()}`;
  const entry = {
    id: 'desktop-submit-retry-1',
    text: 'ship it',
    submittedAt: Date.now() - 50,
  };
  await appendTuiSteeringPersist(sessionId, entry);
  const restored = await drainTuiSteeringPersist(sessionId);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, entry.text);
  assert.equal(restored[0].submissionId, entry.id);
  assert.equal(restored[0].submittedAt, entry.submittedAt);
});

test('process-restart resume restores queued steering before releasing commandBusy', async () => {
  const restoreStarted = Promise.withResolvers();
  const restoreGate = Promise.withResolvers();
  let restored = false;
  let sequence = 0;
  let state = { commandBusy: false, stats: {} };
  const releaseStates = [];
  const api = createSessionApiB({
    runtime: {
      resume: async (id) => ({ id, messages: [] }),
    },
    nextId: () => `resume-item-${++sequence}`,
    flags: {},
    lifecycle: {},
    listeners: new Set(),
    getState: () => state,
    set: (patch) => {
      if (patch.commandBusy === false) releaseStates.push(restored);
      state = { ...state, ...patch };
    },
    flushEmitImmediate: () => {},
    replaceItems: (items) => items,
    clearToastTimers: () => {},
    routeState: () => ({}),
    resetStatsAndSyncContext: () => state.stats,
    restoreLeadSteeringFromDisk: () => {
      restoreStarted.resolve();
      return restoreGate.promise.then(() => { restored = true; });
    },
  });

  let settled = false;
  const resuming = api.resume('restart-session', { quiet: true }).then((value) => {
    settled = true;
    return value;
  });
  await restoreStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.commandBusy, true);
  assert.equal(settled, false, 'resume must keep the command gate until steering is durable in memory');

  restoreGate.resolve();
  assert.equal(await resuming, true);
  assert.equal(state.commandBusy, false);
  assert.deepEqual(releaseStates, [true], 'the release-triggered drain must see restored steering');
});

test('abort starts immediately while ordinary session calls remain in flight', async () => {
  let releaseWork;
  let startedWork = 0;
  let abortCalls = 0;
  let abortOptions = null;
  const workGate = new Promise((resolve) => { releaseWork = resolve; });
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const work = Array.from({ length: 64 }, (_, index) =>
      client.call('session.read', {
        sessionId,
        action: 'getSettingsSnapshot',
        args: [index],
      }, { callId: `reserved-capacity-work:${index}` }));
    try {
      await waitFor(
        () => startedWork === work.length,
        'ordinary calls start without a hidden concurrency gate',
      );
      const started = performance.now();
      const result = await client.call('session.abort', {
        sessionId,
        options: { restorePrompt: false, submissionId: 'desktop-submit-1' },
      }, {
        callId: 'reserved-capacity-abort',
      });
      const elapsed = performance.now() - started;
      assert.equal(result.aborted, true);
      assert.equal(result.restoreText, 'queued prompt');
      assert.deepEqual(result.pastedTexts, { text_1: { text: 'restored text' } });
      assert.deepEqual(abortOptions, {
        restorePrompt: false,
        submissionId: 'desktop-submit-1',
      });
      assert.equal(abortCalls, 1);
      assert.ok(elapsed < 100, `abort waited ${elapsed.toFixed(1)}ms behind ordinary calls`);
    } finally {
      releaseWork();
      await Promise.all(work);
      await client.close('reserved capacity test');
    }
  }, {
    sessionFactory: async () => ({
      ...createStubSessionRuntime(),
      getSettingsSnapshot() {
        startedWork += 1;
        return workGate;
      },
      abort(options) {
        abortCalls += 1;
        abortOptions = options;
        return {
          aborted: true,
          restoreText: 'queued prompt',
          pastedTexts: { text_1: { text: 'restored text' } },
        };
      },
    }),
  });
});
