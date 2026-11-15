#!/usr/bin/env node
// What the portable worksheet modules answer (src/runtime/office/portable: portable-sheet-styles, portable-sheet-xml,
// portable-xlsx-cell-values, portable-sheet-parts), run through Node. Rust `mixdog-ooxml` must answer the same: the
// styles.xml text and the style indices of cell/style write sequences, the worksheet and workbook XML text of the
// section, row, column and defined-name helpers, the cell labels, and the parts a worksheet owns
// (crates/mixdog-ooxml/tests/twin_sheet_xml.rs).
//
//   node benchmarks/rust-core/recorders/record-office-sheet-xml.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-sheet-xml/golden.json. The recording holds `pure` (a function name, its arguments
// and its result or error) and `sequences` (steps over one styles part, one package or one sheet: each step's output,
// then the final text).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-sheet-xml');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-sheet-xml.mjs';
const styles = await importFrom(tree, 'src/runtime/office/portable/portable-sheet-styles.mjs');
const sheet = await importFrom(tree, 'src/runtime/office/portable/portable-sheet-xml.mjs');
const values = await importFrom(tree, 'src/runtime/office/portable/portable-xlsx-cell-values.mjs');
const parts = await importFrom(tree, 'src/runtime/office/portable/portable-sheet-parts.mjs');
const opc = await importFrom(tree, 'src/runtime/office/portable/portable-opc.mjs');
const pkg = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const cells = await importFrom(tree, 'src/runtime/office/portable/portable-cells.mjs');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-sheet-xml-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const BLANK_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
// A part as Excel or LibreOffice writes it: numFmts, a theme font, fills with a solid colour, borders, wrapped and
// unlocked cells written with the words true/false, dxfs, an extLst.
const EXCEL_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;₩&quot;#,##0"/><numFmt numFmtId="170" formatCode="yyyy&quot;년&quot; m&quot;월&quot;"/></numFmts><fonts count="3"><font><sz val="11"/><color theme="1"/><name val="맑은 고딕"/><family val="2"/></font><font><b val="1"/><i val="true"/><sz val="14.5"/><color rgb="FF1F4E79"/><name val="Arial &amp; Co"/></font><font><b val="0"/><sz val="9"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right/><top style="double"><color auto="1"/></top><bottom style="none"/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="14" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment horizontal="center" vertical="top" wrapText="true" indent="2"/><protection locked="false"/></xf><xf numFmtId="170" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="9" fontId="2" fillId="2" borderId="0" xfId="0"><alignment wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="1"><dxf><font><color rgb="FFFF0000"/></font></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/><extLst><ext uri="{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}"/></extLst></styleSheet>';
const BARE_STYLES = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';
const SELF_CLOSED = '<styleSheet xmlns="x"><fonts/><fills count="0"/><cellXfs/></styleSheet>';

const WORKSHEET =
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="2" width="12" customWidth="1" hidden="1" style="3"/><col min="4" max="4" width="9.14"/></cols><sheetData><row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c><c r="C1" s="2"><f>SUM(B1:B2)</f><v>14</v></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2"><v>2</v></c></row><row r="4"/><row r="5"><c r="E5"/></row></sheetData><mergeCells count="2"><mergeCell ref="a1:b2"/><mergeCell ref="D4:E5"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';

// JSON holds neither NaN nor Infinity: a recorded argument that is one is the text `NaN` or `Infinity`, which Number() reads back.
const encode = (value) => (value === Infinity ? 'Infinity' : Number.isNaN(value) ? 'NaN' : value);
const decode = (value) => (value === 'Infinity' ? Infinity : value === 'NaN' ? NaN : value);
const PURE = [];
const pure = (fn, args, run) => PURE.push([fn, args, run]);

// ---- portable-sheet-styles
for (const value of ['#ff0000', 'ff0000', '0f0', '80112233', 'red', '', '  #AbC ', '#12345', 'FFFFFFFFF', 'ａｂｃ'])
  pure('normalizeColor', [value], (v) => styles.normalizeColor(v));
for (const value of [null, 0, 255, true, ['ab', 'cd', 'ef']]) pure('normalizeColor', [value], (v) => styles.normalizeColor(v));

