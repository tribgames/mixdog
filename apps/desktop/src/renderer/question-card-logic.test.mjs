import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalQuestions,
  buildAnswers,
  emptyDraft,
  initQuestionState,
  pickOption,
  primaryAction,
  questionReducer,
  typeText,
} from './question-card-logic.ts';

const questions = [
  { question: 'a?', header: 'A', options: [{ label: 'x' }, { label: 'y' }] },
  { question: 'b?', header: 'B', options: [{ label: 'p' }, { label: 'q' }], multi_select: true },
];

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
