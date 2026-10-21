import assert from 'node:assert/strict';
import test from 'node:test';

import { lastMessageSummary } from './store-summary-last-message.mjs';

const notification = (id) =>
  ['<task-notification>', `<task-id>${id}</task-id>`, '<status>completed</status>', '</task-notification>'].join('\n');

test('a runtime task notification never becomes the last-message line', () => {
  const summary = lastMessageSummary([
    { role: 'assistant', content: 'Two helpers are on it.' },
    { role: 'user', content: `${notification('t1')}\n${notification('t2')}` },
  ]);
  assert.equal(summary.lastMessagePreview, 'Two helpers are on it.');
});

test('prose that only mentions the tag still previews', () => {
  const summary = lastMessageSummary([{ role: 'user', content: 'why does <task-notification> show up here?' }]);
  assert.equal(summary.lastMessagePreview, 'why does <task-notification> show up here?');
});
