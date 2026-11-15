#!/usr/bin/env node
// Golden of the office inspection actions (crate mixdog-office, module `inspect` and `inline_audit`): what Node's `issues` and
// `validate` (`runtime/office/core/office-actions-inspect.mjs`), `getOfficeElement` and `queryOfficeDocument`
// (`core/office-actions-read.mjs`: the text query and the PDF queries pdf-layout, pdf-tables, pdf-images, with the CSV and PNG
// files they write) and the inline audit (`quality/inline-audit.mjs`) answer. Writes native/core/fixtures/office-inspect/golden.json
// and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-inspect.mjs --tree <product tree with node_modules>
//
// The golden has `files` (the fixture documents of every format as hex: delimited files, Word, Excel and PowerPoint packages
// the portable authoring wrote, PDFs with text, a ruled table, an unruled table and a picture), `pure` (csvCell, the audit
// summary, the touched locations and the round counter on literal inputs) and `scenarios`. A scenario is a session (one record
// for all its steps, as the engine keeps it) and a list of steps run in order: `issues`, `validate`, `get`, `query` (with `cwd`
// the folder of the files) and `inline` (`operations`, `exclude`); a step may set the session's `version` first. The answer is the
// exact JSON text or the error message; a PDF picture's pixels (`data`) are recorded as the PNG's dimensions because the
// encoders differ in bytes; the files a query wrote are recorded (a CSV by its bytes, a PNG by its dimensions), and so are the
// requests the Microsoft Office host saw and the session's inline audit round after an `inline` step. Microsoft Office is a
// scripted host: the answers of `host` are given in order (an answer with `copy` first writes that fixture file to the request's
// `output`). The OOXML schema validator is off (MIXDOG_OOXML_VALIDATOR_DISABLED=1: it is a download, and LibreOffice is not
// asked for either). Every file lives in a temporary directory the recording names `<dir>`.
process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-inspect.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
if (process.platform !== 'win32') throw new Error('the Microsoft Office host path is recorded on Windows');

const require = createRequire(path.join(tree, 'package.json'));
const { PDFDocument, StandardFonts } = require('pdf-lib');
const inspectModule = await importFrom(tree, 'src/runtime/office/core/office-actions-inspect.mjs');
const readModule = await importFrom(tree, 'src/runtime/office/core/office-actions-read.mjs');
const auditModule = await importFrom(tree, 'src/runtime/office/quality/inline-audit.mjs');
const clientModule = await importFrom(tree, 'src/runtime/office/com/office-session-client.mjs');
const packageModule = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const ooxml = await importFrom(tree, 'src/runtime/office/portable/portable-ooxml.mjs');
const { issues, validate } = inspectModule;
const { getOfficeElement, queryOfficeDocument, csvCell } = readModule;
const { inlineOfficeAudit, summarizeOfficeAudit, touchedLocations, recordInlineAuditRound } = auditModule;

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-inspect-')));
const dir = path.join(root, 'files');
mkdirSync(dir);
const sepJson = JSON.stringify(path.sep).slice(1, -1);
const named = (text) => {
  const dirJson = JSON.stringify(dir).slice(1, -1);
  return text.replaceAll(`${dirJson}${sepJson}`, '<dir>/').replaceAll(`${dir}${path.sep}`, '<dir>/').replaceAll(dir, '<dir>');
};
const text = (value) => JSON.stringify(value === undefined ? null : value);

// A picture's pixels are a PNG whose bytes depend on the encoder: the recording keeps its dimensions.
const pngDimensions = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
const withPicturesNamed = (json) =>
  json.replace(/"data":"([A-Za-z0-9+/=]+)"/g, (_, data) => {
    const [width, height] = pngDimensions(Buffer.from(data, 'base64'));
    return `"data":"<png ${width}x${height}>"`;
  });
const attempt = async (run) => {
  try {
    return { result: withPicturesNamed(named(text(await run()))) };
  } catch (error) {
    return { error: named(String(error?.message ?? error)) };
  }
};

