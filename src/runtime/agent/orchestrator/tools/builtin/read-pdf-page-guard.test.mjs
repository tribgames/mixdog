import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPdfBuffer } from '../../../../attachments/pdf-extract.mjs';
import { makeEncryptedPdf, makePdf } from './pdf-test-fixtures.mjs';
import { extractPdfText } from './read-special-files.mjs';

test('read PDF: <=100 pages stays a native document block, >100 pages falls back to text with a pages note', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const small = join(dir, 'small.pdf');
  const big = join(dir, 'big.pdf');
  writeFileSync(small, makePdf(3));
  writeFileSync(big, makePdf(101));

  const native = await extractPdfText(small);
  assert.equal(native.content[0].type, 'document');

  const text = await extractPdfText(big);
  assert.equal(typeof text, 'string');
  assert.match(text, /101 pages/);
  assert.match(text, /`pages`/);
  assert.match(text, /Page 1\b/);
  assert.doesNotMatch(text, /Page 21\b/);
  assert.equal(await extractPdfText(big), text);
});

test('read PDF: the native document block records pageCount', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-count-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'three.pdf');
  writeFileSync(file, makePdf(3));
  const result = await extractPdfText(file);
  assert.equal(result.content[0].pageCount, 3);
});

test('read PDF: a password-protected PDF returns a clear error instead of a native block', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-enc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'locked.pdf');
  const bytes = makeEncryptedPdf();
  writeFileSync(file, bytes);
  await assert.rejects(() => inspectPdfBuffer(bytes, { maxPages: Infinity }), (err) => err.name === 'PasswordException');
  const result = await extractPdfText(file);
  assert.equal(typeof result, 'string');
  assert.match(result, /^Error: this PDF is password-protected/);
});

test('read PDF: an invalid PDF returns a clear not-a-valid-PDF error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'broken.pdf');
  const bytes = Buffer.from('%PDF-1.7\ngarbage not a real pdf\n%%EOF\n');
  writeFileSync(file, bytes);
  await assert.rejects(() => inspectPdfBuffer(bytes, { maxPages: Infinity }));
  const result = await extractPdfText(file);
  assert.equal(typeof result, 'string');
  assert.match(result, /^Error: broken\.pdf is not a valid PDF/);
});