const APPLY = [
  [BLANK_STYLES, 0, { bold: true }],
  [BLANK_STYLES, 0, { bold: true, italic: true, fontSize: 14, fontName: 'Arial & Co', color: '#336699' }],
  [BLANK_STYLES, 0, { fillColor: 'ffff00', numberFormat: '#,##0.00', horizontalAlignment: 'Centre', verticalAlignment: 'MIDDLE', wrapText: true }],
  [BLANK_STYLES, 0, { numberFormat: ' General ' }],
  [BLANK_STYLES, 0, { numberFormat: '"₩"#,##0' }],
  [BLANK_STYLES, 0, { numberFormat: 'yyyy-mm-dd', locked: false }],
  [BLANK_STYLES, 0, { indent: 3 }],
  [BLANK_STYLES, 0, { indent: 99, horizontalAlignment: 'right' }],
  [BLANK_STYLES, 0, { indent: -4, horizontalAlignment: 'justify' }],
  [BLANK_STYLES, 0, { indent: 2.6, horizontalAlignment: 'general' }],
  [BLANK_STYLES, 0, { horizontalAlignment: 'diagonal', verticalAlignment: 'sideways' }],
  [BLANK_STYLES, 0, { borders: { style: 'thin', color: '#000' } }],
  [BLANK_STYLES, 0, { borders: { top: { style: 'medium', color: 'ff0000' }, bottom: {}, left: 'thin', right: null } }],
  [BLANK_STYLES, 0, { borders: { top: { style: 'WAVY' } } }],
  [BLANK_STYLES, 0, { borders: { left: { enabled: false }, right: false, top: 'none', bottom: { style: 'none' } } }],
  [BLANK_STYLES, 0, { borders: 'thin' }],
  [BLANK_STYLES, 0, { borders: ['thin'] }],
  [BLANK_STYLES, 0, { fillColor: '' }],
  [BLANK_STYLES, 0, { color: '', bold: 1, italic: 'true', fontSize: 0, fontName: '' }],
  [BLANK_STYLES, 0, { fontSize: '12.5', wrapText: 'yes', locked: 0 }],
  [BLANK_STYLES, 7, { bold: true }],
  [BLANK_STYLES, -1, { bold: true }],
  [BLANK_STYLES, 1.5, { bold: true }],
  [BLANK_STYLES, 'x', { italic: true }],
  [BLANK_STYLES, 0, {}],
  [EXCEL_STYLES, 1, {}],
  [EXCEL_STYLES, 1, { bold: false, numberFormat: '"₩"#,##0' }],
  [EXCEL_STYLES, 1, { fillColor: '' }],
  [EXCEL_STYLES, 1, { borders: { left: 'none', bottom: { style: 'dashed' } } }],
  [EXCEL_STYLES, 2, { locked: true, wrapText: false }],
  [EXCEL_STYLES, 2, { numberFormat: 'yyyy"년" m"월"' }],
  [EXCEL_STYLES, 2, { numberFormat: '0.0%' }],
  [EXCEL_STYLES, 3, { color: '#fff' }],
  [EXCEL_STYLES, 4, { indent: 1 }],
  [EXCEL_STYLES, 4, {}],
  [EXCEL_STYLES, 0, { numberFormat: '@' }],
  [EXCEL_STYLES, 99, { bold: true }],
  [BARE_STYLES, 0, { bold: true }],
  [BARE_STYLES, 0, { numberFormat: '0.0', fillColor: 'abc', borders: { bottom: { style: 'thin' } } }],
  [SELF_CLOSED, 0, { italic: true, numberFormat: '0%' }],
  ['<x/>', 0, {}],
  ['', 0, { bold: true }],
];
for (const args of APPLY) pure('applyCellStyle', args, (xml, base, props) => styles.applyCellStyle(xml, base, props));
for (const xml of [BLANK_STYLES, EXCEL_STYLES, BARE_STYLES, SELF_CLOSED, '', '<x/>'])
  pure('resolveCellStyles', [xml], (v) => styles.resolveCellStyles(v));
for (const code of ['General', ' general ', '', '"₩"#,##0', ' "₩"#,##0 ', 'yyyy"년" m"월"', '0.0', 'GENERAL']) {
  pure('numberFormatId', [EXCEL_STYLES, code], (xml, c) => styles.numberFormatId(xml, c));
  pure('numberFormatId', [BLANK_STYLES, code], (xml, c) => styles.numberFormatId(xml, c));
}
for (const index of [0, 1, 2, 3, 4, 5, 99, -1, 'x', 1.5, null])
  pure('styleHasNumberFormat', [EXCEL_STYLES, index], (xml, i) => styles.styleHasNumberFormat(xml, i));
for (const code of ['General', 'g/표준', 'G/標準', 'Standard', 'STANDAARD', 'Général', 'estándar', 'padrão', '', 'Общий', '常规', '通用格式', '0.00', 'Generalx'])
  pure('isGeneralNumberFormat', [code], (c) => styles.GENERAL_NUMBER_FORMAT.test(c));
for (const style of [
  { color: 255, fillColor: 16777215, numberFormat: 'General', bold: true, italic: false, fontSize: 9 },
  { color: 0, fillColor: 65280, numberFormat: ' 0.00 ', bold: false, italic: true, extra: 'kept' },
  { color: '#ff0000', fillColor: 'FFFFFF', numberFormat: 'G/표준' },
  { color: 'abc', fillColor: 'ffff00ff', numberFormat: '@', zebra: [1, 2] },
  { color: -5, fillColor: 1.4, numberFormat: 'x' },
  { color: 4294967295, fillColor: 16777216 },
  { color: 5000000000, fillColor: 0 },
  { color: null, fillColor: undefined, numberFormat: null },
  {},
  null,
  7,
  'text',
]) pure('normalizeExcelCellStyle', [style], (s) => styles.normalizeExcelCellStyle(s));

// ---- portable-sheet-xml
for (const value of ['허브 실적!', '2024 sales', 'A1', 'R', 'abc12345678', 'ab1', 'Sales_2024', '!!!', '', '  ', 'a b\tc', '.x', 'a'.repeat(300), '가'.repeat(300), 'x😀y', '_ok.name', 'Rc'])
  pure('safeWorkbookTableName', [value], (v) => sheet.safeWorkbookTableName(v));
for (const value of ['Tax Rate', 'A1', '$A$1', 'R', 'RC', 'c', 'ABC123', 'ABCD1', '1abc', '\\ok', 'a-b+c', 'a-b-c', '', '   ', 'a'.repeat(256), '가'.repeat(256), 'rate_2.x', 'x y z', 'İ', 'a😀b', 'a b', '_', 'name!'])
  pure('workbookDefinedNameFault', [value], (v) => sheet.workbookDefinedNameFault(v));
