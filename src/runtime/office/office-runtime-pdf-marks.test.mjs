import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import { executeOfficeTool } from './index.mjs';
import { findPdfText } from './pdf/pdf-analysis.mjs';
import { value, workspace } from './office-test-support.mjs';

// Reading positions and marking an existing PDF: text search, highlight,
// links, page-number placeholders, field previews, and the safety report.

test('PDF text search joins runs on a line and maps a match back to its box', () => {
  const layout = {
    pageCount: 1,
    pages: [{
      page: 1,
      width: 200,
      height: 100,
      items: [
        { text: 'Grand ', x: 10, top: 20, width: 30, height: 10 },
        { text: 'total', x: 40, top: 20, width: 25, height: 10 },
        { text: 'due', x: 70, top: 20.5, width: 15, height: 10 },
        { text: 'Total', x: 10, top: 50, width: 25, height: 10 },
      ],
    }],
  };
  const result = findPdfText(layout, '  total   DUE ');
  assert.equal(result.query, 'total DUE');
  assert.deepEqual(result.matches, [{ page: 1, text: 'total due', line: 'Grand total due', x: 40, top: 20, width: 45, height: 10.5 }]);
  assert.equal(findPdfText(layout, 'total').matchCount, 2);
  assert.equal(findPdfText(layout, 'total', { limit: 1 }).truncated, true);
  assert.throws(() => findPdfText(layout, '   '), /needs query text/);
  assert.equal(findPdfText(layout, 'tota', { wholeWord: true }).matchCount, 0);
  assert.equal(findPdfText(layout, 'total', { wholeWord: true }).matchCount, 2);
  assert.equal(findPdfText(layout, 'tot?al', { regex: true }).matchCount, 2);
  // A pattern that can match nothing never yields empty matches.
  assert.equal(findPdfText(layout, 'x*', { regex: true }).matchCount, 0);
  // Inside one run the box follows glyph widths, not character counts: four i's take far less than half.
  const [narrow] = findPdfText({ pages: [{ page: 1, items: [{ text: 'iiiiWWWW', x: 0, top: 0, width: 100, height: 10 }] }] }, 'WWWW').matches;
  assert.ok(narrow.x < 25 && Math.abs(narrow.x + narrow.width - 100) < 0.01, JSON.stringify(narrow));
  const [hangul] = findPdfText({ pages: [{ page: 1, items: [{ text: '이번 분기 총매출', x: 0, top: 0, width: 100, height: 10 }] }] }, '총매출').matches;
  assert.ok(Math.abs(hangul.x + hangul.width - 100) < 0.01 && hangul.width > 35 && hangul.width < 43, JSON.stringify(hangul));
});

test('PDF search, highlight, links, and page-number placeholders work on an existing document', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'marks.pdf');
  const output = join(cwd, 'marks-out.pdf');
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) {
    const page = pdf.addPage([400, 300]);
    page.drawText(`Section ${index + 1}`, { x: 40, y: 250, size: 14 });
    if (index === 1) page.drawText('Grand total due: 120 USD. Terms at mix.dog apply.', { x: 40, y: 200, size: 12 });
  }
  await writeFile(source, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));

  const found = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout', query: 'TOTAL due' }, { cwd }));
  assert.equal(found.matchCount, 1);
  const [hit] = found.matches;
  assert.equal(hit.page, 2);
  assert.equal(hit.text, 'total due');
  assert.ok(hit.x > 40 && hit.width > 20 && hit.height > 8, JSON.stringify(hit));
  assert.equal(found.pages.length, 3);
  assert.ok(!('items' in found.pages[0]));

  const missing = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'highlight', find: 'nowhere', pages: [1, 3] }],
  }, { cwd });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /found no text matching "nowhere" in pages 1, 3/);

  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'highlight', find: 'total due' },
      { op: 'add_link', find: 'mix.dog', url: 'https://mix.dog' },
      { op: 'add_link', find: 'Section 3', toPage: 1 },
      { op: 'add_text', text: '{page} / {pages}', align: 'center', y: 20, size: 9 },
      // Text added earlier in the same batch is measured afresh.
      { op: 'highlight', find: '2 / 3' },
    ],
  }, { cwd }));
  assert.deepEqual(batch.results.map((result) => [result.op, result.pages]), [
    ['highlight', [2]],
    ['add_link', [2]],
    ['add_link', [3]],
    ['add_text', [1, 2, 3]],
    ['highlight', [2]],
  ]);
  assert.equal(batch.results[0].marks, 1);
  assert.deepEqual(batch.results[0].boxes.map((box) => [box.page, box.text]), [[2, 'total due']]);
  assert.equal(batch.results[1].links, 1);
  assert.equal(batch.results[4].boxes[0].text, '2 / 3');

  const layout = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout' }, { cwd }));
  assert.deepEqual(layout.pages.map((page) => page.items.some((item) => item.text === `${page.page} / 3`)), [true, true, true]);
  const mark = layout.pages[1].boxes.find((box) => box.filled && Math.abs(box.x - (hit.x - 1)) < 0.5 && Math.abs(box.top - (hit.top - 1)) < 0.5);
  assert.ok(mark, JSON.stringify(layout.pages[1].boxes));
  assert.deepEqual(layout.pages.map((page) => page.links.map((link) => link.url || link.page)), [[], ['https://mix.dog'], [1]]);
  assert.ok(Math.abs(layout.pages[2].links[0].top - layout.pages[2].items.find((item) => item.text === 'Section 3').top) < 1.5);

  const saved = await PDFDocument.load(await readFile(output));
  const annotations = (index) => (saved.getPage(index).node.Annots()?.asArray() || []).map((ref) => saved.context.lookup(ref));
  assert.equal(annotations(0).length, 0);
  const [uri] = annotations(1);
  assert.equal(uri.get(PDFName.of('Subtype')).toString(), '/Link');
  assert.equal(uri.get(PDFName.of('A')).get(PDFName.of('URI')).decodeText(), 'https://mix.dog');
  const [internal] = annotations(2);
  assert.equal(internal.get(PDFName.of('Dest')).get(0).toString(), saved.getPage(0).ref.toString());
});

