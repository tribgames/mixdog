import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withAdvisoryLocks } from './advisory-lock.mjs';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-advisory-lock-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('advisory lock leaves nothing beside the target and releases its lockfile', async (t) => {
  const root = sandbox(t);
  const work = join(root, 'work');
  const target = join(work, 'nested', 'new.md');
  await withAdvisoryLocks([target], async () => {
    assert.equal(readdirSync(join(root, 'data', 'locks')).length, 1);
  });
  assert.deepEqual(readdirSync(root).sort(), ['data']);
  assert.deepEqual(readdirSync(join(root, 'data', 'locks')), []);
});

test('a leaf symlink and its referent contend for the same lock', async (t) => {
  const root = sandbox(t);
  const target = join(root, 'real.md');
  const link = join(root, 'link.md');
  writeFileSync(target, 'x');
  try {
    symlinkSync(target, link, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    return t.skip('Windows symlink creation is not permitted on this host');
  }
  await withAdvisoryLocks([target], async () => {
    await assert.rejects(
      withAdvisoryLocks([link], async () => {}),
      (err) => err.code === 'EAGAIN'
    );
  });
});

test('two spellings of one target contend for the same lock', { skip: process.platform !== 'win32' }, async (t) => {
  const root = sandbox(t);
  const target = join(root, 'File.md');
  await withAdvisoryLocks([target], async () => {
    await assert.rejects(
      withAdvisoryLocks([target.toUpperCase()], async () => {}),
      (err) => err.code === 'EAGAIN'
    );
  });
});
