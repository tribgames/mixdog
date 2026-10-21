// read on a PDF reads page ranges: text pages as text, scanned pages (no text
// layer) as page images or OCR text by the caller's model, a note in flat-text
// batches, and a clear message when OCR cannot run here.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makePdf } from './pdf-test-fixtures.mjs';
import { extractPdfText } from './read-special-files.mjs';
import { executeBuiltinTool } from '../builtin.mjs';

const TEXT = (i) => `Page ${i + 1} text layer with enough characters`;
// Pages 1, 3 and 5 carry text; 2 and 4 are scans.
const MIXED = (i) => (i % 2 === 0 ? TEXT(i) : null);

function fixture(t, name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return { dir, file };
}

const stubImage = (page) => ({
  page,
  data: Buffer.from(`png-${page}`).toString('base64'),
  mimeType: 'image/png',
  width: 800,
  height: 1000,
});

test('pages: text pages come back as text and scanned pages as page images, in page order', async (t) => {
  const { file } = fixture(t, 'mixed.pdf', makePdf(5, { pageText: MIXED }));
  const rendered = [];
  const result = await extractPdfText(file, '1-3', {
    pageMode: 'image',
    renderPages: async (_path, pages) => {
      rendered.push(...pages);
      return pages.map(stubImage);
    },
  });
  assert.deepEqual(rendered, [2], 'only the scanned page is rendered');
  const kinds = result.content.map((block) => block.type);
  assert.deepEqual(kinds, ['text', 'image', 'text']);
  assert.match(result.content[0].text, /pages 1-3 of 5; scanned \(no text layer\): 2/);
  assert.match(result.content[0].text, /Page 1 text layer/);
  assert.match(result.content[0].text, /Page 2 \(scanned; page image follows\)/);
  assert.equal(result.content[1].width, 800);
  assert.match(result.content[2].text, /Page 3 text layer/);
  assert.doesNotMatch(JSON.stringify(result), /Page 4|Page 5/);
});

test('whole read: a model that sees images but not native PDFs gets page images, never a document block', async (t) => {
  const { file } = fixture(t, 'short-scan.pdf', makePdf(3, { pageText: MIXED }));
  const result = await extractPdfText(file, undefined, {
    pageMode: 'image',
    nativeDocument: false,
    renderPages: async (_path, pages) => pages.map(stubImage),
    recognizePages: async () => assert.fail('no OCR for a model that sees images'),
  });
  const kinds = result.content.map((block) => block.type);
  assert.ok(!kinds.includes('document'), 'its provider would lower a document block to text');
  assert.deepEqual(kinds, ['text', 'image', 'text']);
  assert.match(result.content[0].text, /Page 1 text layer/);
});

test('pages: a text-only model gets OCR text for scanned pages', async (t) => {
  const { file } = fixture(t, 'mixed.pdf', makePdf(5, { pageText: MIXED }));
  const result = await extractPdfText(file, '2-4', {
    pageMode: 'ocr',
    recognizePages: async (_path, pages) => pages.map((page) => ({ page, text: `recognized words of page ${page}` })),
  });
  assert.equal(typeof result, 'string');
  assert.match(result, /--- Page 2 \(OCR of a scanned page\) ---\nrecognized words of page 2/);
  assert.match(result, /--- Page 3 ---\nPage 3 text layer/);
  assert.match(result, /--- Page 4 \(OCR of a scanned page\) ---\nrecognized words of page 4/);
});

test('pages: OCR that cannot run here says why and keeps the text pages', async (t) => {
  const { file } = fixture(t, 'mixed.pdf', makePdf(5, { pageText: MIXED }));
  const result = await extractPdfText(file, '1-2', {
    pageMode: 'ocr',
    recognizePages: async () => {
      throw new Error('getaddrinfo ENOTFOUND cdn.jsdelivr.net');
    },
  });
  assert.match(result, /Page 1 text layer/);
  assert.match(result, /--- Page 2 ---\n\(no text layer, and OCR is unavailable here: getaddrinfo ENOTFOUND/);
  assert.match(result, /downloads on first use/);
  assert.match(result, /works offline/);
});

test('pages: a flat-text batch notes scanned pages instead of rendering them', async (t) => {
  const { file } = fixture(t, 'mixed.pdf', makePdf(5, { pageText: MIXED }));
  const result = await extractPdfText(file, '4', {
    textOnly: true,
    renderPages: async () => assert.fail('a batch read never renders'),
    recognizePages: async () => assert.fail('a batch read never runs OCR'),
  });
  assert.match(result, /--- Page 4 ---\n\(no text layer: a scanned page\. Read this PDF on its own with pages="4"/);
});

test('pages: a range past the end is refused and one running over the end is clipped', async (t) => {
  const { file } = fixture(t, 'text.pdf', makePdf(3, { pageText: TEXT }));
  assert.match(await extractPdfText(file, '4-5'), /^Error: pages "4-5" out of range — this PDF has 3 pages/);
  const clipped = await extractPdfText(file, '2-9');
  assert.match(clipped, /pages 2-3 of 3; every page has a text layer/);
  assert.match(await extractPdfText(file, '1-21'), /max 20 per request/);
});

test('no pages: a PDF over 10 pages returns its first 5 pages and how to read more', async (t) => {
  const { file } = fixture(t, 'long.pdf', makePdf(37, { pageText: () => null }));
  const result = await extractPdfText(file, undefined, {
    pageMode: 'image',
    renderPages: async (_path, pages) => pages.map(stubImage),
  });
  const images = result.content.filter((block) => block.type === 'image');
  assert.equal(images.length, 5, 'never every page of a long scan at once');
  assert.match(result.content[0].text, /pages 1-5 of 37/);
  assert.match(result.content[0].text, /pass pages \(e\.g\. "6-15"/);
});

test('no pages: a short PDF on a native reader is one document block with its text-layer counts', async (t) => {
  const { file } = fixture(t, 'short.pdf', makePdf(3, { pageText: MIXED }));
  const result = await extractPdfText(file, undefined, { pageMode: 'image' });
  assert.equal(result.content[0].type, 'document');
  assert.equal(result.content[0].pageCount, 3);
  assert.equal(result.content[0].textPages, 2);
  assert.ok(result.content[0].textChars > 0);
});

test('a scanned page renders in memory: nothing is written next to the PDF', async (t) => {
  const { dir, file } = fixture(t, 'scan.pdf', makePdf(2, { pageText: () => null }));
  const result = await extractPdfText(file, '2', { pageMode: 'image' });
  const image = result.content.find((block) => block.type === 'image');
  assert.ok(image?.data?.length > 0, 'a real page image');
  assert.ok(image.width > 0 && image.height > 0);
  assert.deepEqual(readdirSync(dir), ['scan.pdf']);
});

test('read recognizes a stored attachment (no extension) as a PDF and pages it', async (t) => {
  const { dir, file } = fixture(t, 'a'.repeat(64), makePdf(4, { pageText: TEXT }));
  const out = await executeBuiltinTool('read', { file_path: file, pages: '3' }, dir, { pdfPageMode: 'ocr' });
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.match(text, /pages 3-3 of 4/);
  assert.match(text, /Page 3 text layer/);
  assert.doesNotMatch(text, /Page 2 text layer/);
});
