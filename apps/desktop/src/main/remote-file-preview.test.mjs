import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createRemoteFilePreviewMethods, REMOTE_PREVIEW_MAX_READ_BYTES } from './remote-file-preview.ts';

const root = mkdtempSync(join(tmpdir(), 'remote-preview-'));
mkdirSync(join(root, '.hidden'));
writeFileSync(join(root, 'clip.mp4'), Buffer.from('0123456789'));
writeFileSync(join(root, 'page.html'), '<p>hi</p>');
writeFileSync(join(root, 'data.bin'), 'secret');
writeFileSync(join(root, '.hidden', 'a.css'), 'x');
const outside = mkdtempSync(join(tmpdir(), 'remote-preview-out-'));
writeFileSync(join(outside, 'pic.png'), Buffer.from('png'));

const grants = {
  grantedIf: (token) => typeof token === 'string' && token.length > 0,
  grantedFile: (token, _project, rel) => {
    if (token !== 'ok' || rel !== 'pic.png') throw new Error('The selected-file permission does not match this path.');
    return { root: outside, rel: 'pic.png', absolute: join(outside, 'pic.png') };
  },
};
const methods = createRemoteFilePreviewMethods({ host: { projectDirectory: async () => root }, grants });

test('metadata describes a previewable file without a URL', async () => {
  const meta = await methods.previewProjectFile([root, 'clip.mp4', null]);
  assert.equal(meta.kind, 'video');
  assert.equal(meta.size, 10);
  assert.equal('url' in meta, false);
  await assert.rejects(methods.previewProjectFile([root, 'data.bin', null]), /does not support/);
});

test('ranged reads return the requested window as base64 and clamp at EOF', async () => {
  const mid = await methods.previewProjectFileRange([root, 'clip.mp4', null, 2, 3]);
  assert.equal(Buffer.from(mid.data, 'base64').toString(), '234');
  assert.equal(mid.size, 10);
  const tail = await methods.previewProjectFileRange([root, 'clip.mp4', null, 8, 100]);
  assert.equal(Buffer.from(tail.data, 'base64').toString(), '89');
  const past = await methods.previewProjectFileRange([root, 'clip.mp4', null, 50, 4]);
  assert.equal(past.data, '');
});

test('reads are bounded and validated', async () => {
  await assert.rejects(methods.previewProjectFileRange([root, 'clip.mp4', null, 0, REMOTE_PREVIEW_MAX_READ_BYTES + 1]), /length/);
  await assert.rejects(methods.previewProjectFileRange([root, 'clip.mp4', null, -1, 4]), /offset/);
});

test('paths outside the project, hidden files and non-web files are refused', async () => {
  await assert.rejects(methods.previewProjectFileRange([root, '../x.png', null, 0, 4]), /outside the project/);
  await assert.rejects(methods.previewProjectFileRange([root, '.hidden/a.css', null, 0, 4]), /does not support/);
  await assert.rejects(methods.previewProjectFileRange([root, 'data.bin', null, 0, 4]), /does not support/);
  const page = await methods.previewProjectFileRange([root, 'page.html', null, 0, 100]);
  assert.equal(page.mime, 'text/html; charset=utf-8');
});

test('a selected-file grant reads exactly its file and nothing else', async () => {
  const ok = await methods.previewProjectFileRange([resolve(outside), 'pic.png', 'ok', 0, 10]);
  assert.equal(Buffer.from(ok.data, 'base64').toString(), 'png');
  await assert.rejects(methods.previewProjectFileRange([outside, 'other.png', 'ok', 0, 10]), /permission/);
  await assert.rejects(methods.previewProjectFileRange([outside, 'pic.png', 'bad', 0, 10]), /permission/);
});
