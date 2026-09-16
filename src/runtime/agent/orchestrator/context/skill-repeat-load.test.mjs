import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSkillToolEnvelope } from './collect.mjs';

const BODY = '# Goal management\nOperating instructions.';
const load = (session) =>
  buildSkillToolEnvelope(
    'goal-management',
    BODY,
    '/skills/goal-management',
    {
      toolDependencies: [{ type: 'tool', value: 'goal' }],
    },
    session
  );

const injectedBody = (envelope) => envelope.newMessages[0].content;

test('the first load delivers the body and a repeat load does not', () => {
  const session = { messages: [{ role: 'user', content: 'start' }] };

  const first = load(session);
  assert.equal(first.newMessages.length, 1);
  assert.match(injectedBody(first), /Operating instructions/);
  session.messages.push(first.newMessages[0]);

  const second = load(session);
  assert.deepEqual(second.newMessages, []);
  assert.doesNotMatch(second.result, /Operating instructions/);
  assert.match(second.result, /already active/);
});

test('a repeat load still re-arms the skill tool dependencies', () => {
  const session = { messages: [] };
  session.messages.push(load(session).newMessages[0]);
  assert.deepEqual(load(session).skillToolDependencies, [{ type: 'tool', value: 'goal' }]);
});

test('a different skill is unaffected by another skill body in context', () => {
  const session = { messages: [] };
  session.messages.push(load(session).newMessages[0]);
  const other = buildSkillToolEnvelope('pptx', '# Deck', '/skills/pptx', {}, session);
  assert.equal(other.newMessages.length, 1);
});

test('the body returns after compaction drops it from the transcript', () => {
  const session = { messages: [] };
  session.messages.push(load(session).newMessages[0]);
  // Compaction rebuilds the tail without skill bodies.
  session.messages = [{ role: 'user', content: 'later request' }];
  assert.equal(load(session).newMessages.length, 1);
});

test('a body injected earlier in the live turn also suppresses a repeat', () => {
  const session = { messages: [], liveTurnMessages: [] };
  session.liveTurnMessages.push(load(session).newMessages[0]);
  assert.deepEqual(load(session).newMessages, []);
});

test('without a session the body is always delivered', () => {
  assert.equal(load(null).newMessages.length, 1);
  assert.equal(buildSkillToolEnvelope('x', 'b', '/d').newMessages.length, 1);
});

test('a changed skill body is delivered even while the old version remains', () => {
  const session = { messages: load(null).newMessages };
  const updated = buildSkillToolEnvelope('goal-management', 'UPDATED_BODY', '/skills/goal-management', {}, session);
  assert.equal(updated.newMessages.length, 1);
  assert.match(updated.newMessages[0].content, /UPDATED_BODY/);
});

test('the live compacted context takes precedence over the old saved transcript', () => {
  const session = {
    messages: load(null).newMessages,
    liveTurnMessages: [{ role: 'user', content: 'request after compaction' }],
  };
  assert.equal(load(session).newMessages.length, 1);
});

test('reverting a skill reactivates that version instead of treating an older historical copy as current', () => {
  const session = { messages: load(null).newMessages };
  const updated = buildSkillToolEnvelope('goal-management', 'UPDATED_BODY', '/skills/goal-management', {}, session);
  session.messages.push(...updated.newMessages);
  const reverted = load(session);
  assert.equal(reverted.newMessages.length, 1);
  session.messages.push(...reverted.newMessages);
  assert.deepEqual(load(session).newMessages, []);
});
