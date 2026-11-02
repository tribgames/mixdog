import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearDesktopNotice,
  deliverPendingDesktopNotices,
  raiseDesktopNotice,
  registerDesktopNoticeSink,
} from './desktop-notice-host.mjs';

test('a notice raised before any sink waits for the first one, and a cleared one is dropped', () => {
  assert.equal(raiseDesktopNotice('early:a', 'secret-storage-failed'), true);
  assert.equal(raiseDesktopNotice('early:b', 'conversation-save-failed', { name: 7 }), true);
  clearDesktopNotice('early:b');
  const received = [];
  const unregister = registerDesktopNoticeSink((notice) => received.push(notice));
  try {
    assert.deepEqual(received, [{ key: 'early:a', code: 'secret-storage-failed', params: {} }]);
  } finally {
    unregister();
  }
});

test('a notice no sink could deliver waits, one per key, for the next delivery chance', (t) => {
  let attached = false;
  const received = [];
  t.after(
    registerDesktopNoticeSink((notice) => {
      if (!attached) return false;
      received.push(notice.key);
      return true;
    })
  );
  raiseDesktopNotice('late:storage', 'secret-storage-failed');
  raiseDesktopNotice('late:save', 'conversation-save-failed');
  raiseDesktopNotice('late:storage', 'secret-storage-failed');
  assert.deepEqual(received, [], 'nobody attached yet');
  deliverPendingDesktopNotices();
  assert.deepEqual(received, [], 'still nobody: the notices keep waiting');
  attached = true;
  deliverPendingDesktopNotices();
  assert.deepEqual(received, ['late:storage', 'late:save'], 'each once, to the client that attached');
  deliverPendingDesktopNotices();
  assert.deepEqual(received, ['late:storage', 'late:save'], 'delivered notices do not wait again');
});

test('one condition is told once until it is cleared, to every sink', () => {
  const first = [];
  const second = [];
  const unregisterFirst = registerDesktopNoticeSink((notice) => first.push(notice));
  const unregisterSecond = registerDesktopNoticeSink((notice) => second.push(notice));
  try {
    assert.equal(raiseDesktopNotice('cond:x', 'provider-sign-in-expired', { name: 'Anthropic' }), true);
    assert.equal(raiseDesktopNotice('cond:x', 'provider-sign-in-expired', { name: 'Anthropic' }), false);
    assert.equal(first.length, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(first[0], { key: 'cond:x', code: 'provider-sign-in-expired', params: { name: 'Anthropic' } });
    clearDesktopNotice('cond:x');
    assert.equal(raiseDesktopNotice('cond:x', 'provider-sign-in-expired', { name: 'Anthropic' }), true);
    assert.equal(first.length, 2, 'raised again once the condition changed');
  } finally {
    unregisterFirst();
    unregisterSecond();
  }
});
