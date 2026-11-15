#!/usr/bin/env node
// What the portable Word XML builders answer (src/runtime/office/portable: portable-docx-xml, portable-docx-styles and
// docx-formatting), run through Node. Rust `mixdog-ooxml` must answer the same, byte for byte: the table, paragraph and run
// builders, the property merges, the table readers and their errors, the style lookup against a styles part, and the
// formatting patches (crates/mixdog-ooxml/tests/twin_docx_xml.rs).
//
//   node benchmarks/rust-core/recorders/record-office-docx-xml.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-docx-xml/golden.json: `pure` (a function name, its arguments and its result or error)
// and `styles` (a package's files, the style asked for, and what documentStyleId answered with the styles part it left). Table
// widths that need a measured face (available > 0) are not recorded: the font files of this machine decide them, and the
// measuring is replayed by the text-metrics twin; the widths the table states, and the table with no width to measure, are.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-docx-xml');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-docx-xml.mjs';
const xml = await importFrom(tree, 'src/runtime/office/portable/portable-docx-xml.mjs');
const formatting = await importFrom(tree, 'src/runtime/office/portable/docx-formatting.mjs');
const styles = await importFrom(tree, 'src/runtime/office/portable/portable-docx-styles.mjs');
const wordPackage = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const JSZip = createRequire(join(tree, 'package.json'))('jszip');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const pure = [];
const record = async (fn, args, call) => pure.push({ fn, args, ...(await attempt(call)) });
const matches = (list) => list.map((match) => ({ index: match.index, xml: match[0] }));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...inner) => `<w:p>${inner.join('')}</w:p>`;
const doc = (body, section = '') => `<w:document ${W}><w:body>${body}${section}</w:body></w:document>`;
const SECTION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1701"/></w:sectPr>';
const LANDSCAPE = '<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:right="720" w:left="1080"/></w:sectPr>';

// ---- table properties ----------------------------------------------------------------------------------------------
const TABLE_PROPERTIES = [
  {},
  { borders: { style: 'solid', size: 8, color: '#112233' } },
  { borders: { top: { style: 'dash', size: 6, color: 'AABBCC', space: 2 }, bottom: { enabled: false }, insideH: { style: 'wave' } } },
  { borders: { top: { color: '445566' } } },
  { borders: { enabled: false } },
  { borders: {} },
  { borders: true },
  { borders: 'all' },
  { style: 'Table Grid', alignment: 'center' },
  { style: 'heading 1', shading: '#EEF2F7' },
  { shading: 'FFEEDD', alignment: 'right', borders: { left: { style: 'dot', size: 0 }, right: { style: 'nonesuch', space: -3 } } },
  { borders: { top: null, left: { enabled: false }, insideV: { style: 'double', size: '12', color: '' } } },
  { alignment: 'a&b<c>' },
];
for (const properties of TABLE_PROPERTIES) for (const total of [0, 8963.4, 10000])
  await record('wordTableProperties', [properties, { totalWidth: total }], () => xml.wordTableProperties(properties, { totalWidth: total }));

// ---- cell properties -----------------------------------------------------------------------------------------------
const CELLS = [
  '<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>',
  '<w:tc><w:p><w:r><w:t>no properties</w:t></w:r></w:p></w:tc>',
  '<w:tc><w:tcPr/><w:p/></w:tc>',
  '<w:tc w:id="1"><w:tcPr><w:tcW w:w="1000" w:type="dxa"/><w:tcMar><w:left w:w="0" w:type="dxa"/></w:tcMar><w:shd w:val="clear" w:color="auto" w:fill="111111"/></w:tcPr><w:p/></w:tc>',
  '<w:tc><w:tcPr><w:gridSpan w:val="2"/><w:tcBorders><w:top w:val="single"/></w:tcBorders><w:hideMark/><w:vAlign w:val="bottom"/></w:tcPr><w:p/></w:tc>',
  '<w:tc><w:tcPr><w:tcMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar><w:vAlign w:val="top"/></w:tcPr><w:p/></w:tc>',
];
const CELL_PROPERTIES = [
  { fillColor: '#FF0000' },
  { fillColor: null },
  { width: 72, verticalAlignment: 'Middle' },
  { fillColor: 'EEEEEE', width: 36.5, verticalAlignment: 'bottom' },
  { verticalAlignment: 'diagonal' },
  {},
  { fillColor: '', width: 0 },
];
for (const cell of CELLS) for (const properties of CELL_PROPERTIES)
  await record('mergeWordCellProperties', [cell, properties], () => xml.mergeWordCellProperties(cell, properties));