// ---- the fixture documents ------------------------------------------------------------------------------------------
const files = {};
const write = (name, data) => {
  writeFileSync(path.join(dir, name), data);
  files[name] = readFileSync(path.join(dir, name)).toString('hex');
};
const register = (name) => {
  files[name] = readFileSync(path.join(dir, name)).toString('hex');
};
write('hubs.csv', '지점,출고,비고\n대전,48210,정상\n광주,31880\n부산,40120,=HYPERLINK("http://example.com","확인")\n');
write('figures.csv', '지점,증감\n대전,-5.5\n광주,+3.2\n서울,=2+2\n제주,-2+3\n');
write('table.tsv', 'region\tcount\r\nseoul\t12\r\nbusan\t7\r\nincheon\t3\r\n');
write('broken.csv', Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x2c, 0x00, 0x0a]));

const create = (name, kind) => packageModule.createPortableOoxmlDocument(path.join(dir, name), { fileKind: kind });
const apply = (name, format, operations) => ooxml.applyPortableOoxmlBatch(path.join(dir, name), format, operations);
await create('memo.docx', 'docx');
await apply('memo.docx', 'docx', [
  { op: 'append_text', text: 'Quarterly memo for the Seoul office.' },
  { op: 'append_text', text: 'Second paragraph with 한국어 text and a call to action.' },
  { op: 'add_table', values: [['Region', 'Revenue'], ['Seoul', '12'], ['Busan', '7']] },
  { op: 'append_text', text: 'Closing paragraph.' },
]);
register('memo.docx');
await create('empty.docx', 'docx');
register('empty.docx');
await create('book.xlsx', 'xlsx');
await apply('book.xlsx', 'xlsx', [
  { op: 'set_range', sheet: 'Sheet1', range: 'A1:B3', values: [['허브', '처리량'], ['서울', 1200], ['부산', 800]] },
  { op: 'set_formula', cell: 'B4', formula: '=SUM(B2:B3)' },
  { op: 'set_formula', cell: 'B5', formula: '=B4/0' },
  { op: 'add_sheet', name: '요약' },
  { op: 'set_range', sheet: '요약', range: 'A1:B1', values: [['지표', '값']] },
]);
register('book.xlsx');
await create('rules.xlsx', 'xlsx');
await apply('rules.xlsx', 'xlsx', [
  { op: 'set_range', sheet: 'Sheet1', range: 'A1:A4', values: [[1], [2], [3], [4]] },
  { op: 'add_validation', range: 'A1', type: 'WHOLE', operator: 'GREATERTHANOREQUAL', formula1: '0' },
  { op: 'add_validation', range: 'A2', type: 'whole', formula1: '0', formula2: '50' },
  { op: 'add_validation', range: 'A3', formula1: '"서울,부산"' },
  { op: 'add_validation', range: 'A4', formula1: 'A4>0' },
]);
register('rules.xlsx');
await create('deck.pptx', 'pptx');
await apply('deck.pptx', 'pptx', [
  { op: 'add_slide', layout: 'blank' },
  { op: 'add_textbox', slide: 1, text: 'Retention rose after onboarding and kept rising through the second quarter of the year while support tickets fell', left: 48, top: 40, width: 180, height: 30 },
  { op: 'add_slide', layout: 'blank' },
  { op: 'add_textbox', slide: 2, text: 'Clean page', left: 48, top: 180, width: 600, height: 60 },
]);
register('deck.pptx');