test('PDF marks by find measure documents longer than one analysis call', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'long.pdf');
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 120; index += 1) pdf.addPage([200, 100]).drawText(`Page ${index + 1}`, { x: 20, y: 50, size: 12 });
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'highlight', find: 'Page 120' },
      { op: 'add_link', find: 'Page 7', toPage: 120 },
      { op: 'add_link', find: 'Page 7', wholeWord: true, toPage: 120 },
    ],
  }, { cwd }));
  assert.deepEqual(batch.results.map((result) => result.pages), [[120], [7, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79], [7]]);
});

test('PDF preview_fields outlines fields and proposed boxes on a copy', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'form.pdf');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [{ type: 'paragraph', text: 'Name:' }],
    fields: [{ name: '성명', type: 'text', page: 1, x: 100, y: 700, width: 150, height: 24 }],
  }, { cwd }));
  const preview = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'preview_fields', output: 'form-check.pdf', boxes: [{ page: 1, x: 100, y: 650, width: 150, height: 24, label: 'Date' }] }],
  }, { cwd }));
  const [result] = preview.results;
  assert.equal(result.documentChanged, false);
  assert.equal(result.widgets, 1);
  assert.equal(result.output, join(cwd, 'form-check.pdf'));
  const copy = value(await executeOfficeTool({ action: 'open', path: result.output, mode: 'portable' }, { cwd }));
  const layout = value(await executeOfficeTool({ action: 'query', session: copy.session, queryKind: 'pdf-layout' }, { cwd }));
  const [page] = layout.pages;
  const outlined = (y, height) => page.boxes.some((box) => box.stroked && Math.abs(box.x - 100) < 1 && Math.abs(box.top - (page.height - y - height)) < 1);
  assert.ok(outlined(700, 24) && outlined(650, 24), JSON.stringify(page.boxes));
  assert.ok(page.items.some((item) => item.text === '1 성명') && page.items.some((item) => item.text === 'Date'), JSON.stringify(page.items.map((item) => item.text)));
  assert.equal((await PDFDocument.load(await readFile(path))).getForm().getFields().length, 1);
  assert.ok(!(await readFile(path)).equals(await readFile(result.output)));
});

