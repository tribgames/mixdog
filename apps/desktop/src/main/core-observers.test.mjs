import assert from 'node:assert/strict';
import test from 'node:test';

import { observeCoreForMain } from './core-observers.ts';

function setup() {
  let store;
  let event;
  const applied = [];
  const released = [];
  const forgotten = [];
  const entries = [
    { section: 'desktop-ignored', key: null, revision: 1, value: {} },
    { section: 'config', key: 'desktop', revision: 1, value: { keepAwake: false } },
  ];
  const connection = {
    onStoreChange: (l) => {
      store = l;
      return () => {
        store = null;
      };
    },
    onEvent: (l) => {
      event = l;
      return () => {
        event = null;
      };
    },
    snapshot: () => ({ status: 'ready', entries }),
  };
  const off = observeCoreForMain({
    connection,
    applyDesktopSettings: (s) => applied.push(s),
    releaseBrowserSession: (id) => released.push(id),
    forgetSuspendedBrowserSession: (id) => forgotten.push(id),
  });
  return { push: (c) => store?.(c), emit: (e) => event?.(e), applied, released, forgotten, off };
}

test('keep_awake_on_config_change', () => {
  const t = setup();
  t.push({ type: 'section', section: 'config', key: 'desktop' });
  assert.equal(t.applied.length, 1);
  assert.equal(t.applied[0].keepAwake, false);
  t.push({ type: 'section', section: 'config', key: 'notifications' });
  t.push({ type: 'section', section: 'usage', key: null });
  t.push({ type: 'thread', threadId: 'a' });
  assert.equal(t.applied.length, 1);
  t.off();
  t.push({ type: 'section', section: 'config', key: 'agent' });
  assert.equal(t.applied.length, 1);
});

test('release_on_thread_removed', () => {
  const t = setup();
  t.emit({ type: 'notification', notification: { method: 'thread/deleted', params: { threadId: 's1' } } });
  t.emit({ type: 'notification', notification: { method: 'thread/archived', params: { threadId: 's2' } } });
  t.emit({ type: 'notification', notification: { method: 'thread/closed', params: { threadId: 's3' } } });
  t.emit({ type: 'notification', notification: { method: 'thread/deleted', params: {} } });
  t.emit({ type: 'status', status: { state: 'ready' } });
  assert.deepEqual(t.released, ['s1']);
  assert.deepEqual(t.forgotten, ['s2', 's3']);
});

test('a paged config read that a newer change or the unsubscribe superseded is discarded', async () => {
  let store;
  let entries = [{ section: 'config', key: 'desktop', revision: 1, value: null }];
  const pending = [];
  const connection = {
    onStoreChange: (l) => {
      store = l;
      return () => {
        store = null;
      };
    },
    onEvent: () => () => undefined,
    snapshot: () => ({ status: 'ready', entries }),
    call: () => new Promise((resolve) => pending.push(resolve)),
  };
  const applied = [];
  const off = observeCoreForMain({
    connection,
    applyDesktopSettings: (s) => applied.push(s),
    releaseBrowserSession: () => undefined,
  });
  store({ type: 'section', section: 'config', key: 'desktop' });
  entries = [{ section: 'config', key: 'desktop', revision: 2, value: { keepAwake: true } }];
  store({ type: 'section', section: 'config', key: 'desktop' });
  assert.equal(applied.length, 1);
  pending[0]({ config: { desktop: { keepAwake: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].keepAwake, true);
  entries = [{ section: 'config', key: 'desktop', revision: 3, value: null }];
  store({ type: 'section', section: 'config', key: 'desktop' });
  off();
  pending[1]({ config: { desktop: { keepAwake: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.length, 1);
});