// ---- justification -------------------------------------------------------------------------------------------------
for (const value of ['left', 'Center', ' CENTRE ', 'right', 'justify', 'BOTH', 'distribute', 'start', '', null])
  await record('wordJustification', [value], () => xml.wordJustification(value));
const CELL_WITH_PARAGRAPHS =
  '<w:tc><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>a</w:t></w:r></w:p><w:p w:rsid="1"><w:r><w:t>b</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="X"/><w:jc w:val="right"/><w:jc w:val="center"/></w:pPr></w:p></w:tc>';
for (const justification of ['both', 'center', ''])
  await record('justifyWordParagraphs', [CELL_WITH_PARAGRAPHS, justification], () => xml.justifyWordParagraphs(CELL_WITH_PARAGRAPHS, justification));

// ---- whole tables --------------------------------------------------------------------------------------------------
const VALUES = [
  ['항목', '1분기', '2분기', '비고'],
  ['매출', '1,200', '1,350', '목표 초과'],
  ['비용', '800', '790', '  앞뒤 공백  '],
  ['합계', '400', '560', 'line one\r\nline two\nline three'],
];
const BIG = Array.from({ length: 9 }, (_, row) => [`행 ${row}`, `${row * 11}`, `${row * 3.5}%`]);
const OPERATIONS = [
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120] } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], columnAlignments: ['left', 'right', 'right', 'left'], totalRow: true } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80], rowHeights: [20, 0, 18.5] } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], fontName: 'Calibri', fontNameEastAsia: 'Malgun Gothic', fontSize: 10.5, color: '#333333', spacingAfter: 2, textStyle: 'No Spacing' } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], headerRows: 2, headerBold: false, repeatHeader: false } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], headerRows: 9, keepWithNext: true } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], rowStyles: [{ fontSize: 22, color: '#112233', bold: false }, { fontSize: 9 }, null, { bold: true }] } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], borders: { enabled: false } } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], borders: { top: { enabled: false }, left: { enabled: false }, bottom: { enabled: false }, right: { enabled: false }, insideH: { enabled: false }, insideV: { enabled: false } } } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], borders: { enabled: false }, shading: 'EEEEEE' } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120], borders: { enabled: false }, style: 'Table Grid' } },
  { values: BIG, properties: { columnWidths: [100, 50, 50], totalRow: true, keepWithNext: true } },
  { values: BIG, properties: { columnWidths: [100, 50, 50], columnAlignments: ['left', 'right', 'LEFT'] } },
  { values: BIG, properties: { columnWidths: [100, 50, 50], columnAlignments: ['left', 'right', 'justify'], borders: { enabled: false } } },
  { values: BIG, rows: 12, columns: 4, properties: { columnWidths: [100, 50, 50, 40] } },
  { values: BIG, rows: 3, columns: 2, properties: { columnWidths: [100, 50] } },
  { values: [['only']], properties: { columnWidths: [100] } },
  { values: [['a', 'b']], properties: { columnWidths: [100, 100], totalRow: true } },
  { rows: 2, columns: 2, properties: { columnWidths: [50, 50] } },
  { rows: 2, columns: 3 },
  { values: [['a', 'b'], ['c']], properties: { columnWidths: [50, 50] } },
  { values: [['', null, 0, false, 12.5, 'x<y & "z"']], properties: { columnWidths: [10, 10, 10, 10, 10, 10] } },
  { values: VALUES, properties: { columnWidths: [60, 80, 80, 120, 40] } },
  { values: VALUES, properties: { columnWidths: [60, 0, 80, 120] } },
  { values: VALUES, rows: 4, columns: 4, properties: { rowHeights: [14] } },
  { values: VALUES },
  { values: VALUES, properties: { fontName: 'Cambria', style: 'Table Grid', alignment: 'center', shading: '#F0F0F0' } },
  { values: [['a', 'b']], properties: { fontSize: 9 } },
  { values: [[]], properties: {} },
];
for (const operation of OPERATIONS)
  await record('wordTableXml', [operation, { available: 0 }], () => xml.wordTableXml(operation, { available: 0 }));
