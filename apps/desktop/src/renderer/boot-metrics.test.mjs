import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetBootMetricsForTest,
  beginBootSurface,
  desktopBootCoverTimeoutAllowed,
  createBootSurfaceBarrier,
  desktopBootPrerequisitesReady,
  reportBootSurfaceStage,
} from './boot-metrics.ts';
import { startupRestoreCatalogPending } from './use-app-startup-restore.ts';

test('desktop boot stays covered until pane layout restoration completes', () => {
  const prerequisites = {
    snapshotHydrated: true,
    onboardingReady: true,
    updaterStateReady: true,
    startupSettled: true,
  };

  assert.equal(
    desktopBootPrerequisitesReady({
      ...prerequisites,
      restorePending: true,
    }),
    false
  );
  assert.equal(
    desktopBootPrerequisitesReady({
      ...prerequisites,
      restorePending: false,
    }),
    true
  );
});

test('fresh New Task shell does not wait for the project catalog', () => {
  assert.equal(
    startupRestoreCatalogPending({
      projectCatalogReady: false,
      storedSessionId: '',
      storedProjectPath: '',
    }),
    false
  );
  assert.equal(
    desktopBootPrerequisitesReady({
      snapshotHydrated: true,
      onboardingReady: true,
      updaterStateReady: true,
      startupSettled: true,
      restorePending: false,
    }),
    true
  );
});

test('persisted startup routes still wait for the project catalog', () => {
  assert.equal(
    startupRestoreCatalogPending({
      projectCatalogReady: false,
      storedSessionId: 'session-a',
      storedProjectPath: '',
    }),
    true
  );
  assert.equal(
    startupRestoreCatalogPending({
      projectCatalogReady: false,
      storedSessionId: '',
      storedProjectPath: 'C:\\Project\\mixdog',
    }),
    true
  );
  assert.equal(
    startupRestoreCatalogPending({
      projectCatalogReady: true,
      storedSessionId: 'session-a',
      storedProjectPath: '',
    }),
    false
  );
});

test('desktop boot cover cannot time out while pane layout restoration is active', () => {
  assert.equal(desktopBootCoverTimeoutAllowed(true), false);
  assert.equal(desktopBootCoverTimeoutAllowed(false), true);
});

test('cold boot barrier releases on first paint instead of waiting for ready', async () => {
  _resetBootMetricsForTest();
  const barrier = createBootSurfaceBarrier();
  beginBootSurface('conversation', 'session-a');
  await Promise.resolve();

  assert.equal(barrier.getSnapshot().pending, 1);
  reportBootSurfaceStage('conversation', 'session-a', 'dom');
  assert.equal(barrier.getSnapshot().pending, 1);
  reportBootSurfaceStage('conversation', 'session-a', 'paint');
  assert.equal(barrier.getSnapshot().pending, 0);
  reportBootSurfaceStage('conversation', 'session-a', 'ready');
  assert.equal(barrier.getSnapshot().pending, 0);
  barrier.dispose();
});

test('already-painted surfaces never register as pending on the next microtask', async () => {
  _resetBootMetricsForTest();
  const barrier = createBootSurfaceBarrier();
  beginBootSurface('conversation', 'session-b');
  reportBootSurfaceStage('conversation', 'session-b', 'dom');
  reportBootSurfaceStage('conversation', 'session-b', 'paint');
  await Promise.resolve();

  assert.equal(barrier.getSnapshot().pending, 0);
  barrier.dispose();
});

test('boot metrics initialize storage once and publish appended entries in order', () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let storage;
  let assignments = 0;
  const published = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get __mixdogBootMetrics() {
        return storage;
      },
      set __mixdogBootMetrics(value) {
        assignments += 1;
        storage = value;
      },
      mixdogDesktop: {
        perfLog() {
          published.push(['log', storage.at(-1)]);
        },
      },
      dispatchEvent(event) {
        published.push(['event', event.detail]);
      },
    },
  });
  try {
    _resetBootMetricsForTest();
    beginBootSurface('conversation', 'storage-a');
    const firstStorage = storage;
    beginBootSurface('conversation', 'storage-b');
    assert.equal(assignments, 1);
    assert.equal(storage, firstStorage);
    assert.equal(storage.length, 2);
    assert.deepEqual(
      published.map(([kind]) => kind),
      ['log', 'event', 'log', 'event']
    );
    assert.equal(published[0][1], storage[0]);
    assert.equal(published[1][1], storage[0]);
    assert.equal(published[2][1], storage[1]);
    assert.equal(published[3][1], storage[1]);
  } finally {
    _resetBootMetricsForTest();
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete globalThis.window;
  }
});
