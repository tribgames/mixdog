import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('a live-pid owner record the caller proves stale is reported and reclaimed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-singleton-owner-'));
  try {
    const ownerPath = join(root, 'data', 'daemon-owner.json');
    mkdirSync(join(root, 'data'), { recursive: true });
    // The test runner's own pid: alive, and not the claimant's.
    const reused = { kind: 'mixdog-daemon', pid: process.pid, claimedAt: '2020-01-01T00:00:00.000Z' };
    writeFileSync(ownerPath, JSON.stringify(reused));
    const claimant = process.pid + 1;

    assert.deepEqual(readSingletonOwner(ownerPath), { owner: reused, alive: true, stale: false });
    assert.equal(claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: claimant }).owned, false);

    const isStale = (owner) => owner.claimedAt === reused.claimedAt;
    assert.deepEqual(readSingletonOwner(ownerPath, { isStale }), { owner: reused, alive: false, stale: true });
    const claim = claimSingletonOwner(ownerPath, { kind: 'mixdog-daemon', pid: claimant, isStale });
    assert.equal(claim.owned, true);
    assert.equal(readSingletonOwner(ownerPath).owner.pid, claimant);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
