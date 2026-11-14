// This PC's notification preferences come from the core's config key `notifications`: a preference written through
// config/value/write is what the next toast, Browser Use approval toast and taskbar-flash decisions follow.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_NOTIFICATION_PREFERENCES } from '../shared/contract-notifications.ts';
import { allowsTaskbarFlash, decideNotification, notificationConversationOf } from './notification-decision.ts';
import { createPcNotificationView, pcNotificationViewOf } from './pc-notification-view.ts';

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const NOON = at(23, 12);
const conversation = notificationConversationOf({ id: 'sess_a', agentHome: 'secretary' });

// A core holding `notifications`: config/value/write sets a path under it and the connection's snapshot shows the result.
function fakeCore() {
  const config = {};
  const setPath = (path, value) => {
    const keys = path.split('.');
    let node = config;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    node[keys.at(-1)] = value;
  };
  return {
    snapshot: () => ({
      entries: 'notifications' in config ? [{ section: 'config', key: 'notifications', value: config.notifications }] : [],
    }),
    write: (path, value) => setPath(path, value),
  };
}

const toast = (view, event = 'finished', foreground = false) =>
  decideNotification({ ...view, event, conversation, now: NOON, foreground });

test('a core that never wrote notifications gives the defaults', () => {
  const view = createPcNotificationView(fakeCore())(NOON);
  assert.deepEqual(view.preferences, DEFAULT_NOTIFICATION_PREFERENCES);
  assert.deepEqual(view.overrides, []);
});

test('a preference written to the core applies to the next toast, approval toast and taskbar flash', () => {
  const core = fakeCore();
  const read = createPcNotificationView(core);
  assert.equal(toast(read(NOON)).notify, true);
  assert.equal(toast(read(NOON), 'approval').notify, true);
  assert.equal(allowsTaskbarFlash(read(NOON), conversation, NOON), true);

  core.write('notifications.devices.pc', { taskbarFlash: false });
  assert.equal(allowsTaskbarFlash(read(NOON), conversation, NOON), false);
  assert.equal(toast(read(NOON)).notify, true);

  core.write('notifications.devices.pc', { events: { approval: false } });
  assert.equal(toast(read(NOON), 'approval').notify, false);

  core.write('notifications.devices.pc', { quietHours: { enabled: true, start: '11:00', end: '13:00' } });
  assert.equal(toast(read(NOON)).notify, false);
  assert.equal(allowsTaskbarFlash(read(NOON), conversation, NOON), false);

  core.write('notifications.devices.pc', { scope: 'off' });
  assert.equal(toast(read(NOON)).notify, false);
});

test('a conversation mute written to the core silences that conversation until it ends', () => {
  const core = fakeCore();
  const read = createPcNotificationView(core);
  core.write('notifications.overrides', [{ target: { kind: 'agent', id: 'secretary' }, setting: { mode: 'muted', until: NOON + 1000 } }]);
  assert.equal(toast(read(NOON)).notify, false);
  assert.equal(allowsTaskbarFlash(read(NOON), conversation, NOON), false);
  // After the end the mute is gone.
  assert.deepEqual(read(NOON + 2000).overrides, []);
  core.write('notifications.overrides', []);
  assert.equal(toast(read(NOON)).notify, true);
});

test('a stored preference that does not validate falls back to the default per field', () => {
  const view = pcNotificationViewOf({ devices: { pc: { taskbarFlash: 'no', scope: 7 } } }, NOON);
  assert.equal(view.preferences.taskbarFlash, DEFAULT_NOTIFICATION_PREFERENCES.taskbarFlash);
  assert.equal(view.preferences.scope, DEFAULT_NOTIFICATION_PREFERENCES.scope);
});