test('PDF layout and partial marks follow text at every page rotation', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'rotated.pdf');
  const pdf = await PDFDocument.create();
  const rotations = [0, 90, 180, 270];
  for (const rotation of rotations) {
    const page = pdf.addPage([400, 300]);
    page.setMediaBox(100, 50, 400, 300);
    page.drawText('Rotated', { x: 140, y: 250, size: 14 });
    page.setRotation(degrees(rotation));
  }
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const layout = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout' }, { cwd }));
  for (const [index, displayed] of layout.pages.entries()) {
    const vertical = rotations[index] % 180 !== 0;
    assert.equal(displayed.width, vertical ? 300 : 400);
    assert.equal(displayed.height, vertical ? 400 : 300);
    const item = displayed.items.find((entry) => entry.text === 'Rotated');
    assert.ok(item && Math.abs((vertical ? item.width : item.height) - 14) < 0.5, JSON.stringify(item));
    assert.ok(item.x >= 0 && item.x + item.width <= displayed.width && item.top >= 0 && item.top + item.height <= displayed.height, JSON.stringify(item));
    assert.equal(item.vertical === true, vertical);
  }
  // A partial match lands on the same tail in user space, even with a shifted origin.
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'highlight', find: 'tated' },
      { op: 'add_link', find: 'tated', url: 'https://mix.dog' },
    ],
  }, { cwd }));
  for (const result of batch.results) {
    assert.equal(result.boxes.length, rotations.length);
    for (const box of result.boxes) {
      assert.ok(Math.abs(box.x - 157.9) < 1.5 && Math.abs(box.x + box.width - 189) < 1.5 && Math.abs(box.y - 250) < 1 && Math.abs(box.height - 14) < 1, JSON.stringify(box));
    }
  }
  const marked = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout' }, { cwd }));
  for (const page of marked.pages) {
    const [link] = page.links;
    const [hit] = findPdfText({ pages: [page] }, 'tated').matches;
    for (const key of ['x', 'top', 'width', 'height']) assert.ok(Math.abs(link[key] - hit[key]) < 0.1, `${key}: ${JSON.stringify({ link, hit })}`);
    assert.ok(page.boxes.some((box) => box.filled && Math.abs(box.x - hit.x + 1) < 0.1 && Math.abs(box.top - hit.top + 1) < 0.1));
  }
});

test('PDF reversed runs keep cross-run search and links aligned with an offset page box', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'reversed.pdf');
  const output = join(cwd, 'reversed-marked.pdf');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont('Helvetica');
  const size = 14;
  for (const angle of [180, 270]) {
    const page = pdf.addPage([400, 300]);
    page.setMediaBox(100, 50, 400, 300);
    page.setRotation(degrees(angle));
    page.drawText('Alpha', { x: 140, y: 250, size, font });
    page.drawText('beta', { x: 140 + font.widthOfTextAtSize('Alpha ', size), y: 250, size, font });
  }
  await writeFile(source, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'highlight', find: 'pha beta' },
      { op: 'add_link', find: 'pha beta', toPage: 1 },
    ],
  }, { cwd }));
  const expectedX = 140 + font.widthOfTextAtSize('Al', size);
  const expectedWidth = font.widthOfTextAtSize('pha beta', size);
  for (const result of batch.results) {
    assert.deepEqual(result.pages, [1, 2]);
    for (const box of result.boxes) {
      assert.ok(Math.abs(box.x - expectedX) < 0.1, JSON.stringify(box));
      assert.ok(Math.abs(box.width - expectedWidth) < 0.1, JSON.stringify(box));
      assert.ok(Math.abs(box.y - 250) < 0.1 && Math.abs(box.height - size) < 0.1, JSON.stringify(box));
    }
  }
  const layout = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout' }, { cwd }));
  const found = findPdfText(layout, 'pha beta');
  assert.equal(found.matchCount, 2);
  for (const match of found.matches) {
    const page = layout.pages[match.page - 1];
    const [link] = page.links;
    assert.equal(link.page, 1);
    for (const key of ['x', 'top', 'width', 'height']) assert.ok(Math.abs(link[key] - match[key]) < 0.1);
    assert.ok(page.boxes.some((box) => box.filled
      && Math.abs(box.x - (match.x - 1)) < 0.1
      && Math.abs(box.top - (match.top - 1)) < 0.1));
  }
  const saved = await PDFDocument.load(await readFile(output));
  assert.deepEqual(saved.getPages().map((page) => page.getRotation().angle), [180, 270]);
});

test('PDF first match keeps document row order at every page rotation', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'first-rotated.pdf');
  const pdf = await PDFDocument.create();
  const rotations = [0, 90, 180, 270];
  for (const rotation of rotations) {
    const page = pdf.addPage([400, 300]);
    page.setRotation(degrees(rotation));
    // Content stream order is deliberately opposite the reading order.
    page.drawText('Target second', { x: 40, y: 100, size: 14 });
    page.drawText('Target first', { x: 40, y: 240, size: 14 });
  }
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: rotations.map((_, index) => ({ op: 'highlight', page: index + 1, find: 'Target', first: true })),
  }, { cwd }));
  for (const [index, result] of batch.results.entries()) {
    assert.equal(result.marks, 1);
    assert.equal(result.boxes[0].page, index + 1);
    assert.ok(Math.abs(result.boxes[0].y - 240) < 0.1, JSON.stringify(result.boxes));
  }
});