const match = (m) => (m ? { index: m.index, text: m[0] } : null);
for (const [xml, name] of [
  [WORKSHEET, 'mergeCells'], [WORKSHEET, 'sheetData'], [WORKSHEET, 'cols'], [WORKSHEET, 'col'], [WORKSHEET, 'drawing'],
  ['<worksheet><sheetData/><x:sheetData/></worksheet>', 'sheetData'],
]) pure('worksheetSection', [xml, name], (x, n) => match(sheet.worksheetSection(x, n)));
for (const [xml, name, element] of [
  ['<worksheet><sheetData/><pageMargins/></worksheet>', 'mergeCells', '<mergeCells count="1"/>'],
  ['<worksheet><sheetData/><pageMargins/></worksheet>', 'pageMargins', ''],
  ['<worksheet><sheetData/><pageMargins/></worksheet>', 'pageMargins', '<pageMargins left="1"/>'],
  ['<worksheet><sheetData/><pageMargins/></worksheet>', 'tableParts', '<tableParts/>'],
  ['<worksheet><sheetData/></worksheet>\n', 'extLst', '<extLst/>'],
  ['<worksheet><sheetData/></worksheet>', 'unknownSection', '<unknownSection/>'],
  ['<worksheet><sheetData/><pageMargins/></worksheet>', 'unknownSection', '<unknownSection/>'],
  ['<worksheet></worksheet>', 'sheetPr', '<sheetPr/>'],
  ['<worksheet/>', 'sheetPr', '<sheetPr/>'],
  [WORKSHEET, 'drawing', '<drawing r:id="rId1"/>'],
  [WORKSHEET, 'cols', ''],
  [WORKSHEET, 'dimension', '<dimension ref="A1:E5"/>'],
  [WORKSHEET, 'conditionalFormatting', '<conditionalFormatting sqref="A1"/>'],
  ['<worksheet><dataValidations/><hyperlinks/></worksheet>', 'dataValidations', '<dataValidations count="1"/>'],
]) pure('upsertWorksheetSection', [xml, name, element], (x, n, e) => sheet.upsertWorksheetSection(x, n, e));
pure('mergedRanges', [WORKSHEET], (x) => sheet.mergedRanges(x));
pure('mergedRanges', ['<worksheet/>'], (x) => sheet.mergedRanges(x));
pure('mergedRanges', ['<worksheet><mergeCells count="1"><mergeCell ref="a1"/><mergeCell x="1" ref="b2:c3" y="2"/></mergeCells></worksheet>'], (x) => sheet.mergedRanges(x));
pure('writeMergedRanges', [WORKSHEET, ['A1:B2', 'A1:B2', 'D4:E5']], (x, r) => sheet.writeMergedRanges(x, r));
pure('writeMergedRanges', [WORKSHEET, []], (x, r) => sheet.writeMergedRanges(x, r));
pure('writeMergedRanges', ['<worksheet><sheetData/></worksheet>', ['a1:b2']], (x, r) => sheet.writeMergedRanges(x, r));
for (const [from, count] of [[2, 1], [2, -1], [1, 2], [1, -3], [3, -5], [10, 4], [1, -10], [2, 0]])
  pure('shiftWorksheetRows', [WORKSHEET, from, count], (x, f, c) => sheet.shiftWorksheetRows(x, f, c));
pure('shiftWorksheetRows', ['<worksheet/>', 1, 1], (x, f, c) => sheet.shiftWorksheetRows(x, f, c));
pure('shiftWorksheetRows', ['<worksheet><sheetData/></worksheet>', 1, 1], (x, f, c) => sheet.shiftWorksheetRows(x, f, c));
for (const [from, count] of [[1, 1], [2, 1], [2, -1], [1, -2], [3, -5], [5, 3], [1, 0]])
  pure('shiftWorksheetColumns', [WORKSHEET, from, count], (x, f, c) => sheet.shiftWorksheetColumns(x, f, c));
