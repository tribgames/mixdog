import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUserConversationMessage, isProtectedContextUserMessage } from './prompt-utils.mjs';
import { sanitizeToolPairs } from '../context-tool-pairs.mjs';

test('a message made only of several system-reminder blocks is protected context', () => {
  const two = { role: 'user', content: '<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>' };
  assert.equal(isProtectedContextUserMessage(two), true);
  assert.equal(hasUserConversationMessage([two]), false);
  const withText = {
    role: 'user',
    content: '<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>\nhi',
  };
  assert.equal(isProtectedContextUserMessage(withText), false);
});

test('sanitizeToolPairs tolerates null and non-object entries', () => {
  const out = sanitizeToolPairs([null, { role: 'user', content: 'x' }, undefined]);
  assert.equal(out.length, 3);
});
