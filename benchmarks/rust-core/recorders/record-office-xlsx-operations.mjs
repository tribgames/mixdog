#!/usr/bin/env node
// What the portable xlsx batch applier answers (src/runtime/office/portable/portable-xlsx.mjs, portable-xlsx-operations.mjs,
// portable-xlsx-sheet-edits.mjs, xlsx-recalculate.mjs), run through Node: batches of operations on fixture workbooks, applied one
// operation at a time (the answer, then the parts of the package that changed), as whole batches (the answers, then every part),
// the pure helpers (typedNumber, assertWorksheetName, tableStyleInfoXml), and the engine-only recalculation of a workbook
// (LibreOffice is never asked for: recalculateWithFormulaEngine is the engine's own entry). Rust `mixdog-ooxml` must answer the
// same: every answer as JSON text and every part as text (crates/mixdog-ooxml/tests/twin_xlsx_operations.rs).
//
//   node benchmarks/rust-core/recorders/record-office-xlsx-operations.mjs --tree <dir with node_modules> [--faces <dir>]
//
// `--faces` names the folder of the fixture faces when this checkout does not hold native/core/fixtures/office-measure. Output:
// native/core/fixtures/office-xlsx-operations/golden.json: `faces`, `workbooks`, `image`, `scenarios`, `batches`, `pure`, `engine`.
// Texts are measured in the fixture faces of office-measure registered on both sides.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const recorder = 'benchmarks/rust-core/recorders/record-office-xlsx-operations.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-xlsx-operations');
const stage = stageSet(finalDir);
const require = createRequire(join(tree, 'package.json'));
const { GlobalFonts } = require('@napi-rs/canvas');
const JSZip = require('jszip');

const FACES = args.has('faces') ? resolve(args.get('faces')) : join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const portable = 'src/runtime/office/portable/';
const xlsx = await importFrom(tree, `${portable}portable-xlsx.mjs`);
const operations = await importFrom(tree, `${portable}portable-xlsx-operations.mjs`);
const edits = await importFrom(tree, `${portable}portable-xlsx-sheet-edits.mjs`);
const recalculate = await importFrom(tree, `${portable}xlsx-recalculate.mjs`);
const opc = await importFrom(tree, `${portable}portable-opc.mjs`);

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-xlsx-operations-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
// The recording keeps the text a call answers (key order and number spelling included), or the reason it failed.
const text = async (run) => {
  const outcome = await attempt(run);
  return outcome.error === undefined ? { result: JSON.stringify(outcome.result) } : { error: outcome.error.split(work).join('$DIR').replaceAll('\\', '/') };
};

// ---- the markup ---------------------------------------------------------------------------------------------------
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const worksheet = (inner, head = '', tail = '') => `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${head}${inner}${tail}</worksheet>`;
const rels = (...entries) =>
  `${HEAD}<Relationships xmlns="${PKG}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const inline = (reference, value, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t>${value}</t></is></c>`;
const shared = (reference, index) => `<c r="${reference}" t="s"><v>${index}</v></c>`;
const num = (reference, value, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`}><v>${value}</v></c>`;
const formula = (reference, expression, value, type) =>
  `<c r="${reference}"${type ? ` t="${type}"` : ''}><f>${expression}</f>${value === undefined ? '' : `<v>${value}</v>`}</c>`;
const row = (index, inner, attributes = '') => `<row r="${index}"${attributes}>${inner}</row>`;

const STYLES =
  `${HEAD}<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm"/><numFmt numFmtId="165" formatCode="#,##0"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Twin Miriam"/><family val="2"/></font><font><b/><sz val="12"/><name val="Twin Lisu"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0"/>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>';

const SHARED_STRINGS = `${HEAD}<sst xmlns="${MAIN}" count="5" uniqueCount="5"><si><t>Alpha</t></si><si><t>Beta Item</t></si><si><t>Gamma &amp; Co</t></si><si><t xml:space="preserve"> Delta </t></si><si><t>Item sold</t></si></sst>`;

function book({ sheets, styles = STYLES, names = '', calc = '', parts = {}, sharedStrings = SHARED_STRINGS }) {
  const files = {};
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  files['[Content_Types].xml'] =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    `${overrides.join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    (sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '') +
    '</Types>';
  files['_rels/.rels'] = rels(['rId1', 'officeDocument', 'xl/workbook.xml']);
  files['xl/workbook.xml'] =
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
    sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${index + 1}"/>`).join('') +
    `</sheets>${names}${calc}</workbook>`;
  files['xl/_rels/workbook.xml.rels'] = rels(
    ...sheets.map((_, index) => [`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`]),
    [`rId${sheets.length + 1}`, 'styles', 'styles.xml'],
    ...(sharedStrings ? [[`rId${sheets.length + 2}`, 'sharedStrings', 'sharedStrings.xml']] : [])
  );
  files['xl/styles.xml'] = styles;
  if (sharedStrings) files['xl/sharedStrings.xml'] = sharedStrings;
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml;
  });
  return { ...files, ...parts };
}
const zipOf = (files) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip;
};

