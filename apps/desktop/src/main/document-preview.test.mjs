import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDocumentPreviewOperations } from './document-preview.ts';

test('a PDF replaced while rasterizing is re-rendered and reports the new revision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-preview-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.pdf');
  writeFileSync(file, 'old');
  const calls = [];
  const ops = createDocumentPreviewOperations({
    cacheRoot: dir,
    loadDocumentPreview: async () => ({
      documentPreviewFormat: () => 'pdf',
      documentPreviewPdf: async () => {
        throw new Error('unused');
      },
      documentPreviewPages: async () => {
        calls.push(calls.length);
        if (calls.length === 1) writeFileSync(file, 'new content, longer');
        return { pageCount: 1, pages: [] };
      },
    }),
  });
  const result = await ops.documentPreviewPagesIn(dir, 'a.pdf', { pages: [1] });
  assert.equal(calls.length, 2, 'rendered again after the change');
  assert.equal(result.size, 'new content, longer'.length, 'reports the revision of the final pixels');
});

test('an unchanged PDF is rasterized once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-preview-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.pdf'), 'same');
  let calls = 0;
  const ops = createDocumentPreviewOperations({
    cacheRoot: dir,
    loadDocumentPreview: async () => ({
      documentPreviewFormat: () => 'pdf',
      documentPreviewPdf: async () => {
        throw new Error('unused');
      },
      documentPreviewPages: async () => {
        calls += 1;
        return { pageCount: 1, pages: [] };
      },
    }),
  });
  const result = await ops.documentPreviewPagesIn(dir, 'a.pdf', { pages: [1] });
  assert.equal(calls, 1);
  assert.equal(result.size, 4);
});
