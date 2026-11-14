import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { absoluteLocalPath } from './local-files.ts';

test('local paths must already be absolute', () => {
  assert.throws(() => absoluteLocalPath('relative/file'), /must be absolute/);
  assert.equal(absoluteLocalPath(resolve('absolute-file')), resolve('absolute-file'));
});
