import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// MIXDOG_DATA_DIR must be set before the module resolves the data directory.
const root = mkdtempSync(join(tmpdir(), 'mixdog-session-scratch-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { ensureSessionScratchDir, removeSessionScratchDir } = await import('./session-scratch.mjs');

// A session's processes run with TEMP in the scratch directory and make
// junctions there (a copied checkout linked to the real node_modules). Node 24's
// recursive `rmSync` deleted the directory such a junction points at.
test('removing a session scratch removes a junction in it, never what the junction points at', () => {
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'pkg'), { recursive: true });
  writeFileSync(join(outside, 'pkg', 'kept.txt'), 'x');
  writeFileSync(join(outside, 'kept.txt'), 'x');

  const dir = ensureSessionScratchDir('sess_scratch_links');
  mkdirSync(join(dir, 'tree', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'tree', 'nested', 'own.txt'), 'x');
  symlinkSync(outside, join(dir, 'tree', 'node_modules'), 'junction');
  symlinkSync(join(outside, 'pkg'), join(dir, 'linked-at-top'), 'junction');

  removeSessionScratchDir('sess_scratch_links');

  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(outside, 'pkg', 'kept.txt')), true);
  assert.equal(existsSync(join(outside, 'kept.txt')), true);

  unlinkSync(join(outside, 'pkg', 'kept.txt'));
  unlinkSync(join(outside, 'kept.txt'));
  rmdirSync(join(outside, 'pkg'));
  rmdirSync(outside);
});

test('removing a scratch that was never created does nothing', () => {
  removeSessionScratchDir('sess_scratch_absent');
  removeSessionScratchDir('../escape');
});
