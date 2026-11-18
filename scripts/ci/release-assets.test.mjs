import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyAssets } from './release-assets.mjs';

test('a completed draft asset with the same name and size must still match the verified bytes', () => {
  const expected = [{ name: 'package.zip', size: 27, digest: `sha256:${'a'.repeat(64)}` }];
  const uploaded = { ...expected[0], state: 'uploaded' };
  verifyAssets([uploaded], expected, ['package.zip']);
  assert.throws(
    () => verifyAssets([{ ...uploaded, digest: `sha256:${'b'.repeat(64)}` }], expected, ['package.zip']),
    /differs from the verified bytes/,
  );
});
