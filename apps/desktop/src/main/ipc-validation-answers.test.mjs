import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredToolApprovalDecision } from './ipc-validation.ts';

test('tool approval decision carries a trimmed ask_user reply', () => {
  assert.equal(requiredToolApprovalDecision({ approved: true, reply: '  hi there ' }).reply, 'hi there');
  assert.equal(requiredToolApprovalDecision({ approved: true }).reply, undefined);
  for (const bad of [5, 'x'.repeat(4001)]) {
    assert.throws(() => requiredToolApprovalDecision({ approved: true, reply: bad }), TypeError);
  }
  assert.throws(() => requiredToolApprovalDecision({ approved: true, extra: 1 }), TypeError);
});

test('tool approval decision carries validated ask_user answers', () => {
  const answers = [null, { selected: ['A', 'B'] }, { selected: [], text: 'mine' }];
  assert.deepEqual(requiredToolApprovalDecision({ approved: true, answers }).answers, answers);
  assert.equal(requiredToolApprovalDecision({ approved: false, reason: 'dismissed by user' }).answers, undefined);
  for (const bad of [
    'x',
    [null, null, null, null, null],
    [{}],
    [{ selected: 'A' }],
    [{ selected: ['a', 'b', 'c', 'd', 'e'] }],
    [{ selected: ['x'.repeat(201)] }],
    [{ selected: [], text: 'x'.repeat(4001) }],
    [{ selected: [], text: 5 }],
    [{ selected: [], extra: 1 }],
    [[]],
  ]) {
    assert.throws(() => requiredToolApprovalDecision({ approved: true, answers: bad }), TypeError);
  }
});
