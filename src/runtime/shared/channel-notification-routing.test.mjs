import assert from 'node:assert/strict';
import test from 'node:test';

import {
  channelNotificationModelContent,
  channelNotificationSessionId,
} from './channel-notification-routing.mjs';

test('channel inbound targets the reserved session before first chat', () => {
  assert.equal(channelNotificationSessionId(null, 'sess_reserved'), 'sess_reserved');
  assert.equal(channelNotificationSessionId({ id: 'sess_live' }, 'sess_reserved'), 'sess_live');
  assert.equal(channelNotificationSessionId(null, null), null);
});

test('channel inbound content and silent routing remain explicit', () => {
  assert.equal(channelNotificationModelContent({ content: 'discord inbound' }), 'discord inbound');
  assert.equal(channelNotificationModelContent({
    content: 'ignored',
    meta: { instruction: 'respond now' },
  }), 'respond now');
  assert.equal(channelNotificationModelContent({
    content: 'ignored',
    meta: { silent_to_agent: true },
  }), '');
});