// ---- the workbooks ------------------------------------------------------------------------------------------------
const ITEMS = [
  [shared('A2', 0), 3, 1200],
  [shared('A3', 1), 4, 250],
  [shared('A4', 2), 5, 99.5],
  [shared('A5', 3), 6, 10],
];
const ledger = worksheet(
  '<sheetData>' +
    row(1, inline('A1', 'Item') + inline('B1', 'Qty') + inline('C1', 'Price') + inline('D1', 'Total') + inline('E1', 'Date'), ' ht="20" customHeight="1"') +
    ITEMS.map(([label, qty, price], at) => row(at + 2, label + num(`B${at + 2}`, qty) + num(`C${at + 2}`, price, 2) + formula(`D${at + 2}`, `B${at + 2}*C${at + 2}`, qty * price) + inline(`E${at + 2}`, `2026-0${at + 1}-15`))).join('') +
    row(6, inline('A6', 'Sum') + formula('D6', 'SUM(D2:D5)', 3600 + 1000 + 497.5 + 60)) +
    row(8, inline('A8', 'Merged title')) +
    '</sheetData><mergeCells count="1"><mergeCell ref="A8:C8"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
  '<dimension ref="A1:E8"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
    '<cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="3" width="10" customWidth="1"/></cols>'
);
const notes = worksheet(
  '<sheetData>' +
    row(1, inline('A1', 'Check') + formula('B1', 'Ledger!D6*Rate', 5157.5 * 1200) + shared('C1', 4)) +
    row(2, inline('A2', 'Size') + formula('B2', 'IF(B1&gt;100,"big","small")', 'big', 'str') + formula('C2', 'Total+1', 5158.5)) +
    '</sheetData>',
  '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
);
const monthly = worksheet(
  '<sheetData>' +
    row(1, inline('A1', 'Month') + inline('B1', 'Visits') + inline('C1', 'Orders')) +
    [46174, 46204, 46235, 46265].map((serial, at) => row(at + 2, num(`A${at + 2}`, serial, 1) + num(`B${at + 2}`, 1000 + at * 120) + num(`C${at + 2}`, 40 + at * 3))).join('') +
    row(6, inline('A6', 'All') + formula('B6', 'SUM(B2:B5)', 4360) + formula('C6', 'SUM(C2:C5)+Ledger!B2', 169)) +
    '</sheetData>',
  '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
);
const NAMES =
  '<definedNames><definedName name="Rate">Ledger!$C$2</definedName><definedName name="Total">Ledger!$D$6</definedName>' +
  '<definedName name="Local1" localSheetId="1">Notes!$A$1</definedName><definedName name="Months" localSheetId="2">\'월별 데이터\'!$A$2:$A$5</definedName></definedNames>';
const WORKBOOKS = {
  ledger: book({ sheets: [{ name: 'Ledger', xml: ledger }, { name: 'Notes', xml: notes }, { name: '월별 데이터', xml: monthly }], names: NAMES, calc: '<calcPr calcId="191029"/>' }),
  single: book({ sheets: [{ name: 'Only', xml: worksheet('<sheetData/>') }] }),
  withoutStyles: book({ sheets: [{ name: 'Bare', xml: worksheet('<sheetData>' + row(1, inline('A1', 'x')) + '</sheetData>') }], styles: '', sharedStrings: '' }),
};
const names = (zip) => Object.keys(zip.files).filter((entry) => !entry.endsWith('/')).sort();
const partsOf = async (zip) => {
  const parts = {};
  for (const name of names(zip)) {
    const data = await zip.file(name).async('nodebuffer');
    parts[name] = name.startsWith('xl/media/') ? `base64:${data.toString('base64')}` : data.toString('utf8');
  }
  return parts;
};
const changesOf = (before, after) => {
  const changed = {};
  for (const [name, content] of Object.entries(after)) if (before[name] !== content) changed[name] = content;
  return { changed, removed: Object.keys(before).filter((name) => !(name in after)) };
};

