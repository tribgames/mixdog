import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { executeOfficeTool } from './index.mjs';
import { renderPdfPages } from './pdf/pdf-render.mjs';
import { ocrTextLines, parseOcrBlocks, parseOcrTsv } from './pdf/pdf-analysis.mjs';
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

  const pendingReview = value(await executeOfficeTool({
    action: 'finalize',
    session: opened.session,
    output: join(cwd, 'final-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd }));
  assert.equal(pendingReview.finalized, false);
  assert.equal(pendingReview.reason, 'visual_review_required');
  const finalizedResult = await executeOfficeTool({
    action: 'finalize',
    session: opened.session,
    output: join(cwd, 'final-preview.pdf'),
    pages: [1],
    maxWidth: 640,
    design: {
      reviewed: true,
      reviewToken: pendingReview.reviewToken,
      critique: [{ page: 1, verdict: 'pass', note: 'The rotated test page retains its edited text inside the page bounds.' }],
    },
  }, { cwd });
  const finalized = value(finalizedResult);
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.review._images, undefined);
  assert.equal(finalizedResult.content.filter((item) => item.type === 'image').length, 1);
});

// The audit read the same 30K excerpt a reader is shown: on a long report the
// text ran out a few pages in, and a scanned page after that was never reported
// while the answer still read "ok, nothing found".
test('the PDF audit reads every page, not the excerpt a reader is shown', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'long-report.pdf');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const line = 'Night dock throughput held at ninety two percent of the plan. ';
  for (let page = 1; page <= 14; page += 1) {
    const sheet = pdf.addPage([612, 792]);
    for (let row = 0; row < 45; row += 1) {
      sheet.drawText(`${page}-${row} ${line}`, { x: 48, y: 740 - row * 16, size: 10, font });
    }
  }
  // The scanned insert at the back: a page that carries no text layer at all.
  pdf.addPage([612, 792]);
  await writeFile(path, await pdf.save());

  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const audited = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.ok(
    audited.issues.some((issue) => issue.code === 'ocr_required' && issue.path === '/page[15]'),
    JSON.stringify(audited.issues),
  );
  assert.equal(audited.issues.some((issue) => issue.code === 'audit_scope_limited'), false);
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));
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

// OCR is promised to the user before it runs. The engine ships with the
// runtime, but each language's data arrives on first use, so a machine with no
// network reads only what its cache already holds.
test('detect reports which OCR languages this machine can already read', async (t) => {
  await workspace(t);
  const cache = join(process.env.MIXDOG_DATA_DIR, 'office', 'ocr', 'languages');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'kor.traineddata'), 'x');
  await writeFile(join(cache, 'eng.traineddata.gz'), 'x');
  const detected = value(await executeOfficeTool({ action: 'detect' }));
  assert.equal(detected.portable.pdfOcr.available, true);
  assert.deepEqual(detected.portable.pdfOcr.cachedLanguages, ['eng', 'kor']);
  assert.equal(detected.portable.pdfOcr.cachePath, cache);
});

// A PDF can only carry characters some embedded face has a glyph for. Refusing
// is right — a dropped character would ship silently — but the refusal has to
// name what blocks the file, or the caller hunts for a font that cannot exist.
test('a character no installed font carries is named in the refusal, not left to a font hunt', async (t) => {
  const cwd = await workspace(t);
  const emoji = await executeOfficeTool({
    action: 'create',
    format: 'pdf',
    path: join(cwd, 'emoji.pdf'),
    blocks: [{ type: 'paragraph', text: '야간 처리량 😀 회의' }],
  }, { cwd });
  const message = emoji.content[0].text;
  assert.match(message, /U\+1F600/);
  assert.match(message, /Replace or remove/);
  assert.equal(existsSync(join(cwd, 'emoji.pdf')), false, 'a refused create leaves no file behind');
  // The same text without that one character is written normally.
  const plain = value(await executeOfficeTool({
    action: 'create',
    format: 'pdf',
    path: join(cwd, 'plain.pdf'),
    blocks: [{ type: 'paragraph', text: '야간 처리량 92.8% — 회의' }],
  }, { cwd }));
  assert.match(plain.document.pages[0].text, /야간 처리량 92\.8%/);
});

