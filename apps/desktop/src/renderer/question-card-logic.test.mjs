import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalQuestions,
  buildAnswers,
  emptyDraft,
  initQuestionState,
  pickOption,
  primaryAction,
  queuedPlainAnswer,
  questionAwareSubmit,
  steerQueuedAsAnswer,
  questionReducer,
  typeText,
} from './question-card-logic.ts';

const questions = [
  { question: 'a?', header: 'A', options: [{ label: 'x' }, { label: 'y' }] },
  { question: 'b?', header: 'B', options: [{ label: 'p' }, { label: 'q' }], multi_select: true },
];

test('a plain composer message answers the question and is not sent again', async () => {
  const calls = [];
  const submit = async (content, options) => (calls.push(['submit', content, options]), 'sent');
  const answer = async (reply) => (calls.push(['answer', reply]), true);
  const dismiss = async () => (calls.push(['dismiss']), true);
  const wrapped = questionAwareSubmit(submit, answer, dismiss);
  assert.equal(await wrapped('  hello  ', { id: 'x' }), true);
  assert.deepEqual(calls, [['answer', 'hello']]);
  // A refused answer (another device answered first) is not accepted.
  const refused = questionAwareSubmit(submit, async () => false, dismiss);
  assert.equal(await refused('hi'), false);
});

test('a reply over the 4000-character cap goes out whole as a message instead of being cut', async () => {
  const calls = [];
  const wrapped = questionAwareSubmit(
    async (content) => (calls.push(['submit', content.length]), 'sent'),
    async (reply) => (calls.push(['answer', reply.length]), true),
    async () => (calls.push(['dismiss']), true)
  );
  assert.equal(await wrapped('x'.repeat(4000)), true);
  assert.equal(await wrapped('y'.repeat(4001)), 'sent');
  assert.deepEqual(calls, [['answer', 4000], ['dismiss'], ['submit', 4001]]);
});

test('attachments and slash commands dismiss the question, then submit', async () => {
  for (const [content, options] of [
    ['look', { pastedImages: { 1: { id: 1 } } }],
    ['see [Pasted text #1]', { pastedTexts: { 1: { id: 1 } } }],
    ['/model', undefined],
    [[{ type: 'text', text: 'parts' }], undefined],
  ]) {
    const calls = [];
    const wrapped = questionAwareSubmit(
      async (c, o) => (calls.push(['submit', c, o]), 'sent'),
      async () => (calls.push(['answer']), true),
      async () => (calls.push(['dismiss']), true)
    );
    assert.equal(await wrapped(content, options), 'sent');
    assert.deepEqual(calls, [['dismiss'], ['submit', content, options]]);
  }
});

test('send path: a failed or throwing answer never enqueues the text', async () => {
  for (const answer of [
    async () => false,
    async () => {
      throw new Error('offline');
    },
  ]) {
    const calls = [];
    const wrapped = questionAwareSubmit(
      async () => (calls.push('submit'), true),
      answer,
      async () => (calls.push('dismiss'), true)
    );
    const outcome = await wrapped('plain', { id: 'q1' }).catch((error) => error.message);
    assert.ok(outcome === false || outcome === 'offline');
    assert.deepEqual(calls, []);
  }
});

test('queue path: only plain queued follow-ups answer', () => {
  assert.equal(queuedPlainAnswer({ id: 'a', text: ' yes ' }), 'yes');
  assert.equal(queuedPlainAnswer({ id: 'a', text: '/model' }), null);
  assert.equal(queuedPlainAnswer({ id: 'a', text: 'look', images: [{ id: 1 }] }), null);
  assert.equal(queuedPlainAnswer({ id: 'a', text: 'look', pastedTexts: { 1: { id: 1 } } }), null);
  assert.equal(queuedPlainAnswer({ id: 'a', text: 'x', images: [], pastedImages: {} }), 'x');
});

test('steer path: Steer now answers the question instead of interrupting', async () => {
  const answers = [];
  const ok = await steerQueuedAsAnswer(
    async () => ' go ',
    async (reply) => (answers.push(reply), true)
  );
  assert.deepEqual(ok, { text: 'go', answered: true });
  assert.deepEqual(answers, ['go']);
  // A refused or throwing answer hands the text back for the composer.
  assert.deepEqual(
    await steerQueuedAsAnswer(
      async () => 'go',
      async () => false
    ),
    { text: 'go', answered: false }
  );
  assert.deepEqual(
    await steerQueuedAsAnswer(
      async () => 'go',
      async () => {
        throw new Error('x');
      }
    ),
    { text: 'go', answered: false }
  );
  // Nothing restored from the queue: nothing is answered.
  assert.deepEqual(
    await steerQueuedAsAnswer(
      async () => undefined,
      async () => true
    ),
    { text: '', answered: false }
  );
});

test('adaptive primary button', () => {
  let drafts = questions.map(emptyDraft);
  assert.equal(primaryAction(drafts, 0), 'skip');
  assert.equal(primaryAction(drafts, 1), 'close');
  drafts = [pickOption(drafts[0], 1, false), drafts[1]];
  assert.equal(primaryAction(drafts, 0), 'next');
  assert.equal(primaryAction(drafts, 1), 'send');
  assert.equal(primaryAction([emptyDraft()], 0), 'close');
});

test('picking clears text, typing clears picks, answers align by index', () => {
  let d = typeText(pickOption(emptyDraft(), 0, true), 'free');
  assert.deepEqual(d, { selected: [], text: 'free' });
  d = pickOption(d, 1, true);
  d = pickOption(d, 0, true);
  assert.deepEqual(d, { selected: [0, 1], text: '' });
  assert.deepEqual(buildAnswers(questions, [emptyDraft(), d]), [null, { selected: ['p', 'q'] }]);
  assert.deepEqual(buildAnswers(questions, [typeText(emptyDraft(), ' hi '), emptyDraft()]), [
    { selected: [], text: 'hi' },
    null,
  ]);
});

test('rapid multi-select picks all land (no lost updates)', () => {
  let state = initQuestionState(questions);
  state = questionReducer(state, { type: 'step', delta: 1 });
  // Two picks dispatched before any render both apply to the latest state.
  state = questionReducer(state, { type: 'pick', option: 0 });
  state = questionReducer(state, { type: 'pick', option: 1 });
  assert.deepEqual(state.drafts[1].selected, [0, 1]);
  assert.deepEqual(buildAnswers(questions, state.drafts), [null, { selected: ['p', 'q'] }]);
  state = questionReducer(state, { type: 'text', value: 'x' });
  assert.deepEqual(state.drafts[1], { selected: [], text: 'x' });
  assert.equal(questionReducer(state, { type: 'step', delta: 5 }).index, 1);
  assert.equal(questionReducer(state, { type: 'go', index: -3 }).index, 0);
});

test('approvalQuestions rejects missing questions', () => {
  assert.equal(approvalQuestions({}), null);
  assert.equal(approvalQuestions({ questions: questions }).length, 2);
});

test('approvalQuestions keeps each option tradeoff for the card', () => {
  const [q] = approvalQuestions({
    questions: [
      { question: 'Q?', header: 'h', options: [{ label: 'A', description: 'Fast, local only.' }, { label: 'B' }] },
    ],
  });
  assert.deepEqual(q.options, [
    { label: 'A', description: 'Fast, local only.' },
    { label: 'B', description: '' },
  ]);
});
