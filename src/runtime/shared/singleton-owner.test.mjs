import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claimSingletonOwner, readSingletonOwner } from './singleton-owner.mjs';

test('claimSingletonOwner creates a missing data directory on first boot', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  try {
    const ownerPath = join(root, 'fresh', 'data', 'daemon-owner.json');
    const claim = claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon' });
    assert.equal(claim.owned, true);
    assert.equal(readSingletonOwner(ownerPath).owner.pid, process.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
