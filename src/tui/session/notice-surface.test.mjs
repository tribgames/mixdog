import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createNoticeSurface } from './notice-surface.mjs';

function createSurface() {
  let state = { items: [], toasts: [], progressHint: null };
  let disposed = false;
  const pushed = [];
  const surface = createNoticeSurface({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      return true;
    },
    isDisposed: () => disposed,
    pushItem: (item) => {
      pushed.push(item);
      state = { ...state, items: [...state.items, item] };
    },
    replaceItems: (items) => items,
  });
  return {
    surface,
    pushed,
    getState: () => state,
    dispose: () => {
      disposed = true;
    },
  };
}

test('toasts expire after their ttl unless the store is disposed', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { surface, getState, dispose } = createSurface();
    assert.equal(surface.pushToast('   '), null);
    const id = surface.pushToast('saved', 'success', 500, { owner: 'goal' });
    assert.deepEqual(getState().toasts, [{ id, text: 'saved', tone: 'success', owner: 'goal' }]);
    mock.timers.tick(500);
    assert.deepEqual(getState().toasts, []);
    surface.pushToast('kept', 'info', 100);
    dispose();
    mock.timers.tick(100);
    assert.equal(getState().toasts.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('pushNotice routes to a toast by default and to the transcript on request', () => {
  const { surface, pushed, getState } = createSurface();
  assert.equal(surface.pushNotice(''), null);
  const toastId = surface.pushNotice('hello', 'warn', { ttlMs: 10_000 });
  assert.equal(getState().toasts[0].id, toastId);
  const noticeId = surface.pushNotice('persist me', 'info', { transcript: true });
  assert.deepEqual(pushed, [{ kind: 'notice', id: noticeId, text: 'persist me', tone: 'info' }]);
  assert.equal(surface.removeNotice(noticeId), true);
  assert.deepEqual(getState().items, []);
  assert.equal(surface.removeNotice(noticeId), false);
  assert.equal(surface.removeNotice(null), false);
  surface.clearToastTimers();
});

test('setProgressHint clamps the percent and clears on empty text', () => {
  const { surface, getState } = createSurface();
  surface.setProgressHint('downloading', 'info', 140.6);
  assert.deepEqual(getState().progressHint, { text: 'downloading', tone: 'info', percent: 100 });
  surface.setProgressHint('downloading', 'info', 'n/a');
  assert.deepEqual(getState().progressHint, { text: 'downloading', tone: 'info' });
  surface.setProgressHint('');
  assert.equal(getState().progressHint, null);
});
