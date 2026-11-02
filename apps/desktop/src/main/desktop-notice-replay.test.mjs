import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverPendingDesktopNotices,
  raiseDesktopNotice,
  registerDesktopNoticeSink,
} from '../../../../src/runtime/shared/desktop-notice-host.mjs';
import { DESKTOP_NOTICE_EVENT } from '../shared/desktop-notice.ts';
import { desktopNoticeSink } from './desktop-service.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';

test('a notice that waited for a desktop is replayed to the window only: the phone shows it once', (t) => {
  let desktopAttached = false;
  const windowNotices = [];
  const phoneFrames = [];
  const emit = (message) => {
    if (!desktopAttached) return false;
    windowNotices.push(message.value.key);
    return true;
  };
  // The service's event bus: the window, then the in-process relay.
  let relay = () => {};
  const publishDesktopEvent = (name, value) => {
    const delivered = emit({ kind: 'desktop-event', name, value }) !== false;
    relay({ name, value });
    return delivered;
  };
  const push = createRelayPushLanes({
    clients: new Map([['phone', { lanes: new Set(['state']) }]]),
    subscribeDesktopEvents: (listener) => {
      relay = listener;
      return () => {};
    },
    broadcastEncrypted: (payload) => {
      if (payload.event === DESKTOP_NOTICE_EVENT) phoneFrames.push(payload.payload.key);
    },
  });
  t.after(() => push.dispose());
  t.after(registerDesktopNoticeSink(desktopNoticeSink(emit, publishDesktopEvent)));

  raiseDesktopNotice('conversation-save', 'conversation-save-failed');
  assert.deepEqual(phoneFrames, ['conversation-save'], 'the phone hears it at once');
  assert.deepEqual(windowNotices, [], 'no window yet');

  desktopAttached = true;
  deliverPendingDesktopNotices();
  assert.deepEqual(windowNotices, ['conversation-save'], 'the window that attached gets it');
  assert.deepEqual(phoneFrames, ['conversation-save'], 'the replay does not reach the phone again');
});
