import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { executeOfficeTool } from './index.mjs';
import { renderPdfPages } from './pdf/pdf-render.mjs';
import { parseOcrBlocks, parseOcrTsv } from './pdf/pdf-analysis.mjs';
import { wrapText } from './pdf/pdf-draw.mjs';
import {
  classifyOoxmlValidationErrors,
  ensureOoxmlValidator,
  ooxmlValidatorManifest,
} from './portable/ooxml-validator.mjs';
import { PNG_PIXEL, unicodeFontPath, value, workspace } from './office-test-support.mjs';

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
  page.drawLine({ start: { x: 40, y: 190 }, end: { x: 360, y: 190 }, thickness: 1, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 300, y: 40, width: 12, height: 12, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const layout = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-layout',
  }, { cwd }));
  assert.ok(layout.pages[0].items.some((item) => item.text === 'Metric'));
  const rule = layout.pages[0].lines.find((line) => Math.abs(line.x1 - 40) < 1 && Math.abs(line.x2 - 360) < 1);
  assert.ok(rule && Math.abs(rule.y1 - 110) < 1, JSON.stringify(layout.pages[0].lines));
  const checkbox = layout.pages[0].boxes.find((box) => box.checkbox);
  assert.ok(checkbox && Math.abs(checkbox.x - 300) < 1 && Math.abs(checkbox.top - 248) < 1 && checkbox.stroked, JSON.stringify(layout.pages[0].boxes));
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
  const [picture] = images.images;
  assert.ok(Math.abs(picture.x - 40) < 1 && Math.abs(picture.top - 240) < 1 && Math.abs(picture.placedWidth - 20) < 1, JSON.stringify(picture));
  assert.equal(picture.placements, 1);
  const filesResult = await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-images',
    output: 'extracted-images',
  }, { cwd });
  const files = value(filesResult);
  assert.equal(files.output, join(cwd, 'extracted-images'));
  assert.ok((await readFile(files.images[0].path)).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.ok(!filesResult.content.some((item) => item.type === 'image'));

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'add_text', page: 1, text: 'Centered', align: 'center', y: 150, size: 12 },
      { op: 'add_text', page: 1, text: 'Right', align: 'right', y: 130, size: 12 },
    ],
  }, { cwd }));
  const marked = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout' }, { cwd }));
  const centered = marked.pages[0].items.find((item) => item.text === 'Centered');
  const right = marked.pages[0].items.find((item) => item.text === 'Right');
  assert.ok(centered && Math.abs((centered.x + (centered.width / 2)) - 200) < 1, JSON.stringify(centered));
  assert.ok(right && Math.abs((right.x + right.width) - (400 - 36)) < 1, JSON.stringify(right));
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
    {
      path: '/ppt/charts/chart1.xml',
      xPath: '/c:chartSpace[1]/c:chart[1]/c:plotArea[1]/c:barChart[1]',
      id: 'Sch_UnexpectedElementContentExpectingComplex',
      description: "The element has unexpected child element 'http://schemas.openxmlformats.org/drawingml/2006/chart:axId'.",
    },
    {
      path: '/ppt/charts/chart1.xml',
      xPath: '/c:chartSpace[1]/c:chart[1]/c:plotArea[1]/c:barChart[1]',
      id: 'Sch_UnexpectedElementContentExpectingComplex',
      description: "The element has unexpected child element 'http://example.com/custom:bogus'.",
    },
  ]);
  assert.equal(classified.compatibilityWarnings.length, 4);
  assert.equal(classified.errors.length, 3);
  const unavailable = await ensureOoxmlValidator({
    dataDir: await workspace(t),
    download: false,
  });
  assert.equal(unavailable.disabled, true);
});

