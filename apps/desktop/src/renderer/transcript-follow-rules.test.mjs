import assert from 'node:assert/strict';
import test from 'node:test';
import { scrollShouldReattachFollow } from './transcript-follow-rules';

const at = (top) => ({ top, maxScrollTop: 570, viewportHeight: 600 });

test('an upward frame inside the bottom band does not re-attach follow', () => {
  // The first smooth-scroll frame of the wheel notch that released follow.
  assert.equal(scrollShouldReattachFollow(at(564), 570), false);
});

test('arriving at or settling on the bottom re-attaches follow', () => {
  assert.equal(scrollShouldReattachFollow(at(566), 500), true);
  assert.equal(scrollShouldReattachFollow(at(565), 565), true);
  assert.equal(scrollShouldReattachFollow(at(540), 400), true);
  assert.equal(scrollShouldReattachFollow(at(300), 200), false);
});