pure('shiftWorksheetColumns', ['<worksheet/>', 1, 1], (x, f, c) => sheet.shiftWorksheetColumns(x, f, c));
pure('shiftWorksheetColumns', ['<worksheet><sheetData><row r="1"><c r="A0"/></row></sheetData></worksheet>', 1, 1], (x, f, c) => sheet.shiftWorksheetColumns(x, f, c));
pure('shiftWorksheetColumns', ['<worksheet><sheetData><row r="1"><c/><c r="a1"/></row></sheetData></worksheet>', 1, 1], (x, f, c) => sheet.shiftWorksheetColumns(x, f, c));
for (const [xml, name, element] of [
  ['<worksheet><hyperlinks><hyperlink/></hyperlinks><hyperlinks/></worksheet>', 'hyperlinks', '<hyperlinks x="1"/>'],
  ['<worksheet><sheetData/><pageMargins/></worksheet>', 'hyperlinks', '<hyperlinks/>'],
  ['<worksheet><sheetData/></worksheet>', 'sheetData', '<sheetData/>'],
]) pure('appendWorksheetSection', [xml, name, element], (x, n, e) => sheet.appendWorksheetSection(x, n, e));
for (const [kind, options, priority] of [
  ['colorScale', {}, undefined], ['colorScale', { minColor: '#fff', midColor: '00ff00', maxColor: 'abc' }, 2],
  ['colorScale', { minColor: 'bad', midColor: 'bad' }, 5], ['dataBar', {}, undefined], ['dataBar', { color: '#336699' }, 3],
  ['dataBar', { fillColor: 'aabbcc' }, 1], ['dataBar', { color: 'bad', fillColor: 'aabbcc' }, 1], ['dataBar', { color: '', fillColor: 'aabbcc' }, 1],
  ['other', { minColor: '111' }, 1],
]) pure('conditionalScaleRule', [kind, options, priority], (k, o, p) => (p === undefined ? sheet.conditionalScaleRule(k, o) : sheet.conditionalScaleRule(k, o, p)));
for (const [xml, options] of [
  ['<styleSheet><cellStyles count="0"/></styleSheet>', { color: 'ff0000' }],
  ['<styleSheet><cellStyles count="0"/></styleSheet>', { color: 'ff0000', fillColor: '00ff00' }],
  ['<styleSheet><cellStyles count="0"/></styleSheet>', {}],
  ['<styleSheet><dxfs count="1"><dxf><font><color rgb="FFFF0000"/></font></dxf></dxfs></styleSheet>', { color: 'ff0000' }],
  ['<styleSheet><dxfs count="1"><dxf><font><color rgb="FFFF0000"/></font></dxf></dxfs></styleSheet>', { fillColor: '#abc' }],
  ['<styleSheet><dxfs count="0"/></styleSheet>', { fillColor: '#abc' }],
  ['<styleSheet><dxfs/></styleSheet>', { color: 'bad' }],
  ['<styleSheet></styleSheet>', { color: '123' }],
  [EXCEL_STYLES, { color: 'ff0000' }],
  [EXCEL_STYLES, { fillColor: 'ff0000', color: '00ff00' }],
  ['<x/>', { color: 'ff0000' }],
]) pure('appendDifferentialFormat', [xml, options], (x, o) => sheet.appendDifferentialFormat(x, o));
const MERGED = '<worksheet><mergeCells count="2"><mergeCell ref="a1:b2"/><mergeCell ref="D4:E5"/></mergeCells></worksheet>';
for (const ref of ['A1', 'B1', 'a2', 'B2', 'C3', 'D4', 'E5', 'F9', 'bad', 'A0'])
  pure('mergedCellAnchor', [MERGED, ref], (x, r) => sheet.mergedCellAnchor(x, r));
pure('mergedCellAnchor', ['<worksheet><mergeCells><mergeCell ref="A:B"/></mergeCells></worksheet>', 'A1'], (x, r) => sheet.mergedCellAnchor(x, r));
for (const view of ['<sheetView workbookViewId="0"><pane/><selection/></sheetView>', '<sheetView workbookViewId="0"/>', '<x/>', '<sheetView>', '<sheetView a="1">가</sheetView>', '<sheetView a="1">unclosed'])
  pure('sheetViewParts', [view], (v) => sheet.sheetViewParts(v));
pure('composeSheetView', [' a="1"', '<pane/>'], (a, b) => sheet.composeSheetView(a, b));
pure('composeSheetView', [' a="1"', ''], (a, b) => sheet.composeSheetView(a, b));
// `mutate` is described, not passed: { replace: [from, to] } rewrites the view text; { parts: true } cuts and recomposes.
const mutator = (spec) => (view) => {
  if (spec.parts) {
    const { attrs, body } = sheet.sheetViewParts(view);
    return sheet.composeSheetView(`${attrs} showGridLines="0"`, `${body}<pane/>`);
  }
  return view.replace(spec.replace[0], spec.replace[1]);
};
for (const [xml, spec] of [
  ['<worksheet><sheetData/></worksheet>', { replace: ['/>', ' showGridLines="0"/>'] }],
  [WORKSHEET, { parts: true }],
  ['<worksheet><sheetViews><sheetView a="1"><x/></sheetView><sheetView b="2"/></sheetViews><sheetData/></worksheet>', { parts: true }],
  ['<worksheet><sheetViews/><sheetData/></worksheet>', { replace: ['0', '9'] }],
  ['<worksheet><sheetData/></worksheet>', { parts: true }],
]) pure('updateSheetView', [xml, spec], (x, s) => sheet.updateSheetView(x, mutator(s)));
for (const [row, column] of [[1, 1], [2, 1], [1, 2], [3, 4], [0, 0], ['x', 5], [-3, 2], [2.5, 1], [null, undefined], [27, 28]])
  pure('freezePaneXml', [row, column], (r, c) => sheet.freezePaneXml(r, c));
for (const range of ['A1', ' b2:d5 ', 'D5:B2', 'A:C', 'c:a', '2:5', '5:2', 'aa10:ab11', 'Sheet1!A1:B2', "'My Sheet'!A1", 'nope', '', 'A1:', ':B2', 'A0:B2', 'A1:B0', '$A$1', 'XFD1048576', '1:1', 'ａ1'])
  pure('parseAreaRange', [range], (r) => sheet.parseAreaRange(r));
for (const area of [{ startCol: 1, endCol: 4, startRow: 1, endRow: 5 }, { startCol: 27, endCol: 28, startRow: 10, endRow: 10 }, { startCol: 0, endCol: 0, startRow: 0, endRow: 0 }])
  pure('areaReference', [area], (a) => sheet.areaReference(a));
for (const text of ['', 'abc', '가나다', 'ｆｕｌｌ', 'ab⺀cd', '😀', 'aᄀb', '힣', '힤', '￦', '￧', '｠｡', '⹿', '꓏ꓐ', '︰﹯ﹰ', 'x\u0000y'])
  pure('displayWidth', [text], (t) => sheet.displayWidth(t));