// A 6 x 4 RGB picture, encoded here so the PDF embeds a known one.
const crcTable = (() => {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};
const png = (width, height) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = (x * 40) & 0xff;
      raw[at + 1] = (y * 60) & 0xff;
      raw[at + 2] = 128;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
{
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of [['Hello World', 'Second line of body text'], ['Page two', 'lorem ipsum filler text']]) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, index) => page.drawText(line, { x: 72, y: 700 - index * 16, size: 12, font }));
  }
  write('report.pdf', Buffer.from(await doc.save()));
}
{
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // a ruled 3 x 3 table, then an unruled one aligned in columns
  const ruled = doc.addPage([612, 792]);
  const cells = [['Region', 'Count', 'Note'], ['Seoul', '12', 'a, b'], ['Busan', '7', 'say "hi"']];
  for (let line = 0; line <= 3; line += 1) {
    ruled.drawLine({ start: { x: 72, y: 700 - line * 24 }, end: { x: 372, y: 700 - line * 24 }, thickness: 0.5 });
    ruled.drawLine({ start: { x: 72 + line * 100, y: 700 }, end: { x: 72 + line * 100, y: 628 }, thickness: 0.5 });
  }
  cells.forEach((row, r) => row.forEach((cell, c) => ruled.drawText(cell, { x: 78 + c * 100, y: 682 - r * 24, size: 10, font })));
  const plain = doc.addPage([612, 792]);
  const rows = [['Item', 'Qty', 'Price'], ['Apple', '3', '1.20'], ['Pear', '12', '0.80'], ['Plum', '7', '2.50'], ['Fig', '1', '9.99']];
  rows.forEach((row, r) => row.forEach((cell, c) => plain.drawText(cell, { x: 72 + c * 120, y: 700 - r * 16, size: 11, font })));
  write('tables.pdf', Buffer.from(await doc.save()));
}
{
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // One picture object for each page: pdf.js's own extraction waits forever for the copy of an image two pages share.
  const picture = await doc.embedPng(png(6, 4));
  const another = await doc.embedPng(png(6, 4));
  const first = doc.addPage([612, 792]);
  first.drawText('A page with a picture', { x: 72, y: 720, size: 12, font });
  first.drawImage(picture, { x: 72, y: 500, width: 120, height: 80 });
  const second = doc.addPage([612, 792]);
  second.drawImage(another, { x: 100, y: 300, width: 60, height: 40 });
  second.drawText('Second page', { x: 72, y: 720, size: 12, font });
  write('images.pdf', Buffer.from(await doc.save()));
}

// ---- the scripted Microsoft Office host ---------------------------------------------------------------------------
let requestLog = [];
const installHost = (sessionId, answers) => {
  const client = {
    sessionId,
    closed: false,
    closing: false,
    pending: new Map(),
    stderr: '',
    child: {
      stdin: {
        write(line) {
          const request = JSON.parse(line);
          const requestId = request.requestId;
          delete request.requestId;
          const answer = answers.shift() ?? { reply: { ok: false, error: 'no answer scripted' } };
          if (answer.copy) copyFileSync(path.join(dir, answer.copy), request.output);
          // The copy's name is a random one in the temporary folder.
          requestLog.push(request.action === 'save_copy' ? { ...request, output: '<copy>' } : request);
          const pending = client.pending.get(requestId);
          client.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.resolve(structuredClone(answer.reply));
        },
      },
    },
  };
  clientModule.sessionClients.set(sessionId, client);
};

const finding = (severity, code, at, message) => ({ severity, code, path: at, message });
const docxIssues = { ok: true, value: { ok: true, format: 'docx', issueCount: 1, issues: [finding('warning', 'empty_paragraph', '/body/p[9]', 'An empty paragraph.')] } };
const xlsxIssues = {
  ok: true,
  value: { ok: true, format: 'xlsx', issueCount: 1, issues: [finding('warning', 'cell_overflow', '/sheet[Sheet1]/cell[A1]', 'The text is cut.')] },
};
const pptxIssues = {
  ok: true,
  value: {
    ok: false,
    format: 'pptx',
    issueCount: 2,
    issues: [finding('error', 'text_overflow', '/slide[1]/shape[1]', 'The text runs out of the box.'), finding('warning', 'empty_slide', '/slide[2]', 'Nothing here.')],
  },
};
const sheetCell = (ref, value, extra = {}) => ({ path: `/sheet[Sheet1]/cell[${ref}]`, ref, value, ...extra });
const excelRead = () => ({
  ok: true,
  value: {
    format: 'xlsx',
    sheets: [
      {
        path: '/sheet[Sheet1]',
        name: 'Sheet1',
        cells: [sheetCell('A1', '허브'), sheetCell('B1', '처리량'), sheetCell('B2', 1200), sheetCell('B4', 2000, { formula: '=SUM(B2:B3)' })],
      },
    ],
    pagination: { unit: 'populated-cell', offset: 0, limit: 2000, returned: 4, total: 4, nextOffset: null },
  },
});
const wordRead = () => ({
  ok: true,
  value: {
    format: 'docx',
    paragraphCount: 2,
    tableCount: 0,
    trackChanges: false,
    paragraphs: [
      { path: '/body/p[1]', index: 1, text: 'Quarterly memo', style: 'Normal', inTable: false },
      { path: '/body/p[2]', index: 2, text: 'Second paragraph', style: 'Normal', inTable: false },
    ],
    pictures: [{ path: '/body/p[2]/picture[1]', altText: '' }],
    pagination: { unit: 'paragraph', offset: 0, limit: 200, returned: 2, total: 2, nextOffset: null },
  },
});
const deckRead = () => ({
  ok: true,
  value: {
    format: 'pptx',
    slideCount: 1,
    slideWidth: 960,
    slideHeight: 540,
    slides: [{ path: '/slide[1]', index: 1, notes: '', background: { color: 'FFFFFF' }, shapes: [{ path: '/slide[1]/shape[1]', index: 1, type: 17, name: 'Title', text: 'Quarterly review', left: 48, top: 40, width: 600, height: 60, font: { size: 40 } }] }],
    pagination: { unit: 'slide', offset: 0, limit: 20, returned: 1, total: 1, nextOffset: null },
  },
});

