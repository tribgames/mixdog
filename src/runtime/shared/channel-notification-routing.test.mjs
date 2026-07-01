import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelNotificationModelContent,
  shouldMirrorChannelNotificationToPending,
} from './channel-notification-routing.mjs';

test('channel schedule notification uses instruction as model content', () => {
  const content = channelNotificationModelContent({
    content: ' ',
    meta: {
      type: 'schedule',
      instruction: 'scheduled prompt body',
    },
  });
  assert.equal(content, 'scheduled prompt body');
});

test('silent channel notification has no model content', () => {
  const content = channelNotificationModelContent({
    content: 'hidden',
    meta: {
      type: 'schedule',
      silent_to_agent: true,
    },
  });
  assert.equal(content, '');
});

test('non-schedule notification preserves instruction-first routing', () => {
  const content = channelNotificationModelContent({
    content: 'worker result body',
    meta: {
      type: 'webhook',
      instruction: 'relay instruction',
    },
  });
  assert.equal(content, 'relay instruction');
});

test('only schedule channel notifications are mirrored to pending fallback', () => {
  assert.equal(shouldMirrorChannelNotificationToPending({ type: 'schedule' }), true);
  assert.equal(shouldMirrorChannelNotificationToPending({ type: 'webhook' }), false);
  assert.equal(shouldMirrorChannelNotificationToPending({}), false);
});