for (const [operation, available] of [[{ values: [[]] }, 400], [{ rows: 1, columns: 1 }, 400]])
  await record('wordTableXml', [operation, { available }], () => xml.wordTableXml(operation, { available }));
for (const [values, properties] of [[VALUES, {}], [[], {}], [[[]], {}], [null, {}]])
  await record('naturalTableColumnWidths', [values, properties, 0], () => xml.naturalTableColumnWidths(values, properties, 0));

// ---- the table readers ---------------------------------------------------------------------------------------------
const TABLES = OPERATIONS.slice(0, 6).map((operation) => xml.wordTableXml(operation, { available: 0 }));
const MERGED =
  '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="10"/><w:gridCol w:w="20"/></w:tblGrid><w:tr w:rsidR="1"><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>joined &amp; heading that runs long enough</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
const NO_GRID = '<w:tbl><w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>';
const EMPTY_TABLE = '<w:tbl/>';
const NESTED = `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/>${TABLES[0]}</w:tc></w:tr></w:tbl>`;
const READ = [...TABLES, MERGED, NO_GRID, EMPTY_TABLE, NESTED];
for (const table of READ) {
  await record('tableRowMatches', [table], () => matches(xml.tableRowMatches(table)));
  await record('rowCellMatches', [xml.tableRowMatches(table)[0]?.[0] ?? ''], () => matches(xml.rowCellMatches(xml.tableRowMatches(table)[0]?.[0] ?? '')));
}
for (const table of [TABLES[0], MERGED, NO_GRID]) {
  for (const [mode, index] of [['delete', 1], ['delete', 2], ['delete', 4], ['insert', 1], ['insert', 3], ['insert', 5], ['insert', 9], ['delete', 9]])
    await record('rewriteTableColumns', [table, index, mode], () => xml.rewriteTableColumns(table, index, mode));
}
await record('rewriteTableColumns', ['<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>', 1, 'delete'], () =>
  xml.rewriteTableColumns('<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>', 1, 'delete')
);
for (const table of [TABLES[0], TABLES[1], MERGED]) {
  await record('alignWordTableColumns', [table, ['right', '', 'justify', 'center', 'start']], () => xml.alignWordTableColumns(table, ['right', '', 'justify', 'center', 'start']));
  await record('alignWordTableColumns', [table, ['', '']], () => xml.alignWordTableColumns(table, ['', '']));
}

const BODY = doc(`${para(run('intro'))}${TABLES[0]}${para(run('between'))}${MERGED}${para(run('tail'))}${TABLES[2]}${para(run('end'))}`, SECTION);
const ODD_BODY = `${para(run('no body'))}${TABLES[0]}${MERGED}`;
for (const [current, number] of [[BODY, 1], [BODY, 2], [BODY, 3], [BODY, 4], [BODY, 0], [BODY, '2'], [BODY, 1.5], [BODY, null], [ODD_BODY, 2], [ODD_BODY, 3], [doc(para(run('x'))), 1],
  [doc(Array.from({ length: 8 }, (_, at) => TABLES[at % 3]).join('')), 9]])
  await record('docxTable', [current, number], () => {
    const table = xml.docxTable(current, number);
    return { index: table.index, xml: table[0] };
  });