// ---- the scenarios ------------------------------------------------------------------------------------------------
const scenarios = [];
const scenario = (name, spec) => scenarios.push({ name, ...spec });
const backendOf = (format) => (format === 'pdf' ? 'mixdog-pdf' : format === 'csv' || format === 'tsv' ? 'mixdog-tabular' : 'mixdog-ooxml');
const local = (name, file, format, steps, more = {}) => scenario(name, { file, format, backend: backendOf(format), mode: 'portable', steps, ...more });
const com = (name, file, format, host, steps, more = {}) =>
  scenario(name, { file, format, backend: 'microsoft-office-com', mode: 'background', ownership: 'owned', visible: false, com: true, host, steps, ...more });
const step = (kind, stepArgs = {}, more = {}) => ({ kind, args: stepArgs, ...more });

local('csv-ragged-rows-and-formula-like-values', 'hubs.csv', 'csv', [
  step('issues'),
  step('issues', { range: 'C1:C4' }),
  step('validate'),
  step('get', { target: '/sheet[hubs]/cell[C4]' }),
  step('get', { target: '/sheet[hubs]' }),
  step('get', { target: '/sheet[hubs]/cell[Z9]' }),
  step('get', { target: '  ' }),
  step('query', { query: '대전' }),
  step('query', { query: '' }),
  step('query', { query: 'x', queryKind: 'pdf-layout' }),
  step('query', { query: 'x', queryKind: 'bogus' }),
]);
local('csv-a-negative-figure-is-not-a-formula', 'figures.csv', 'csv', [step('issues'), step('validate')]);
local('csv-with-bad-bytes', 'broken.csv', 'csv', [step('issues'), step('validate')]);
local('tsv', 'table.tsv', 'tsv', [step('issues'), step('validate'), step('query', { query: 'SEOUL' })]);
local('docx', 'memo.docx', 'docx', [
  step('issues'),
  step('issues', { auditProfile: 'redlining', author: 'Claude' }),
  step('validate'),
  step('validate', { auditProfile: 'redlining', author: 'Claude', compatibility: false }),
  step('validate', { assertions: [{ kind: 'equals', cell: 'A1', value: 1 }] }),
  step('get', { target: '/body/p[1]' }),
  step('get', { target: '/body/p[2]', limit: 1 }),
  step('get', { target: '/body' }),
  step('get', { target: '/body/p[99]' }),
  step('query', { query: 'seoul' }),
  step('query', { query: 'nothing-here-at-all' }),
]);
local('docx-empty', 'empty.docx', 'docx', [step('issues'), step('validate')]);
local('xlsx', 'book.xlsx', 'xlsx', [
  step('issues'),
  step('issues', { auditProfile: 'financial-model' }),
  step('issues', { sheet: 'Sheet1' }),
  step('validate'),
  step('validate', { assertions: [{ kind: 'equals', sheet: 'Sheet1', cell: 'B2', value: 1200 }, { kind: 'equals', sheet: 'Sheet1', cell: 'B3', value: 1 }] }),
  step('validate', { assertions: [{ kind: 'matches', cell: 'A1', matches: '(' }] }),
  step('validate', { downloadDependencies: false }),
  step('get', { target: '/sheet[Sheet1]' }),
  step('get', { target: '/sheet[Sheet1]/cell[B2]' }),
  step('get', { target: '/sheet[요약]' }),
  step('get', { target: '/sheet[Nope]' }),
  step('query', { query: '부산' }),
]);
local('xlsx-validation-rules', 'rules.xlsx', 'xlsx', [step('issues'), step('validate'), step('get', { target: '/sheet[Sheet1]' }), step('query', { query: 'a' })]);
local('pptx', 'deck.pptx', 'pptx', [
  step('issues'),
  step('issues', { pages: [1] }),
  step('validate'),
  step('get', { target: '/slide[1]' }),
  step('get', { target: '/slide[2]/shape[1]' }),
  step('query', { query: 'clean' }),
]);
local('pptx-print-sheet', 'deck.pptx', 'pptx', [step('issues')], { printSheet: true });
local('pdf', 'report.pdf', 'pdf', [
  step('issues'),
  step('issues', { pages: [2] }),
  step('validate'),
  step('get', { target: '/page[1]' }),
  step('query', { query: 'second' }),
  step('query', { query: '' }),
  step('query', { queryKind: 'pdf-layout' }),
  step('query', { queryKind: 'pdf-layout', pages: [2], limit: 3 }),
  step('query', { queryKind: 'pdf-layout', query: 'Page two' }),
  step('query', { queryKind: 'PDF-Layout', query: 'o', limit: 2 }),
  step('query', { queryKind: 'pdf-layout', pages: [9] }),
  step('query', { queryKind: 'pdf-tables' }),
  step('query', { queryKind: 'pdf-images' }),
  step('query', { queryKind: 'pdf-unknown' }),
]);
local('pdf-tables', 'tables.pdf', 'pdf', [
  step('query', { queryKind: 'pdf-tables' }),
  step('query', { queryKind: 'pdf-tables', pages: [2] }),
  step('query', { queryKind: 'pdf-tables', output: 'out-tables' }),
  step('query', { queryKind: 'pdf-tables', output: path.join(dir, 'out-absolute'), pages: [1] }),
  step('query', { queryKind: 'pdf-layout', query: 'Seoul' }),
]);
local('pdf-images', 'images.pdf', 'pdf', [
  step('query', { queryKind: 'pdf-images' }),
  step('query', { queryKind: 'pdf-images', pages: [2] }),
  step('query', { queryKind: 'pdf-images', output: 'out-images' }),
  step('issues'),
  step('validate'),
]);
local('pdf-damaged', 'broken.csv', 'pdf', [step('issues'), step('validate'), step('query', { queryKind: 'pdf-layout' })]);
// Microsoft Office
com(
  'com-docx',
  'memo.docx',
  'docx',
  [{ reply: docxIssues }, { reply: wordRead() }, { reply: wordRead() }, { reply: { ok: true, value: { ok: true, opened: true, documentSaved: true, persisted: true, issues: [] } } }],
  [step('issues'), step('validate', {}, { version: 1 })]
);
com(
  'com-xlsx',
  'book.xlsx',
  'xlsx',
  [{ copy: 'book.xlsx', reply: { ok: true } }, { reply: xlsxIssues }, { reply: excelRead() }, { reply: excelRead() }],
  [step('issues', { sheet: 'Sheet1' })]
);
com(
  'com-xlsx-copy-fails',
  'book.xlsx',
  'xlsx',
  [{ reply: { ok: false, error: 'Excel is busy' } }, { reply: xlsxIssues }, { reply: excelRead() }, { reply: excelRead() }],
  [step('issues')]
);
com('com-pptx', 'deck.pptx', 'pptx', [{ copy: 'deck.pptx', reply: { ok: true } }, { reply: pptxIssues }, { reply: deckRead() }], [step('issues')]);
com('com-pptx-copy-fails', 'deck.pptx', 'pptx', [{ reply: { ok: false } }, { reply: pptxIssues }, { reply: deckRead() }], [step('issues')]);
com('com-issues-fail', 'memo.docx', 'docx', [{ reply: { ok: false, error: 'Word is busy' } }], [step('issues'), step('issues')]);
com(
  'com-validate',
  'memo.docx',
  'docx',
  [
    { reply: { ok: true, value: { ok: true, opened: true, documentSaved: false, persisted: false, issues: [finding('warning', 'x', '/body', 'm')] } } },
    { reply: { ok: true, value: { ok: true, opened: true, documentSaved: true, persisted: true, issues: [] } } },
    { reply: { ok: false, error: 'Word refused' } },
  ],
  [step('validate'), step('validate', { __postSave: true, __skipNativeIssues: true, __skipNativeSnapshot: true }), step('validate', { __skipNative: true }), step('validate')],
  { mode: 'attach', ownership: 'attached', visible: true }
);
// The inline audit
local('inline-audit-deck', 'deck.pptx', 'pptx', [
  step('inline', {}, { operations: [{ op: 'set_text', slide: 1, shape: 1, text: 'x' }] }),
  step('inline', {}, { operations: [{ op: 'set_text', slide: 2, shape: 1, text: 'x' }] }),
  step('inline', {}, { operations: [{ op: 'duplicate_slide', slide: 2 }, { op: 'set_text', slide: 2, shape: 1, text: 'x' }] }),
  step('inline', {}, { operations: [] }),
  step('inline', {}, { operations: [{ op: 'set_text', slide: 2, shape: 1, text: 'x' }], exclude: ['text_overflow', 'text_box_too_narrow'] }),
  step('inline', {}, { operations: [{ op: 'set_text', slide: 2, shape: 1, text: 'x' }], exclude: ['text_overflow', 'text_box_too_narrow', 'shapes_too_close'] }),
]);
local(
  'inline-audit-authored-deck',
  'deck.pptx',
  'pptx',
  [step('inline', {}, { operations: [{ op: 'set_text', slide: 2, shape: 1, text: 'x' }] }), step('inline', {}, { operations: [{ op: 'set_text', slide: 2, shape: 1, text: 'x' }] })],
  { authored: true }
);
local('inline-audit-workbook', 'book.xlsx', 'xlsx', [step('inline', {}, { operations: [{ op: 'set_formula', sheet: 'Sheet1', cell: 'B4', formula: '=SUM(B2:B3)' }] }), step('inline')]);
local('inline-audit-document', 'memo.docx', 'docx', [step('inline', {}, { operations: [{ op: 'append_text', text: 'x' }] })]);
local('inline-audit-empty-document', 'empty.docx', 'docx', [step('inline', {}, { operations: [{ op: 'append_text', text: 'x' }] })]);
local('inline-audit-other-formats-have-none', 'report.pdf', 'pdf', [step('inline')]);
local('inline-audit-unreadable-file', 'broken.csv', 'docx', [step('inline')]);

