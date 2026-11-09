import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { isolatedRuntimeRoot } from './runtime-root.mjs';

test('runtime roots isolate POSIX users without changing the Windows temp layout', () => {
  assert.equal(
    isolatedRuntimeRoot({ platform: 'linux', tempDir: '/var/tmp', uid: 1001 }),
    join('/var/tmp', 'mixdog-1001')
  );
  assert.equal(isolatedRuntimeRoot({ platform: 'win32', tempDir: '/temp', uid: null }), join('/temp', 'mixdog'));
});
