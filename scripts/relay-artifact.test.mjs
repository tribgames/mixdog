import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  recordLocalRelayArtifact,
  recordRelayArtifact,
  verifyLocalRelayArtifact,
  verifyRelayArtifact,
  RELAY_BUILD_INFO,
} from './relay-artifact.mjs';

const target = 'x86_64-unknown-linux-gnu';
const sourceCommit = 'a'.repeat(40);
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'relay-artifact-'));
  writeFileSync(join(folder, 'mixdog-relay'), 'native relay bytes');
  return folder;
}

test('provenance returns the actual checked-out source, independent of a dispatch or PR head', () => {
  const folder = fixture();
  try {
    recordRelayArtifact({ folder, target, sourceCommit });
    assert.equal(verifyRelayArtifact({ folder, target }), sourceCommit);
    assert.notEqual(sourceCommit, 'b'.repeat(40), 'the workflow event head is not the build identity');
    assert.throws(() => verifyRelayArtifact({ folder, target: 'aarch64-unknown-linux-gnu' }), /target/);
    writeFileSync(join(folder, 'mixdog-relay'), 'different binary');
    assert.throws(() => verifyRelayArtifact({ folder, target }), /differs/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an artifact without trustworthy source and hash is never selected', () => {
  const folder = fixture();
  try {
    assert.throws(() => verifyRelayArtifact({ folder, target }), /ENOENT/);
    assert.throws(() => recordRelayArtifact({ folder, target, sourceCommit: 'main' }), /full/);
    recordRelayArtifact({ folder, target, sourceCommit });
    const info = JSON.parse(readFileSync(join(folder, RELAY_BUILD_INFO), 'utf8'));
    for (const change of [{ sourceCommit: 'main' }, { schema: 2 }, { binarySha256: 'bad' }]) {
      writeFileSync(join(folder, RELAY_BUILD_INFO), JSON.stringify({ ...info, ...change }));
      assert.throws(() => verifyRelayArtifact({ folder, target }));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a local build of a dirty tree is told apart from a CI artifact', () => {
  const folder = fixture();
  const sourceFingerprint = 'c'.repeat(64);
  try {
    recordLocalRelayArtifact({ folder, target, sourceCommit, sourceFingerprint, dirty: true });
    assert.throws(() => verifyRelayArtifact({ folder, target }), /local relay build is not a CI artifact/);
    const info = verifyLocalRelayArtifact({ folder, target });
    assert.equal(info.sourceFingerprint, sourceFingerprint);
    assert.equal(info.dirty, true);
    writeFileSync(join(folder, 'mixdog-relay'), 'different binary');
    assert.throws(() => verifyLocalRelayArtifact({ folder, target }), /differs/);
    recordRelayArtifact({ folder, target, sourceCommit });
    assert.throws(() => verifyLocalRelayArtifact({ folder, target }), /local relay build/);
    assert.throws(
      () => recordLocalRelayArtifact({ folder, target, sourceCommit, sourceFingerprint: 'x', dirty: true }),
      /fingerprint/
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
