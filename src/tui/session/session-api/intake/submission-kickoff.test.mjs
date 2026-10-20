import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionIntake } from './submission.mjs';
import { isQueuedEntryEditable, isQueuedEntryVisible } from '../../queue-helpers.mjs';

function intake() {
  const queued = [];
  const api = createSubmissionIntake({
    nextId: () => 'id-1',
    flags: {},
    getState: () => ({ busy: false, commandBusy: false }),
    enqueue: (text, options) => {
      queued.push({ text, ...options });
      return true;
    },
    autoClearBeforeSubmit: () => {},
  });
  return { api, queued };
}

test('a kickoff submit reaches the queue hidden: no bubble, no queue row, never restored', () => {
  const { api, queued } = intake();
  assert.equal(api.submit('[mixdog-runtime] Greet the user.', { kickoff: true }), true);
  const [entry] = queued;
  assert.equal(entry.suppressDisplay, true);
  assert.equal(entry.isMeta, true);
  assert.equal(entry.restorable, false);
  assert.equal(isQueuedEntryEditable(entry), false);
  assert.equal(isQueuedEntryVisible(entry), false);
});

test('an ordinary submit stays a visible, editable prompt', () => {
  const { api, queued } = intake();
  api.submit('hello');
  assert.equal(queued[0].suppressDisplay, undefined);
  assert.equal(isQueuedEntryVisible(queued[0]), true);
});
