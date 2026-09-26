import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { attachCrossSurfaceShare } from './cross-surface-share.mjs';
import { createSharedDirWatch } from './shared-dir-watch.mjs';

// Lets settled drains release their in-flight slot (setImmediate is not mocked).
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

// fs.watch stand-in: records every underlying handle and lets the test fire
// directory events into the open ones.
function createFakeWatch() {
  const handles = [];
  const impl = (dir, _options, onChange) => {
    const handle = {
      dir,
      closed: false,
      close() {
        handle.closed = true;
      },
      on() {
        return handle;
      },
    };
    handles.push({ handle, onChange });
    return handle;
  };
  const emit = (filename) => {
    for (const { handle, onChange } of handles) if (!handle.closed) onChange('rename', filename);
  };
  return { impl, handles, emit };
}

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

function createHarness({ state: stateExtra = {}, runtime: runtimeExtra = {}, share: shareOverrides, watchDir } = {}) {
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
    ...(watchDir ? { watchDir } : {}),
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

test('32 sessions share one spool directory watcher; each keeps its own filter and drain', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const fake = createFakeWatch();
    const registry = createSharedDirWatch(fake.impl);
    const spool = join(tmpdir(), 'mixdog-shared-spool', 'session-pending-messages.json');
    const drains = new Array(32).fill(0);
    const sessions = drains.map((_, index) =>
      createHarness({
        state: { sessionId: `sess-${index}` },
        runtime: {
          pendingSpoolPath: () => spool,
          takeRemoteInjections: async () => {
            drains[index] += 1;
            return [];
          },
        },
        watchDir: registry.subscribe,
      })
    );
    assert.equal(fake.handles.length, 1, 'one underlying fs.watch for 32 sessions');
    assert.equal(fake.handles[0].handle.dir, dirname(spool));
    assert.equal(registry.watchedCount(), 1);

    // Same per-session filter as before: sibling lock/tmp files are ignored.
    fake.emit('session-pending-messages.json.lock');
    mock.timers.tick(120);
    await flushMicrotasks();
    assert.deepEqual(drains, new Array(32).fill(0));

    // A spool change reaches every session exactly once after its debounce.
    fake.emit('session-pending-messages.json');
    fake.emit('session-pending-messages.json');
    mock.timers.tick(120);
    await flushMicrotasks();
    assert.deepEqual(drains, new Array(32).fill(1));

    // A busy session skips the watch-driven drain; the others still drain.
    sessions[1].setState({ busy: true });
    fake.emit('session-pending-messages.json');
    mock.timers.tick(120);
    await flushMicrotasks();
    assert.equal(drains[1], 1);
    assert.equal(drains[2], 2);
    sessions[1].setState({ busy: false });

    // Closing one session releases only its subscription.
    sessions[0].flags.disposed = true;
    mock.timers.tick(3000);
    await flushMicrotasks();
    assert.equal(fake.handles[0].handle.closed, false);
    drains.fill(0);
    fake.emit('session-pending-messages.json');
    mock.timers.tick(120);
    await flushMicrotasks();
    assert.equal(drains[0], 0);
    assert.deepEqual(drains.slice(1), new Array(31).fill(1));

    // The last release closes the shared handle; a new session reopens one.
    for (const session of sessions) session.flags.disposed = true;
    mock.timers.tick(3000);
    await flushMicrotasks();
    assert.equal(fake.handles[0].handle.closed, true);
    assert.equal(registry.watchedCount(), 0);
    createHarness({ runtime: { pendingSpoolPath: () => spool }, watchDir: registry.subscribe });
    assert.equal(fake.handles.length, 2);
    assert.equal(registry.watchedCount(), 1);
  } finally {
    mock.timers.reset();
  }
});
