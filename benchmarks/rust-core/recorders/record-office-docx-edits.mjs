#!/usr/bin/env node
// What the portable Word batch answers (src/runtime/office/portable: portable-docx and portable-docx-edits), run through Node:
// fill_template, replace_text, appended text and lists, tables (add, cell, style, rows, columns), paragraph styles and formats,
// pictures, hyperlinks, bookmarks, comments (add, reply, resolve, delete), contents, running headers and footers, page numbers,
// breaks, track changes carried from one operation to the next, and the dispatcher's own repairs after a batch. The documents are
// the shapes office-runtime-portable.slow, native-authoring, docx-design-tools.slow and office-runtime-design drive these through.
// Rust `mixdog-ooxml` must answer the same: the returned result rows and the text of every part, exactly
// (crates/mixdog-ooxml/tests/twin_docx_edits.rs).
//
//   node benchmarks/rust-core/recorders/record-office-docx-edits.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-docx-edits/golden.json. The recording holds `sequences` (steps over one package: each step's
// output, then the package's names and every part's text) and `assets` (the picture files a step names, by placeholder). A time
// of day in an answer is scrubbed by the replay on both sides.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-docx-edits');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-docx-edits.mjs';
const docx = await importFrom(tree, 'src/runtime/office/portable/portable-docx.mjs');
const JSZip = createRequire(join(tree, 'package.json'))('jszip');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- the pictures -------------------------------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
// A PNG header of the stated size with one empty data chunk: the size is all the document reads of it.
const png = (width, height) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0))]);
};
const ASSETS = { '@wide.png': png(1400, 700), '@small.png': png(120, 60), '@tall.png': png(300, 900) };
const assetDir = mkdtempSync(join(tmpdir(), 'docx-edits-'));
for (const [name, data] of Object.entries(ASSETS)) writeFileSync(join(assetDir, name.slice(1)), data);
// An operation names a picture by placeholder; the recording keeps the placeholder, the run the file.
const withFiles = (value) => JSON.parse(JSON.stringify(value), (_, item) => (typeof item === 'string' && Object.hasOwn(ASSETS, item) ? join(assetDir, item.slice(1)) : item));

// ---- the markup ---------------------------------------------------------------------------------------------------
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DATE = '2026-03-04T09:30:00Z';
const TYPES = (...extra) =>
  `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${extra.join('')}</Types>`;
const RELS = (...entries) =>
  `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;
const run = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
const keep = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const SECTION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>';
const doc = (body, tail = SECTION) => `${HEAD}<w:document ${W}><w:body>${body}${tail}</w:body></w:document>`;
const heading = (level, text) => para(run(text), `<w:pStyle w:val="Heading${level}"/>`);
const STYLE = (id, name, extra = '', type = 'paragraph') => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const STYLES = (...styles) =>
  `${HEAD}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>${styles.join('')}</w:styles>`;
const DEFAULT_STYLES = STYLES(
  STYLE('Heading1', 'heading 1', '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>'),
  STYLE('Heading2', 'heading 2'),
  STYLE('Heading3', 'heading 3'),
  STYLE('Caption', 'caption'),
  STYLE('a6', 'List Paragraph', '<w:basedOn w:val="Normal"/>'),
  STYLE('TableGrid', 'Table Grid', '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>', 'table'),
);
const ins = (id, author, inner) => `<w:ins w:id="${id}" w:author="${author}" w:date="${DATE}">${inner}</w:ins>`;
const del = (id, author, text) => `<w:del w:id="${id}" w:author="${author}" w:date="${DATE}"><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
const cell = (inner, props = '') => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${inner}</w:tc>`;
const row = (cells) => `<w:tr>${cells}</w:tr>`;
const grid = (...widths) => `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
const table = (rows, columns = [3000, 3000], props = '<w:tblStyle w:val="TableGrid"/><w:tblW w:w="6000" w:type="dxa"/>') =>
  `<w:tbl><w:tblPr>${props}</w:tblPr>${grid(...columns)}${rows}</w:tbl>`;
const simpleTable = (...texts) => table(row(texts.map((text) => cell(para(run(text)))).join('')), texts.map(() => 3000));
const BASE = (body, extra = {}) => ({
  '[Content_Types].xml': TYPES(),
  '_rels/.rels': RELS(['rId1', 'officeDocument', 'word/document.xml']),
  'word/document.xml': body,
  'word/_rels/document.xml.rels': RELS(['rId1', 'styles', 'styles.xml']),
  'word/styles.xml': DEFAULT_STYLES,
  ...extra,
});

