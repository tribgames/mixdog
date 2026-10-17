import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('open sections skip off-screen layout but keep their DOM; folded ones are untouched', async () => {
  const css = await readFile(new URL('./desktop/27-search-review.css', import.meta.url), 'utf8');
  assert.match(css, /\.session-diff-section:not\(\[data-collapsed="true"\]\) \{\s*content-visibility: auto;/);
  const source = await readFile(new URL('./session-diff-section.tsx', import.meta.url), 'utf8');
  assert.match(source, /style=\{collapsed \? undefined : \{ containIntrinsicBlockSize: `auto \$\{estimate\}px` \}\}/);
});
