import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptEndReached } from './transcript-follow-rules';

const at = (top) => ({ top, maxScrollTop: 570, viewportHeight: 600 });

test('only the very end of the content counts as reaching the bottom', () => {
  assert.equal(transcriptEndReached(at(570)), true);
  assert.equal(transcriptEndReached(at(568.5)), true);
  // The old 32px (12% of the pane) re-attach band is not the bottom.
  assert.equal(transcriptEndReached(at(560)), false);
  assert.equal(transcriptEndReached(at(540)), false);
  assert.equal(transcriptEndReached(at(300)), false);
});

test('a transcript that does not overflow is always at its end', () => {
  assert.equal(transcriptEndReached({ top: 0, maxScrollTop: 0, viewportHeight: 600 }), true);
});