pure('displayWidth', [null], (t) => sheet.displayWidth(t));
for (const [style, base, isDefault] of [
  [{ fontSize: 22, bold: true }, 11, false], [{ fontSize: 22, bold: true }, 11, true], [{ bold: true }, 11, false], [{ fontSize: '14' }, 11, false],
  [null, 11, false], [undefined, 10, false], [{ fontSize: 0 }, 12, false], [{ fontSize: 'x', bold: 1 }, 12, false], [{ fontSize: 9.5 }, 11, false],
]) pure('cellWidthScale', [style ?? null, base, isDefault], (s, b, d) => sheet.cellWidthScale(s ?? undefined, b, { isDefault: d }));
const WIDTHS = [
  [1234.5, '#,##0.00'], [0.5, '0%'], [-5, '0'], [-5, '0;(0)'], [-5, '0;-0;"zero"'], [0, '0;-0;"zero"'], [0, '0;-0;'], [1234, '#,##0"원"'],
  [1234567.891, '#,##0.00_);(#,##0.00)'], [1234567.891, '[$₩-412]#,##0'], [1234567.891, '[Red]#,##0'], [46174, 'yyyy-mm-dd'],
  [46174, 'yyyy"년" mm"월" dd"일"'], [46174, 'mmmm d, yyyy'], [46174, 'h:mm AM/PM'], [46174, 'dddd'], [46174, 'a/p h'], [1234.5, 'General'], [1234.5, ' general '],
  [1234.5, ''], [1234.5, '@'], [0.5700000000000001, ''], [123456789012, ''], [1e-10, ''], [-1e-10, ''], [0.000001234, ''], [123456.789012345, ''],
  [-123456.789012345, ''], [99999999999, ''], [-99999999999, ''], [1e21, ''], [123456500000, ''], [0.1 + 0.2, ''], [12345678901, ''], [0.00012345678912, ''],
  [1500000, '0.0,,"M"'], [1500000, '#,##0,'], [1500000, '0,'], [12.5, '# ?/?'], [12.5, '0.00E+00'], [1234, '0\\ "won"'], [1234, '"a;b"0'],
  [1234, '0;"x;y"'], [1234, '*-0'], [1234, '#,##0,;'], [-1234, '#,##0;[Red]-#,##0'], [12345678, '000000000'], [0.5, '0.000%'], [0.5, '0%%'],
  [3, '0 "units"'], [1234567, '#,###'], [1234567, '#,##0.0'], [1234567, '0.00,'], [1e22, '0'], [99.995, '0.00'], [0.5, '.00'], [5, '"ab'], [5, '\\'], [5, '[$USD'],
  [5, '[h]:mm'], [5, 'yy-mm-dd;@'], [5, '"y"0'], [5, '0\\y'], [5, "0'y"], [5, 'm/d/yyyy h:mm'],
  ['12', '0'], ['abc', '0'], [null, '0'], [true, '0'], [[], '0'], [{}, '0'], [Infinity, '0'], [NaN, '0'],
];
for (const [value, format] of WIDTHS) pure('formattedNumberWidth', [encode(value), format], (v, f) => sheet.formattedNumberWidth(decode(v), f));
pure('formattedNumberWidth', [{ undefined: true }, '0'], (_v, f) => sheet.formattedNumberWidth(undefined, f));
pure('formattedNumberWidth', [{ undefined: true }, ''], (_v, f) => sheet.formattedNumberWidth(undefined, f));
const widths = (list) => new Map(list);
pure('writeColumnWidths', [WORKSHEET, [[2, 12.5], [4, 8], [6, 20.25]]], (x, w) => sheet.writeColumnWidths(x, widths(w)));
pure('writeColumnWidths', [WORKSHEET, [[1, 30]]], (x, w) => sheet.writeColumnWidths(x, widths(w)));
pure('writeColumnWidths', [WORKSHEET, []], (x, w) => sheet.writeColumnWidths(x, widths(w)));
pure('writeColumnWidths', ['<worksheet><sheetData/></worksheet>', [[3, 7.5], [1, 11]]], (x, w) => sheet.writeColumnWidths(x, widths(w)));
pure('writeColumnWidths', ['<worksheet><cols><col min="1" max="3000" width="5"/></cols><sheetData/></worksheet>', [[2, 6]]], (x, w) => sheet.writeColumnWidths(x, widths(w)));
pure('writeColumnWidths', ['<worksheet><cols><col max="2" width="5"/><col min="0" max="1"/></cols><sheetData/></worksheet>', [[2, 6]]], (x, w) => sheet.writeColumnWidths(x, widths(w)));
const asLists = (hidden) => ({ rows: [...hidden.rows].sort((a, b) => a - b), columns: [...hidden.columns].sort((a, b) => a - b) });
for (const xml of [WORKSHEET, '<worksheet/>', '', '<worksheet><cols><col min="3" max="2" hidden="true"/><col min="5" hidden="1"/><col max="9" hidden="1"/><col min="7" max="9" hidden="0"/></cols><sheetData><row r="3" hidden="1"><c r="A3"/></row><row hidden="1"/><row r="x" hidden="true"/><row r="9" hidden="false"/></sheetData></worksheet>', '<worksheet><cols><col min="1" max="5000" hidden="1"/></cols></worksheet>'])
  pure('hiddenSheetAreas', [xml], (x) => asLists(sheet.hiddenSheetAreas(x)));