// A scan becomes searchable only if the invisible layer carries the words the
// page shows. Korean and CJK word boxes are ink extents split at syllable
// boundaries, so rebuilding a line from geometry reads 출고율 as "출 고 율" and
// the phrase on the page can no longer be found.
test('the OCR text layer keeps the line the engine read, not its word boxes', () => {
  const rows = [
    '1\t1\t0\t0\t0\t0\t0\t0\t1191\t1684\t-1\t',
    '4\t1\t1\t1\t1\t0\t153\t378\t245\t26\t-1\t',
    '5\t1\t1\t1\t1\t1\t153\t378\t52\t26\t93.3\t정시',
    '5\t1\t1\t1\t1\t2\t231\t378\t34\t26\t91.3\t출',
    '5\t1\t1\t1\t1\t3\t281\t378\t17\t26\t93.0\t고',
    '5\t1\t1\t1\t1\t4\t297\t374\t23\t44\t92.7\t율',
    '5\t1\t1\t1\t1\t5\t321\t381\t77\t21\t92.4\t92.8%',
    '5\t1\t1\t1\t2\t1\t153\t444\t55\t26\t96.2\t야간',
    '5\t1\t1\t1\t2\t2\t900\t444\t55\t26\t96.9\t증원',
  ].join('\n');
  const lines = ocrTextLines(rows, '정시 출고율 92.8%\n야간                      증원\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '정시 출고율 92.8%');
  assert.equal(lines[0].fromEngine, true);
  assert.deepEqual(
    { left: lines[0].left, top: lines[0].top, width: lines[0].width, height: lines[0].height },
    { left: 153, top: 374, width: 245, height: 44 },
  );
  // Two columns the engine read as one row: stretching a single run across the
  // gap would put every character in it far from the word it belongs to.
  assert.ok(lines[1].columnGap > lines[1].height * 1.5, JSON.stringify(lines[1]));
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
  // The worker API writes this table without a header row, so a reader that
  // assumes one eats the first word and reports an empty page.
  const headerless = parseOcrTsv('5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t92.5\tHello\n5\t1\t1\t1\t1\t2\t50\t20\t20\t12\t88\tworld');
  assert.deepEqual(headerless.map((word) => word.text), ['Hello', 'world']);
  assert.equal(headerless[0].left, 10);
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

test('PDF blocks are checked before writing, and a list is drawn as a list', async (t) => {
  const cwd = await workspace(t);
  // A block the writer cannot read used to flow as an empty paragraph: the
  // table and the list simply never appeared, and the result said nothing.
  const refused = await executeOfficeTool({
    action: 'create',
    path: join(cwd, 'refused.pdf'),
    format: 'pdf',
    blocks: [
      { kind: 'title', text: 'Night shift' },
      { type: 'bullets', items: ['hire'] },
      { type: 'table', columns: 3 },
    ],
  }, { cwd });
  assert.equal(refused.isError, true);
  const message = refused.content[0].text;
  assert.match(message, /block 1 names its block with kind; the field is type/);
  assert.match(message, /block 2 has unknown type "bullets"\. Use one of: paragraph, heading, list, table, image, pagebreak, cover, callout, quote, caption, stats, rule/);
  assert.match(message, /block 3 \(table\) has unknown field\(s\): columns/);
  assert.match(message, /block 3 \(table\) is missing: rows/);
  assert.equal(existsSync(join(cwd, 'refused.pdf')), false, 'a refused create leaves no file behind');

  const path = join(cwd, 'listed.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'heading', text: 'Actions' },
      { type: 'list', items: ['Hire twelve crew', 'Add one shuttle'] },
      { type: 'list', ordered: true, items: ['First', 'Second'] },
      { type: 'table', headers: ['Item', 'Count'], rows: [['Crew', '12']] },
    ],
  }, { cwd }));
  const layout = value(await executeOfficeTool({
    action: 'query',
    session: created.session,
    queryKind: 'pdf-layout',
  }, { cwd }));
  const items = layout.pages[0].items.map((item) => item.text.trim());
  assert.ok(items.includes('•'), `the bullet is drawn: ${JSON.stringify(items)}`);
  assert.ok(
    items.some((item) => /^1\.\s*First$/.test(item)) && items.some((item) => /^2\.\s*Second$/.test(item)),
    `an ordered list numbers its items: ${JSON.stringify(items)}`,
  );
  // The marker sits left of its text, which keeps its own indent.
  const marker = layout.pages[0].items.find((item) => item.text.trim() === '•');
  const text = layout.pages[0].items.find((item) => item.text.includes('Hire twelve crew'));
  assert.ok(marker.x < text.x, JSON.stringify({ marker: marker.x, text: text.x }));
  // A table header given separately still leads the table.
  assert.ok(items.includes('Item') && items.includes('Crew'));
  assert.equal(created.blocks, 4, JSON.stringify({ blocks: created.blocks, fields: created.fields }));
});