// ---- a picture to place --------------------------------------------------------------------------------------------
function png(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanline = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => scanline));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const IMAGE = png(40, 20);
const IMAGE_FILE = join(work, 'pixel.png');
writeFileSync(IMAGE_FILE, IMAGE);
const withImage = (op) => (op.path === '$IMG' ? { ...op, path: IMAGE_FILE } : op);

// ---- one operation at a time ----------------------------------------------------------------------------------------
const SCENARIOS = [
  [
    'cells and ranges',
    'ledger',
    [
      { op: 'set_cell', cell: 'B2', value: 7 },
      { op: 'set_cell', cell: 'A1', value: 'Item name' },
      { op: 'set_cell', cell: 'E2', value: '1,234.50' },
      { op: 'set_cell', cell: 'E3', value: '15%' },
      { op: 'set_cell', cell: 'E4', value: '2026-09-30' },
      { op: 'set_cell', cell: 'E5', value: '007' },
      { op: 'set_cell', cell: 'F2', value: ' padded ' },
      { op: 'set_cell', cell: 'F3', value: true },
      { op: 'set_cell', cell: 'F4', value: null },
      { op: 'set_formula', cell: 'F2', formula: '=SUM(B2:B5)' },
      { op: 'set_formula', cell: 'F3', formula: 'sum(b2:b5)*2' },
      { op: 'set_formula', sheet: 'notes', cell: 'C3', formula: "='Ledger'!D6+1" },
      { op: 'set_formula', sheet: '월별 데이터', cell: 'D2', formula: "=SUM(Ledger!B2:B5)" },
      { op: 'set_cell', cell: 'B8', value: 'inside the merge' },
      { op: 'set_cell', cell: 'A8', value: 'the anchor' },
      { op: 'set_cell', cell: 'zz', value: 1 },
      { op: 'set_formula', cell: 'F5', formula: '=' },
      { op: 'set_range', range: 'A10:C11', values: [['a', '1,000', '2026-02-28'], ['2026-02-30', '12%', 'x']] },
      { op: 'set_range', range: 'A12', values: [['single']] },
      { op: 'set_range', range: 'D12:E13', values: [[1, 2], [3]] },
      { op: 'set_range', range: 'A1:B1' },
      { op: 'set_range', range: 'bad' },
      { op: 'append_row', values: ['Gamma', '1,200', 3, null, 'Tail'] },
      { op: 'append_row', sheet: 'Notes', values: ['n'] },
      { op: 'append_row', values: [] },
      { op: 'clear_cell', cell: 'D2' },
      { op: 'clear_cell', cell: 'Z99' },
      { op: 'clear_cell', cell: 'a1' },
      { op: 'replace_text', find: 'Item', replace: 'Thing' },
      { op: 'replace_text', find: 'Gamma', replace: 'Epsilon & <Co>' },
      { op: 'replace_text', find: 'nothing-here', replace: 'x' },
      { op: 'replace_text', find: '', replace: 'x' },
      { op: 'set_style', range: 'A1:D1', properties: { bold: true, fillColor: 'FFEEAA', color: '112233', horizontalAlignment: 'center' } },
      { op: 'set_style', cell: 'E2', properties: { numberFormat: '#,##0.00', italic: true } },
      { op: 'set_style', range: 'B2:C3', properties: { borders: { bottom: 'thin' }, wrapText: true } },
      { op: 'set_style' },
      { op: 'set_style', range: 'A:C', properties: { bold: true } },
      { op: 'set_style', range: 'A1:Z2000', properties: { bold: true } },
      { op: 'merge_cells', range: 'D8:E8' },
      { op: 'merge_cells', range: 'D8:E8' },
      { op: 'unmerge_cells', range: 'A8:C8' },
      { op: 'unmerge_cells', range: 'Q8:R9' },
      { op: 'merge_cells', range: 'A:C' },
      { op: 'freeze_panes', row: 2, column: 1 },
      { op: 'freeze_panes', row: 1, column: 1 },
      { op: 'freeze_panes', row: 3 },
      { op: 'freeze_panes', column: 3, sheet: 'Notes' },
      { op: 'set_sheet_view', showGridlines: false, zoom: 150 },
      { op: 'set_sheet_view', zoom: 1000 },
      { op: 'set_sheet_view', showGridlines: true, zoom: 'x' },
      { op: 'set_sheet_view' },
      { op: 'set_autofilter', range: 'A1:E6' },
      { op: 'set_autofilter', enabled: false },
      { op: 'set_autofilter', range: 'nonsense' },
      { op: 'set_cell', sheet: 'Nope', cell: 'A1', value: 1 },
      { op: 'set_cell', sheet: 'Notes', cell: 'A1', value: 'ok' },
      { op: 'frobnicate' },
      {},
    ],
  ],
  [
    'sheets, rows and columns',
    'ledger',
    [
      { op: 'add_sheet', name: 'Summary' },
      { op: 'add_sheet', name: 'summary' },
      { op: 'add_sheet', name: 'a:b' },
      { op: 'add_sheet', name: 'x'.repeat(32) },
      { op: 'add_sheet', name: "'quoted'" },
      { op: 'add_sheet', name: 'History' },
      { op: 'add_sheet' },
      { op: 'rename_sheet', sheet: 'Ledger', name: 'Ledger 2026' },
      { op: 'rename_sheet', sheet: 'Notes', name: 'Checks' },
      { op: 'rename_sheet', sheet: 'Nope', name: 'Whatever' },
      { op: 'rename_sheet', sheet: 'Checks', name: '' },
      { op: 'copy_sheet', sheet: 'Checks' },
      { op: 'copy_sheet', sheet: 'Ledger 2026', name: 'Ledger copy' },
      { op: 'copy_sheet', sheet: 'Ledger 2026', name: 'ledger copy' },
      { op: 'copy_sheet', sheet: 'Ledger 2026', name: 'a/b' },
      { op: 'delete_sheet', sheet: 'Summary' },
      { op: 'delete_sheet', sheet: 'Summary' },
      { op: 'delete_sheet', sheet: '월별 데이터' },
      { op: 'insert_rows', sheet: 'Ledger 2026', row: 3, count: 2 },
      { op: 'insert_rows', sheet: 'Ledger 2026', row: 1 },
      { op: 'delete_rows', sheet: 'Ledger 2026', row: 2 },
      { op: 'delete_rows', sheet: 'Ledger 2026', row: 3, count: 2 },
      { op: 'insert_columns', sheet: 'Ledger 2026', column: 2 },
      { op: 'delete_columns', sheet: 'Ledger 2026', column: 2, count: 2 },
      { op: 'delete_columns', sheet: 'Ledger 2026', column: 1 },
      { op: 'insert_rows', sheet: 'Ledger copy', row: 2, count: 3 },
      { op: 'define_name', name: 'Tax', refersTo: '=Ledger!$C$3' },
      { op: 'define_name', name: 'Tax_two', refersTo: "'Ledger copy'!$C$3" },
      { op: 'define_name', name: 'Tax', refersTo: '==Ledger!$D$3' },
      { op: 'define_name', name: 'A1', refersTo: 'x' },
      { op: 'define_name', name: 'Has Space', refersTo: 'x' },
      { op: 'define_name', name: 'NoTarget' },
      { op: 'define_name' },
      { op: 'delete_name', name: 'Tax' },
      { op: 'delete_name', name: 'Nonexistent' },
      { op: 'sort_range', sheet: 'Ledger copy', range: 'A1:E7', by: 'B', order: 'desc' },
      { op: 'set_sheet_visibility', sheet: 'Checks', visibility: 'hidden' },
      { op: 'set_sheet_visibility', sheet: 'Checks', visible: true },
      { op: 'set_sheet_visibility', sheet: 'Checks', visibility: 'very_hidden' },
      { op: 'set_sheet_visibility', sheet: 'Ledger copy', visible: false },
      { op: 'set_sheet_visibility', sheet: 'Ledger 2026', visibility: 'hidden' },
      { op: 'set_sheet_visibility', sheet: 'Ledger 2026', visibility: 'sideways' },
      { op: 'delete_sheet', sheet: 'Checks' },
    ],
  ],
  [
    'layout, print and annotations',
    'ledger',
    [
      { op: 'set_row_height', row: 2, height: 30 },
      { op: 'set_row_height', row: 1, count: 3, height: 18.555 },
      { op: 'set_row_height', row: 40, height: 12 },
      { op: 'set_row_height', row: 2, height: 500 },
      { op: 'set_row_height', height: 12 },
      { op: 'set_column_width', column: 'D', width: 20 },
      { op: 'set_column_width', column: 3, width: 12.5, count: 2 },
      { op: 'set_column_width', column: 'AA', width: 0 },
      { op: 'set_column_width', column: 'B', width: 300 },
      { op: 'set_column_width', width: 5 },
      { op: 'set_row_visibility', row: 4, visible: false },
      { op: 'set_row_visibility', row: 40, visible: false },
      { op: 'set_row_visibility', row: 90, visible: true },
      { op: 'set_row_visibility', row: 4, visible: true },
      { op: 'set_row_visibility', row: 4 },
      { op: 'set_column_visibility', column: 'C', visible: false },
      { op: 'set_column_visibility', column: 5, visible: false, count: 2 },
      { op: 'set_column_visibility', column: 'C', visible: true },
      { op: 'set_header_footer', kind: 'header', alignment: 'center', text: '{sheet} - {page}/{pages}' },
      { op: 'set_header_footer', kind: 'header', alignment: 'left', text: 'R&D {date} {time} {file}' },
      { op: 'set_header_footer', kind: 'footer', alignment: 'right', text: 'Confidential & more' },
      { op: 'set_header_footer', kind: 'FOOTER', text: 'Page {PAGE}' },
      { op: 'set_header_footer', kind: 'header', alignment: 'center' },
      { op: 'set_header_footer', kind: 'sideways', text: 'x' },
      { op: 'set_header_footer', kind: 'header', alignment: 'middle', text: 'x' },
      { op: 'add_conditional_format', range: 'B2:B5', formula: '=B2>4', fillColor: 'FFC7CE', color: '9C0006' },
      { op: 'add_conditional_format', range: 'B2:B5', formula: 'B2<4', fillColor: 'FFC7CE', color: '9C0006' },
      { op: 'add_conditional_format', range: 'C2:C5', type: 'colorScale', minColor: 'FF0000', maxColor: '00FF00', midColor: 'FFFF00' },
      { op: 'add_conditional_format', range: 'D2:D5', type: 'dataBar', color: '5B9BD5' },
      { op: 'add_conditional_format', range: 'D2:D5', type: 'bar' },
      { op: 'add_conditional_format', range: 'D2:D5', type: 'sparkle' },
      { op: 'add_conditional_format', range: 'nonsense', formula: 'x' },
      { op: 'delete_conditional_formats', range: 'C2:C5' },
      { op: 'delete_conditional_formats', range: 'Z2:Z5' },
      { op: 'add_validation', range: 'E2:E5', formula1: '서울,부산' },
      { op: 'add_validation', range: 'B2:B5', type: 'whole', formula1: '1', formula2: '10', inputMessage: 'Between <1> & 10', errorMessage: 'No' },
      { op: 'add_validation', range: 'C2', type: 'decimal', operator: 'greaterThan', formula1: '=0' },
      { op: 'add_validation', range: 'C2', formula1: 'C3>0' },
      { op: 'add_validation', range: 'C2', formula1: 'Notes!$A$1:$A$2' },
      { op: 'add_validation', range: 'C2', type: 'whole', formula1: '1' },
      { op: 'add_validation', range: 'C2', formula1: '' },
      { op: 'add_table', range: 'A1:E6', name: 'Sales Table' },
      { op: 'add_table', range: 'A10:C11', style: 'none' },
      { op: 'add_table', range: 'A1:A1', style: 'TableStyleLight9', name: '1bad name!' },
      { op: 'add_table', range: 'A:C' },
      { op: 'set_hyperlink', cell: 'A2', address: 'https://example.com/a?b=1&c=2', text: 'Example', screenTip: 'Go <now>' },
      { op: 'set_hyperlink', cell: 'A3', subAddress: "'Notes'!A1" },
      { op: 'set_hyperlink', cell: 'A2', address: 'https://example.com/second' },
      { op: 'set_hyperlink', cell: 'A4' },
      { op: 'protect_sheet', password: 'secret', allowSorting: true, allowFormattingCells: true },
      { op: 'protect_sheet' },
      { op: 'unprotect_sheet' },
      { op: 'add_note', cell: 'B2', text: 'Check this & that', author: 'Lee' },
      { op: 'add_note', cell: 'B2', text: 'Second text' },
      { op: 'add_note', cell: 'C3', text: 'Another' },
      { op: 'add_note', cell: 'C3' },
      { op: 'add_provenance', cell: 'D2', source: { document: 'Annual report', page: 4, url: 'https://example.com/report' } },
      { op: 'add_provenance', cell: 'D2', source: '출처: 감사보고서' },
      { op: 'add_provenance', cell: 'D2', source: { document: 'Annual report', page: 4, url: 'https://example.com/report' } },
      { op: 'add_provenance', cell: 'D3' },
      { op: 'delete_note', cell: 'B2' },
      { op: 'delete_note', cell: 'B2' },
      { op: 'delete_note', sheet: 'Notes', cell: 'A1' },
      { op: 'autofit_range', range: 'A:E' },
      { op: 'autofit_range', range: '1:6' },
      { op: 'autofit_range', range: 'B2:C3' },
      { op: 'set_page_setup', orientation: 'landscape', fitToPagesWide: 1 },
      { op: 'set_page_setup', printArea: 'A1:E6', printTitleRows: '1:1', centerHorizontally: true, topMargin: 0.5 },
      { op: 'set_page_setup', fitToContent: true },
      { op: 'set_page_setup', orientation: 'diagonal' },
      { op: 'add_chart', chartType: 'column', range: 'A1:B5', title: 'Quantities' },
      { op: 'add_chart', chartType: 'line', range: "'월별 데이터'!A1:C5", cell: 'G2' },
      { op: 'add_image', path: '$IMG', cell: 'G10' },
      { op: 'set_drawing', drawing: 1, left: 120, top: 60, width: 300 },
      { op: 'set_drawing', drawing: 'nothing' },
      { op: 'set_drawing' },
      { op: 'delete_drawing', drawing: 2 },
      { op: 'delete_drawing', drawing: 9 },
      { op: 'add_pivot_table', source: 'A1:C5', rows: ['Item'], values: ['Qty'], cell: 'H2' },
      { op: 'add_pivot_table', source: 'A1:C5', rows: ['Item'], values: [] },
      { op: 'add_pivot_table', source: 'A1:A1', rows: ['Item'], values: ['Qty'] },
    ],
  ],
  [
    'a workbook with one sheet and a bare one',
    'single',
    [
      { op: 'set_cell', cell: 'A1', value: 'x' },
      { op: 'set_row_height', row: 2, height: 20 },
      { op: 'set_row_visibility', row: 5, visible: false },
      { op: 'add_sheet', name: 'Two' },
      { op: 'set_row_visibility', sheet: 'Two', row: 3, visible: false },
      { op: 'delete_sheet', sheet: 'Only' },
      { op: 'delete_sheet', sheet: 'Two' },
      { op: 'set_sheet_visibility', sheet: 'Two', visibility: 'hidden' },
    ],
  ],
  [
    'a workbook without styles',
    'withoutStyles',
    [
      { op: 'set_cell', cell: 'B1', value: '15%' },
      { op: 'set_range', range: 'A2:A3', values: [['2026-01-01'], ['1,500']] },
      { op: 'set_style', cell: 'A1', properties: { bold: true } },
      { op: 'add_conditional_format', range: 'A1', formula: 'A1>1', fillColor: 'FF0000' },
      { op: 'set_column_width', column: 'A', width: 12 },
    ],
  ],
];
const scenarios = [];
for (const [name, workbookName, steps] of SCENARIOS) {
  const zip = zipOf(WORKBOOKS[workbookName]);
  let before = await partsOf(zip);
  const recorded = [];
  for (const operation of steps) {
    const output = await text(() => xlsx.applyXlsx(zip, [withImage(operation)]));
    const after = await partsOf(zip);
    recorded.push({ op: operation, output, ...changesOf(before, after) });
    before = after;
  }
  scenarios.push({ name, workbook: workbookName, steps: recorded });
}

