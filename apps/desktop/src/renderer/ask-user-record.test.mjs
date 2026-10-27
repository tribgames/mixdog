import assert from 'node:assert/strict';
import test from 'node:test';

import { holdsWaitingAskUser, splitAskUser } from './ask-user-record.tsx';
import { askUserAnswers, askUserChatReply } from './transcript-tool-result.ts';

const ask = (id, result) => ({
  kind: 'tool',
  id,
  name: 'ask_user',
  args: { questions: [] },
  ...(result ? { result } : {}),
});
const read = (id) => ({ kind: 'tool', id, name: 'read', args: {}, result: 'ok', completedAt: 1 });
const answered = 'User has answered your questions: "Q?"="A". You can now continue with these answers in mind.';

test('questions leave a roll-up; counts follow only what was completed', () => {
  const aggregate = {
    kind: 'tool',
    id: 'g',
    aggregate: true,
    count: 3,
    completedCount: 2,
    toolMembers: [read('r'), ask('done', answered), ask('wait')],
  };
  const { rest, asked, waiting } = splitAskUser([aggregate], true);
  assert.deepEqual(
    asked.map((item) => item.id),
    ['done']
  );
  assert.equal(waiting, true);
  assert.equal(rest.length, 1);
  assert.deepEqual(
    rest[0].toolMembers.map((item) => item.id),
    ['r']
  );
  assert.equal(rest[0].count, 1);
  assert.equal(rest[0].completedCount, 1, 'the completed read stays completed');
  // Without a live card a waiting question stays in the roll-up.
  assert.equal(splitAskUser([aggregate], false).waiting, false);
  assert.equal(holdsWaitingAskUser(aggregate), true);
  assert.equal(holdsWaitingAskUser(ask('done', answered)), false);
});

test('a question asked through the call_tool bridge is still a question', () => {
  const bridged = {
    kind: 'tool',
    id: 'b',
    name: 'call_tool',
    args: { name: 'ask_user', arguments: { questions: [] } },
  };
  assert.equal(holdsWaitingAskUser(bridged), true);
  assert.equal(splitAskUser([bridged], true).waiting, true);
  assert.deepEqual(
    splitAskUser([{ ...bridged, result: answered }], true).asked.map((item) => item.id),
    ['b']
  );
  assert.equal(holdsWaitingAskUser({ ...bridged, args: { name: 'read', arguments: {} } }), false);
});

test("a handoff (handoff_user, or an older transcript's ask_user handoff) waits and settles as a card", () => {
  const handoff = { kind: 'takeover', surface: 'browser', instructions: 'Solve the CAPTCHA' };
  const calls = [
    { kind: 'tool', id: 'h1', name: 'handoff_user', args: { handoff } },
    { kind: 'tool', id: 'h2', name: 'ask_user', args: { handoff } },
    { kind: 'tool', id: 'h3', name: 'call_tool', args: { name: 'handoff_user', arguments: { handoff } } },
  ];
  for (const call of calls) {
    assert.equal(holdsWaitingAskUser(call), true, call.id);
    assert.equal(splitAskUser([call], true).waiting, true, call.id);
    assert.deepEqual(
      splitAskUser([{ ...call, result: 'User pressed Done' }], true).asked.map((item) => item.id),
      [call.id]
    );
  }
});

test('a chat reply leads the result and the picks still parse', () => {
  const both =
    'User replied in chat: "keep \\"it\\"". User has answered your questions: "q1"="PG"; "q2"=(no answer). You can now continue with these answers in mind.';
  assert.deepEqual(askUserChatReply(both).reply, 'keep "it"');
  assert.deepEqual(Object.fromEntries(askUserAnswers(both)), {
    q1: { picked: 'PG', typed: '' },
    q2: { picked: '', typed: '' },
  });
  const only = 'User replied in chat: "hi". You can now continue with these answers in mind.';
  assert.equal(askUserChatReply(only).reply, 'hi');
  assert.equal(askUserAnswers(only).size, 0);
  assert.equal(askUserChatReply(answered).reply, '');
});

test('answers parse picks and typed text apart, quotes included', () => {
  const result =
    'User has answered your questions: "A \\"x\\"?"="A, B" + "mine, too" (typed); "Typed?"="free" (typed); "None?"=(no answer). You can now continue with these answers in mind.';
  assert.deepEqual(Object.fromEntries(askUserAnswers(result)), {
    'A "x"?': { picked: 'A, B', typed: 'mine, too' },
    'Typed?': { picked: '', typed: 'free' },
    'None?': { picked: '', typed: '' },
  });
  assert.equal(askUserAnswers('User closed the questions without answering.').size, 0);
});
