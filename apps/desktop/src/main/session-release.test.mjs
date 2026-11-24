import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseDeletedSession } from './session-release.ts';

test('a step of a deleted session that throws or rejects never skips the others', async () => {
  const ran = [];
  const errors = [];
  await releaseDeletedSession(
    [
      () => {
        throw new Error('sync');
      },
      async () => {
        ran.push('b');
        throw new Error('async');
      },
      () => ran.push('c'),
    ],
    (error) => errors.push(error.message)
  );
  assert.deepEqual(ran, ['b', 'c']);
  assert.deepEqual(errors.sort(), ['async', 'sync']);
});
