import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeNotifications, updateNoticeEvent } from './runtime-notifications.mjs';

function world(entries = []) {
  const notices = new Map(entries.map((entry) => [entry.key, entry]));
  const store = { sections: (name) => (name === 'notice' ? [...notices.values()] : []) };
  const logged = [];
  const bus = createRuntimeNotifications({ store, log: (line) => logged.push(line) });
  const raise = (key, value) => {
    notices.set(key, { section: 'notice', key, revision: notices.size + 1, value });
    bus.onChange({ type: 'section', section: 'notice', key });
  };
  return { bus, raise, logged };
}

const ready = (version) => ({ key: 'update-ready', code: 'update-ready', params: { version } });

test('the update notice reaches a listener as the bus event Node emits', () => {
  const { bus, raise } = world();
  const seen = [];
  bus.onNotification((event) => seen.push(event));
  raise('update-ready', ready('1.4.6'));
  assert.deepEqual(seen, [{ content: 'update ready', meta: { kind: 'update-notice', version: '1.4.6', tone: 'info' } }]);
  assert.deepEqual(seen[0], updateNoticeEvent('1.4.6'));
});

test('a standing notice is delivered to a listener that subscribes later, once', () => {
  const { bus, raise } = world([{ section: 'notice', key: 'update-ready', revision: 1, value: ready('1.4.6') }]);
  const seen = [];
  bus.onNotification((event) => seen.push(event.meta.version));
  bus.onChange({ type: 'appSnapshot' });
  raise('update-ready', ready('1.4.6'));
  assert.deepEqual(seen, ['1.4.6']);
  raise('update-ready', ready('1.4.7'));
  assert.deepEqual(seen, ['1.4.6', '1.4.7']);
});

test('other notices and other sections are not runtime notifications', () => {
  const { bus, raise } = world();
  const seen = [];
  bus.onNotification((event) => seen.push(event));
  raise('secret-storage', { key: 'secret-storage', code: 'secret-storage-failed', params: {} });
  bus.onChange({ type: 'section', section: 'update', key: null });
  assert.deepEqual(seen, []);
});

test('a throwing listener is logged and does not block the others, and an unsubscribed one hears nothing', () => {
  const { bus, raise, logged } = world();
  const seen = [];
  bus.onNotification(() => {
    throw new Error('broken');
  });
  const stop = bus.onNotification((event) => seen.push(event));
  stop();
  const kept = [];
  bus.onNotification((event) => kept.push(event));
  raise('update-ready', ready('1.4.6'));
  assert.equal(seen.length, 0);
  assert.equal(kept.length, 1);
  assert.match(logged[0], /broken/);
  assert.equal(bus.onNotification('not a function'), null);
});