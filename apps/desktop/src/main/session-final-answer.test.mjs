import assert from 'node:assert/strict';
import test from 'node:test';
import { isSessionMissingError, sessionFinalAnswer, SESSION_NOT_AVAILABLE_CODE } from './session-final-answer.ts';
import { SessionHost } from './session-host.ts';
import { restoreTranscriptItems } from '../../../../src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs';

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
  const messages = [
    { role: 'user', content: 'Check this' },
    { role: 'assistant', content: 'Progress, not the final reply' },
    {
      role: 'assistant',
      content: 'Background answer',
      meta: {
        transcript: { at: 2_000, completion: { status: 'done', elapsedMs: 1_000 } },
      },
    },
  ];
  for (const itemLimit of [Infinity, 2]) {
    const items = restoreTranscriptItems(messages, { sessionId: 'stored', itemLimit });
    const answer = sessionFinalAnswer(snapshot(items), 1_000);
    assert.equal(answer?.text, 'Background answer');
    assert.equal(answer?.status, 'done');
    assert.equal(answer?.at, 2_000);
  }
  messages[2].meta.transcript.completion.status = 'failed';
  const items = restoreTranscriptItems(messages);
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

test('the host reads the requested session without selecting it or publishing its state', async () => {
  const reads = [];
  const state = snapshot([assistant('final', 'Background session answer'), done('turn', 'final')]);
  const result = await SessionHost.prototype.readSessionFinalAnswer.call(
    {
      readSession: async (...args) => {
        reads.push(args);
        return state;
      },
    },
    'background-session',
    1_000
  );
  assert.deepEqual(reads, [['background-session', false, false, undefined, false, undefined]]);
  assert.equal(result.text, 'Background session answer');
});

test('the host passes the abort signal to the session read and tags a missing session', async () => {
  const signal = new AbortController().signal;
  const reads = [];
  const missing = new Error('session gone-session is not available');
  const call = (readSession) =>
    SessionHost.prototype.readSessionFinalAnswer.call({ readSession }, 'gone-session', 1_000, signal);
  await assert.rejects(
    call(async (...args) => {
      reads.push(args);
      throw missing;
    }),
    (error) => error === missing && error.code === SESSION_NOT_AVAILABLE_CODE && isSessionMissingError(error)
  );
  assert.equal(reads[0][5], signal);
  await assert.rejects(
    call(async () => {
      throw new Error('disconnected');
    }),
    (error) => error.code === undefined && !isSessionMissingError(error)
  );
});
