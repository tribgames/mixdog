import assert from 'node:assert/strict';
import test from 'node:test';

import { NOTIFICATION_BODY_CHARS, NOTIFICATION_TITLE_CHARS, boundedNotification } from './server-notifier.ts';

test('server notifications are bounded and keep the server label first', () => {
  const long = 'x'.repeat(500);
  const bounded = boundedNotification({ title: `Box · ${long}\nsecond`, body: long });
  assert.equal([...bounded.title].length, NOTIFICATION_TITLE_CHARS);
  assert.ok(bounded.title.startsWith('Box · '));
  assert.ok(bounded.title.endsWith('…'));
  assert.ok(!bounded.title.includes('\n'));
  assert.equal([...bounded.body].length, NOTIFICATION_BODY_CHARS);
});
