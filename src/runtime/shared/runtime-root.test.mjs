import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensurePrivateRuntimeRoot,
  isolatedRuntimeRoot,
} from './runtime-root.mjs';

test('runtime roots isolate POSIX users without changing the Windows temp layout', () => {
  assert.equal(
    isolatedRuntimeRoot({ platform: 'linux', tempDir: '/var/tmp', uid: 1001 }),
    join('/var/tmp', 'mixdog-1001'),
  );
  assert.equal(
    isolatedRuntimeRoot({ platform: 'win32', tempDir: '/temp', uid: null }),
    join('/temp', 'mixdog'),
  );
});

test('runtime root creation is owner-only on POSIX', () => {
  const parent = mkdtempSync(join(tmpdir(), 'mixdog-runtime-root-'));
  const root = join(parent, 'runtime');
  try {
    assert.equal(ensurePrivateRuntimeRoot(root), root);
    if (process.platform !== 'win32') {
      assert.equal(statSync(root).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