// ---- the run ------------------------------------------------------------------------------------------------------
const filesUnder = (folder) => {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  if (statSync(folder, { throwIfNoEntry: false })?.isDirectory()) walk(folder);
  return found;
};
const writtenBy = (folder) =>
  filesUnder(folder).map((file) => {
    const bytes = readFileSync(file);
    const entry = { file: named(file).replace('<dir>/', '').split(path.sep).join('/') };
    return file.endsWith('.png') ? { ...entry, png: pngDimensions(bytes) } : { ...entry, hex: bytes.toString('hex') };
  });

const recorded = [];
for (const item of scenarios) {
  const id = `office_twin_${recorded.length + 1}`;
  const target = path.join(dir, item.file);
  const session = {
    id,
    source: target,
    target,
    fileKind: path.extname(item.file).slice(1),
    format: item.format,
    mode: item.mode,
    backend: item.backend,
    snapshotVersion: 0,
    created: false,
    dataDir: dir,
    ...(item.printSheet ? { printSheet: true } : {}),
    ...(item.authored ? { authored: true } : {}),
    ...(item.com ? { ownership: item.ownership, visible: item.visible } : {}),
  };
  if (item.com) installHost(id, [...(item.host ?? [])]);
  const results = [];
  for (const one of item.steps) {
    requestLog = [];
    const entry = { kind: one.kind, args: one.args };
    if (one.version !== undefined) {
      session.snapshotVersion = one.version;
      entry.version = one.version;
    }
    if (one.operations) entry.operations = one.operations;
    if (one.exclude) entry.exclude = one.exclude;
    const outputs = [];
    const callArgs = structuredClone(one.args);
    const outcome = await attempt(async () => {
      switch (one.kind) {
        case 'issues':
          return issues(session, callArgs);
        case 'validate':
          return validate(session, callArgs);
        case 'get':
          return getOfficeElement(session, callArgs);
        case 'query':
          return queryOfficeDocument(session, callArgs, dir, null);
        default:
          return inlineOfficeAudit(session, { operations: one.operations ?? [], exclude: one.exclude ?? [] });
      }
    });
    Object.assign(entry, outcome);
    if (one.kind === 'inline') entry.round = text(session.inlineAudit ?? null);
    if (one.kind === 'query' && one.args.output) {
      const folder = path.isAbsolute(one.args.output) ? one.args.output : path.join(dir, one.args.output);
      outputs.push(...writtenBy(folder));
      entry.written = outputs;
    }
    if (item.com) entry.requests = requestLog.map((request) => named(text(request)));
    results.push(entry);
  }
  recorded.push({
    name: item.name,
    id,
    file: item.file,
    format: item.format,
    backend: item.backend,
    mode: item.mode,
    printSheet: item.printSheet === true,
    authored: item.authored === true,
    ...(item.com ? { com: { ownership: item.ownership, visible: item.visible }, host: item.host ?? [] } : {}),
    steps: results,
  });
  clientModule.sessionClients.delete(id);
}