for (const [xml, columns, visible] of [
  [WORKSHEET, [1], true], [WORKSHEET, [2, 3], false], [WORKSHEET, [4], false], [WORKSHEET, [4], true], [WORKSHEET, [], true],
  ['<worksheet><sheetData/></worksheet>', [3], false], ['<worksheet><sheetData/></worksheet>', [3, 1], true],
]) pure('writeColumnVisibility', [xml, columns, visible], (x, c, v) => sheet.writeColumnVisibility(x, c, v));
for (const name of ['Sheet1', 'Data_1', '_x', 'a.b', 'Data 1', '월별', "it's", '1abc', '', 'a-b', "''"]) pure('quoteSheetName', [name], (n) => sheet.quoteSheetName(n));
for (const range of ["'월별 계산'!A1:A7", "'월별, 계산'!$A$1:$A$7, B2:B3,Data!C1", 'A1:B2', 'Data!$A$1:$B$2', "'It''s'!A1", "'a'!b'c'!D1", ' Sheet 1 !A1', '', ',', "'x,y'!A1,'z'!B1", '!A1', 'S!', 'a!b!c', "'unclosed,A1", null, 12])
  pure('sheetQualifiedAreas', [range], (r) => sheet.sheetQualifiedAreas(r));
for (const range of ['A1', 'a1:B2', 'A1:B2:C3', '$A$1:B2', 'A:B', '1:2', 'Sheet1!A1', '', 'AB12:cd34', 'A1:']) pure('absoluteRange', [range], (r) => sheet.absoluteRange(r));
const WORKBOOK = '<workbook><sheets><sheet name="S"/></sheets><definedNames><definedName name="Rate">0.1</definedName><definedName name="Total" localSheetId="0"/></definedNames><calcPr calcId="1"/></workbook>';
const predicate = (spec) => (item) => (spec.contains ? item.includes(spec.contains) : spec.always === true);
for (const [xml, entry, spec] of [
  [WORKBOOK, '<definedName name="New">1</definedName>', { contains: 'Rate' }],
  [WORKBOOK, '<definedName name="Rate">0.2</definedName>', { contains: '"Rate"' }],
  [WORKBOOK, null, { contains: '"Rate"' }],
  [WORKBOOK, null, { always: true }],
  [WORKBOOK, '', { always: true }],
  [WORKBOOK, '<definedName name="X">1</definedName>', { always: true }],
  ['<workbook><sheets/><calcPr/></workbook>', '<definedName name="New">1</definedName>', { always: false }],
  ['<workbook><sheets/></workbook>\n', '<definedName name="New">1</definedName>', { always: false }],
  ['<workbook><sheets/></workbook>', null, { always: false }],
  ['<workbook><sheets/><definedNames/></workbook>', '<definedName name="A">1</definedName>', { always: false }],
  ['<workbook><sheets/><definedNames/></workbook>', null, { always: false }],
  ['<workbook/>', '<definedName name="A">1</definedName>', { always: false }],
]) pure('upsertDefinedName', [xml, entry, spec], (x, e, s) => sheet.upsertDefinedName(x, e, predicate(s)));

// ---- portable-xlsx-cell-values
for (const [serial, code] of [
  [46174, 'm"월"'], [46174, 'yyyy-mm'], [46174, 'yyyy-mm-dd'], [46174, 'mmm yy'], [46174, '#,##0'], [46174, '0"분"'], [46174, 'h:mm'],
  [46174, 'mmmm d, yyyy'], [46174, 'dd/mm/yy'], [46174, 'd'], [46174, 'D-M-YY'], [46174, 'yyyy;@'], [46174, '[$-409]yyyy'], [46174, 'yyyy\\-mm\\-dd'],
  [46174, '"y"yyyy'], [46174, '\\y yyyy'], [46174, 'yyy'], [46174, 'y'], [46174, 'mmmmm'], [46174, 'ddd'], [46174, 'dddd'], [46174, '"unclosed yyyy'],
  [46174, 'yyyy\\'], [46174, '"d"'], [46174, '\\d'], [46174, ''], [46174, 'General'], [46174, 'yyyy-mm-dd hh:mm'], [46174, 'yyyy"s"'],
  [1, 'yyyy-mm-dd'], [0, 'yyyy-mm-dd'], [-1, 'yyyy-mm-dd'], [59, 'yyyy-mm-dd'], [60, 'yyyy-mm-dd'], [61, 'yyyy-mm-dd'], [45000.75, 'yyyy-mm-dd'],
  [45000.99999999, 'yyyy-mm-dd'], [45000.5, 'd'], [-100000, 'yyyy-mm-dd'], [2958465, 'yyyy-mm-dd'], [2958466, 'mmmm yyyy'], [100000000, 'yyyy-mm-dd'],
  [-100000000, 'yyyy mm dd'], [99999999, 'yyyy-mm-dd'], [100000001, 'yyyy'], [1e12, 'yyyy'], [1e12, '"x"y'], [1e12, 'mmm'], [-1e12, 'dd'],
  ['46174', 'yyyy-mm-dd'], [null, 'yyyy'], [true, 'yyyy'], [NaN, 'yyyy'], [Infinity, 'yyyy'], [46174.5, 'mm/dd'], [46174, 'D'],
  [-693594, 'yyyy-mm-dd'], [-693960, 'yyyy yy'], [-2209161600000 / 86400000 - 1, 'yyyy'], [3e7, 'yyyy yy m'], [1.5e8, 'yy'],
]) pure('formattedDateText', [encode(serial), code], (s, c) => values.formattedDateText(decode(s), c));