test('PDF text edits embed an explicit Unicode font for non-Latin text', async (t) => {
  const fontPath = await unicodeFontPath();
  if (!fontPath) return t.skip('No Unicode TrueType font is installed');
  const text = /DejaVuSans/i.test(fontPath) ? 'Ελληνικά-Русский' : '한글-日本語-中文';
  const expected = text.split('-')[0];
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
    operations: [{ op: 'add_text', page: 1, text, x: 30, y: 60, size: 16, fontPath }],
  }, { cwd }));
  assert.equal(edited.results[0].fontEmbedded, true);
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
    pages: [1],
  }, { cwd }));
  assert.ok(JSON.stringify(snapshot.document.pages).includes(expected));
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
      { name: 'Tags', type: 'optionlist', page: 1, x: 300, y: 600, width: 120, height: 40, options: ['alpha', 'beta', 'gamma'], value: ['alpha', 'gamma'] },
      { name: 'Tiny', type: 'text', page: 1, x: 50, y: 600, width: 20, height: 8, required: true, maxLength: 4 },
    ],
    properties: { title: 'Frontier PDF', pageNumbers: false },
  }, { cwd }));
  assert.equal(created.created, true);
  assert.equal(created.artifacts[0].type, 'pdf');
  assert.equal(created.outputCount, 1);
  assert.equal(created.document.fieldCount, 4);
  assert.ok(created.formIssues.some((issue) => issue.code === 'field_too_small' && issue.path === '/field[4]'));
  const fieldsByName = Object.fromEntries(created.document.fields.map((field) => [field.name, field]));
  assert.equal(fieldsByName.Tags.type, 'optionlist');
  assert.deepEqual(fieldsByName.Tags.value, ['alpha', 'gamma']);
  assert.equal(fieldsByName.Tiny.required, true);
  assert.equal(fieldsByName.Tiny.maxLength, 4);
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
  assert.equal(snapshot.document.fieldCount, 4);
  assert.equal(snapshot.document.attachmentCount, 1);
  assert.equal(snapshot.document.attachments[0].name, 'evidence.txt');
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'ocr_required' && issue.path === '/page[2]'));
  assert.equal(issues.issues.filter((issue) => issue.path === '/page[2]').length, 1);
  assert.ok(issues.issues.some((issue) => issue.code === 'field_too_small' && issue.path === '/field[4]'));
});

test('PDF forms expose options, validate fill values, and report what was filled', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'form.pdf');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const form = pdf.getForm();
  form.createTextField('Name').addToPage(page, { x: 40, y: 320, width: 200, height: 24 });
  form.createCheckBox('Agree').addToPage(page, { x: 40, y: 280, width: 18, height: 18 });
  const size = form.createDropdown('Size');
  size.addOptions(['small', 'large']);
  size.addToPage(page, { x: 40, y: 240, width: 120, height: 24 });
  const colour = form.createRadioGroup('Colour');
  colour.addOptionToPage('red', page, { x: 40, y: 200, width: 18, height: 18 });
  colour.addOptionToPage('blue', page, { x: 80, y: 200, width: 18, height: 18 });
  await writeFile(path, await pdf.save());

  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const fields = Object.fromEntries(opened.document.fields.map((field) => [field.name, field]));
  assert.equal(fields.Name.type, 'text');
  assert.equal(fields.Name.readOnly, false);
  assert.equal(fields.Agree.type, 'checkbox');
  assert.deepEqual(fields.Size.options, ['small', 'large']);
  assert.deepEqual(fields.Colour.options, ['red', 'blue']);
  assert.deepEqual([opened.document.pages[0].width, opened.document.pages[0].height, opened.document.pages[0].rotation], [400, 400, 0]);

  const unknown = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_form', values: { Nmae: 'x' } }],
  }, { cwd });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no field named Nmae; fields: Name, Agree, Size, Colour/);
  const badOption = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_form', values: { Size: 'medium' } }],
  }, { cwd });
  assert.equal(badOption.isError, true);
  assert.match(badOption.content[0].text, /options: small, large/);

  const filled = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_form', values: { Name: 'Mixdog', Agree: 'yes', Size: 'large', Colour: '/blue' } }],
  }, { cwd }));
  assert.deepEqual(filled.results[0].filled, ['Name', 'Agree', 'Size', 'Colour']);
  assert.equal(filled.results[0].flattened, false);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(
    Object.fromEntries(snapshot.document.fields.map((field) => [field.name, field.value])),
    { Name: 'Mixdog', Agree: true, Size: 'large', Colour: 'blue' },
  );

  const fontPath = await unicodeFontPath();
  if (!fontPath) return;
  const unicodeName = /DejaVuSans/i.test(fontPath) ? 'Ξένος' : '재영';
  const flattened = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_form', values: { Name: unicodeName }, flatten: true }],
  }, { cwd }));
  assert.equal(flattened.results[0].fontEmbedded, true);
  assert.equal(flattened.results[0].flattened, true);
  const baked = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(baked.document.fieldCount, 0);
  assert.ok(baked.document.pages[0].text.includes(unicodeName), baked.document.pages[0].text);
});

