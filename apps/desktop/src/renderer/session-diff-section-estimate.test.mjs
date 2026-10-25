import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionDiffSectionEstimate } from './session-diff-section.tsx';

const row = (...patches) => ({ parts: patches.map((patch) => ({ patch })) });

test('an open file off screen holds its header plus one line per patch line', () => {
  assert.equal(sessionDiffSectionEstimate(row('@@ -1 +1 @@\n-a\n+b')), 34 + 3 * 19);
  // Parts are joined by a newline when drawn.
  assert.equal(sessionDiffSectionEstimate(row('-a\n+b', '-c')), 34 + 3 * 19);
  // A file with no text yet still reserves a line under its header.
  assert.equal(sessionDiffSectionEstimate(row()), 34 + 19);
});