// The document anatomy beyond prose — a cover group, a stat strip, a callout field, a quote with its
// rule, a caption, a rule — is written by the same writer, in Korean, and every word lands on the page.
test('PDF anatomy blocks — cover, stats, callout, quote, caption, rule — are drawn and their words land', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'anatomy.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'cover', eyebrow: '운영기획팀 · 내부 검토', title: '물류 허브 증설 검토', subtitle: '도크 4 증설 예산 승인 요청', meta: ['2026년 9월', '작성: 운영기획팀'] },
      { type: 'stats', items: [{ value: '1.6배', label: '처리량 (운영 로그)' }, { value: '0.3%', label: '오류율 (품질 시트)' }, { value: '22시', label: '피크 시간대' }] },
      { type: 'callout', label: '결론', text: '야간 셔틀 두 대를 추가한 첫 분기에 처리량은 1.6배로 늘고 오류율은 0.3%로 내려갔다.' },
      { type: 'quote', text: '야간에 도크가 하나 더 있었다면 셔틀을 기다리며 서 있는 시간이 없었을 겁니다.', attribution: '3번 도크 야간 조장' },
      { type: 'rule' },
      { type: 'paragraph', text: '본문 단락.' },
      { type: 'caption', text: '표: 라인별 월 처리 건수. 출처: 운영 로그.' },
    ],
  }, { cwd }));
  assert.equal(created.blocks, 7);
  const layout = value(await executeOfficeTool({ action: 'query', session: created.session, queryKind: 'pdf-layout' }, { cwd }));
  const items = layout.pages[0].items.map((item) => item.text.trim());
  for (const expected of ['물류 허브 증설 검토', '도크 4 증설 예산 승인 요청', '1.6배', '피크 시간대', '결론', '— 3번 도크 야간 조장', '표: 라인별 월 처리 건수. 출처: 운영 로그.']) {
    assert.ok(items.some((item) => item.includes(expected)), `${expected} is on the page: ${JSON.stringify(items)}`);
  }
  // The stat strip's values share one baseline, and the callout's label sits above its text.
  const values = layout.pages[0].items.filter((item) => ['1.6배', '0.3%', '22시'].includes(item.text.trim()));
  assert.equal(values.length, 3);
  assert.ok(values.every((item) => Math.abs(item.top - values[0].top) < 1), JSON.stringify(values.map((item) => item.top)));
  const label = layout.pages[0].items.find((item) => item.text.trim() === '결론');
  const body = layout.pages[0].items.find((item) => item.text.includes('야간 셔틀 두 대를'));
  assert.ok(label.top < body.top, JSON.stringify({ label: label.top, body: body.top }));
  // A block that names a stat wrongly is refused before anything is written.
  const refused = await executeOfficeTool({ action: 'create', path: join(cwd, 'refused.pdf'), format: 'pdf', blocks: [{ type: 'stats', items: ['1.6배'] }] }, { cwd });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /stats\) items must be an array of \{ value, label \} objects/);
});