// ---- whole batches --------------------------------------------------------------------------------------------------
const BATCHES = [
  ['a batch that writes a formula and a value', 'ledger', [{ op: 'set_cell', cell: 'B2', value: 9 }, { op: 'set_formula', cell: 'F2', formula: 'B2*2' }, { op: 'add_sheet', name: 'Extra' }, { op: 'set_cell', sheet: 'Extra', cell: 'A1', value: 'in the new sheet' }]],
  ['a batch of formatting only leaves the calculation alone', 'ledger', [{ op: 'set_style', range: 'A1:B1', properties: { bold: true } }, { op: 'freeze_panes', row: 2 }, { op: 'merge_cells', range: 'A9:C9' }]],
  ['a batch that renames, copies and deletes', 'ledger', [{ op: 'rename_sheet', sheet: 'Notes', name: 'Checks' }, { op: 'copy_sheet', sheet: 'Checks', name: 'Checks 2' }, { op: 'delete_sheet', sheet: 'Checks' }]],
  ['a batch that fails on its third operation', 'ledger', [{ op: 'set_cell', cell: 'A1', value: 'first' }, { op: 'add_sheet', name: 'Second' }, { op: 'delete_sheet', sheet: 'Nope' }, { op: 'set_cell', cell: 'A2', value: 'never' }]],
  ['an empty batch', 'ledger', []],
  ['a batch that keeps the workbook calculation block it has', 'ledger', [{ op: 'define_name', name: 'Extra', refersTo: 'Ledger!$A$1' }]],
];
const batches = [];
for (const [name, workbookName, ops] of BATCHES) {
  const zip = zipOf(WORKBOOKS[workbookName]);
  const output = await text(() => xlsx.applyXlsx(zip, ops));
  batches.push({ name, workbook: workbookName, ops, output, parts: await partsOf(zip) });
}