for (const current of [BODY, ODD_BODY, doc('')])
  await record('docxTables', [current], () => matches(xml.docxTables(current)));
await record('replaceDocxTable', [BODY, 2, '<w:tbl>NEW</w:tbl>'], () => xml.replaceDocxTable(BODY, xml.docxTable(BODY, 2), '<w:tbl>NEW</w:tbl>'));

const ERROR_OPERATIONS = [
  { op: 'delete_table_row', table: 1, row: 9 },
  { op: 'insert_table_row', table: 2, row: 9 },
  { op: 'delete_table_row', table: 3, row: 0 },
  { op: 'delete_table_column', table: 1, column: 7 },
  { op: 'insert_table_column', table: 1, column: 8 },
  { op: 'insert_table_column', table: 1, column: 5 },
  { op: 'insert_table_column', table: 1, column: 1 },
  { op: 'delete_table_column', table: 2, column: 2 },
  { op: 'delete_table_column', table: 2, column: 1.5 },
  { op: 'delete_table_column', table: 2, column: '2' },
  { op: 'delete_table_column', table: 2, column: 'two' },
  { op: 'delete_table_column', table: 2 },
  { op: 'merge_table_cells', table: 1, row: 2, col: 3 },
  { op: 'set_table_cell', row: null, col: 'c' },
];
for (const table of [TABLES[0], MERGED, NO_GRID, EMPTY_TABLE]) {
  for (const op of ERROR_OPERATIONS) {
    await record('missingDocxRowError', [op, table], () => xml.missingDocxRowError(op, table).message);
    await record('checkDocxColumn', [op, table], () => xml.checkDocxColumn(op, table));
  }
}
for (const op of ERROR_OPERATIONS.slice(-3))
  await record('missingDocxCellError', [op, 2], () => xml.missingDocxCellError(op, [1, 2]).message);

// ---- section widths and block insertion -----------------------------------------------------------------------------
const TWO_SECTIONS = doc(`${para(run('a'))}<w:p><w:pPr>${LANDSCAPE}</w:pPr></w:p>${para(run('b'))}`, SECTION);
for (const [document, position] of [[BODY, 0], [BODY, BODY.length], [TWO_SECTIONS, 0], [TWO_SECTIONS, TWO_SECTIONS.indexOf('<w:p><w:pPr><w:sectPr') + 5], [TWO_SECTIONS, TWO_SECTIONS.indexOf('b</w:t>')], [doc(para(run('x'))), 0],
  ['<w:sectPr><w:pgMar w:left="100" w:right="200"/></w:sectPr>', 0], ['<w:sectPr><w:pgSz w:w="9000"/></w:sectPr>', 0]])
  await record('sectionTextWidth', [document, position], () => xml.sectionTextWidth(document, position));
const INSERT_BODY = doc(`${para(run('one'))}${para(run('two'))}${TABLES[0]}${para(run('three'))}`, SECTION);
for (const [document, block, number] of [[INSERT_BODY, para(run('NEW')), 0], [INSERT_BODY, para(run('NEW')), 1], [INSERT_BODY, TABLES[1], 2], [INSERT_BODY, para(run('NEW')), 3], [INSERT_BODY, para(run('NEW')), 4],
  [INSERT_BODY, para(run('NEW')), -1], [INSERT_BODY, para(run('NEW')), 1.5], [INSERT_BODY, para(run('NEW')), '2'], [INSERT_BODY, para(run('NEW')), null], ['<w:document/>', para(run('NEW')), 1], ['<w:document/>', para(run('NEW')), 0],
  [doc('<w:p/>'), para(run('NEW')), 0], [doc(`${TABLES[0]}<w:p/>`), para(run('NEW')), 0]])
  await record('insertDocxBlockAt', [document, block, number], () => xml.insertDocxBlockAt(document, block, number));

