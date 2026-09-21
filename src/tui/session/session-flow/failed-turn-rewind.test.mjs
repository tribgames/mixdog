import assert from 'node:assert/strict';
import test from 'node:test';
import { rewoundFailedTurnItems } from './failed-turn-rewind.mjs';

const PROMPT = '전체 테스트 돌려줘';
const history = [
  { kind: 'user', id: 1, text: 'hi' },
  { kind: 'assistant', id: 2, text: 'hello' },
  { kind: 'turndone', id: 3, status: 'done' },
];
const failedPrompt = { kind: 'user', id: 4, text: PROMPT };
const failure = [
  { kind: 'notice', id: 5, text: 'Our servers are currently overloaded.', tone: 'error' },
  { kind: 'turndone', id: 6, status: 'failed', detail: 'Our servers are currently overloaded.' },
];

test('an output-less failed turn is dropped when its prompt is resubmitted', () => {
  assert.deepEqual(rewoundFailedTurnItems([...history, failedPrompt, ...failure], `${PROMPT} `), history);
});

test('a failed turn with assistant or tool activity stays so the retry continues below it', () => {
  for (const activity of [
    { kind: 'tool', id: 7, name: 'shell' },
    { kind: 'assistant', id: 8, text: 'partial' },
  ]) {
    assert.equal(rewoundFailedTurnItems([...history, failedPrompt, activity, ...failure], PROMPT), null);
  }
});

test('a completed turn, a different prompt or an empty transcript never rewinds', () => {
  assert.equal(
    rewoundFailedTurnItems([...history, failedPrompt, { kind: 'turndone', id: 9, status: 'done' }], PROMPT),
    null
  );
  assert.equal(
    rewoundFailedTurnItems([...history, failedPrompt, ...failure], 'Continue from where you left off.'),
    null
  );
  assert.equal(rewoundFailedTurnItems([...history, failedPrompt, ...failure], ''), null);
  assert.equal(rewoundFailedTurnItems([], PROMPT), null);
});