test('PDF create resolves a Unicode font, wraps unspaced text, grows table rows, and numbers pages', async (t) => {
  const fontPath = await unicodeFontPath();
  if (!fontPath) return t.skip('No Unicode TrueType font is installed');
  const cwd = await workspace(t);
  const path = join(cwd, 'wrapped.pdf');
  const greek = /DejaVuSans/i.test(fontPath);
  const prose = (greek ? 'Ελληνικά' : '한글문장').repeat(60);
  const choices = greek ? ['Αθήνα', 'Πάτρα'] : ['개발', '영업'];
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'heading', text: 'Wrap' },
      { type: 'paragraph', text: prose },
      { type: 'paragraph', text: 'line one\nline two' },
      { type: 'table', rows: [['Item', 'Description'], ['A', 'word '.repeat(80).trim()]], columnWidths: [1, 3] },
      ...Array.from({ length: 10 }, () => ({ type: 'paragraph', text: 'filler '.repeat(120).trim() })),
    ],
    fields: [
      { name: 'Team', type: 'dropdown', page: 1, x: 400, y: 780, width: 120, height: 24, options: choices, value: choices[1] },
      { name: 'Note', type: 'text', page: 1, x: 400, y: 740, width: 120, height: 24, value: choices[0] },
    ],
  }, { cwd }));
  assert.equal(created.font.embedded, true);
  assert.equal(created.pageNumbers, true);
  assert.deepEqual(created.document.fields.map((field) => field.value), [choices[1], choices[0]]);
  const pageCount = created.document.pageCount;
  assert.ok(pageCount >= 2);
  const layout = value(await executeOfficeTool({ action: 'query', session: created.session, queryKind: 'pdf-layout' }, { cwd }));
  for (const page of layout.pages) {
    for (const item of page.items) assert.ok(item.x + item.width <= page.width + 1, `${item.text} leaves page ${page.page}`);
  }
  const items = layout.pages[0].items;
  const lineOne = items.find((item) => item.text === 'line one');
  const lineTwo = items.find((item) => item.text === 'line two');
  assert.ok(lineOne && lineTwo && lineTwo.top > lineOne.top);
  const last = layout.pages.at(-1);
  assert.ok(last.items.some((item) => item.text === `${last.page} / ${pageCount}`));
});

test('PDF tables read bordered cells by geometry and ignore the prose around them', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'ruled.pdf');
  const description = 'word '.repeat(30).trim();
  const png = join(cwd, 'dot.png');
  await writeFile(png, PNG_PIXEL);
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'heading', text: 'Quarterly numbers' },
      { type: 'paragraph', text: 'Two columns of prose sit above the table and must not become rows.' },
      { type: 'table', rows: [['Item', 'Description', 'Value'], ['A', description, '12'], ['B', '', '7']], columnWidths: [1, 3, 1] },
      { type: 'paragraph', text: 'Source: internal ledger 2026' },
      { type: 'image', path: png, width: 40, height: 40, align: 'center' },
    ],
    properties: { pageNumbers: true },
  }, { cwd }));
  const pictures = value(await executeOfficeTool({ action: 'query', session: created.session, queryKind: 'pdf-images' }, { cwd }));
  assert.equal(pictures.imageCount, 1);
  assert.ok(Math.abs(pictures.images[0].x - ((595.28 - 40) / 2)) < 1 && Math.abs(pictures.images[0].placedWidth - 40) < 1, JSON.stringify(pictures.images[0]));
  const tables = value(await executeOfficeTool({ action: 'query', session: created.session, queryKind: 'pdf-tables', output: 'tables' }, { cwd }));
  assert.equal(tables.tableCount, 1);
  const [table] = tables.tables;
  assert.equal(table.source, 'ruled');
  assert.equal(table.columns, 3);
  assert.deepEqual(table.rows[0], ['Item', 'Description', 'Value']);
  assert.equal(table.rows[1][0], 'A');
  assert.equal(table.rows[1][1].replace(/\s+/g, ' '), description);
  assert.deepEqual(table.rows[2], ['B', '', '7']);
  assert.equal(table.path, join(cwd, 'tables', 'page-1-table-1.csv'));
  const csv = await readFile(table.path, 'utf8');
  assert.ok(csv.startsWith('Item,Description,Value\r\nA,"'), csv.slice(0, 40));
  assert.ok(csv.endsWith('B,,7\r\n'));
});