// A user's .svg logo lands in Word, Excel and PowerPoint; the PDF page draws
// rasters only, so the same file was refused outright. It is rasterized here,
// and the page still places it at the size the vector declares.
test('an SVG lands on a PDF page at its own size, rasterized above it', async (t) => {
  const cwd = await workspace(t);
  const svg = join(cwd, '로고.svg');
  await writeFile(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="#1F6F8B"/></svg>',
  );
  const path = join(cwd, 'logo.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [{ type: 'heading', text: '로고' }, { type: 'image', path: svg }],
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'stamp_image', page: 1, path: svg, x: 60, y: 60, width: 120 }],
  }, { cwd }));
  const images = value(await executeOfficeTool({
    action: 'query',
    session: created.session,
    queryKind: 'pdf-images',
  }, { cwd }));
  const placements = images.images.map((image) => ({
    placedWidth: image.placedWidth,
    placedHeight: image.placedHeight,
    pixels: image.width,
  }));
  const flowed = placements.find((image) => Math.abs(image.placedWidth - 240) < 1);
  const stamped = placements.find((image) => Math.abs(image.placedWidth - 120) < 1);
  // The block is placed at the vector's declared size, not at its pixel count.
  assert.ok(flowed && Math.abs(flowed.placedHeight - 120) < 1, JSON.stringify(placements));
  // A stamp keeps its own width and the vector's aspect ratio.
  assert.ok(stamped && Math.abs(stamped.placedHeight - 60) < 1, JSON.stringify(placements));
  // Both are rasterized well above the box, so zooming the page does not blur them.
  assert.ok(flowed.pixels >= 480, JSON.stringify(placements));
});

// A table whose header looked exactly like its data, with every figure started
// at the left edge of its column, is a grid of text rather than a table: the
// reader cannot scan the numbers or tell which row names the columns.
test('a written table sets its figures against the right edge and marks its header', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'hubs.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'table', headers: ['허브', '처리량', '메모'], rows: [['대전', '128,400', '야간 증원 검토'], ['광주', '84,200', '유지']] },
    ],
  }, { cwd }));
  const layout = value(await executeOfficeTool({
    action: 'query',
    session: created.session,
    queryKind: 'pdf-layout',
  }, { cwd }));
  const { items, lines } = layout.pages[0];
  const at = (text) => items.find((item) => item.text === text);
  const rightEdge = (text) => at(text).x + at(text).width;
  assert.ok(Math.abs(rightEdge('128,400') - rightEdge('84,200')) < 0.6, JSON.stringify([at('128,400'), at('84,200')]));
  assert.ok(at('128,400').x > at('대전').x + 40, 'the figures are set against the right edge of their column');
  // Words stay on the left: only the column of figures turns.
  assert.ok(Math.abs(at('야간 증원 검토').x - at('유지').x) < 0.6, 'the note column stays left-aligned');
  const headerBottom = at('허브').top + 12;
  assert.ok(
    lines.some((line) => Math.abs(line.y1 - line.y2) < 0.6 && line.x2 - line.x1 > 300 && Math.abs(line.y1 - headerBottom) < 14),
    `a rule closes the header row: ${JSON.stringify(lines)} against ${headerBottom}`,
  );
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

// `design` carries authoring content for every other format, so blocks named
// there were the document: dropping them wrote an empty PDF and reported success.
test('PDF blocks given as design content are written, and an empty document is visible in the result', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'hub.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    design: {
      blocks: [
        { type: 'heading', text: '허브별 실적' },
        { type: 'table', headers: ['허브', '지연'], rows: [['대전', '38'], ['부산', '9']] },
      ],
    },
  }, { cwd }));
  assert.equal(created.blocks, 2, JSON.stringify({ blocks: created.blocks, fields: created.fields }));
  const tables = value(await executeOfficeTool({
    action: 'query',
    session: created.session,
    queryKind: 'pdf-tables',
  }, { cwd }));
  assert.equal(tables.tableCount, 1);
  assert.deepEqual(tables.tables[0].rows, [['허브', '지연'], ['대전', '38'], ['부산', '9']]);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));

  const empty = value(await executeOfficeTool({
    action: 'create',
    path: join(cwd, 'empty.pdf'),
    format: 'pdf',
  }, { cwd }));
  assert.equal(empty.blocks, 0);
  assert.equal(empty.fields, 0);
  value(await executeOfficeTool({ action: 'close', session: empty.session }, { cwd }));
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