// ---- styles and properties ------------------------------------------------------------------------------------------
for (const name of ['heading 1', 'Heading 2', ' table grid ', 'List Paragraph', 'normal table', 'No Spacing', 'Intense Quote', 'Body Text', 'Caption  Text', '', null, '제목 1', 'heading 5'])
  await record('docxStyleId', [name], () => xml.docxStyleId(name));

const RUN_PROPERTIES = [
  '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic"/><w:b/><w:sz w:val="22"/>',
  '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:cs="Arial"/><w:color w:val="111111"/>',
  '<w:sz w:val="40"/><w:b/><w:rFonts w:ascii="X"/><w:lang w:val="ko-KR"/><w:custom/>',
  '<w:u w:val="single"/><w:i/><w:szCs w:val="9"/>',
  '',
];
const FONT_OVERRIDES = [
  { name: 'Georgia' },
  { nameEastAsia: 'Batang' },
  { name: 'A&B', nameEastAsia: '바탕', size: 11.25, color: '#abcdef' },
  { size: 0.2, color: 'XYZ' },
  { color: '123456' },
  {},
];
for (const existing of RUN_PROPERTIES) for (const overrides of FONT_OVERRIDES)
  await record('mergeWordRunFonts', [existing, overrides], () => xml.mergeWordRunFonts(existing, overrides));
const RUNS = [
  `${run('a')}${run('b', '<w:b/>')}`,
  '<w:r><w:rPr/><w:t>x</w:t></w:r><w:r w:rsidR="1"><w:rPr><w:i/><w:sz w:val="20"/></w:rPr><w:t>y</w:t></w:r><w:r><w:tab/></w:r>',
  '<w:p><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t>z</w:t></w:r></w:p>',
];
for (const fragment of RUNS) for (const format of ['<w:color w:val="FF0000"/><w:sz w:val="30"/>', '<w:b/>', ''])
  await record('applyWordRunFormat', [fragment, format], () => xml.applyWordRunFormat(fragment, format || undefined));

for (const [text, options] of [['plain', undefined], [' lead', undefined], ['trail ', {}], ['x', { preserve: true }], ['', undefined], ['a & b <c>', undefined], ['\tx', undefined], [' nb', undefined]])
  await record('wordTextElement', [text, options ?? null], () => xml.wordTextElement(text, options));
for (const [text, options] of [['no tab', undefined], ['a\tb', undefined], ['\ta\t\tb\t', undefined], [' a\t b ', { preserve: true }], ['', undefined], [null, undefined]])
  await record('wordTextContent', [text, options ?? null], () => xml.wordTextContent(text, options));
for (const properties of [
  {}, { name: 'Calibri' }, { nameEastAsia: '맑은 고딕' }, { name: 'A&B', nameEastAsia: 'X', bold: true, italic: false, underline: true, hidden: false, color: '#334455', size: 10.5 },
  { fontSize: 9 }, { size: null, fontSize: 12 }, { size: 0 }, { size: 0.1 }, { underline: false, hidden: true }, { bold: null }, { color: 'red' }, { size: 'big' },
])
  await record('wordRunProperties', [properties], () => xml.wordRunProperties(properties));
for (const [text, options] of [['plain', {}], ['제목', { alignment: 'Justify', style: 'Heading1', runProperties: '<w:b/>' }], [' x ', { alignment: 'nope' }], [null, {}], [12, { style: 'A&B' }], ['t', undefined]])
  await record('wordParagraph', [text, options ?? null], () => xml.wordParagraph(text, options));
for (const fragment of ['<w:tc><w:p><w:r><w:t>a</w:t></w:r><w:r><w:t xml:space="preserve"> b </w:t></w:r></w:p></w:tc>', '<w:t/>', '<w:p><w:t a="1">x</w:t><w:tab/></w:p>'])
  await record('blankTableCells', [fragment], () => xml.blankTableCells(fragment));
