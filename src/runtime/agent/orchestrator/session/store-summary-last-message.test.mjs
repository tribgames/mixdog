import assert from 'node:assert/strict';
import test from 'node:test';

import { incomingTailOf, lastMessageSummary } from './store-summary-last-message.mjs';

test('a routine "nothing new" reply is neither the last line nor an incoming message', () => {
  const messages = [
    { role: 'assistant', content: 'Two new issues: #221, #222.' },
    { role: 'assistant', content: 'ROUTINE_QUIET' },
  ];
  assert.equal(lastMessageSummary(messages).lastMessagePreview, 'Two new issues: #221, #222.');
  assert.equal(incomingTailOf(messages).includes(2), false);
});

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