// ---- portable-sheet-parts
for (const password of ['', 'a', 'password', 'Password', '가', '😀x', 'abc123', 'a'.repeat(15), 'a'.repeat(40), '\u0000', 'x y', null, undefined, 12345, '한글 비밀번호'])
  pure('excelPasswordHash', [password === undefined ? { undefined: true } : password], (p) => parts.excelPasswordHash(p && p.undefined === true ? undefined : p));

const pureOut = [];
for (const [fn, args, run] of PURE) pureOut.push({ fn, args, ...(await attempt(() => run(...args))) });

// ---- sequences
const sequences = [];

// styles: each step threads the styles part
const STYLE_SEQUENCES = [
  { name: 'blank styles merged twice', start: BLANK_STYLES, steps: [
    [0, { bold: true, numberFormat: '#,##0.0' }], [0, { bold: true, numberFormat: '#,##0.0' }], [1, { numberFormat: '0%' }], [1, { numberFormat: '#,##0.0' }],
    [2, { fillColor: '#ffff00' }], [3, { fillColor: '#ffff00' }], [1, { bold: false }], [0, { fillColor: 'ffff00' }], [5, { borders: { bottom: { style: 'thin' } } }],
    [6, { borders: { bottom: { style: 'thin' } } }], [0, { borders: { bottom: { style: 'thin' } } }], [7, { borders: { bottom: 'none' } }], [7, { numberFormat: 'General' }],
  ] },
  { name: 'a workbook written by Excel', start: EXCEL_STYLES, steps: [
    [1, { bold: true }], [1, {}], [2, {}], [2, { numberFormat: '"₩"#,##0' }], [3, { italic: true, fontSize: 12 }], [4, { locked: false }], [4, { fillColor: '' }],
    [5, { fillColor: 'ff0000' }], [6, { numberFormat: '0.00' }], [6, { numberFormat: '0.000' }], [7, { numberFormat: '0.00' }], [8, { numberFormat: 'yyyy"년" m"월"' }],
  ] },
  { name: 'number formats are numbered from 164', start: BLANK_STYLES, steps: [
    [0, { numberFormat: 'a' }], [0, { numberFormat: 'b' }], [0, { numberFormat: ' a ' }], [0, { numberFormat: 'c<d>&"e"' }], [1, { numberFormat: 'A' }], [0, { numberFormat: 'general' }], [0, { numberFormat: '  ' }],
  ] },
  { name: 'a failing step leaves the part as it was', start: BLANK_STYLES, steps: [
    [0, { bold: true }], [1, { borders: { top: { style: 'wavy' } } }], [1, { italic: true }],
  ] },
  { name: 'a part with no root', start: '<x/>', steps: [[0, { bold: true }], [0, {}]] },
];
for (const sequence of STYLE_SEQUENCES) {
  let xml = sequence.start;
  const outputs = [];
  for (const [base, props] of sequence.steps) {
    const out = await attempt(() => styles.applyCellStyle(xml, base, props));
    if (out.result) xml = out.result.xml;
    outputs.push(out.error !== undefined ? out : { result: { index: out.result.index } });
  }
  sequences.push({ name: sequence.name, kind: 'styles', start: sequence.start, steps: sequence.steps.map(([base, props]) => ({ op: 'apply', base, props })), outputs, final: xml, resolved: styles.resolveCellStyles(xml) });
}

