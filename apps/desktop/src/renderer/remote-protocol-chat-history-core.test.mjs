import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeHistory, nodeSide, onlyTheStepFollows } from './remote-protocol-chat-history-core.mjs';

/** The recorded approval frame and the frame after it (the step), from Node's recording. */
function recordedStep() {
  const states = nodeSide(nodeHistory('running-approval-pending')).history.filter((h) => h.kind === 'state');
  const at = states.findIndex((h) => h.interim);
  return { before: states[at].value, after: states[at + 1].value };
}
const changed = (after, fields) => ({ ...structuredClone(after), ...fields });

test('the recorded approval frame is followed by exactly its step', () => {
  const { before, after } = recordedStep();
  assert.equal(onlyTheStepFollows(before, after), true);
});

test('a step that appends no row, two rows, or jumps the revision is a difference', () => {
  const { before, after } = recordedStep();
  assert.equal(onlyTheStepFollows(before, changed(after, { items: before.items, structureRevision: before.structureRevision })), false, 'zero rows');
  assert.equal(onlyTheStepFollows(before, changed(after, { items: before.items })), false, 'no row, revision moved');
  const row = after.items[after.items.length - 1];
  assert.equal(onlyTheStepFollows(before, changed(after, { items: [...after.items, row], structureRevision: after.structureRevision + 1 })), false, 'two rows');
  assert.equal(onlyTheStepFollows(before, changed(after, { structureRevision: before.structureRevision + 7 })), false, 'revision jump');
});

test('a step that also changes an unrelated field is a difference', () => {
  const { before, after } = recordedStep();
  assert.equal(onlyTheStepFollows(before, changed(after, { goal: 'something else' })), false);
  assert.equal(onlyTheStepFollows(before, changed(after, { workspace: 'elsewhere' })), false);
});