// ---- the sequences over one package -------------------------------------------------------------------------------
const packageOf = async (files) => {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip;
};
const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const found = {};
  for (const name of names) if (!zip.files[name].dir) found[name] = (await zip.file(name)?.async('string')) ?? '';
  return { names, parts: found };
};
const runStep = async (zip, step) => {
  switch (step.fn) {
    case 'applyDocx':
      return await docx.applyDocx(zip, withFiles(step.operations));
    case 'set':
      zip.file(step.name, step.text);
      return null;
    case 'remove':
      zip.remove(step.name);
      return null;
    default:
      throw new Error(`unknown step ${step.fn}`);
  }
};
const SEQUENCES = [];
const sequence = (name, files, steps) => SEQUENCES.push({ name, files, steps });
// Each operation is one batch of its own, so its result row and error stand alone; `batch` is several in one call.
const each = (...operations) => operations.map((op) => ({ fn: 'applyDocx', operations: [op] }));
const batch = (...operations) => ({ fn: 'applyDocx', operations });

const REPORT = doc(
  heading(1, 'Quarterly report') +
    para(`${run('Revenue grew ', '<w:b/>')}${run('{{growth}} in {{quarter}}')}`) +
    para(run('{{company}}은 성장했습니다. {{missing}}')) +
    para(`${keep('성장', '<w:rFonts w:ascii="Noto Serif KR" w:hAnsi="Noto Serif KR"/>')}${keep('했습니다 라고 한다.')}`) +
    para(`${run('before')}<w:r><w:tab/></w:r>${run('after the tab')}`) +
    simpleTable('Region', 'Result') +
    para(run('Between the tables')) +
    simpleTable('North', '12') +
    para(run('The closing paragraph with the quick brown fox.')),
);

sequence('fill_template', BASE(REPORT), [
  ...each(
    { op: 'fill_template', tokens: { growth: '22%', quarter: 'Q3' } },
    { op: 'fill_template', tokens: { company: '모아페이' } },
    { op: 'fill_template', tokens: { missing: 'x' }, strict: true },
    { op: 'fill_template', tokens: { nothing: 'x' } },
    { op: 'fill_template', tokens: ['x'] },
    { op: 'fill_template' },
    { op: 'fill_template', tokens: { growth: '1' }, strict: 'yes' },
  ),
]);
sequence('replace_text', BASE(REPORT), [
  ...each(
    { op: 'replace_text', find: 'quick brown', replace: 'slow red' },
    { op: 'replace_text', find: 'Revenue', replace: '' },
    { op: 'replace_text', find: 'tables', replace: 'lists' },
    { op: 'replace_text', find: 'before after', replace: 'x' },
    { op: 'replace_text', find: 'absent', replace: 'x' },
    { op: 'replace_text', find: '', replace: 'x' },
    { op: 'replace_text', replace: 'x' },
    { op: 'replace_text', find: 'Region', replace: 7 },
    { op: 'replace_text', find: '성장', replace: '감소' },
  ),
]);
sequence('replace_text in the stories', BASE(REPORT, {
  'word/header1.xml': `${HEAD}<w:hdr ${W}>${para(run('Header text'))}</w:hdr>`,
  'word/footer1.xml': `${HEAD}<w:ftr ${W}>${para(run('Footer text'))}</w:ftr>`,
  'word/footnotes.xml': `${HEAD}<w:footnotes ${W}><w:footnote w:id="1">${para(run('Footnote text'))}</w:footnote></w:footnotes>`,
  'word/comments.xml': `${HEAD}<w:comments ${W}><w:comment w:id="1" w:author="Eve" w:date="${DATE}" w:initials="E">${para(run('Comment text'))}</w:comment></w:comments>`,
}), [
  ...each(
    { op: 'replace_text', find: 'text', replace: 'words' },
    { op: 'fill_template', tokens: { company: 'Acme' } },
    { op: 'normalize_runs' },
  ),
]);

