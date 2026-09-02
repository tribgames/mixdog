import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { executeOfficeTool } from './index.mjs';
import { renderPdfPages } from './pdf/pdf-render.mjs';
import { parseOcrBlocks, parseOcrTsv } from './pdf/pdf-analysis.mjs';
import {
  classifyOoxmlValidationErrors,
  ensureOoxmlValidator,
  ooxmlValidatorManifest,
} from './portable/ooxml-validator.mjs';
import { unicodeFontPath, value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('PDF backend edits and validates without Microsoft Office', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pdf');
  const output = join(cwd, 'edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await writeFile(source, await pdf.save());

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'auto',
  }, { cwd }));
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-pdf');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'add_text', page: 1, text: 'PDF edited', x: 20, y: 20, size: 14 },
      { op: 'rotate_pages', pages: [1], rotation: 90 },
      { op: 'set_metadata', properties: { title: 'Mixdog PDF' } },
    ],
  }, { cwd }));

  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
  }, { cwd }));
  assert.equal(validation.ok, true);
  assert.equal(validation.pages, 1);

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(snapshot.document.pageCount, 1);
  assert.equal(snapshot.document.pages[0].path, '/page[1]');

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: 'Visual QA delta', x: 30, y: 60, size: 16 }],
  }, { cwd }));
  const qaResult = await executeOfficeTool({
    action: 'qa',
    session: opened.session,
    output: join(cwd, 'qa-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const qa = value(qaResult);
  assert.equal(qa.review.visualDiff.available, true);
  assert.ok(qa.review.visualDiff.changedPercent > 0);
  assert.ok(qaResult.content.filter((item) => item.type === 'image').length >= 2);
  value(await executeOfficeTool({ action: 'rollback', session: opened.session }, { cwd }));

  const renderedResult = await executeOfficeTool({
    action: 'render',
    session: opened.session,
    output: join(cwd, 'preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const rendered = value(renderedResult);
  assert.equal(rendered.images.length, 1);
  assert.equal(renderedResult.content[1].type, 'image');
  assert.equal(renderedResult.content[1].source.media_type, 'image/png');

  const finalizedResult = await executeOfficeTool({
    action: 'finalize',
    session: opened.session,
    output: join(cwd, 'final-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const finalized = value(finalizedResult);
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.review._images, undefined);
  assert.equal(finalizedResult.content.filter((item) => item.type === 'image').length, 1);
});

test('PDF rendering compresses long documents into at most 12 contact sheets with full coverage', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'thirteen-pages.pdf');
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 13; page += 1) pdf.addPage([200, 120]);
  await writeFile(path, await pdf.save());

  const rendered = await renderPdfPages(path, { maxWidth: 200 });
  assert.equal(rendered.pageCount, 13);
  assert.equal(rendered.images.length, 7);
  assert.deepEqual(rendered.images[0].pages, [1, 2]);
  assert.deepEqual(rendered.visualCoverage, {
    reviewedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    reviewed: 13,
    total: 13,
    complete: true,
    remainingPages: [],
  });
});

test('PDF rendering workers ignore parent-only V8 heap flags', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'worker-flags.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 120]);
  await writeFile(path, await pdf.save());
  const original = process.execArgv;
  process.execArgv = ['--max-old-space-size=768'];
  try {
    const rendered = await renderPdfPages(path, { maxWidth: 200 });
    assert.equal(rendered.pageCount, 1);
    assert.equal(rendered.images.length, 1);
  } finally {
    process.execArgv = original;
  }
});

test('PDF specialized queries expose positioned text, inferred tables, and embedded images', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'analysis.pdf');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.drawText('Metric', { x: 40, y: 240, size: 12 });
  page.drawText('Value', { x: 220, y: 240, size: 12 });
  page.drawText('Revenue', { x: 40, y: 210, size: 12 });
  page.drawText('120', { x: 220, y: 210, size: 12 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2S9sAAAAASUVORK5CYII=', 'base64');
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 40, y: 40, width: 20, height: 20 });
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const layout = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-layout',
  }, { cwd }));
  assert.ok(layout.pages[0].items.some((item) => item.text === 'Metric'));
  const tables = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-tables',
  }, { cwd }));
  assert.equal(tables.tableCount, 1);
  assert.deepEqual(tables.tables[0].rows[0], ['Metric', 'Value']);
  const imagesResult = await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-images',
  }, { cwd });
  const images = value(imagesResult);
  assert.ok(images.imageCount >= 1);
  assert.ok(imagesResult.content.some((item) => item.type === 'image'));
});

