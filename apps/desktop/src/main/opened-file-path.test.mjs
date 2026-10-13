// Where an open file lives is read from the open file, never trusted from the
// path it was opened by (opened-file-path.ts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openedFilePath, walkedFilePath } from './opened-file-path.ts';

const locators = [
  ['this platform', openedFilePath],
  ['the walking fallback', (_handle, openedBy, identity) => walkedFilePath(openedBy, identity)],
];

test('an open file is located where it really is, and never at a path naming another file', async (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'opened-file-path-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'real'));
  writeFileSync(join(base, 'real', 'file.txt'), 'file');
  writeFileSync(join(base, 'other.txt'), 'other');
  symlinkSync(join(base, 'real'), join(base, 'via'), 'junction');
  const viaJunction = join(base, 'via', 'file.txt');
  const handle = await open(viaJunction, 'r');
  t.after(() => handle.close());
  const identity = await handle.stat({ bigint: true });
  const other = join(base, 'other.txt');
  for (const [label, locate] of locators) {
    assert.equal(await locate(handle, viaJunction, identity), join(base, 'real', 'file.txt'), label);
    assert.notEqual(await locate(handle, other, identity).catch(() => null), other, label);
  }
});