test('PDF text wrapping keeps line breaks, wraps at spaces, and breaks unspaced runs by character', () => {
  const font = { widthOfTextAtSize: (text, size) => Array.from(text).length * size };
  assert.deepEqual(wrapText('', font, 10, 100), ['']);
  assert.deepEqual(wrapText('one two three', font, 10, 70), ['one two', 'three']);
  assert.deepEqual(wrapText('first\n\nthird', font, 10, 100), ['first', '', 'third']);
  assert.deepEqual(wrapText('가나다라마바사', font, 10, 30), ['가나다', '라마바', '사']);
  assert.deepEqual(wrapText('ab 가나다라마바사 cd', font, 10, 40), ['ab', '가나다라', '마바사', 'cd']);
});

test('PDF batches merge sources, extract page subsets to a file, rotate relatively, and round-trip attachments', async (t) => {
  const cwd = await workspace(t);
  const main = join(cwd, 'main.pdf');
  const extra = join(cwd, 'extra.pdf');
  const one = await PDFDocument.create();
  one.addPage([200, 100]);
  await writeFile(main, await one.save());
  const three = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) three.addPage([200, 100]);
  await writeFile(extra, await three.save());
  const attachment = join(cwd, 'data.csv');
  await writeFile(attachment, 'a,b\n1,2\n', 'utf8');

  const opened = value(await executeOfficeTool({ action: 'open', path: main, mode: 'portable' }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'merge_pdf', sources: [{ path: extra, pages: [1, 3], title: 'Extra' }], bookmarks: true },
      { op: 'add_bookmark', title: 'Start', page: 1 },
      { op: 'rotate_pages', pages: [1], rotation: 90 },
      { op: 'rotate_pages', pages: [1], rotation: 90 },
      { op: 'extract_pages', pages: [2, 3], output: 'subset.pdf' },
      { op: 'add_attachment', path: attachment, name: 'data.csv' },
      { op: 'compress' },
    ],
  }, { cwd }));
  const [merge, , rotateA, rotateB, extract, , compress] = edited.results;
  assert.equal(merge.pagesAdded, 2);
  assert.equal(merge.pageCount, 3);
  assert.equal(merge.bookmarks, 1);
  assert.equal(rotateA.pages[0].rotation, 90);
  assert.equal(rotateB.pages[0].rotation, 180);
  assert.equal(extract.documentChanged, false);
  assert.equal((await PDFDocument.load(await readFile(extract.output))).getPageCount(), 2);
  assert.equal(typeof compress.bytesBefore, 'number');
  assert.equal(typeof compress.bytesAfter, 'number');

  const extracted = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'extract_attachment', name: 'data.csv', output: 'data-copy.csv' },
      { op: 'split_pages', output: 'parts' },
      { op: 'split_pages', every: 2, output: 'pairs' },
    ],
  }, { cwd }));
  assert.equal(await readFile(extracted.results[0].output, 'utf8'), 'a,b\n1,2\n');
  const [, split, pairs] = extracted.results;
  assert.equal(split.count, 3);
  assert.deepEqual(split.files.map((file) => file.pages), [[1], [2], [3]]);
  assert.ok(split.files[2].output.endsWith('-003.pdf') && split.files[2].output.startsWith(join(cwd, 'parts')));
  assert.equal((await PDFDocument.load(await readFile(split.files[1].output))).getPageCount(), 1);
  assert.deepEqual(pairs.files.map((file) => file.pages), [[1, 2], [3]]);
  assert.ok(pairs.files[0].output.endsWith('-001-002.pdf'));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.pageCount, 3);
  assert.equal(snapshot.document.pages[0].rotation, 180);
  assert.equal(snapshot.document.attachments[0].name, 'data.csv');
  assert.deepEqual(
    snapshot.document.outline.map((entry) => [entry.title, entry.page, entry.level]),
    [['Extra', 2, 1], ['Start', 1, 1]],
  );
});