for (const [fragment, text] of [
  ['<w:r><w:rPr><w:b/></w:rPr><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r>', 'new'],
  ['<w:r><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r><w:r><w:t>three</w:t></w:r>', 'a\tb'],
  ['<w:r><w:t xml:space="preserve"> one </w:t></w:r>', ' lead & trail '],
  ['<w:r><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r>', ''],
  ['<w:r><w:t>one</w:t></w:r><w:r><w:t>two</w:t></w:r>', '\t'],
])
  await record('withFirstRunText', [fragment, text], () => xml.withFirstRunText(fragment, text));
for (const [xmlText, owner, tag, value] of [
  ['<w:tc><w:tcPr><w:tcW w:w="1"/></w:tcPr><w:p/></w:tc>', 'tc', 'tcPr', '<w:vAlign w:val="top"/>'],
  ['<w:tc w:id="3"><w:p/></w:tc>', 'tc', 'tcPr', '<w:vAlign w:val="top"/>'],
  ['<w:tc><w:tcPr w:x="1"></w:tcPr></w:tc>', 'tc', 'tcPr', 'V'],
  ['<w:p><w:r/></w:p>', 'p', 'pPr', '<w:jc w:val="left"/>'],
  ['<w:tcPr/>', 'tc', 'tcPr', 'V'],
])
  await record('replaceWordProperties', [xmlText, owner, tag, value], () => xml.replaceWordProperties(xmlText, owner, tag, value));

// ---- paragraph properties --------------------------------------------------------------------------------------------
const PARAGRAPH_PROPERTIES = [
  {}, { keepWithNext: true }, { keepWithNext: false, keepTogether: true, pageBreakBefore: false, widowControl: true },
  { border: { side: 'left', size: 12, color: '1F6F8B' }, shading: '#EEF2F7', indentLeft: 12, indentRight: 12, spacingAfter: 8, alignment: 'left' },
  { border: { side: 'top' } }, { border: { side: 'middle', style: 'solid', space: '' } }, { border: { side: 'right', space: 'x' } }, { border: { color: '#000000', size: 0, space: 3.5 } },
  { border: false }, { tabStops: [] }, { tabStops: [{ alignment: 'RIGHT', position: 432, leader: 'Dots' }, { alignment: 'weird', position: 72, leader: 'dash' }, { position: 0, leader: 'line' }, {}, { alignment: 'decimal', position: 10.5, leader: 'middleDot' }] },
  { tabStops: null }, { spacingBefore: 6 }, { spacingBefore: 6, spacingAfter: 0, lineSpacing: 14.7 }, { lineSpacing: 20, lineSpacingRule: 'EXACT' }, { lineSpacing: 0 }, { spacingAfter: -4 }, { spacingAfter: 'x' },
  { indentLeft: 36 }, { indentFirstLine: 10.5 }, { indentFirstLine: -18 }, { indentLeft: 10, indentRight: 5, indentFirstLine: 0 }, { indentLeft: -5 }, { indentFirstLine: 'z' },
  { alignment: 'justify' }, { alignment: 'Centre' }, { alignment: 'nothing' }, { shading: 'E0E0E0', alignment: 'right', widowControl: false },
];
const NUMBERING = [null, { level: 0, numId: 7 }, { level: 5, numId: 2 }, { level: -1, numId: 3 }, { level: '1', numId: 9 }, { level: 1.5, numId: 4 }];
for (const properties of PARAGRAPH_PROPERTIES) for (const numbering of NUMBERING.slice(0, properties.keepWithNext === true ? 6 : 2))
  await record('paragraphFormatXml', [properties, numbering], () => xml.paragraphFormatXml(properties, numbering));

