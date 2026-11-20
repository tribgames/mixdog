import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base64OfDataUrl,
  blockerLabel,
  continueWithoutRequest,
  chosenAmong,
  imageRefusalOf,
  recoveryStateOf,
  replaceRequest,
  undoRequest,
} from './image-refusal';

test('what was chosen is read from the stored choices, so it can be put back after the conversation is reopened', () => {
  const state = recoveryStateOf({
    edits: [{ messageId: 'row-7', part: 2, choice: 'continueWithout' }],
    newContextAt: null,
    gate: {
      state: 'repair',
      images: [{ messageId: 'row-3', part: null, message: 'x', actions: ['newBranchWithoutContext'] }],
    },
  });
  assert.deepEqual(chosenAmong(state, refusal.blockers), [{ messageId: 'row-7', part: 2 }]);
  assert.equal(state.gate.images[0].part, null);
  assert.equal(state.choicesUnreadable, false);
  const unreadable = recoveryStateOf({
    edits: [],
    newContextAt: null,
    choicesUnreadable: true,
    gate: { state: 'checking', done: 1, total: 4 },
  });
  assert.equal(unreadable.choicesUnreadable, true);
  assert.deepEqual(unreadable.gate, { state: 'checking', done: 1, total: 4 });
  assert.equal(recoveryStateOf({ edits: [], gate: { state: 'later' } }), null, 'a malformed answer is not guessed at');
});

const refusal = {
  blockers: [
    { messageId: 'row-7', part: 2, name: 'scan.heic', message: 'Nothing…', actions: ['replace', 'continueWithout'] },
    { messageId: 'row-9', part: 0, name: '', message: 'Another…', actions: ['replace', 'continueWithout'] },
  ],
  newContextOffered: true,
  message: 'Nothing was sent. …',
};

test('a failure carries its image refusal in errorKind, and any other failure carries none', () => {
  const read = imageRefusalOf({ kind: 'unknown', imageRefusal: refusal });
  assert.equal(read.blockers.length, 2);
  assert.deepEqual(read.blockers[0], refusal.blockers[0]);
  assert.equal(read.newContextOffered, true);
  assert.equal(imageRefusalOf({ kind: 'unknown' }), null);
  assert.equal(imageRefusalOf(undefined), null);
  assert.equal(imageRefusalOf({ imageRefusal: { blockers: [] } }), null);
  assert.equal(
    imageRefusalOf({ imageRefusal: { blockers: [{ messageId: 5, part: 'x' }] } }),
    null,
    'a malformed one is not guessed at'
  );
});

test('each fix is the request the core method takes, naming the images by message and position', () => {
  const read = imageRefusalOf({ imageRefusal: refusal });
  assert.deepEqual(continueWithoutRequest(read.blockers), {
    type: 'continueWithout',
    images: [
      { messageId: 'row-7', part: 2 },
      { messageId: 'row-9', part: 0 },
    ],
  });
  assert.deepEqual(undoRequest([read.blockers[1]]), { type: 'undo', images: [{ messageId: 'row-9', part: 0 }] });
  assert.deepEqual(replaceRequest(read.blockers[0], 'AAAA', 'new.png'), {
    type: 'replace',
    image: { messageId: 'row-7', part: 2 },
    data: 'AAAA',
    name: 'new.png',
  });
});

test('an image is called by its file name, else by its place; a picked file is sent as its base64', () => {
  assert.equal(blockerLabel(refusal.blockers[0], 0), 'scan.heic');
  assert.equal(blockerLabel(refusal.blockers[1], 1), '#2');
  assert.equal(base64OfDataUrl('data:image/png;base64,AAAA'), 'AAAA');
  assert.equal(base64OfDataUrl('data:text/plain,hello'), null);
});