// a package: drawing and notes, then the labels of a sheet with dates
const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const partsOut = {};
  for (const name of names) if (!zip.files[name].dir) partsOut[name] = await opc.zipText(zip, name);
  return { names, parts: partsOut };
};
const DOLLARS = "math $$x$$ cost $& and $' or $` then $1";
const runPartsStep = async (state, step) => {
  switch (step.op) {
    case 'create': {
      const path = join(work, `created-${state.n}.xlsx`);
      await pkg.createPortableOoxmlDocument(path, { fileKind: 'xlsx', title: 't', sheetName: 'Data' });
      state.zip = await opc.loadPackage(path);
      state.sheet = (await cells.workbookSheets(state.zip))[0];
      state.xml = await opc.zipText(state.zip, state.sheet.path);
      return { sheet: state.sheet };
    }
    case 'drawing': {
      const made = await parts.ensureWorksheetDrawing(state.zip, state.sheet, state.xml);
      state.xml = made.worksheet;
      return made;
    }
    case 'note': {
      const made = await parts.writeWorksheetNote(state.zip, state.sheet, state.xml, step.request);
      state.xml = made.worksheet;
      return { ...made, changed: made.changed === true };
    }
    case 'setSheet':
      state.xml = step.xml;
      return null;
    case 'set':
      state.zip.file(step.name, step.text);
      return null;
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};
const PART_SEQUENCES = [
  { name: 'a drawing is made once', steps: [{ op: 'create' }, { op: 'drawing' }, { op: 'drawing' }] },
  { name: 'a drawing that exists already is found', steps: [
    { op: 'create' },
    { op: 'set', name: 'xl/worksheets/_rels/sheet1.xml.rels', text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing7.xml"/></Relationships>' },
    { op: 'drawing' },
    { op: 'set', name: 'xl/drawings/drawing1.xml', text: '<x/>' },
  ] },
  { name: 'the next free drawing number', steps: [{ op: 'create' }, { op: 'set', name: 'xl/drawings/drawing1.xml', text: '<x/>' }, { op: 'set', name: 'xl/drawings/drawing2.xml', text: '<x/>' }, { op: 'drawing' }] },
  { name: 'notes: create, replace, append, repeat', steps: [
    { op: 'create' },
    { op: 'note', request: { cell: 'b2', text: DOLLARS } },
    { op: 'note', request: { cell: 'B2', text: 'second', author: 'Ann', append: true } },
    { op: 'note', request: { cell: 'B2', text: 'second', append: true } },
    { op: 'note', request: { cell: 'C10', text: 'a <b> & "c"\nline 2' } },
    { op: 'note', request: { cell: 'B2', text: 'replaced', author: 'Bob' } },
    { op: 'note', request: { cell: 'AA100', text: '가나다', author: 'Ann' } },
    { op: 'note', request: { cell: '0', text: 'x' } },
    { op: 'note', request: { cell: 'A1', text: 'trim ', author: 'Mixdog', append: true } },
    { op: 'note', request: { cell: 'A1', text: 'trim ', author: 'Mixdog', append: true } },
  ] },
  { name: 'notes beside a drawing and an existing comments part', steps: [
    { op: 'create' },
    { op: 'drawing' },
    { op: 'set', name: 'xl/comments1.xml', text: '<?xml version="1.0"?><comments xmlns="x"><authors><author>Zed</author><author>A &amp; B</author></authors><commentList><comment ref="D4" authorId="0"><text><r><t>old</t></r><r><t xml:space="preserve"> note</t></r></text></comment></commentList></comments>' },
    { op: 'set', name: 'xl/worksheets/_rels/sheet1.xml.rels', text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>' },
    { op: 'note', request: { cell: 'D4', text: 'new', author: 'A & B', append: true } },
    { op: 'note', request: { cell: 'E5', text: 'fresh', author: 'A & B' } },
  ] },
];
let ordinal = 0;
for (const sequence of PART_SEQUENCES) {
  const state = { n: (ordinal += 1) };
  const outputs = [];
  for (const step of sequence.steps) outputs.push(await attempt(() => runPartsStep(state, step)));
  sequences.push({ name: sequence.name, kind: 'parts', steps: sequence.steps, outputs, snapshot: state.zip ? await snapshotOf(state.zip) : null, worksheet: state.xml ?? null });
}

// cell labels: a package whose sheet holds dates, formulas with cached results, shared strings and a missing cache
const sheetStyles = [];
{
  let xml = BLANK_STYLES;
  const wanted = [
    { numberFormat: 'yyyy-mm-dd' }, { numberFormat: 'm"월"' }, { numberFormat: '#,##0' }, { numberFormat: 'mmm yy' }, { numberFormat: 'h:mm' }, { numberFormat: 'yyyy' },
  ];
  for (const props of wanted) {
    const made = styles.applyCellStyle(xml, 0, props);
    xml = made.xml;
    sheetStyles.push(made.index);
  }
  sheetStyles.xml = xml;
}
const [S_DATE, S_MONTH, S_NUMBER, S_SHORT, S_TIME, S_YEAR] = sheetStyles;
const LABEL_SHEET =
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="${S_DATE}"><v>46174</v></c><c r="C1" s="${S_MONTH}"><v>46174</v></c><c r="D1" s="${S_NUMBER}"><v>1234.5</v></c></row>` +
  `<row r="2"><c r="A2" s="${S_SHORT}"><f>B1+1</f><v>46175</v></c><c r="B2" s="${S_TIME}"><v>46174</v></c><c r="C2"><f>A5</f></c><c r="D2" t="str"><f>"x"</f><v>text</v></c></row>` +
  `<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="inlineStr"><is><t>inline</t></is></c><c r="C3" s="${S_DATE}" t="s"><v>1</v></c><c r="D3" s="${S_DATE}"><f>1/0</f><v>1e12</v></c></row>` +
  `<row r="4"><c r="A4" s="${S_YEAR}"><v>-1</v></c><c r="B4" s="${S_YEAR}"><v>1e12</v></c><c r="B4" s="${S_DATE}"><v>45000.5</v></c><c r="C4" s="99"><v>5</v></c></row>` +
  `</sheetData></worksheet>`;
const CELL_REFS = [[1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [2, 2], [3, 2], [4, 2], [1, 3], [2, 3], [3, 3], [4, 3], [1, 4], [2, 4], [3, 4], [5, 5], [27, 1], [0, 1]];
{
  const path = join(work, 'labels.xlsx');
  await pkg.createPortableOoxmlDocument(path, { fileKind: 'xlsx', title: 't', sheetName: 'Data' });
  const zip = await opc.loadPackage(path);
  zip.file('xl/styles.xml', sheetStyles.xml);
  zip.file('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Header &amp; co</t></si><si><t>46174</t></si></sst>');
  const sheetPath = (await cells.workbookSheets(zip))[0].path;
  zip.file(sheetPath, LABEL_SHEET);
  const labels = await values.sheetCellLabelReader(zip, LABEL_SHEET);
  const reader = await values.sheetCellReader(zip, LABEL_SHEET);
  const outputs = [];
  for (const [column, row] of CELL_REFS) {
    outputs.push({
      label: await attempt(() => labels.label(column, row)),
      dated: await attempt(() => labels.dated(column, row)),
      value: await attempt(() => reader(column, row)),
    });
  }
  sequences.push({ name: 'cell labels and values of a sheet with dates', kind: 'labels', styles: sheetStyles.xml, sharedStrings: await opc.zipText(zip, 'xl/sharedStrings.xml'), worksheet: LABEL_SHEET, cells: CELL_REFS, outputs });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { pure: pureOut, sequences });
writeSetManifest(stage, { set: 'office-sheet-xml', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
