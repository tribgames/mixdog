import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupStaleTranscriptSpillDirs, createSpillDirectories } from './spill-dir.mjs';

test('the stale sweep only reclaims spill directories, never other mixdog-transcript-* directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spill-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deadPid = 2_147_483_000;
  const deadSpill = join(root, `mixdog-transcript-${deadPid}-0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0-Ab12Cd`);
  const foreign = [
    'mixdog-transcript-cache-Xy12Zw',
    'mixdog-transcript-writer-Q1w2E3',
    `mixdog-transcript-${deadPid}-not-a-nonce`,
  ].map((name) => join(root, name));
  for (const path of [deadSpill, ...foreign]) mkdirSync(path);

  cleanupStaleTranscriptSpillDirs({ root });

  assert.equal(existsSync(deadSpill), false, 'a dead owner spill directory is reclaimed');
  for (const path of foreign) assert.equal(existsSync(path), true, `${path} is not a spill directory`);
});

test('an owner pid answering EPERM is alive, so its fresh spill directory survives the sweep', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spill-eperm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const otherUserPid = 4242;
  const spill = join(root, `mixdog-transcript-${otherUserPid}-0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0-Ab12Cd`);
  mkdirSync(spill);
  t.mock.method(process, 'kill', (pid) => {
    assert.equal(pid, otherUserPid);
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  });

  cleanupStaleTranscriptSpillDirs({ root });

  assert.equal(existsSync(spill), true);
});

test('a live process spill directory survives the sweep', (t) => {
  const directories = createSpillDirectories();
  const directory = directories.create();
  t.after(() => directories.release(directory));
  cleanupStaleTranscriptSpillDirs();
  assert.equal(existsSync(directory), true);
});
