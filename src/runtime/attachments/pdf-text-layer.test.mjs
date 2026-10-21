// Intake measures how much of a PDF reads as text: the counts price it and
// tell the model, when it goes by reference, which pages are scans.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makePdf } from '../agent/orchestrator/tools/builtin/pdf-test-fixtures.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-text-layer-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { inspectPdfBuffer, pageHasTextLayer } = await import('./pdf-extract.mjs');
const { materializePromptSubmission, preparePromptSubmissionForProvider } = await import('./store.mjs');

const TEXT = (i) => `Page ${i + 1} text layer with enough characters`;

test('a stamped page number alone is not a text layer', () => {
  assert.equal(pageHasTextLayer('12'), false);
  assert.equal(pageHasTextLayer('  Page 3 of 40  '), false);
  assert.equal(pageHasTextLayer('A paragraph of real extracted text.'), true);
});

test('measureText counts text pages and their characters, nothing else', async () => {
  const pdf = makePdf(4, { pageText: (i) => (i < 3 ? TEXT(i) : null) });
  const measured = await inspectPdfBuffer(pdf, { measureText: true, maxPages: Infinity });
  assert.equal(measured.pageCount, 4);
  assert.equal(measured.textPages, 3);
  // The extracted text, as pdf.js lays it out (inter-word spacing may differ).
  assert.ok(measured.textChars >= 3 * 30 && measured.textChars <= 3 * TEXT(0).length, String(measured.textChars));
  assert.equal('text' in measured, false);
});

test('intake records the page count and text layer on the stored part', async () => {
  const data = makePdf(3, { pageText: (i) => (i === 0 ? TEXT(i) : null) }).toString('base64');
  const intake = materializePromptSubmission([
    { type: 'file', data, mimeType: 'application/pdf', filename: 'scan.pdf' },
  ]);
  const prepared = await preparePromptSubmissionForProvider(intake, { nativePdf: true });
  assert.equal(prepared.prompt[0].pageCount, 3);
  assert.equal(prepared.prompt[0].textPages, 1);
  assert.ok(prepared.prompt[0].textChars >= 30 && prepared.prompt[0].textChars <= TEXT(0).length);
});