// ---- the helpers that stand alone -----------------------------------------------------------------------------------------
const TYPED = ['1', '-500000', '1,234', '1,234.5', '15%', '92.8%', '0.5%', '007', '1-2', '1e3', '(100)', 'TRUE', '', ' 12 ', '+7', '.5', '1,23', '12,345,678.90', '100%', '-3.25', '3.', '00.5', '１２', '1 000', 12, null, true];
const pure = {
  typedNumber: TYPED.map((value) => ({ value, output: edits.typedNumber(value) })),
  assertWorksheetName: await Promise.all(
    ['Sheet 1', '  padded  ', '', undefined, 'x'.repeat(31), 'x'.repeat(32), 'a/b', 'a?b', 'a*b', 'a[b', "'lead", 'trail\'', 'history', 'HISTORY', '월별 데이터', 42].map(async (value) => ({
      value: value === undefined ? null : value,
      output: await text(() => operations.assertWorksheetName('add_sheet', value)),
    }))
  ),
  tableStyleInfoXml: [undefined, 'none', ' None ', '', 'TableStyleLight9', 5, null, 'A<B'].map((style) => ({ style: style === undefined ? { missing: true } : { value: style }, output: operations.tableStyleInfoXml(style) })),
};

// ---- engine-only recalculation ----------------------------------------------------------------------------------------------
const chain = (count, upward) =>
  worksheet(
    '<sheetData>' +
      Array.from({ length: count }, (_, at) => {
        const index = at + 1;
        const expression = upward ? (index === count ? null : `B${index + 1}+1`) : index === 1 ? null : `B${index - 1}+1`;
        return row(index, expression === null ? num(`B${index}`, 1) : formula(`B${index}`, expression));
      }).join('') +
      '</sheetData>'
  );