test('PDF marks by find land on the text when the page box does not start at the origin', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'offset.pdf');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.setMediaBox(100, 50, 400, 300);
  page.drawText('Offset', { x: 140, y: 250, size: 14 });
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'highlight', find: 'Offset' }],
  }, { cwd }));
  const [box] = batch.results[0].boxes;
  assert.ok(Math.abs(box.x - 140) < 0.5 && Math.abs(box.y - 250) < 0.5 && box.width > 35 && box.width < 40, JSON.stringify(box));
  const layout = value(await executeOfficeTool({ action: 'query', session: opened.session, queryKind: 'pdf-layout' }, { cwd }));
  const item = layout.pages[0].items.find((entry) => entry.text === 'Offset');
  const mark = layout.pages[0].boxes.find((entry) => entry.filled && Math.abs(entry.x - (item.x - 1)) < 0.5 && Math.abs(entry.top - (item.top - 1)) < 0.5);
  assert.ok(mark, JSON.stringify({ item, boxes: layout.pages[0].boxes }));
  assert.deepEqual(layout.pages[0].origin, { x: 100, y: 50 });
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.deepEqual(snapshot.document.pages[0].origin, { x: 100, y: 50 });
});

test('PDF marks accept a pattern, stop at the first match, and link URLs to themselves', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'urls.pdf');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 200]);
  page.drawText('See https://mix.dog/terms, then http://example.com. Dates: 2026-09-06 and 2026-10-01.', { x: 20, y: 120, size: 11 });
  pdf.addPage([500, 200]).drawText('No links on this page.', { x: 20, y: 120, size: 11 });
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const batch = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'highlight', find: '\\d{4}-\\d{2}-\\d{2}', regex: true },
      { op: 'highlight', find: '\\d{4}-\\d{2}-\\d{2}', regex: true, first: true, color: '8be9fd' },
      { op: 'add_link', urls: true },
    ],
  }, { cwd }));
  assert.equal(batch.results[0].marks, 2);
  assert.equal(batch.results[1].marks, 1);
  assert.equal(batch.results[1].boxes[0].text, '2026-09-06');
  assert.deepEqual(batch.results[2].urls, ['https://mix.dog/terms', 'http://example.com']);
  // A portable open without output edits a managed copy; the batch names it.
  const saved = await PDFDocument.load(await readFile(batch.output));
  const uris = (saved.getPage(0).node.Annots()?.asArray() || [])
    .map((ref) => saved.context.lookup(ref).get(PDFName.of('A')).get(PDFName.of('URI')).decodeText());
  assert.deepEqual(uris, ['https://mix.dog/terms', 'http://example.com']);
  const invalid = await executeOfficeTool({ action: 'batch', session: opened.session, operations: [{ op: 'highlight', find: '(', regex: true }] }, { cwd });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /pattern is invalid/);
  const none = await executeOfficeTool({ action: 'batch', session: opened.session, operations: [{ op: 'add_link', urls: true, pages: [2] }] }, { cwd });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /found no http\(s\) address in the selected pages/);
});

test('PDF issues name active content without following it', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'active.pdf');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 100]);
  page.drawText('Click', { x: 20, y: 50, size: 12 });
  const link = (action) => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 45, 60, 60], Border: [0, 0, 0], A: action }));
  page.node.addAnnot(link({ Type: 'Action', S: 'URI', URI: PDFString.of('https://mix.dog') }));
  page.node.addAnnot(link({ Type: 'Action', S: 'URI', URI: PDFString.of('file:///C:/Windows/system.ini') }));
  page.node.addAnnot(link({ Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.obj({ Type: 'Action', S: 'Launch', F: PDFString.of('calc.exe') }));
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const found = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  const active = found.issues.filter((issue) => issue.code === 'active_content');
  assert.deepEqual(active.map((issue) => issue.path), ['/metadata', '/page[1]', '/page[1]']);
  assert.match(active[0].message, /Launch action when opened/);
  assert.match(active[1].message, /link to file:\/\/\/C:\/Windows\/system\.ini/);
  assert.match(active[2].message, /JavaScript action/);
});