test('OCR TSV parsing and on-demand OOXML validator manifest stay deterministic', async (t) => {
  const words = parseOcrTsv('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t92.5\tHello');
  assert.deepEqual(words, [{
    text: 'Hello',
    confidence: 92.5,
    left: 10,
    top: 20,
    width: 30,
    height: 12,
  }]);
  assert.deepEqual(parseOcrBlocks([{
    paragraphs: [{ lines: [{ words: [{ text: 'Block', confidence: 88, bbox: { x0: 2, y0: 3, x1: 12, y1: 9 } }] }] }],
  }]), [{
    text: 'Block',
    confidence: 88,
    left: 2,
    top: 3,
    width: 10,
    height: 6,
  }]);
  const manifest = ooxmlValidatorManifest();
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.platforms.length, 6);
  const classified = classifyOoxmlValidationErrors([
    {
      path: '/ppt/charts/chart1.xml',
      xPath: '/c:chartSpace[1]/c:chart[1]/c:extLst[1]/c:ext[1]',
      description: "The 'uri' attribute is not declared.",
    },
    {
      path: '/xl/charts/chart1.xml',
      xPath: '/c:chartSpace[1]/c:chart[1]/c:extLst[1]/c:ext[1]',
      description: "The 'uri' attribute is not declared.",
    },
    { path: '/word/document.xml', xPath: '/w:document[1]', description: 'Invalid child.' },
    {
      path: '/ppt/presentation.xml',
      xPath: '/p:presentation[1]',
      description: "The element has unexpected child element 'http://schemas.openxmlformats.org/presentationml/2006/main:notesMasterIdLst'. List of possible elements expected: <http://schemas.openxmlformats.org/presentationml/2006/main:notesSz>.",
    },
    {
      path: '/ppt/presentation.xml',
      xPath: '/p:presentation[1]/p:sldIdLst[1]',
      description: "The element has unexpected child element 'http://schemas.openxmlformats.org/presentationml/2006/main:notesMasterIdLst'.",
    },
  ]);
  assert.equal(classified.compatibilityWarnings.length, 3);
  assert.equal(classified.errors.length, 2);
  const unavailable = await ensureOoxmlValidator({
    dataDir: await workspace(t),
    download: false,
  });
  assert.equal(unavailable.disabled, true);
});

test('PDF text edits embed an explicit Unicode font for non-Latin text', async (t) => {
  const fontPath = await unicodeFontPath();
  if (!fontPath) return t.skip('No Unicode TrueType font is installed');
  const cwd = await workspace(t);
  const source = join(cwd, 'unicode-source.pdf');
  const output = join(cwd, 'unicode-edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await writeFile(source, await pdf.save());
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: '한글-日本語-中文', x: 30, y: 60, size: 16, fontPath }],
  }, { cwd }));
  assert.equal(edited.results[0].fontEmbedded, true);
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
    pages: [1],
  }, { cwd }));
  assert.match(JSON.stringify(snapshot.document.pages), /한글/);
});

test('PDF create lints forms, reports OCR handoff, and preserves attachments', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'created.pdf');
  const attachment = join(cwd, 'source.txt');
  await writeFile(attachment, 'attached evidence', 'utf8');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'heading', text: 'Frontier PDF' },
      { type: 'paragraph', text: 'Structured document body.' },
      { type: 'pagebreak' },
    ],
    fields: [
      { name: 'Reviewer', type: 'text', page: 1, x: 50, y: 650, width: 180, height: 24, value: 'Mixdog' },
      { name: 'Approved', type: 'checkbox', page: 1, x: 240, y: 650, width: 18, height: 18, value: true },
    ],
    properties: { title: 'Frontier PDF' },
  }, { cwd }));
  assert.equal(created.created, true);
  assert.equal(created.artifacts[0].type, 'pdf');
  assert.equal(created.outputCount, 1);
  assert.equal(created.document.fieldCount, 2);
  assert.ok(created.document.likelyScannedPages.includes(2));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'add_attachment', path: attachment, name: 'evidence.txt', description: 'Source evidence' }],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    pages: [1],
  }, { cwd }));
  assert.equal(snapshot.document.metadata.title, 'Frontier PDF');
  assert.equal(snapshot.document.fieldCount, 2);
  assert.equal(snapshot.document.attachmentCount, 1);
  assert.equal(snapshot.document.attachments[0].name, 'evidence.txt');
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'ocr_required' && issue.path === '/page[2]'));
});