const model = worksheet(
  '<sheetData>' +
    row(1, inline('A1', 'Item') + inline('B1', 'Qty') + inline('C1', 'Price') + inline('D1', 'Total')) +
    row(2, inline('A2', 'Rent') + num('B2', 3) + num('C2', 1200) + formula('D2', 'B2*C2', 0)) +
    row(3, inline('A3', 'Power') + num('B3', 4) + num('C3', 250.5) + formula('D3', 'B3*C3')) +
    row(4, inline('A4', 'Misc') + num('B4', 0) + num('C4', 10) + formula('D4', 'C4/B4')) +
    row(5, inline('A5', 'Sum') + formula('D5', 'SUM(D2:D4)') + formula('E5', 'SUM(D:D)') + formula('F5', 'D2&amp;"-"&amp;A2')) +
    row(6, formula('A6', 'IF(D2&gt;100,TRUE,FALSE)') + formula('B6', 'D2*Rate') + formula('C6', 'ROUND(D3/7,2)') + formula('D6', 'A9') + formula('E6', 'UPPER(A2)')) +
    row(7, formula('A7', 'Notes!B1+1') + formula('B7', 'Missing!A1') + formula('C7', 'NOSUCHFUNCTION(1)') + formula('D7', 'INDIRECT("A1")') + formula('E7', 'VLOOKUP("Power",A2:D4,2,FALSE)')) +
    row(8, formula('A8', 'B8') + formula('B8', 'A8') + formula('C8', 'IFERROR(D4,"none")') + formula('D8', 'COUNTA(A1:A5)') + formula('E8', 'DATE(2026,9,30)')) +
    '</sheetData>'
);
const modelNotes = worksheet('<sheetData>' + row(1, inline('A1', 'n') + formula('B1', 'Total*2') + formula('C1', 'Months_total')) + '</sheetData>');
const sharedFormulas = worksheet(
  '<sheetData>' +
    row(1, num('A1', 1) + num('B1', 5)) +
    row(2, num('A2', 2) + '<c r="B2"><f t="shared" ref="B2:B4" si="0">A2*10</f></c>') +
    row(3, num('A3', 3) + '<c r="B3"><f t="shared" si="0"/></c>') +
    row(4, num('A4', 4) + '<c r="B4"><f t="shared" si="0"/></c>') +
    row(5, '<c r="A5"><f t="array" ref="A5:A6">A2:A3*2</f></c>') +
    row(6, '<c r="A6"/>') +
    '</sheetData>'
);
const longColumn = worksheet(
  '<sheetData>' + Array.from({ length: 20_001 }, (_, at) => row(at + 1, formula(`A${at + 1}`, '1+1'))).join('') + '</sheetData>'
);
const ENGINE_NAMES = '<definedNames><definedName name="Rate">Model!$C$2</definedName><definedName name="Total">Model!$D$5</definedName><definedName name="Months_total">"x"</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Model!$A$1:$E$8</definedName></definedNames>';
const engineBooks = {
  'a model of every kind of result': book({ sheets: [{ name: 'Model', xml: model }, { name: 'Notes', xml: modelNotes }], names: ENGINE_NAMES, calc: '<calcPr fullCalcOnLoad="1"/>' }),
  'stored-once formulas': book({ sheets: [{ name: 'Shared', xml: sharedFormulas }] }),
  'a workbook without formulas': WORKBOOKS.single,
  'a workbook that reads another workbook': book({ sheets: [{ name: 'Model', xml: model }], parts: { 'xl/externalLinks/externalLink1.xml': `${HEAD}<externalLink xmlns="${MAIN}"/>` } }),
  'more formulas than the engine takes': book({ sheets: [{ name: 'Long', xml: longColumn }] }),
  'a chain read from its far end': book({ sheets: [{ name: 'Chain', xml: chain(600, true) }] }),
  'a chain read from its near end': book({ sheets: [{ name: 'Chain', xml: chain(700, false) }] }),
  'nothing the engine can read': book({ sheets: [{ name: 'Refused', xml: worksheet('<sheetData>' + row(1, formula('A1', 'INDIRECT("B1")') + formula('B1', 'OFFSET(A1,1,1)')) + '</sheetData>') }] }),
  'only errors': book({ sheets: [{ name: 'Errors', xml: worksheet('<sheetData>' + row(1, formula('A1', '1/0') + formula('B1', 'A1+1') + formula('C1', 'NA()')) + '</sheetData>') }] }),
};
// The three long sheets are written by the test from this description (the recording keeps a digest of what changed in them).
const GENERATED = {
  'more formulas than the engine takes': { kind: 'formulas', count: 20_001 },
  'a chain read from its far end': { kind: 'chain', count: 600, upward: true },
  'a chain read from its near end': { kind: 'chain', count: 700, upward: false },
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const engine = [];
const engineWorkbooks = {};
for (const [name, files] of Object.entries(engineBooks)) {
  const path = join(work, 'engine.xlsx');
  writeFileSync(path, await zipOf(files).generateAsync({ type: 'nodebuffer' }));
  const before = await partsOf(await JSZip.loadAsync(readFileSync(path)));
  const output = await text(() => recalculate.recalculateWithFormulaEngine(path));
  const after = await partsOf(await JSZip.loadAsync(readFileSync(path)));
  const changes = changesOf(before, after);
  const generate = GENERATED[name];
  if (generate) {
    engineWorkbooks[name] = { ...files, 'xl/worksheets/sheet1.xml': { generate } };
    engine.push({ name, output, changedSha256: Object.fromEntries(Object.entries(changes.changed).map(([part, content]) => [part, sha256(content)])), removed: changes.removed });
  } else {
    engineWorkbooks[name] = files;
    engine.push({ name, output, ...changes });
  }
}

writeJson(join(stage, 'golden.json'), {
  platform: process.platform,
  workbooks: { ...WORKBOOKS, ...engineWorkbooks },
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  image: IMAGE.toString('base64'),
  scenarios,
  batches,
  pure,
  engine,
});
writeSetManifest(stage, { set: 'office-xlsx-operations', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(work, { recursive: true, force: true });
