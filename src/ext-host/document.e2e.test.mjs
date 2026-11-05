// Document previews and the LibreOffice probe, against the real worker (previews) and in process
// (the probe, whose candidate list is a test seam of the module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { documentHandlers, setLibreOfficeCandidatesForTest } from './document.mjs';
import { startWorker } from './test/worker-client.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function samplePdf(file, pages = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) doc.addPage([400, 200]).drawText(`Preview page ${i}`, { x: 20, y: 100, size: 24, font });
  fs.writeFileSync(file, await doc.save());
}

test('a PDF previews in place and rasterizes into pages; the root and type are guarded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-doc-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-doc-outside-'));
  const cacheRoot = path.join(root, '.cache');
  await samplePdf(path.join(root, 'a.pdf'), 3);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'plain');
  const worker = startWorker();
  try {
    await worker.ready;
    const call = (method, params, paths = [root]) => worker.call(method, { root, cacheRoot, ...params }, paths);

    const preview = await call('document.preview', { rel: 'a.pdf' });
    assert.equal(preview.result.ok.format, 'pdf');
    assert.equal(preview.result.ok.path, path.join(root, 'a.pdf'));
    assert.equal(preview.result.ok.cached, true);
    assert.equal(preview.result.pin, false);

    const pages = await call('document.previewPages', { rel: 'a.pdf', options: { pages: [2, 1, 2], maxWidth: 10 } });
    assert.equal(pages.result.ok.pageCount, 3);
    assert.deepEqual(pages.result.ok.pages.map((p) => p.page), [1, 2], 'sorted and de-duplicated');
    for (const page of pages.result.ok.pages) {
      assert.equal(page.mime, 'image/png');
      assert.deepEqual(Buffer.from(page.base64, 'base64').subarray(0, 4), PNG_MAGIC);
      assert.ok(page.width <= 320, 'a width below the floor is raised to it, not honoured');
    }

    const tooMany = await call('document.previewPages', { rel: 'a.pdf', options: { pages: [1, 2, 3, 4, 5] } });
    assert.equal(tooMany.result.err.code, 'invalid_params');
    const noPages = await call('document.previewPages', { rel: 'a.pdf', options: { pages: [0] } });
    assert.equal(noPages.result.err.code, 'invalid_params');

    const text = await call('document.preview', { rel: 'notes.txt' });
    assert.equal(text.result.err.code, 'no_preview_for_type');
    assert.equal(text.result.err.message, 'This file type has no built-in document preview.');

    const escape = await call('document.preview', { rel: '../escape.pdf' });
    assert.equal(escape.result.err.code, 'path_outside_project');
    const unapproved = await call('document.preview', { rel: 'a.pdf' }, [outside]);
    assert.equal(unapproved.result.err.code, 'path_not_approved');
    const directory = await call('document.preview', { rel: '.' });
    assert.ok(directory.result.err, 'a directory is no document');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a password keeps its thread on the worker that unlocked the document', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exthost-doc-pin-'));
  await samplePdf(path.join(root, 'a.pdf'), 1);
  const worker = startWorker();
  try {
    await worker.ready;
    const params = { root, rel: 'a.pdf', cacheRoot: path.join(root, '.cache') };
    const plain = await worker.call('document.previewPages', params, [root], 'viewer');
    assert.equal(plain.result.pin, false);
    const unlocked = await worker.call('document.previewPages', { ...params, options: { password: 'secret' } }, [root], 'viewer');
    assert.equal(unlocked.result.pin, true);
    const later = await worker.call('document.previewPages', params, [root], 'viewer');
    assert.equal(later.result.pin, true, 'later requests without the password stay pinned');
    const other = await worker.call('document.previewPages', params, [root], 'someone-else');
    assert.equal(other.result.pin, false);
    const tooLong = await worker.call('document.previewPages', { ...params, options: { password: 'x'.repeat(256) } }, [root], 'v2');
    assert.equal(tooLong.result.err.code, 'invalid_params');
  } finally {
    await worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the LibreOffice probe reports installed with a version only when the program prints one', async () => {
  try {
    const status = (params = {}) => documentHandlers['document.libreOfficeStatus']({ params }).then((r) => r.value);
    setLibreOfficeCandidatesForTest([]);
    assert.deepEqual(await status({ refresh: true }), { installed: false });
    // `node --version` exits 0 and prints no LibreOffice version line.
    setLibreOfficeCandidatesForTest([process.execPath]);
    assert.deepEqual(await status({ refresh: true }), { installed: true });
    // The answer is cached until a refresh is asked for.
    setLibreOfficeCandidatesForTest([]);
    assert.deepEqual(await status(), { installed: false });
    setLibreOfficeCandidatesForTest([process.execPath]);
    assert.deepEqual(await status(), { installed: true });
    // An install of an already-installed LibreOffice is a status, never a package-manager run.
    const install = await documentHandlers['document.installLibreOffice']({ params: {} });
    assert.deepEqual(install.value, { installed: true });
  } finally {
    setLibreOfficeCandidatesForTest();
  }
});
