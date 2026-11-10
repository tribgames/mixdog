import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeGlobRuns } from './search-glob-tool.mjs';

const GLOB_ACCUM_CAP = 50000;

test('a glob run that exactly fills the accumulation cap is complete, not truncated', () => {
  const paths = Array.from({ length: GLOB_ACCUM_CAP }, (_, index) => `file-${index}.mjs`);

  const exact = mergeGlobRuns([{ paths }]);
  assert.equal(exact.allFiles.length, GLOB_ACCUM_CAP);
  assert.equal(exact.accumTruncated, false);

  // One path beyond the cap is a real drop and must still be reported.
  const over = mergeGlobRuns([{ paths: [...paths, 'one-more.mjs'] }]);
  assert.equal(over.allFiles.length, GLOB_ACCUM_CAP);
  assert.equal(over.accumTruncated, true);
});
