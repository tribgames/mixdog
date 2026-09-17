import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readInstructionsText, writeInstructionsText } from './instructions-file.ts';

test('Instructions writes retain the unchanged source and reject stale concurrent edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-instructions-test-'));
  const file = join(root, 'instructions.md');
  await writeFile(file, 'Original\n', 'utf8');
  const first = writeInstructionsText(file, 'First\n', 'Original\n');
  const second = writeInstructionsText(file, 'Second\n', 'Original\n');
  const [saved, stale] = await Promise.allSettled([first, second]);
  assert.equal(saved.status, 'fulfilled');
  assert.equal(stale.status, 'rejected');
  assert.match(stale.reason.message, /changed since/);
  assert.equal(await readFile(saved.value.backupPath, 'utf8'), 'Original\n');
  assert.equal(await readFile(file, 'utf8'), 'First\n');
});

test('Common Instructions migration backs up the legacy content without mutating the legacy file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-instructions-legacy-test-'));
  const legacy = join(root, 'user-workflow.md');
  const file = join(root, 'instructions.md');
  await writeFile(legacy, 'Legacy guidance', 'utf8');
  assert.equal(await readInstructionsText(file, legacy), 'Legacy guidance');
  const saved = await writeInstructionsText(file, 'Current guidance', 'Legacy guidance', legacy);
  assert.equal(await readFile(saved.backupPath, 'utf8'), 'Legacy guidance');
  assert.equal(await readFile(legacy, 'utf8'), 'Legacy guidance');
  assert.equal(await readInstructionsText(file, legacy), 'Current guidance');
});
