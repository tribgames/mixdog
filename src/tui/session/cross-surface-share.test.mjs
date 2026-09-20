import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { attachCrossSurfaceShare } from './cross-surface-share.mjs';

function createFakeShare(overrides = {}) {
  const calls = { ensure: 0, dispose: 0, abort: 0 };
  const share = {
    ensure: () => calls.ensure++,
    viewerConnected: () => false,
    sendSubmit: () => false,
    sendAbort: () => {
      calls.abort++;
      return true;
    },
    waitForViewerSync: async () => false,
    dispose: () => calls.dispose++,
    ...overrides,
  };
  return { share, calls };
}

function createHarness({ state: stateExtra = {}, runtime: runtimeExtra = {}, share: shareOverrides } = {}) {
  let state = { sessionId: 'sess-1', sessionRemoteAttached: false, busy: false, commandBusy: false, ...stateExtra };
  const flags = { disposed: false, pendingSessionReset: false };
  const { share, calls } = createFakeShare(shareOverrides);
  const log = [];
  const runtime = {
    enqueueRemoteAttachedPrompt: (entry) => {
      log.push(['spool', entry]);
      return true;
    },
    takeRemoteInjections: async () => [],
    ...runtimeExtra,
  };
  const api = {
    submit: (prompt) => {
      log.push(['submit', prompt]);
      return 'local';
    },
    submitAsync: async (prompt) => {
      log.push(['submitAsync', prompt]);
      return 'local-async';
    },
    abort: () => {
      log.push(['abort']);
      return 'local-abort';
    },
    resume: async (id) => {
      log.push(['resume', id]);
      return true;
    },
  };
  const bag = {
    enqueue: (content, options) => {
      log.push(['enqueue', content, options]);
      return true;
    },
    drain: async () => log.push(['drain']),
    refreshGoalState: () => log.push(['refreshGoalState']),
    scheduleGoalContinuation: () => log.push(['scheduleGoalContinuation']),
    flushEmit: () => log.push(['flushEmit']),
  };
  attachCrossSurfaceShare({
    runtime,
    api,
    bag,
    flags,
    getState: () => state,
    getPublishedState: () => state,
    listeners: new Set(),
    set: (patch) => {
      state = { ...state, ...patch };
    },
    createShare: () => share,
  });
  return {
    api,
    bag,
    flags,
    log,
    calls,
    setState: (patch) => {
      state = { ...state, ...patch };
    },
  };
}

test('an owner keeps submits local and reconciles the pipe on construction', async () => {
  const { api, log, calls, bag } = createHarness();
  assert.equal(calls.ensure, 1);
  assert.equal(api.submit('hi'), 'local');
  assert.equal(await api.submitAsync('hi2'), 'local-async');
  assert.equal(api.abort(), 'local-abort');
  assert.equal(bag.liveShareMirroring(), false);
  assert.deepEqual(
    log.map((entry) => entry[0]),
    ['submit', 'submitAsync', 'abort']
  );
});

test('an attached viewer forwards submits to the owner spool and aborts over the pipe', async () => {
  const { api, log, calls } = createHarness({
    state: { sessionRemoteAttached: true },
    share: { viewerConnected: () => true },
  });
  assert.equal(api.submit('   '), false);
  assert.equal(api.submit('forward me', { id: 'view-1' }), true);
  assert.equal(await api.submitAsync('forward async'), true);
  assert.equal(api.abort(), true);
  assert.equal(calls.abort, 1);
  const spooled = log.filter((entry) => entry[0] === 'spool').map((entry) => entry[1]);
  assert.equal(spooled.length, 2);
  assert.equal(spooled[0].id, 'view-1');
  assert.equal(spooled[0].text, 'forward me');
  assert.equal(
    log.some((entry) => entry[0] === 'submit'),
    false
  );
});

test('resume re-arms goal continuation and waits for the owner frame when attached', async () => {
  const { api, log, calls } = createHarness({
    state: { sessionRemoteAttached: true },
    share: { waitForViewerSync: async () => true },
  });
  const ensureBefore = calls.ensure;
  assert.equal(await api.resume('sess-1'), true);
  assert.equal(calls.ensure, ensureBefore + 1);
  assert.deepEqual(
    log.map((entry) => entry[0]),
    ['resume', 'refreshGoalState', 'scheduleGoalContinuation', 'flushEmit']
  );
});

test('the attach tick drains the owner spool and disposes the share once the store is disposed', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { flags, log, calls } = createHarness({
      runtime: {
        takeRemoteInjections: async () => [{ text: 'from desktop', id: ' inj-1 ', options: { fast: true } }],
      },
    });
    mock.timers.tick(3000);
    await new Promise((resolve) => setImmediate(resolve));
    const enqueued = log.find((entry) => entry[0] === 'enqueue');
    assert.deepEqual(enqueued, ['enqueue', 'from desktop', { fast: true, displayText: 'from desktop', id: 'inj-1' }]);
    assert.ok(log.some((entry) => entry[0] === 'drain'));
    flags.disposed = true;
    mock.timers.tick(3000);
    assert.equal(calls.dispose, 1);
  } finally {
    mock.timers.reset();
  }
});
