import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findCachedGraphBinary } from './graph-binary-fetcher.mjs';

test('graph cache lookup rejects unmanifested and hash-mismatched executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-graph-cache-'));
  try {
    const dir = join(root, 'graph-bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, process.platform === 'win32' ? 'mixdog-graph-evil.exe' : 'mixdog-graph-evil'), 'evil');
    assert.equal(findCachedGraphBinary(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