test('a form field takes a reader\'s rectangle and draws the caption it declares', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'labelled-form.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    mode: 'portable',
    blocks: [{ type: 'heading', text: 'Request' }],
    // rect and kind are how a PDF reader reports a field; both spellings reach
    // the box and the type the writer draws.
    fields: [
      { name: 'hub', label: 'Hub', kind: 'text', page: 1, rect: [72, 600, 260, 24] },
      { name: 'approved', label: 'Approved', kind: 'checkbox', page: 1, rect: [72, 560, 18, 18] },
    ],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.deepEqual(
    snapshot.document.fields.map((field) => [field.name, field.type]),
    [['hub', 'text'], ['approved', 'checkbox']],
  );
  // A field is a bare box: without its caption drawn, the page reaches the
  // reader as unlabelled rectangles.
  const page = snapshot.document.pages[0];
  assert.ok(page.text.includes('Hub') && page.text.includes('Approved'), page.text);

  const boxless = await executeOfficeTool({
    action: 'create',
    path: join(cwd, 'boxless-form.pdf'),
    format: 'pdf',
    mode: 'portable',
    blocks: [{ type: 'heading', text: 'Request' }],
    fields: [{ name: 'hub', label: 'Hub', type: 'text', page: 1 }],
  }, { cwd });
  assert.equal(boxless.isError, true);
  assert.match(boxless.content[0].text, /Form field hub has no usable box: give x, y, width and height/);
});

test('a filled value that will not fit its field box is reported with the fill', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'clipped-form.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    mode: 'portable',
    blocks: [{ type: 'heading', text: 'Request' }],
    fields: [
      { name: 'department', type: 'text', page: 1, x: 200, y: 640, width: 120, height: 22, fontSize: 11 },
      { name: 'reason', type: 'text', page: 1, x: 200, y: 500, width: 200, height: 40, multiline: true, fontSize: 11 },
    ],
  }, { cwd }));
  // A form reads as filled whether or not the box can show the value, so the
  // measurement rides on the fill itself.
  const overflowing = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{
      op: 'fill_form',
      values: {
        department: 'Operations planning and night logistics group',
        reason: 'The night shift ran at sixty-eight percent of its planned headcount for the whole quarter, and the on-time dispatch rate fell with it every single week.',
      },
    }],
  }, { cwd }));
  const clipped = overflowing.results[0].clipped || [];
  assert.deepEqual(clipped.map((entry) => entry.field).sort(), ['department', 'reason']);
  assert.equal(clipped.find((entry) => entry.field === 'department').reason, 'width');
  assert.equal(clipped.find((entry) => entry.field === 'reason').reason, 'height');
  assert.match(overflowing.results[0].warning, /do not fit their field box/);
  const fitting = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'fill_form', values: { department: 'Ops', reason: 'Short reason.' } }],
  }, { cwd }));
  assert.equal(fitting.results[0].clipped, undefined);
  assert.equal(fitting.results[0].warning, undefined);
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

