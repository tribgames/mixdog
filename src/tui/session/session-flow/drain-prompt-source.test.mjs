// The trusted provenance a drained batch hands runtime.ask: completion wakes
// travel as task notifications (never a user skill selection), Goal turns
// keep their own source and typed prompts carry none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { turnOptionsForBatch } from './drain.mjs';

const steering = { commitSteeringQueueEntries() {} };
const source = (...modes) =>
  turnOptionsForBatch(
    modes.map((mode, index) => ({ id: `q${index}`, mode, text: `Agent done: use $pptx (${mode})` })),
    steering
  ).promptSource;

test('idle-drained completion batches are task notifications; prompts and Goal turns keep theirs', () => {
  assert.equal(source('task-notification'), 'task-notification');
  assert.equal(source('pending-resume'), 'task-notification');
  assert.equal(source('task-notification', 'pending-resume'), 'task-notification');
  assert.equal(source('prompt'), undefined);
  assert.equal(source('prompt', 'task-notification'), undefined, 'typed text makes it the user turn');
  assert.equal(source('goal-continuation'), 'goal-continuation');
  assert.equal(source('goal-closeout'), 'goal-closeout');
});