// appended text, lists and formats
sequence('append_text', BASE(REPORT), [
  ...each(
    { op: 'append_text', text: 'A plain closing line' },
    { op: 'append_text', text: 'Tab\tseparated', properties: { bold: true, italic: true, size: 12, color: '#336699', name: 'Arial', alignment: 'center' } },
    { op: 'append_text', text: 'First bullet', properties: { listKind: 'bullet' } },
    { op: 'append_text', text: 'Second bullet', properties: { listKind: 'bullet', listLevel: 1 } },
    { op: 'append_text', text: 'First number', properties: { listKind: 'number' } },
    { op: 'append_text', text: 'Second number', properties: { listKind: 'number', listContinue: true } },
    { op: 'append_text', text: '첫째 항목', properties: { listKind: 'number' } },
    { op: 'append_text', text: 'Forced korean', properties: { listKind: 'number', listNumbering: 'korean' } },
    { op: 'append_text', text: 'Forced global', properties: { listKind: 'number', listNumbering: 'global' } },
    { op: 'append_text', text: 'Bad scheme', properties: { listKind: 'number', listNumbering: 'roman' } },
    { op: 'append_text', text: 'Not a list', properties: { listKind: 'none' } },
    { op: 'append_text', text: 'Indented bullet', properties: { listKind: 'bullet', indentLeft: 12 } },
    { op: 'append_text', text: 'Indented bullet with a first line', properties: { listKind: 'bullet', indentLeft: 12, indentFirstLine: 3 } },
    { op: 'append_text', text: 'Styled', style: 'Heading 2' },
    { op: 'append_text', text: 'Styled by property', properties: { style: 'caption' } },
    { op: 'append_text', text: 'Unknown style', style: 'No Such Style' },
    { op: 'append_text', text: 'Shaded', properties: { shading: '#EEEEEE', keepWithNext: true, spacingBefore: 6, spacingAfter: 12, tabStops: [{ position: 200, alignment: 'right', leader: 'dot' }] } },
    { op: 'append_text' },
    { op: 'append_text', text: 0 },
  ),
]);
sequence('append_text in a document that ends in a table', BASE(doc(para(run('Intro')) + simpleTable('a', 'b'))), each({ op: 'append_text', text: 'After the table' }, { op: 'append_text', text: 'Again' }));
sequence('append_text in a fresh document', BASE(doc('<w:p/>')), each({ op: 'append_text', text: 'First words' }, { op: 'append_text', text: 'Second words' }));
sequence('append_text without a body', BASE(`${HEAD}<w:document ${W}></w:document>`), each({ op: 'append_text', text: 'x' }));

