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

test("a document's password reaches only its conversion, and only as bounded text", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-preview-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'secret.docx'), 'encrypted');
  const pdf = join(dir, 'out.pdf');
  writeFileSync(pdf, 'pdf');
  const conversions = [];
  const ops = createDocumentPreviewOperations({
    cacheRoot: dir,
    loadDocumentPreview: async () => ({
      documentPreviewFormat: () => 'docx',
      documentPreviewPdf: async (_path, options) => {
        conversions.push(options);
        return { path: pdf, format: 'docx', mtimeMs: 1, size: 3, cached: false };
      },
      documentPreviewPages: async (_path, options) => {
        assert.equal('password' in options, false, 'rasterizing never sees the password');
        return { pageCount: 1, pages: [] };
      },
    }),
  });
  await ops.documentPreviewPagesIn(dir, 'secret.docx', { pages: [1], password: 'open sesame' });
  await ops.documentPreviewPagesIn(dir, 'secret.docx', { pages: [2] });
  assert.deepEqual(conversions, [{ cacheRoot: dir, password: 'open sesame' }, { cacheRoot: dir }]);
  for (const password of [42, 'x'.repeat(256)]) {
    await assert.rejects(ops.documentPreviewPagesIn(dir, 'secret.docx', { pages: [1], password }), (error) => {
      assert.match(error.message, /at most 255 characters/);
      assert.ok(!error.message.includes('xxxx'));
      return true;
    });
  }
});
