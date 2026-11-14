import assert from 'node:assert/strict';
import test from 'node:test';

import { observeCoreForMain } from './core-observers.ts';

function setup() {
  let store;
  let event;
  const applied = [];
  const released = [];
  const entries = [
    { section: 'desktop-ignored', key: null, revision: 1, value: {} },
    { section: 'config', key: 'desktop', revision: 1, value: { keepAwake: false } },
  ];
  const connection = {
    onStoreChange: (l) => ((store = l), () => (store = null)),
    onEvent: (l) => ((event = l), () => (event = null)),
    snapshot: () => ({ status: 'ready', entries }),
  };
  const off = observeCoreForMain({
    connection,
    applyDesktopSettings: (s) => applied.push(s),
    releaseBrowserSession: (id) => released.push(id),
  });
  return { push: (c) => store?.(c), emit: (e) => event?.(e), applied, released, off };
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
  t.emit({ type: 'notification', notification: { method: 'thread/deleted', params: {} } });
  t.emit({ type: 'status', status: { state: 'ready' } });
  assert.deepEqual(t.released, ['s1']);
});