// ---- the helpers on literal inputs ----------------------------------------------------------------------------------
const pure = { csv: [], summary: [], touched: [], rounds: [] };
for (const cell of ['plain', 'a,b', 'say "hi"', 'line\nbreak', 'cr\rlf', '', '"', '한,글', ' lead', 'tab\t']) pure.csv.push({ cell, result: csvCell(cell) });
const sample = [
  finding('warning', 'text_overflow', '/slide[3]/shape[2]', 'over'),
  finding('error', 'missing_relationship', '/ppt/slides/_rels/slide1.xml.rels', 'rel'),
  finding('info', 'shapes_too_close', '/slide[1]/shape[1]', 'close'),
  finding('warning', 'low_contrast', '/slide[1]/shape[4]', 'dim'),
  finding('warning', 'cell_overflow', '/sheet[Data]/cell[A1]', 'cut'),
  finding('warning', 'cell_overflow', '/sheet[Data]/cell[A10]', 'cut'),
  finding('warning', 'cell_overflow', '/sheet[data]/cell[A2]', 'cut'),
  finding('warning', 'widow', '/page[2]', 'widow'),
  finding('warning', 'orphan_heading', '/body/p[4]', 'orphan'),
  finding('toString', 'low_contrast', '/slide[9]/shape[1]', 'dim'),
  { code: 'formula_cache_missing', path: '/sheet[Data]/cell[B2]', message: 'no cache' },
  { severity: 'warning', code: 'odd', message: 'no path' },
  ...Array.from({ length: 14 }, (_, index) => finding('warning', 'text_overflow', `/slide[${index + 4}]/shape[1]`, `over ${index}`)),
];
for (const [list, touched] of [
  [sample, []],
  [sample, ['/slide[3]']],
  [sample, ['/sheet[Data]', '/body']],
  [sample.slice(2, 3), []],
  [[], []],
]) pure.summary.push({ issues: list, touched, result: text(summarizeOfficeAudit(list, { touched })) });
for (const [format, operations] of [
  ['pptx', [{ slide: 2 }, { slides: [1, 4, 0, -1, 'x'] }, { slide: '3' }, { slide: 2.5 }, null, 'x', []]],
  ['pptx', []],
  ['xlsx', [{ sheet: 'Data' }, { sheet: '' }, { sheet: 5 }, {}]],
  ['docx', [{ op: 'x' }, {}]],
  ['pdf', [{ slide: 1 }]],
]) pure.touched.push({ format, operations, result: text(touchedLocations(format, operations)) });
for (const format of ['pptx', 'docx']) {
  const session = {};
  const failing = () => summarizeOfficeAudit([finding('warning', 'text_overflow', '/slide[1]/shape[1]', 'over')]);
  const outcomes = [];
  for (const audit of [failing(), failing(), failing(), failing(), summarizeOfficeAudit([]), failing()]) {
    session.format = format;
    outcomes.push(text(recordInlineAuditRound(session, audit)));
  }
  pure.rounds.push({ format, results: outcomes });
}

// ---- the output ---------------------------------------------------------------------------------------------------
const out = {
  note: 'Recorded from the Node inspection actions (runtime/office/core/office-actions-inspect.mjs, office-actions-read.mjs, quality/inline-audit.mjs); tests/twin_inspect.rs replays it.',
  files,
  pure,
  scenarios: recorded,
};
rmSync(root, { recursive: true, force: true });
const fixtures = path.join(FIXTURES_ROOT, 'office-inspect');
mkdirSync(fixtures, { recursive: true });
const body = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), body);
writeSetManifest(fixtures, { set: 'office-inspect', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${body.length} bytes, ${recorded.length} scenarios`);