// ---- formatting patches -----------------------------------------------------------------------------------------------
const PARAGRAPHS = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:keepNext/><w:pageBreakBefore/><w:tabs><w:tab w:val="right" w:pos="2000"/></w:tabs><w:spacing w:before="200" w:after="140"/><w:ind w:left="120"/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr>${run('Heading')}</w:p>`,
  `<w:p>${run('no properties')}</w:p>`,
  '<w:p w:rsidR="1"><w:pPr/><w:r/></w:p>',
  '<w:p><w:pPr><w:rPr><w:b/></w:rPr><w:jc w:val="left"/><w:ind w:left="720" w:firstLine="360"/></w:pPr></w:p>',
  '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/><w:foo/></w:pPr></w:p>',
  '<w:p/>',
  '<w:r/>',
  '<w:p w:x="1"/>',
];
const PATCHES = [
  { pageBreakBefore: false }, { spacingAfter: 8 }, { keepWithNext: true, alignment: 'center' }, { indentFirstLine: -18 }, { indentFirstLine: 18, indentLeft: 40 },
  { border: { side: 'left', size: 4 }, shading: 'EEEEEE' }, { tabStops: [{ alignment: 'right', position: 400 }] }, { lineSpacing: 18, lineSpacingRule: 'exact', spacingBefore: 3 }, {},
];
for (const paragraph of PARAGRAPHS) for (const patch of PATCHES)
  await record('patchParagraphFormat', [paragraph, patch, null], () => xml_patchParagraph(paragraph, patch, null));
for (const paragraph of PARAGRAPHS.slice(0, 4))
  await record('patchParagraphFormat', [paragraph, { keepTogether: true }, { level: 1, numId: 5 }], () => xml_patchParagraph(paragraph, { keepTogether: true }, { level: 1, numId: 5 }));
function xml_patchParagraph(paragraph, patch, numbering) {
  return formatting.patchParagraphFormat(paragraph, patch, numbering);
}

const STYLES = [
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>',
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>',
  '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:pPr/><w:rPr/></w:style>',
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders/></w:tblPr><w:tcPr/></w:style>',
  '<w:style w:type="paragraph" w:styleId="Plain"><w:name w:val="Plain"/></w:style>',
];
const STYLE_PATCHES = [
  { bold: true, spacingAfter: 6 }, { name: 'Georgia', nameEastAsia: '바탕', size: 14, color: '#112233' }, { alignment: 'center', italic: false, keepWithNext: true },
  { indentFirstLine: -12, lineSpacing: 15 }, { underline: true, hidden: false }, {},
];
for (const style of STYLES) for (const patch of STYLE_PATCHES)
  await record('patchWordStyle', [style, patch], () => formatting.patchWordStyle(style, patch));

const FIRST = (a, fonts = '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/>') => run(a, fonts);
const PHRASE_DOCS = [
  [`<w:document ${W}><w:body>${para(FIRST('아무것도 ', '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/><w:b/><w:sz w:val="66"/>'), FIRST('하지 않는 시간', '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/><w:color w:val="112233"/><w:sz w:val="66"/>'))}</w:body></w:document>`, '아무것도 하지 않는 시간', { size: 24 }],
  [para(FIRST('before target after target', '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/><w:b/>')), 'target', { bold: false, color: 'FF0000' }],
  [para(run('a'), '<w:r><w:tab/></w:r>', run('b')), 'ab', { size: 12 }],
  [para(run('Korean 한국어', '<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/>')), 'Korean 한국어', { name: 'Georgia' }],
  [para(run('abc'), run('def'), run('ghi')), 'cde', { italic: true }],
  [para(run('abc'), run('def'), run('ghi')), 'abcdefghi', { underline: true }],
  [para(run('abc')) + para(run('abc')), 'abc', { bold: true }],
  [para(run('xx')) + para(run('abc')), 'abc', { size: 9 }],
  [para(run('a😀b')), '😀', { bold: true }],
  [para(run('a😀b')), 'b', { bold: true }],
  [para(run('x &amp; y')), '& y', { color: '112233' }],
  [para(run('x &amp; y')), '&amp;', { color: '112233' }],
  [para(run('same'), run('same')), 'same', { bold: true }],
  [para(run('bold', '<w:b/>')), 'bold', { bold: true }],
  [para(run('bold', '<w:b w:val="1"/>')), 'bold', { bold: true }],
  [para(run('plain')), 'plain', { hidden: true, underline: false }],
  ['<w:p><w:r><w:t>spaced</w:t></w:r></w:p>', 'spaced', { size: 8 }],
  ['<w:p w:rsidR="2"><w:r w:rsidR="3"><w:rPr/><w:t>self</w:t></w:r></w:p>', 'self', { size: 8 }],
  [para(run('a'), '<w:r><w:br/></w:r>', run('b')), 'b', { size: 8 }],
  [para(run('one two')), 'one', {}],
  [para(run('one two')), '', { bold: true }],
  [para(run('one two')), 'two\0', { bold: true }],
  [para(run('one two')), 'missing', { bold: true }],
];
for (const [document, find, properties] of PHRASE_DOCS)
  await record('formatFirstBodyPhrase', [document, find, properties], () => formatting.formatFirstBodyPhrase(document, find, properties));

// ---- the style lookup -------------------------------------------------------------------------------------------------
const STYLE_ENTRY = (type, id, name, extra = '') => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const ENGLISH_STYLES = `<w:styles ${W}>${STYLE_ENTRY('paragraph', 'Normal', 'Normal')}${STYLE_ENTRY('paragraph', 'Heading1', 'heading 1')}${STYLE_ENTRY('table', 'TableNormal', 'Normal Table')}</w:styles>`;
const KOREAN_STYLES = `<w:styles ${W}>${STYLE_ENTRY('paragraph', 'a', 'Normal', '<w:qFormat/>')}${STYLE_ENTRY('table', 'a1', 'Normal Table')}${STYLE_ENTRY('paragraph', '1', 'heading 1', '<w:basedOn w:val="a"/>')}${STYLE_ENTRY('paragraph', 'a5', 'Quote')}${STYLE_ENTRY('paragraph', 'Custom_x0020_Note', 'Custom Note')}</w:styles>`;
const STYLE_CASES = [];
for (const [label, styleXml] of [['english', ENGLISH_STYLES], ['korean', KOREAN_STYLES], ['stock', wordPackage.wordStyles()], ['none', null], ['empty', '']])
  for (const [requested, type] of [
    ['heading 1', 'paragraph'], ['Heading1', 'paragraph'], ['Heading 1', 'paragraph'], ['1', 'paragraph'], ['Quote', 'paragraph'], ['a5', 'paragraph'], ['caption', 'paragraph'], ['Caption', 'paragraph'],
    ['Table Grid', 'table'], ['TableGrid', 'table'], ['table grid', 'paragraph'], ['Normal Table', 'table'], ['normal', 'paragraph'], ['List Paragraph', 'paragraph'], ['Custom Note', 'paragraph'],
    ['custom note', 'paragraph'], ['Custom_x0020_Note', 'paragraph'], ['No Such Style', 'paragraph'], ['  ', 'paragraph'], ['', 'table'], ['Title', 'paragraph'], ['Intense Quote', 'paragraph'], ['No Spacing', 'paragraph'],
  ]) {
    const files = styleXml === null ? {} : { 'word/styles.xml': styleXml };
    const zip = new JSZip();
    for (const [name, text] of Object.entries(files)) zip.file(name, text);
    const outcome = await attempt(async () => {
      const answer = await styles.documentStyleId(zip, requested, type);
      return { answer, styles: (await zip.file('word/styles.xml')?.async('string')) ?? null };
    });
    STYLE_CASES.push({ label, files, requested, type, ...outcome });
  }

writeJson(join(stage, 'golden.json'), { pure, styles: STYLE_CASES });
writeSetManifest(stage, { set: 'office-docx-xml', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