// A writer splits a line into a run per token, and Korean has no space before
// a particle: reading the file back must return the sentence that was written,
// and a query must answer with the text around the hit, not the whole body.
test('PDF text reads back with its own spacing and a query answers with an excerpt', async (t) => {
  const fontPath = await unicodeFontPath();
  if (!fontPath) return t.skip('No Unicode TrueType font is installed');
  const greek = /DejaVuSans/i.test(fontPath);
  const sentence = greek
    ? 'Η νυχτερινή βάρδια αυξήθηκε 18% το 2026.'
    : '야간 전환 뒤 처리량이 18% 늘었습니다.';
  const needle = greek ? 'νυχτερινή' : '야간';
  const cwd = await workspace(t);
  const path = join(cwd, 'spacing.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    properties: { pageNumbers: false },
    blocks: [
      { type: 'heading', text: greek ? 'Αναφορά' : '분기 보고' },
      { type: 'paragraph', text: sentence },
      ...Array.from({ length: 12 }, () => ({ type: 'paragraph', text: `${sentence} ` .repeat(6).trim() })),
    ],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
  assert.ok(snapshot.document.pages[0].text.includes(sentence), snapshot.document.pages[0].text.slice(0, 200));
  const queried = value(await executeOfficeTool({ action: 'query', session: created.session, query: needle }, { cwd }));
  const body = queried.matches.find((match) => match.excerpt === true);
  assert.ok(body, JSON.stringify(queried.matches).slice(0, 300));
  assert.ok(body.value.includes(needle));
  assert.ok(body.value.length < body.valueLength, `${body.value.length} < ${body.valueLength}`);
  assert.ok(body.occurrences > 3, `occurrences ${body.occurrences}`);
  for (const match of queried.matches) assert.ok(String(match.value).length <= 700, String(match.value).length);
});

// A heading belongs to the section it opens, not to the paragraph it follows.
// The writer owns that flow, so the gap above a heading is wider than the gap
// under it without the author asking — and no gap is spent at the top of a page.
test('PDF flow opens a section: a heading takes more space above it than below', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'flow.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    properties: { margin: 54, pageNumbers: false },
    blocks: [
      { type: 'heading', text: 'Opening', level: 1 },
      { type: 'paragraph', text: 'The first section ends here.' },
      { type: 'heading', text: 'Evidence', level: 2 },
      { type: 'paragraph', text: 'The second section starts here.' },
    ],
  }, { cwd }));
  const layout = value(await executeOfficeTool({ action: 'query', session: created.session, queryKind: 'pdf-layout' }, { cwd }));
  const items = layout.pages[0].items;
  const at = (text) => items.find((item) => item.text.startsWith(text));
  const [first, ends, heading, starts] = ['Opening', 'The first section ends', 'Evidence', 'The second section'].map(at);
  assert.ok(first && ends && heading && starts, JSON.stringify(items.map((item) => item.text)));
  const above = heading.top - (ends.top + ends.height);
  const below = starts.top - (heading.top + heading.height);
  assert.ok(above > below, `heading gap above ${above.toFixed(1)} should exceed below ${below.toFixed(1)}`);
  // The first block still starts at the top margin: the rule never opens a page with a hole.
  assert.ok(first.top < 60, `first heading starts at ${first.top.toFixed(1)}`);
});

// A first column of 1호, 2호 is a row label with a digit in it; figures are set
// against the right edge, labels against the left, and a list leaves the same
// step under it that a table does.
test('PDF tables keep a digit-bearing label column left and figures right', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'labels.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    properties: { margin: 54, pageNumbers: false },
    blocks: [
      { type: 'list', items: ['first point', 'second point'] },
      { type: 'table', headers: ['Line', 'Oct', 'Nov'], rows: [['1호', '1,200', '1,320'], ['2호', '980', '1,150']], columnWidths: [2, 1, 1] },
    ],
  }, { cwd }));
  const layout = value(await executeOfficeTool({ action: 'query', session: created.session, queryKind: 'pdf-layout' }, { cwd }));
  const items = layout.pages[0].items;
  const at = (text) => items.find((item) => item.text === text);
  const [line, one, two, oct, big, small] = ['Line', '1호', '2호', 'Oct', '1,200', '980'].map(at);
  // pdf.js joins the bullet and its text into one run or two depending on the
  // embedded face's space width; the list item is the run that ends with its text.
  const second = items.find((item) => item.text.endsWith('second point'));
  assert.ok(line && one && two && oct && big && small && second, JSON.stringify(items.map((item) => item.text)));
  // Labels share the header's left edge; figures share one right edge.
  assert.ok(Math.abs(one.x - line.x) < 1 && Math.abs(two.x - line.x) < 1, `${one.x} ${two.x} vs ${line.x}`);
  assert.ok(Math.abs((big.x + big.width) - (small.x + small.width)) < 1, `${big.x + big.width} vs ${small.x + small.width}`);
  assert.ok(big.x > one.x + one.width, 'figures sit in their own column, right of the labels');
  assert.ok(Math.abs((oct.x + oct.width) - (big.x + big.width)) < 1, 'the header over a figure column shares its right edge');
  // The table starts a full step under the list's last item.
  assert.ok(line.top - (second.top + second.height) >= 10, `${line.top - (second.top + second.height)}`);
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