sequence('set_paragraph_style', BASE(REPORT), [
  ...each(
    { op: 'set_paragraph_style', paragraph: 1, style: 'Heading 2' },
    { op: 'set_paragraph_style', paragraph: 2, style: 'Heading2' },
    { op: 'set_paragraph_style', paragraph: 3 },
    { op: 'set_paragraph_style', paragraph: 4, style: 'caption' },
    { op: 'set_paragraph_style', paragraph: 5, style: 'No Such Style' },
    { op: 'set_paragraph_style', paragraph: '6', style: 'List Paragraph' },
    { op: 'set_paragraph_style', paragraph: 99, style: 'Heading 1' },
    { op: 'set_paragraph_style', style: 'Heading 1' },
  ),
]);
sequence('set_paragraph_format', BASE(REPORT), [
  ...each(
    { op: 'set_paragraph_format', paragraph: 2, properties: { alignment: 'center', keepWithNext: true, spacingAfter: 6 } },
    { op: 'set_paragraph_format', paragraph: 2, properties: { alignment: 'center', keepWithNext: true, spacingAfter: 6 } },
    { op: 'set_paragraph_format', paragraph: 3, properties: { listKind: 'bullet' } },
    { op: 'set_paragraph_format', paragraph: 4, properties: { listKind: 'number', listLevel: 1 } },
    { op: 'set_paragraph_format', paragraph: 5, properties: { listKind: 'number', listContinue: true } },
    { op: 'set_paragraph_format', paragraph: 5, properties: { listKind: 'none' } },
    { op: 'set_paragraph_format', paragraph: 3, properties: { listKind: 'bullet', indentLeft: 10 } },
    { op: 'set_paragraph_format', paragraph: 1, properties: { listKind: 'number', listNumbering: 'korean' } },
    { op: 'set_paragraph_format', paragraph: 1, properties: { listKind: 'number', listNumbering: 'nope' } },
    { op: 'set_paragraph_format', paragraph: 1, properties: { lineSpacing: 1.5, indentFirstLine: 12, border: { style: 'single', size: 4, color: '#999999' } } },
    { op: 'set_paragraph_format', paragraph: 99, properties: { alignment: 'left' } },
    { op: 'set_paragraph_format', paragraph: 2 },
  ),
]);
sequence('set_paragraph_format over a tracked formatting change', BASE(doc(para(run('listed'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr><w:pPrChange w:id="1" w:author="Eve" w:date="2026-03-04T09:30:00Z"><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr></w:pPrChange>'))), each({ op: 'set_paragraph_format', paragraph: 1, properties: { listKind: 'none' } }));
sequence('set_list', BASE(REPORT), [
  ...each(
    { op: 'set_list', paragraph: 2 },
    { op: 'set_list', paragraph: 3, kind: 'number' },
    { op: 'set_list', paragraph: 4, kind: 'number' },
    { op: 'set_list', paragraph: 5, kind: 'Number', level: 1 },
    { op: 'set_list', paragraph: 5, kind: 'none' },
    { op: 'set_list', paragraph: 4, kind: 'none' },
    { op: 'set_list', paragraph: 2, kind: 'bullet', level: 9 },
    { op: 'set_list', paragraph: 3, kind: 'number', numbering: 'korean' },
    { op: 'set_list', paragraph: 3, kind: 'number', numbering: 'bad' },
    { op: 'set_list', paragraph: 99 },
    { op: 'set_list' },
  ),
]);
sequence('set_font', BASE(REPORT), [
  ...each(
    { op: 'set_font', find: 'Revenue', properties: { bold: true, color: '#C00000', size: 14 } },
    { op: 'set_font', find: 'brown fox', properties: { italic: true, name: 'Arial' } },
    { op: 'set_font', find: '했습니다 라고', properties: { underline: true } },
    { op: 'set_font', find: 'absent', properties: { bold: true } },
    { op: 'set_font', find: 'Revenue', properties: {} },
    { op: 'set_font', find: '', properties: { bold: true } },
    { op: 'set_font', find: 'Revenue' },
  ),
]);

// tables
const TABLE_STYLES = DEFAULT_STYLES.replace('</w:styles>', `${STYLE('Strong', 'Strong', '', 'character')}</w:styles>`);
sequence('add_table', BASE(REPORT, { 'word/styles.xml': TABLE_STYLES }), [
  ...each(
    { op: 'add_table', values: [['Name', 'Score'], ['Ann', '9']], properties: { columnWidths: [100, 60] } },
    { op: 'add_table', paragraph: 2, values: [['x', 'y', 'z']], properties: { columnWidths: [50, 50, 50], style: 'Table Grid', headerRow: true } },
    { op: 'add_table', paragraph: 1, rows: 2, columns: 2, properties: { style: 'No Such Table Style', columnWidths: [80, 80] } },
    { op: 'add_table', rows: 1, columns: 3, properties: { style: 'TableGrid', textStyle: 'Caption', columnWidths: [40, 40, 40], alignment: 'center' } },
    { op: 'add_table', paragraph: 99, rows: 1, columns: 1 },
    { op: 'add_table', rows: 2, columns: 2, properties: { columnWidths: [30, 30], columnAlignments: ['left', 'right'] } },
  ),
]);
sequence('add_table in a document without a section', BASE(doc(para(run('x')), '')), each({ op: 'add_table', rows: 1, columns: 2, properties: { columnWidths: [40, 40] } }));
sequence('add_table without a body', BASE(`${HEAD}<w:document ${W}></w:document>`), each({ op: 'add_table', rows: 1, columns: 1, properties: { columnWidths: [40] } }));

const CELLS = doc(
  para(run('Top')) +
    table(
      row(cell(para(run('H1'))) + cell(para(run('H2')))) +
        row(cell(para(`${run('a')}${run('b')}`) + para(run('second paragraph'))) + cell('<w:p/>')) +
        row(cell(para(run('c'))) + cell('')),
      [3000, 3000],
    ) +
    para(run('Gap')) +
    simpleTable('s1', 's2'),
);
sequence('set_table_cell', BASE(CELLS), [
  ...each(
    { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Header one' },
    { op: 'set_table_cell', table: 1, row: 2, col: 1, text: 'Merged\tcell' },
    { op: 'set_table_cell', table: 1, row: 2, col: 2, text: 'Filled empty' },
    { op: 'set_table_cell', table: 1, row: 3, col: 2, text: 'No paragraph' },
    { op: 'set_table_cell', table: 2, row: 1, col: 2, text: 'A & B <c>' },
    { op: 'set_table_cell', table: 1, row: 1, col: 1 },
    { op: 'set_table_cell', table: 1, row: 9, col: 1, text: 'x' },
    { op: 'set_table_cell', table: 1, row: 1, col: 9, text: 'x' },
    { op: 'set_table_cell', table: 9, row: 1, col: 1, text: 'x' },
    { op: 'set_table_cell', row: 1, col: 1, text: 'x' },
  ),
]);
sequence('set_table_cell tracked', BASE(CELLS), [
  batch({ op: 'track_changes' }, { op: 'set_table_cell', table: 1, row: 2, col: 1, text: 'Tracked text', author: 'Eve' }),
  ...each(
    { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Second tracked' },
    { op: 'set_table_cell', table: 1, row: 2, col: 2, text: 'Into an empty cell', author: 'Bo' },
    { op: 'set_table_cell', table: 1, row: 3, col: 2, text: ' padded ' },
    { op: 'set_table_cell', table: 2, row: 1, col: 1 },
  ),
]);
sequence('set_table_style', BASE(CELLS, { 'word/styles.xml': TABLE_STYLES }), [
  ...each(
    { op: 'set_table_style', table: 1, properties: { style: 'Table Grid' } },
    { op: 'set_table_style', table: 2, properties: { style: 'No Such Style', alignment: 'center', columnAlignments: ['left', 'right'] } },
    { op: 'set_table_style', table: 1, properties: { borders: { style: 'single', size: 8, color: '#336699' } } },
    { op: 'set_table_style', table: 2, properties: { style: 'TableGrid', textStyle: 'Caption' } },
    { op: 'set_table_style', table: 1 },
    { op: 'set_table_style', table: 5, properties: {} },
  ),
]);
sequence('table rows and columns', BASE(CELLS), [
  ...each(
    { op: 'insert_table_row', table: 1 },
    { op: 'insert_table_row', table: 1, row: 1 },
    { op: 'insert_table_row', table: 1, row: 5 },
    { op: 'insert_table_row', table: 1, row: 9 },
    { op: 'insert_table_row', table: 1, row: 0 },
    { op: 'insert_table_row', table: 1, row: 1.5 },
    { op: 'delete_table_row', table: 1, row: 2 },
    { op: 'delete_table_row', table: 1, row: 99 },
    { op: 'delete_table_row', table: 2, row: 1 },
    { op: 'insert_table_column', table: 1, column: 1 },
    { op: 'insert_table_column', table: 1, column: 4 },
    { op: 'insert_table_column', table: 1, column: 9 },
    { op: 'delete_table_column', table: 1, column: 2 },
    { op: 'delete_table_column', table: 2, column: 1 },
    { op: 'delete_table_column', table: 2, column: 9 },
    { op: 'delete_table_column', table: 99, column: 1 },
  ),
]);
sequence('table cell styles through the batch', BASE(CELLS), [
  ...each(
    { op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { fillColor: '#DDDDDD', bold: true, fontSize: 9, horizontalAlignment: 'center' } },
    { op: 'merge_table_cells', table: 1, row: 1, col: 1, endCol: 2 },
    { op: 'set_table_cell_style', table: 9, row: 1, col: 1, properties: { bold: true } },
  ),
]);
sequence('fit_table through the batch', BASE(CELLS), each({ op: 'fit_table', table: 1 }, { op: 'fit_table', table: 2 }, { op: 'fit_table', table: 9 }));
sequence('table adjacency', BASE(doc(para(run('x')))), [
  batch({ op: 'add_table', rows: 1, columns: 1, properties: { columnWidths: [40] } }, { op: 'add_table', rows: 1, columns: 1, properties: { columnWidths: [40] } }),
  batch({ op: 'add_table', paragraph: 1, rows: 1, columns: 1, properties: { columnWidths: [40] } }),
]);
sequence('a document that already ends in a table keeps it', BASE(doc(para(run('x')) + simpleTable('a', 'b'))), [
  batch({ op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'changed' }),
  batch({ op: 'add_table', rows: 1, columns: 1, properties: { columnWidths: [40] } }),
]);
sequence('tables already side by side stay as they were', BASE(doc(para(run('x')) + simpleTable('a', 'b') + simpleTable('c', 'd') + para(run('end')))), [
  batch({ op: 'set_table_cell', table: 2, row: 1, col: 1, text: 'changed' }),
]);

// pictures
sequence('add_image', BASE(REPORT), [
  ...each(
    { op: 'add_image', path: '@wide.png' },
    { op: 'add_image', path: '@small.png', altText: '  A small picture  ' },
    { op: 'add_image', path: '@tall.png', width: 100 },
    { op: 'add_image', path: '@tall.png', height: 50, paragraph: 2, properties: { alignment: 'center' } },
    { op: 'add_image', path: '@small.png', width: 60, height: 40, paragraph: 1, properties: { keepWithNext: false } },
    { op: 'add_image', path: '@small.png', width: -5 },
    { op: 'add_image', path: 'figure.bmp.txt' },
    { op: 'add_image', path: '@small.png', paragraph: 99 },
  ),
]);
sequence('add_image into a landscape section', BASE(doc(para(run('x')), '<w:sectPr><w:pgSz w:w="16838" w:h="11906"/><w:pgMar w:left="1000" w:right="1000"/></w:sectPr>')), each({ op: 'add_image', path: '@wide.png' }));

// hyperlinks, bookmarks and comments
sequence('add_hyperlink', BASE(REPORT), [
  ...each(
    { op: 'add_hyperlink', address: 'https://example.com/a?b=1&c=2' },
    { op: 'add_hyperlink', address: 'https://example.com', find: 'brown fox' },
    { op: 'add_hyperlink', address: 'https://example.com', find: 'brown fox', display: 'ignored for a phrase' },
    { op: 'add_hyperlink', address: 'https://example.com', display: 'A label', paragraph: 2 },
    { op: 'add_hyperlink', subAddress: 'Heading_1', display: 'Jump' },
    { op: 'add_hyperlink', address: 'https://example.com', subAddress: 'top', find: 'Result' },
    { op: 'add_hyperlink', address: 'https://example.com', find: 'North' },
    { op: 'add_hyperlink', address: 'https://example.com', find: 'before after' },
    { op: 'add_hyperlink', address: 'https://example.com', find: 'absent phrase' },
    { op: 'add_hyperlink', address: 'https://example.com', display: 'x', paragraph: 99 },
    { op: 'add_hyperlink', display: 'only text' },
    { op: 'add_hyperlink', address: '   ' },
    { op: 'add_hyperlink' },
  ),
]);
sequence('add_bookmark', BASE(REPORT), [
  ...each(
    { op: 'add_bookmark', name: 'intro', paragraph: 1 },
    { op: 'add_bookmark', name: 'fox & co', find: 'brown fox' },
    { op: 'add_bookmark', name: 'cell', find: 'North' },
    { op: 'add_bookmark', name: ' padded ', paragraph: '3' },
    { op: 'add_bookmark', name: 'missing', find: 'absent' },
    { op: 'add_bookmark', name: 'missing', paragraph: 99 },
    { op: 'add_bookmark', paragraph: 1 },
    { op: 'add_bookmark', name: 'any' },
  ),
]);
sequence('comments', BASE(REPORT), [
  ...each(
    { op: 'add_comment', find: 'brown fox', text: 'A comment on the phrase' },
    { op: 'add_comment', find: 'brown fox', text: 'Second', author: 'Eve', initials: 'EV' },
    { op: 'add_comment', find: 'North', text: 'In a table cell' },
    { op: 'add_comment', find: 'before after', text: 'Across a tab' },
    { op: 'add_comment', find: 'Revenue', text: 'A & <b>' },
    { op: 'add_comment_reply', comment: 1, text: 'A reply' },
    { op: 'add_comment_reply', comment: 3, text: 'Reply in a cell' },
    { op: 'add_comment_reply', comment: 1, text: 'Second reply', author: 'Bo' },
    { op: 'set_comment_resolved', comment: 1 },
    { op: 'set_comment_resolved', comment: 2, resolved: false },
    { op: 'delete_comment', comment: 2 },
    { op: 'delete_comment', comment: 4 },
    { op: 'delete_comment', comment: 99 },
    { op: 'add_comment_reply', comment: 99, text: 'x' },
    { op: 'add_comment_reply', comment: 1 },
    { op: 'add_comment_reply', comment: 0, text: 'x' },
    { op: 'set_comment_resolved', comment: 1.5 },
    { op: 'delete_comment' },
    { op: 'add_comment', find: 'absent', text: 'x' },
    { op: 'add_comment', find: 'Revenue' },
    { op: 'add_comment', text: 'No phrase' },
  ),
]);
sequence('provenance', BASE(REPORT), [
  ...each(
    { op: 'add_provenance', paragraph: 2, source: 'Annual report' },
    { op: 'add_provenance', paragraph: 3, source: '자료: 운영관리시스템' },
    { op: 'add_provenance', paragraph: 4, source: '운영관리시스템' },
    { op: 'add_provenance', paragraph: 1, source: { document: 'book', target: 'p4' } },
    { op: 'add_provenance', paragraph: 99, source: 'x' },
    { op: 'add_provenance', paragraph: 1 },
    { op: 'add_provenance', paragraph: 1, source: '   ' },
  ),
]);
sequence('comments in a document with a reply anchored in a footer', BASE(REPORT, {
  'word/footer1.xml': `${HEAD}<w:ftr ${W}><w:p><w:commentRangeStart w:id="5"/><w:r><w:t>footer words</w:t></w:r><w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r></w:p></w:ftr>`,
  'word/comments.xml': `${HEAD}<w:comments ${W}><w:comment w:id="5" w:author="Eve" w:date="${DATE}" w:initials="E"><w:p><w:r><w:t>footer comment</w:t></w:r></w:p></w:comment></w:comments>`,
}), each({ op: 'add_comment_reply', comment: 5, text: 'answering the footer' }, { op: 'delete_comment', comment: 5 }));

// contents, running text, breaks
const CONTENTS = doc(heading(1, 'Intro') + para(run('text')) + heading(2, 'Scope') + heading(3, 'Deep') + heading(1, 'Closing'));
sequence('insert_toc', BASE(CONTENTS), [
  ...each(
    { op: 'insert_toc' },
    { op: 'insert_toc', paragraph: 1, upperHeadingLevel: 2, lowerHeadingLevel: 1 },
    { op: 'insert_toc', upperHeadingLevel: 1, lowerHeadingLevel: 2 },
    { op: 'insert_toc', lowerHeadingLevel: 9, upperHeadingLevel: 12 },
    { op: 'insert_toc', paragraph: 99 },
  ),
]);
sequence('insert_toc without a styles part', (({ 'word/styles.xml': _styles, ...rest }) => rest)(BASE(CONTENTS)), each({ op: 'insert_toc' }));
sequence('set_header_footer', BASE(REPORT), [
  ...each(
    { op: 'set_header_footer', text: 'Quarterly report' },
    { op: 'set_header_footer', text: 'Quarterly report again', header: true },
    { op: 'set_header_footer', text: 'A footer', kind: 'footer', properties: { alignment: 'right', size: 9, bold: true, color: '#666666', name: 'Arial' } },
    { op: 'set_header_footer', text: 'Footer by flag', header: false },
    { op: 'set_header_footer', text: 'First page', kind: 'first' },
    { op: 'set_header_footer', text: 'First footer', kind: 'footer', variant: 'first' },
    { op: 'set_header_footer', text: 'Even header', variant: 'even' },
    { op: 'set_header_footer', text: 'Header kind', kind: 'header', header: false },
    { op: 'set_header_footer', text: 'Bad kind', kind: 'sidebar' },
    { op: 'set_header_footer', text: 'Bad variant', variant: 'last' },
    { op: 'set_header_footer', kind: 'footer' },
    { op: 'set_header_footer', text: '<b> & text', section: 1 },
    { op: 'set_header_footer', text: 'Section nine', section: 9 },
    { op: 'set_header_footer', text: 'Bad section', section: 'x' },
  ),
]);
const SECTIONED = doc(
  para(run('first')) +
    para('', '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>') +
    para(run('second')) +
    para('', '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>') +
    para(run('third')),
);
sequence('running text in a document of sections', BASE(SECTIONED), [
  ...each(
    { op: 'set_header_footer', text: 'Every section' },
    { op: 'set_header_footer', text: 'Second only', section: 2, kind: 'footer' },
    { op: 'add_page_numbers' },
    { op: 'add_page_numbers', section: 1, kind: 'header', alignment: 'right' },
    { op: 'set_header_footer', text: 'First page of all', variant: 'first' },
  ),
]);
sequence('add_page_numbers', BASE(REPORT), [
  ...each(
    { op: 'add_page_numbers' },
    { op: 'add_page_numbers' },
    { op: 'add_page_numbers', alignment: 'RIGHT', prefix: 'Page', separator: ' of ' },
    { op: 'add_page_numbers', includeTotal: true },
    { op: 'add_page_numbers', includeTotal: false, separator: ' / ' },
    { op: 'add_page_numbers', separator: '   ' },
    { op: 'add_page_numbers', kind: 'header', alignment: 'left' },
    { op: 'add_page_numbers', variant: 'first', alignment: 'diagonal' },
    { op: 'add_page_numbers', kind: 'sidebar' },
    { op: 'set_header_footer', text: 'A footer line', kind: 'footer', variant: 'even' },
    { op: 'add_page_numbers', variant: 'even' },
  ),
]);
sequence('page numbers beside the author text of a footer', BASE(REPORT), [
  ...each({ op: 'set_header_footer', text: 'Confidential', kind: 'footer' }, { op: 'add_page_numbers', prefix: 'Page' }, { op: 'add_page_numbers' }),
]);
sequence('insert_break', BASE(REPORT), [
  ...each(
    { op: 'insert_break' },
    { op: 'insert_break', kind: 'column', paragraph: 2 },
    { op: 'insert_break', kind: 'Page', paragraph: 3 },
    { op: 'insert_break', kind: 'section_next', paragraph: 1 },
    { op: 'insert_break', kind: 'section_continuous', paragraph: 4 },
    { op: 'insert_break', kind: 'section_next' },
    { op: 'insert_break', kind: 'line' },
    { op: 'insert_break', kind: 'page', paragraph: 99 },
  ),
]);
sequence('insert_break in a document of sections', BASE(SECTIONED), each({ op: 'insert_break', kind: 'section_continuous', paragraph: 1 }, { op: 'insert_break', kind: 'section_next', paragraph: 3 }, { op: 'insert_break', kind: 'section_next' }));
sequence('insert_break without a section', BASE(doc(para(run('x')) + para(run('y')), '')), each({ op: 'insert_break', kind: 'section_next', paragraph: 1 }, { op: 'insert_break', kind: 'page' }));
sequence('insert_break beside a self-closing section', BASE(doc(para(run('x')) + para(run('y')) + '<w:sectPr/>', '')), each({ op: 'insert_break', kind: 'section_continuous', paragraph: 1 }));

// operations of the operations module, through the dispatcher
sequence('document operations through the dispatcher', BASE(REPORT), [
  ...each(
    { op: 'set_document_font', properties: { name: 'Noto Serif KR', size: 10.5 } },
    { op: 'define_styles', styles: { 'Heading 1': { size: 15, bold: true } } },
    { op: 'set_page', properties: { orientation: 'landscape' } },
    { op: 'add_note', text: 'A footnote', find: 'brown fox' },
    { op: 'set_paragraph_text', paragraph: 1, text: 'Rewritten heading' },
    { op: 'set_run_text', paragraph: 2, run: 1, text: 'Rev' },
    { op: 'move_paragraph', paragraph: 1, index: 3 },
    { op: 'remove_paragraph', paragraph: 3 },
    { op: 'resolve_revisions' },
    { op: 'resolve_revision', revision: 1 },
    { op: 'set_content_control', tag: 'none', text: 'x' },
    { op: 'normalize_runs' },
  ),
]);
sequence('normalize_runs', BASE(doc(para(`${run('a')}${run('b')}<w:proofErr w:type="spellStart"/>${run('c')}`) + para(run('plain')) + para('<w:r w:rsidR="00A1"><w:t>x</w:t></w:r>')), {
  'word/footer1.xml': `${HEAD}<w:ftr ${W}><w:p><w:r><w:t>f</w:t></w:r><w:r><w:t>g</w:t></w:r></w:p></w:ftr>`,
}), each({ op: 'normalize_runs' }, { op: 'normalize_runs' }));

// track changes carried across a batch
sequence('track changes in one batch', BASE(REPORT), [
  batch(
    { op: 'append_text', text: 'Before tracking' },
    { op: 'track_changes' },
    { op: 'append_text', text: 'Tracked line', author: 'Eve' },
    { op: 'append_text', text: 'Tracked bullet', properties: { listKind: 'bullet', author: 'Bo' } },
    { op: 'replace_text', find: 'quick brown', replace: 'slow red', author: 'Eve' },
    { op: 'replace_text', find: 'before after', replace: 'x', author: 'Eve' },
    { op: 'fill_template', tokens: { growth: '22%' }, author: 'Eve' },
    { op: 'set_table_cell', table: 1, row: 1, col: 2, text: 'Tracked cell', author: 'Eve' },
    { op: 'set_paragraph_text', paragraph: 1, text: 'Tracked heading' },
    { op: 'remove_paragraph', paragraph: 3 },
    { op: 'track_changes', enabled: false },
    { op: 'append_text', text: 'Untracked again' },
    { op: 'replace_text', find: 'Tracked', replace: 'Plain' },
  ),
  batch({ op: 'track_changes', enabled: true }, { op: 'replace_text', find: 'slow', replace: '' }),
]);
sequence('track changes already on in the document', BASE(REPORT, { 'word/settings.xml': `${HEAD}<w:settings ${W}><w:trackRevisions/></w:settings>` }), [
  batch({ op: 'append_text', text: 'Tracked from the start' }, { op: 'replace_text', find: 'Revenue', replace: 'Income' }),
  batch({ op: 'track_changes', enabled: false }, { op: 'append_text', text: 'Untracked' }),
]);
sequence('track changes with a failing step', BASE(REPORT), [
  batch({ op: 'append_text', text: 'Kept before the failure' }, { op: 'set_paragraph_style', paragraph: 99, style: 'Heading 1' }, { op: 'append_text', text: 'Never reached' }),
  batch({ op: 'unknown_operation' }),
  batch({ op: 'constructor' }),
  batch({ op: 'toString' }),
  batch({ op: '__proto__' }),
  batch({}),
  batch({ op: 5 }),
  batch(),
]);

const sequences = [];
for (const entry of SEQUENCES) {
  const zip = await packageOf(entry.files);
  const outputs = [];
  for (const step of entry.steps) outputs.push(await attempt(() => runStep(zip, step)));
  sequences.push({ ...entry, outputs, snapshot: await snapshotOf(zip) });
}
rmSync(assetDir, { recursive: true, force: true });

const assets = Object.fromEntries(Object.entries(ASSETS).map(([name, data]) => [name, data.toString('base64')]));
writeJson(join(stage, 'golden.json'), { assets, sequences });
writeSetManifest(stage, { set: 'office-docx-edits', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
