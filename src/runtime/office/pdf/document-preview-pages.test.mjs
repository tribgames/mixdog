import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { documentPreviewPages } from './document-preview.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, 'a.pdf');
  writeFileSync(pdf, 'rev1');
  const calls = [];
  const renderPages = async (_path, { pages, maxWidth }) => {
    calls.push({ pages: [...pages], maxWidth });
    return {
      pageCount: 5,
      images: pages.map((page) => ({
        page,
        width: maxWidth,
        height: 10,
        mimeType: 'image/png',
        data: `px-${calls.length}-${page}`,
      })),
    };
  };
  return { dir, pdf, calls, renderPages, cacheRoot: join(dir, 'cache') };
}

test('a repeated page request is served from cache with an identical reply', async (t) => {
  const f = fixture(t);
  const options = { pages: [1], maxWidth: 800, cacheRoot: f.cacheRoot, renderPages: f.renderPages };
  const first = await documentPreviewPages(f.pdf, options);
  const second = await documentPreviewPages(f.pdf, options);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(first, {
    pageCount: 5,
    pages: [{ page: 1, width: 800, height: 10, mime: 'image/png', base64: 'px-1-1' }],
  });
  // A different width or an extra page only rasterizes what is missing.
  await documentPreviewPages(f.pdf, { ...options, pages: [1, 2] });
  assert.deepEqual(f.calls.at(-1), { pages: [2], maxWidth: 800 });
  await documentPreviewPages(f.pdf, { ...options, maxWidth: 400 });
  assert.equal(f.calls.length, 3);
});

test('the disk cache serves a fresh process-level memory miss', async (t) => {
  const f = fixture(t);
  const options = { pages: [3], maxWidth: 640, cacheRoot: f.cacheRoot, renderPages: f.renderPages };
  const first = await documentPreviewPages(f.pdf, options);
  // Evict memory by filling it with other pages of other widths.
  for (let width = 321; width < 321 + 40; width += 1) {
    await documentPreviewPages(f.pdf, { ...options, pages: [1], maxWidth: width });
  }
  const before = f.calls.length;
  const again = await documentPreviewPages(f.pdf, options);
  assert.equal(f.calls.length, before);
  assert.deepEqual(again, first);
});

test('a changed PDF is rasterized again and older revisions are pruned', async (t) => {
  const f = fixture(t);
  const options = { pages: [1], maxWidth: 800, cacheRoot: f.cacheRoot, renderPages: f.renderPages };
  const first = await documentPreviewPages(f.pdf, options);
  writeFileSync(f.pdf, 'revision two is longer');
  const second = await documentPreviewPages(f.pdf, options);
  assert.equal(f.calls.length, 2);
  assert.notEqual(second.pages[0].base64, first.pages[0].base64);
  const root = join(f.cacheRoot, 'document-preview-pages');
  assert.equal(existsSync(root), true);
  assert.equal(readdirSync(root).length, 1);
});
