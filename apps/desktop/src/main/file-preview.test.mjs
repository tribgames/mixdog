import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureFilePreviewFile, registerFilePreview, resolveFilePreview } from './file-preview.ts';

const tokenOf = (url) => new URL(url).pathname.split('/')[1];

test('an evicted converted file is regenerated once under the same token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  try {
    const first = join(dir, 'a.pdf');
    const second = join(dir, 'b.pdf');
    await writeFile(first, 'one');
    let conversions = 0;
    const regenerate = async () => {
      conversions += 1;
      await new Promise((done) => setTimeout(done, 20));
      await writeFile(second, 'two');
      return { path: second, mtimeMs: 1, size: 3 };
    };
    const preview = registerFilePreview(first, '1:3', { regenerate });
    const record = resolveFilePreview(tokenOf(preview.url));

    await ensureFilePreviewFile(record);
    assert.equal(record.path, first);
    assert.equal(conversions, 0);

    await rm(first);
    await Promise.all([ensureFilePreviewFile(record), ensureFilePreviewFile(record), ensureFilePreviewFile(record)]);
    assert.equal(conversions, 1);
    assert.equal(resolveFilePreview(tokenOf(preview.url)).path, second);
    assert.equal(record.generation, 1, 'the regenerated file is another representation');

    await ensureFilePreviewFile(record);
    assert.equal(conversions, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a preview without a source stays pointed at its missing file, which the handler answers 404 for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  try {
    const file = join(dir, 'plain.pdf');
    await writeFile(file, 'x');
    const record = resolveFilePreview(tokenOf(registerFilePreview(file, 'v1').url));
    await rm(file);
    await ensureFilePreviewFile(record);
    assert.equal(record.path, file);
    assert.throws(() => statSync(record.path), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a source saved since the token was made is not served under the old token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  try {
    const old = join(dir, 'a.pdf');
    const next = join(dir, 'b.pdf');
    await writeFile(old, 'one');
    await writeFile(next, 'new!');
    const preview = registerFilePreview(old, '1:3', { regenerate: async () => ({ path: next, mtimeMs: 2, size: 4 }) });
    const record = resolveFilePreview(tokenOf(preview.url));
    await rm(old);
    await ensureFilePreviewFile(record);
    assert.equal(record.path, old);
    assert.equal(record.generation, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a source that fails to convert leaves the file missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'));
  try {
    const gone = join(dir, 'gone.pdf');
    await writeFile(gone, 'x');
    const preview = registerFilePreview(gone, 'v1', {
      regenerate: async () => {
        throw new Error('source gone');
      },
    });
    const record = resolveFilePreview(tokenOf(preview.url));
    await rm(gone);
    await ensureFilePreviewFile(record);
    assert.equal(record.path, gone);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
