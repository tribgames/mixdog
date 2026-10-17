import assert from 'node:assert/strict';
import test from 'node:test';
import { isScratchConversation, isScratchSession } from './shared.mjs';

test('empty and instruction-only sessions remain scratch conversations', () => {
  assert.equal(isScratchConversation(), true);
  assert.equal(isScratchConversation([{ role: 'system', content: 'instructions' }], []), true);
});

test('a notification turn with a recorded outcome is retained for every session owner', () => {
  const message = {
    role: 'user',
    content: '<system-reminder>Internal notification.</system-reminder>',
    meta: { transcript: { completion: { status: 'failed', detail: 'Provider usage limit reached.' } } },
  };
  for (const owner of ['user', 'agent']) {
    assert.equal(isScratchSession({ owner, messages: [message] }), false);
    assert.equal(isScratchSession({ owner, messages: [], liveTurnMessages: [message] }), false);
  }
});
