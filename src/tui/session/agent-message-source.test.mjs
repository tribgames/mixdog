import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSteeringEntries } from '../../runtime/agent/orchestrator/session/loop/steering.mjs';
import { restoreTranscriptItems } from './session-api-ext.mjs';

test('restored Agent transcript preserves Lead message attribution', () => {
  const items = restoreTranscriptItems([
    {
      role: 'user',
      content: 'Review this change.',
      meta: { transcript: { at: 1, sender: 'lead' } },
    },
    {
      role: 'user',
      content: 'Please explain the result.',
      meta: { transcript: { at: 2, sender: 'user' } },
    },
  ], { sessionId: 'sess_agent' });

  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'user');
  assert.equal(items[0].sender, 'lead');
  assert.equal(items[0].text, 'Review this change.');
  assert.equal(items[1].kind, 'user');
  assert.equal(items[1].sender, 'user');
  assert.equal(items[1].text, 'Please explain the result.');
});

test('busy Agent steering keeps User attribution metadata', () => {
  const merged = mergeSteeringEntries([{
    id: 'desktop-message',
    content: 'Can you clarify?',
    transcriptMeta: { sender: 'user' },
  }]);
  assert.deepEqual(merged.transcriptMeta, { sender: 'user' });
});