const PDF_PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function rc4(key, data) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const output = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k += 1) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    output[k] = data[k] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}

function md5(...parts) {
  return createHash('md5').update(Buffer.concat(parts)).digest();
}

function paddedPassword(password) {
  return Buffer.concat([Buffer.from(password, 'latin1'), PDF_PAD]).subarray(0, 32);
}

// Standard security handler, revision 2 (RC4 40-bit): the smallest file a
// viewer treats as encrypted and, with a user password, refuses to open.
function encryptedPdf({ userPassword = '', ownerPassword = 'owner' } = {}) {
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const permissions = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const ownerValue = rc4(md5(paddedPassword(ownerPassword)).subarray(0, 5), paddedPassword(userPassword));
  const key = md5(paddedPassword(userPassword), ownerValue, permissions, id).subarray(0, 5);
  const userValue = rc4(key, PDF_PAD);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O <${ownerValue.toString('hex')}> /U <${userValue.toString('hex')}> >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('PDF snapshots report encryption and edits point at secure decrypt', async (t) => {
  const cwd = await workspace(t);
  const locked = join(cwd, 'locked.pdf');
  await writeFile(locked, encryptedPdf({ userPassword: 'secret' }));
  const opened = value(await executeOfficeTool({ action: 'open', path: locked, mode: 'portable' }, { cwd }));
  assert.equal(opened.document.encrypted, true);
  assert.equal(opened.document.passwordRequired, true);
  assert.equal(opened.document.pageCount, 1);
  const edit = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: 'x' }],
  }, { cwd });
  assert.equal(edit.isError, true);
  assert.match(edit.content[0].text, /security:'decrypt'/);
  const issues = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'encrypted' && issue.severity === 'error'));
  const wrongPassword = value(await executeOfficeTool({ action: 'snapshot', session: opened.session, password: 'nope' }, { cwd }));
  assert.equal(wrongPassword.document.passwordRequired, true);
  const unlocked = value(await executeOfficeTool({ action: 'snapshot', session: opened.session, password: 'secret' }, { cwd }));
  assert.equal(unlocked.document.encrypted, true);
  assert.equal(unlocked.document.passwordRequired, false);
  assert.deepEqual(unlocked.document.likelyScannedPages, [1]);

  const ownerOnly = join(cwd, 'owner-only.pdf');
  await writeFile(ownerOnly, encryptedPdf({ userPassword: '' }));
  const readable = value(await executeOfficeTool({ action: 'open', path: ownerOnly, mode: 'portable' }, { cwd }));
  assert.equal(readable.document.encrypted, true);
  assert.equal(readable.document.passwordRequired, false);
});

test('PDF secure either encrypts through qpdf or says plainly that qpdf is missing', async (t) => {
  const cwd = await workspace(t);
  const plain = join(cwd, 'plain.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  await writeFile(plain, await pdf.save());
  const secured = await executeOfficeTool({
    action: 'secure',
    security: 'encrypt',
    path: plain,
    password: 'secret',
    output: 'locked.pdf',
  }, { cwd });
  if (secured.isError) {
    assert.match(secured.content[0].text, /qpdf/);
    assert.match(secured.content[0].text, /left as is/);
    return;
  }
  const locked = value(await executeOfficeTool({ action: 'open', path: join(cwd, 'locked.pdf'), mode: 'portable' }, { cwd }));
  assert.equal(locked.document.encrypted, true);
  assert.equal(locked.document.passwordRequired, true);
  value(await executeOfficeTool({
    action: 'secure',
    security: 'decrypt',
    path: join(cwd, 'locked.pdf'),
    password: 'secret',
    output: 'unlocked.pdf',
  }, { cwd }));
  const unlocked = value(await executeOfficeTool({ action: 'open', path: join(cwd, 'unlocked.pdf'), mode: 'portable' }, { cwd }));
  assert.equal(unlocked.document.encrypted, false);
});
