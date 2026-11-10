import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isSessionMissingError, sessionFinalAnswer, SESSION_NOT_AVAILABLE_CODE, withSessionMissingCode } from './session-final-answer.ts';

// Node's transcript restore went with the Node core; the rows it made of these stored sessions were recorded from it
// (shared/test-recorded/record/record-session-final-answer.mjs).
const RESTORED = JSON.parse(readFileSync(new URL('../shared/test-recorded/session-final-answer.restore.node.json', import.meta.url), 'utf8')).cases;
const restored = (name) => RESTORED.find((entry) => entry.name === name).items;

const assistant = (id, text) => ({ id, kind: 'assistant', text, streaming: false });
const done = (id, finalAssistantId, at = 2_000, status = 'done') => ({
  id,
  kind: 'turndone',
  finalAssistantId,
  at,
  status,
});
const snapshot = (items, extra = {}) => ({ items, busy: false, ...extra });

test('a stored completed session restores the exact answer identity for notifications', () => {
  for (const name of ['done, every item', 'done, last 2 items']) {
    const answer = sessionFinalAnswer(snapshot(restored(name)), 1_000);
    assert.equal(answer?.text, 'Background answer');
    assert.equal(answer?.status, 'done');
    assert.equal(answer?.at, 2_000);
  }
  const items = restored('failed, no options');
  assert.equal(sessionFinalAnswer(snapshot(items), 1_000)?.status, 'failed');
  assert.equal(items.at(-1).finalAssistantId, undefined);
});

test('the completion identifies its final assistant, not user text, progress or tools', () => {
  const state = snapshot([
    { id: 'user', kind: 'user', text: 'First user prompt' },
    assistant('progress', 'I will check this.'),
    { id: 'tool', kind: 'tool', text: 'raw tool output' },
    assistant('final', 'This is the final answer.'),
    done('turn-1', 'final'),
  ]);
  assert.deepEqual(sessionFinalAnswer(state, 1_000), {
    id: 'turn-1',
    at: 2_000,
    status: 'done',
    text: 'This is the final answer.',
  });
});

test('late, streaming, missing and older answers stay pending', () => {
  const items = [assistant('old', 'Old answer'), done('old-turn', 'old', 500)];
  assert.equal(sessionFinalAnswer(snapshot(items), 1_000), null);
  assert.equal(sessionFinalAnswer(snapshot([...items, done('new-turn', 'new')]), 1_000), null);
  assert.equal(sessionFinalAnswer(snapshot([...items, done('new-turn', 'old')]), 1_000), null);
  assert.equal(sessionFinalAnswer(snapshot([assistant('progress', 'Working'), done('new-turn', null)]), 1_000), null);
  const complete = [assistant('final', 'Answer'), done('new-turn', 'final')];
  assert.equal(sessionFinalAnswer(snapshot(complete, { busy: true }), 1_000), null);
  assert.equal(sessionFinalAnswer(snapshot(complete, { streamingTail: assistant('next', '...') }), 1_000), null);
  assert.equal(
    sessionFinalAnswer(snapshot([...complete, { id: 'next', kind: 'user', text: 'Next question' }]), 1_000),
    null
  );
  assert.equal(
    sessionFinalAnswer(
      snapshot([{ ...assistant('final', 'Partial'), streaming: true }, done('new-turn', 'final')]),
      1_000
    ),
    null
  );
});

test('the same wording is still a new answer when another turn produces it', () => {
  const state = snapshot([
    assistant('old', 'Done'),
    done('old-turn', 'old', 500),
    { id: 'user', kind: 'user', text: 'Again' },
    assistant('new', 'Done'),
    done('new-turn', 'new'),
  ]);
  assert.equal(sessionFinalAnswer(state, 1_000).id, 'new-turn');
});

test('a turn answered by a reaction alone is done with nothing to read; an unmarked empty turn stays pending', () => {
  const user = { id: 'user', kind: 'user', text: '고마워' };
  const reacted = { id: 'turn', kind: 'turndone', at: 2_000, status: 'done', reacted: true };
  assert.deepEqual(sessionFinalAnswer(snapshot([user, reacted]), 1_000), {
    id: 'turn',
    at: 2_000,
    status: 'done',
    text: '',
    reacted: true,
  });
  const { reacted: _reacted, ...plain } = reacted;
  assert.equal(sessionFinalAnswer(snapshot([user, plain]), 1_000), null);
  // A reaction beside a reply: the reply is the answer, as before.
  const both = sessionFinalAnswer(
    snapshot([user, assistant('final', 'Congrats!'), { ...reacted, finalAssistantId: 'final' }]),
    1_000
  );
  assert.equal(both.text, 'Congrats!');
  assert.equal(both.reacted, undefined);
});

test('a stopped turn without a final reply is not announced as an answer', () => {
  const state = snapshot([assistant('progress', 'Checking'), done('failed-turn', null, 2_000, 'failed')]);
  assert.deepEqual(sessionFinalAnswer(state, 1_000), { id: 'failed-turn', at: 2_000, status: 'failed', text: '' });
});

// The two host cases read through Node's SessionHost (session-host.ts), which went with the Node core: the core answers
// `thread/finalAnswer/read` now (uncovered-cases.md). The missing-session tag the desktop applies stays here.
test('a missing session is tagged with the code the desktop reads; another failure is not', () => {
  const missing = withSessionMissingCode(new Error('session gone-session is not available'));
  assert.equal(missing.code, SESSION_NOT_AVAILABLE_CODE);
  assert.equal(isSessionMissingError(missing), true);
  const other = withSessionMissingCode(new Error('disconnected'));
  assert.equal(other.code, undefined);
  assert.equal(isSessionMissingError(other), false);
});
