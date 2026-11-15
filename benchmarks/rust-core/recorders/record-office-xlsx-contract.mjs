#!/usr/bin/env node
// What the XLSX contract and audit modules answer (src/runtime/office/portable: xlsx-audit-support, xlsx-sheet-hygiene,
// xlsx-conventions, xlsx-contract), run through Node. Rust `mixdog-ooxml` must answer the same: the reading helpers on
// recorded cells, styles and sheets, the issue lists and convention summaries of fixture workbooks (a financial model, a
// report, messy sheets) and the formula, range and operation checks of the contract with their messages
// (crates/mixdog-ooxml/tests/twin_xlsx_contract.rs).
//
//   node benchmarks/rust-core/recorders/record-office-xlsx-contract.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-xlsx-contract/golden.json. The recording holds `pure` (a function name, its
// arguments and its result or error) and `audits` (a workbook snapshot, the issues each sheet's audits list and the
// convention summary).
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-xlsx-contract');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-xlsx-contract.mjs';
const support = await importFrom(tree, 'src/runtime/office/portable/xlsx-audit-support.mjs');
const hygiene = await importFrom(tree, 'src/runtime/office/portable/xlsx-sheet-hygiene.mjs');
const conventions = await importFrom(tree, 'src/runtime/office/portable/xlsx-conventions.mjs');
const contract = await importFrom(tree, 'src/runtime/office/portable/xlsx-contract.mjs');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const PURE = [];
const pure = (fn, args, run) => PURE.push([fn, args, run]);
// The engine's shared-formula move stands in as a function both sides can write: the formula it is given and the deltas.
const translate = (formula, rows, columns) => `T(${formula}|${rows}|${columns})`;

// ---- xlsx-audit-support
for (const text of ['a.b*c', '$^{}()|[]\\', '모델 (1)', '', 'plain', "it's"]) pure('escapeRegExp', [text], (v) => support.escapeRegExp(v));
for (const sheet of [{ name: 'Data' }, { path: '/s/1', name: 'x' }, {}, { name: 0 }, { path: '' }, { name: '모델' }])
  pure('sheetPath', [sheet], (v) => support.sheetPath(v));
for (const [sheet, cell] of [[{ name: 'Data' }, { ref: 'A1' }], [{ name: 'Data' }, { ref: 'A1', path: '/x' }], [{}, {}], [{ path: '/p' }, { ref: 'b2' }]])
  pure('cellPath', [sheet, cell], (a, b) => support.cellPath(a, b));
for (const formula of ['=A1+B1', '=IF(A="x!","a""b",1)', 'SUM(1,2)', '', '=="x"', '="Sheet Name!"&A1', '="unterminated', null, 0, '=\'My Sheet\'!A1'])
  pure('formulaBody', [formula], (v) => support.formulaBody(v));
const NUMERIC_CELLS = [
  { value: 5 }, { value: -2.5 }, { value: '12' }, { value: ' 12.5 ' }, { value: '1e3' }, { value: '-4E-2' }, { value: '1,200' }, { value: 'abc' },
  { value: '' }, { value: null }, {}, { value: true }, { value: 0 },
  { formula: '=A1', cachedValue: 7, value: 1 }, { formula: '=A1', cachedValue: null, value: 3 }, { formula: '=A1', value: '4' }, { formula: '=A1' },
  { formula: '=A1', cachedValue: 'x', value: 2 }, { formula: 0, value: 9 }, { formula: '=A1', cachedValue: 0, value: 9 },
];
for (const cell of NUMERIC_CELLS) {
  pure('numericValue', [cell], (v) => support.numericValue(v));
  pure('isNumericCell', [cell], (v) => support.isNumericCell(v));
}
for (const cell of [{ value: false }, { value: 'FALSE' }, { value: ' false ' }, { value: 'False!' }, { value: 0 }, { value: null }, { formula: '=1>2', cachedValue: false }, { formula: '=1>2', cachedValue: 'false', value: true }, { formula: '=x', value: false }, {}])
  pure('falseValue', [cell], (v) => support.falseValue(v));
for (const cell of [{ ref: 'A1' }, { ref: 'b2' }, { ref: ' c3 ' }, { ref: 'AA10' }, { ref: 'A0' }, { ref: 'B' }, { ref: 5 }, {}, { ref: 'XFD1048576' }, { ref: '$A$1' }, { ref: null }])
  pure('position', [cell], (v) => support.position(v));
pure('locate', [[{ ref: 'A1', value: 1 }, { ref: 'zz', value: 2 }, { ref: 'C3' }, {}]], (v) => support.locate(v));
for (const style of [null, {}, { numberFormat: 'General' }, { numberFormat: ' general ' }, { numberFormat: '표준' }, { numberFormat: 'G/표준' }, { numberFormat: '#,##0' }, { numberFormat: 0 }, { numberFormat: 'Standard' }, { numberFormat: '常规' }])
  pure('generalFormat', [style], (v) => support.generalFormat(v));
const STYLES = [
  null, 'text', 5, [], {}, { color: '000000' }, { color: 'FF000000' }, { color: 'ff0000ff' }, { color: '1F4E79' }, { color: 0 }, { color: 255 }, { color: '' },
  { fillColor: 'FFFFFF' }, { fillColor: 'ffffffff' }, { fillColor: 'FFFF00' }, { fillColor: 16777215 }, { fillColor: 65535 }, { fillColor: 0 },
  { bold: true }, { bold: 'true' }, { italic: true }, { underline: true }, { numberFormat: '#,##0' }, { numberFormat: 'General' }, { numberFormat: '  ' },
  { fontSize: 11 }, { fontSize: 14 }, { fontSize: '12' }, { fontSize: 0 }, { fontSize: -3 }, { fontSize: null }, { fontSize: 'big' }, { color: true },
];
for (const style of STYLES) {
  pure('isMarkedInputStyle', [style], (v) => support.isMarkedInputStyle(v));
  pure('hasVisibleStyle', [style], (v) => support.hasVisibleStyle(v));
}
const TABLE_SHEETS = [
  { tables: [{ range: 'A1:C10', name: 'Sales' }, { range: '$E$2:$F$9' }, { range: 'A:B' }, { range: '3:9' }, { range: 'junk' }, {}, { range: 'C5:A1' }] },
  { tables: [] }, {}, { tables: [{ range: 'B2' }] }, { mergedRanges: ['A1:D1', '$A$3:$B$4', 'A:A', 'bad', '', 'F6'] },
];
for (const sheet of TABLE_SHEETS) {
  pure('tableAreas', [sheet], (v) => support.tableAreas(v));
  pure('mergedAreas', [sheet], (v) => support.mergedAreas(v));
}
const AREAS = [{ startCol: 2, endCol: 4, startRow: 2, endRow: 6 }, { startCol: 1, endCol: 1, startRow: 1, endRow: 1 }];
for (const at of [{ row: 1, column: 1 }, { row: 2, column: 2 }, { row: 3, column: 3 }, { row: 7, column: 3 }, { row: 3, column: 5 }, { row: 0, column: 0 }]) {
  pure('insideArea', [AREAS, at], (a, b) => support.insideArea(a, b));
  pure('insideTableBody', [AREAS, at], (a, b) => support.insideTableBody(a, b));
}
pure('notedRefs', [{ notes: [{ cell: '$b$2', text: 'x' }, { cell: 'c3' }, { text: 'no cell' }, null] }, [{ ref: 'a1', note: 'n' }, { ref: 'A2' }, { note: 'orphan' }, { ref: 'd4', note: '' }]], (a, b) => [...support.notedRefs(a, b)].sort());
pure('notedRefs', [{}, []], (a, b) => [...support.notedRefs(a, b)].sort());
pure('issueList', [[['info', 'a'], ['warning', 'b']]], (pushes) => {
  const list = new support.IssueList();
  for (const [severity, code] of pushes) list.push(severity, code, `/p/${code}`, `m ${code}`);
  return { issues: list.issues, omitted: list.omitted };
});
{
  const pushes = [];
  for (let index = 0; index < 130; index += 1) pushes.push(['warning', 'x']);
  for (let index = 0; index < 3; index += 1) pushes.push(['info', 'y']);
  pure('issueList', [pushes], (list) => {
    const issues = new support.IssueList();
    for (const [severity, code] of list) issues.push(severity, code, '/p', 'm');
    return { issues: issues.issues.length, omitted: issues.omitted, first: issues.issues[0], last: issues.issues[issues.issues.length - 1] };
  });
}

// ---- xlsx-contract
for (const [formula, rows, columns] of [
  ['=A1+B1', 1, 0], ['=A1+B1', 0, 1], ['=A1+B1', 0, 0], ['=Ops[월]+B2', 2, 0], ['=[@월]*2', 1, 1], ['=SUM(Ops[[#This Row],[월]],"[x]")', 1, 0],
  ['="a[b]"&Data!B2', 1, 0], ['=Ops[a]+Ops[b]', 0, 3], ['', 1, 1], [null, 1, 0], ['=\u0000 0\u0000', 1, 0], ['="\u00000\u0000"+A1', 1, 0], ['=Ops[[a],[b]]', 3, 3],
]) pure('filledFormula', [formula, rows, columns], (...a) => contract.filledFormula(...a, translate));
for (const operations of [
  [{ op: 'set_cell', cell: 'A1', value: 1 }],
  [{ op: 'set_formula', cell: 'B2', formula: '=A1' }],
  [{ op: 'set_formula', range: 'B2:C3', formula: '=A1+Data!B2', style: { bold: true } }, { op: 'set_cell', cell: 'A1' }],
  [{ op: 'set_formula', range: 'B2', formula: '=A1' }],
  [{ op: 'set_formula', range: 'D4:D6', formula: '=Ops[월]*C4', cell: 'ignored' }],
  [{ op: 'set_formula', range: 'bad', formula: '=A1' }],
  [{ op: 'set_formula', range: null, formula: '=A1' }],
  [{ op: 'set_formula', range: 'A1:A200000', formula: '=1' }],
  [{ op: 'set_formula', range: 'B2:B3' }],
  [null, 5, { op: 'set_formula', range: 'A1:A2', formula: 7 }],
  [],
]) pure('expandFilledFormulas', [operations], (v) => contract.expandFilledFormulas(v, translate));
for (const reference of ['A:C', 'a:c', ' B:B ', 'C:A', 'A:XFE', '1:5', '3:3', '5:3', '2:1048577', '0:3', 'A1:B2', 'A1', ' A1 ', 'B2:A1', 'A1:A200000', '', 'x', 'A:1', 'AA:AB'])
  pure('parseXlsxAutofitRange', [reference], (v) => contract.parseXlsxAutofitRange(v));
for (const formula of ['=A1', '=Data 2024!A1:A5', '=SUM(Data 2024!A1:A5)+\'Data 2024\'!B1', '="Data 2024!A1"', '=A1:C3 Sheet2!B2', '=My Sheet!$A$1', '=x Data 2024!A1', '=Q 1 2!A:A', '=Sheet 3!3:4', '=Sheet 3!A', '', '=Plain!A1', '=Two Words!Name'])
  pure('quoteUnquotedSheetReferences', [formula], (v) => contract.quoteUnquotedSheetReferences(v));
for (const [formula, options] of [
  ['=SUM(A1:A3)', {}], ['SUM(A1:A3)', {}], ['=', {}], ['', {}], [null, {}], ['=TEXTJOIN(",",1,A1:A3)', {}], ['=concat(A1,B1)+ifs(A1>1,1)', {}], ['=SWITCH(A1,1,"a")+MAXIFS(A:A,B:B,1)+MINIFS(A:A,B:B,1)', {}],
  ['=_xlfn.TEXTJOIN(",",1,A1)', {}], ['=MYTEXTJOIN(1)', {}], ['=CONCATENATE(A1,B1)', {}], ['=IFS (A1>1,1)', {}],
  ['=XLOOKUP(A1,B:B,C:C)', { backend: 'mixdog-ooxml' }], ['=sort(A1:A5)+1', { backend: 'mixdog-ooxml' }], ['=XLOOKUP(A1,B:B,C:C)', { backend: 'excel' }], ['=XLOOKUP(A1,B:B,C:C)', {}],
  ['=MYSORT(A1)', { backend: 'mixdog-ooxml' }], ['=SEQUENCE(3)', { backend: 'mixdog-ooxml' }], ['=A1+FILTERED(1)', { backend: 'mixdog-ooxml' }],
  ['=월별 계산!B5+Plain!A1', { sheetNames: ['월별 계산', 'Plain'] }], ['=My Sheet!B5+My Sheet 2!B5', { sheetNames: ['My Sheet', 'My Sheet 2'] }],
  ['="My Sheet!B5"&My Sheet!B5', { sheetNames: ['My Sheet'] }], ["='My Sheet'!B5", { sheetNames: ['My Sheet'] }], ['=Data 2024!A1:A5+1', {}], ['=2024 Sales!A1', { sheetNames: ['2024 Sales'] }],
  ['=A-B!C1', { sheetNames: ['A-B', null, '', 7] }], ['=Q1.Data!A1', { sheetNames: ['Q1.Data', 'it\'s'] }], ["=it's!A1", { sheetNames: ["it's"] }],
]) pure('normalizeXlsxFormula', [formula, options], (f, o) => contract.normalizeXlsxFormula(f, o));
for (const value of ['서울,부산', '"서울,부산"', '=서울,부산', 'Data!$A$1:$A$9', "'My Data'!A1:A9", 'A1', '$A$1:$B$9', '', null, '  =x  ', '=B2>0', '"unterminated', 'a'])
  pure('listValidationChoices', [value], (v) => contract.listValidationChoices(v));
for (const operation of [
  {}, { type: '' }, { type: 'expression' }, { type: 'Formula' }, { type: 'CellIs' }, { type: 'colorScale' }, { type: 'Colour-Scale' }, { type: 'scale' }, { type: 'Heat Map' },
  { type: 'dataBar' }, { type: 'bar' }, { type: 'Data_Bar' }, { type: 'icons' }, { type: 5 }, { type: '  ' }, { type: ' bad type ' }, null,
]) pure('conditionalFormatKind', [operation], (v) => contract.conditionalFormatKind(v));

const OPERATIONS = [
  { op: 'set_cell', cell: 'A1', value: 1 }, { op: 'set_cell', cell: 'a1' }, { op: 'set_cell' }, { op: 'set_cell', cell: 'A0' }, { op: 'set_cell', cell: 'XFE1' }, { op: 'set_cell', cell: 'A1048577' },
  { op: 'set_formula', cell: 'B2', formula: '=A1' }, { op: 'clear_cell', cell: 7 }, { op: 'add_note', cell: ' C3 ' }, { op: 'delete_note', cell: null }, { op: 'set_cell', cell: false },
  { op: 'freeze_panes' }, { op: 'freeze_panes', row: 2 }, { op: 'freeze_panes', row: 1, column: 1 }, { op: 'freeze_panes', row: 0, column: 0 }, { op: 'freeze_panes', column: 2 },
  { op: 'freeze_panes', row: -1 }, { op: 'freeze_panes', row: 1.5 }, { op: 'freeze_panes', row: '2' }, { op: 'freeze_panes', row: 1048577 }, { op: 'freeze_panes', row: 2, column: 16385 },
  { op: 'freeze_panes', row: 2, column: null }, { op: 'freeze_panes', row: null, column: 2 }, { op: 'freeze_panes', row: 2, column: 1.2 },
  { op: 'sort_range' }, { op: 'sort_range', range: 'A1:C9' }, { op: 'sort_range', range: 'A1:C9', order: 'DESC' }, { op: 'sort_range', range: 'A1:C9', order: 'descending' }, { op: 'sort_range', range: 'A1:C9', order: 'up' },
  { op: 'sort_range', range: 'A1:C9', order: 5 }, { op: 'sort_range', range: 'bad' }, { op: 'sort_range', range: 'A9:A1' },
  { op: 'add_conditional_format', range: 'A1:A5' }, { op: 'add_conditional_format', range: 'A1:A5', formula: 'A1>1' }, { op: 'add_conditional_format', range: 'A1:A5', type: 'colorScale' },
  { op: 'add_conditional_format', range: 'A1:A5', type: 'dataBar', formula: 'A1>1' }, { op: 'add_conditional_format', range: 'A1:A5', type: 'Cell Is', formula: ' A1>1 ' },
  { op: 'add_conditional_format', range: 'A1:A5', type: 'icons' }, { op: 'add_conditional_format', type: 'bar' }, { op: 'add_conditional_format', range: 'A1:A5', type: 'heatmap', formula: '  ' },
  { op: 'add_pivot_table', source: 'A1:D25', destination: 'F1', values: ['매출'] }, { op: 'add_pivot_table', source: '원자료!A1:D25', destination: 'F1', values: '매출' },
  { op: 'add_pivot_table', source: "'My Data'!A1:D25", sheet: 'My Data', destinationSheet: 'Pivot', destination: "Pivot!A3", values: [{ field: '매출' }, { name: '건수', function: 'SUM' }, '', '  수량  ', null] },
  { op: 'add_pivot_table', source: '원자료!A1:D25', sheet: '다른' }, { op: 'add_pivot_table', source: 'A1:D5', destination: 'X!B2', destinationSheet: 'Y' },
  { op: 'add_pivot_table', source: 'A1:D5', values: [{ field: '매출', function: 'average' }] }, { op: 'add_pivot_table', source: 'A1:D5', values: [{ aggregation: 'count', name: 'n' }] },
  { op: 'add_pivot_table', source: 'A1:D5', values: [{}] }, { op: 'add_pivot_table', source: 'A1:D5', values: [[]] }, { op: 'add_pivot_table', source: 'A1:D5', values: null }, { op: 'add_pivot_table', source: null, values: 5 },
  { op: 'add_validation' }, { op: 'add_validation', formula1: '  ' }, { op: 'add_validation', range: 'A1:A9', formula1: '서울,부산' }, { op: 'add_validation', range: 'A1', formula1: 'B2>0' },
  { op: 'add_validation', range: 'A1', formula1: '1', type: 'WHOLE', operator: 'BETWEEN', formula2: '9' }, { op: 'add_validation', range: 'A1', formula1: '1', type: 'whole' },
  { op: 'add_validation', range: 'A1', formula1: '1', type: 'whole', operator: 'between' }, { op: 'add_validation', range: 'A1', formula1: '1', type: 'whole', operator: 'greaterthanorequal' },
  { op: 'add_validation', range: 'A1', formula1: '1', type: 'list', operator: 'equal' }, { op: 'add_validation', range: 'A1', formula1: '1', type: 'nope' }, { op: 'add_validation', range: 'A1', formula1: '1', type: 'date', operator: 'nope' },
  { op: 'add_validation', range: 'A1', formula1: '=\'Data\'!$A$1:$A$9' }, { op: 'add_validation', formula1: 'x,y', operator: ' ' }, { op: 'add_validation', range: 'A1:B2', formula1: 'x,y', operator: '' },
  { op: 'set_style', cell: 'B2' }, { op: 'set_style', cell: 'b2', range: 'A1:B2' }, { op: 'set_style', cell: 'bad' }, { op: 'set_style', range: 'A1:C3' }, { op: 'set_style' }, { op: 'set_style', range: 'bad' },
  { op: 'set_range' }, { op: 'set_range', range: 'A1:B2' }, { op: 'set_range', range: 'A1:B2', values: [[1, 2], [3, 4]] }, { op: 'set_range', range: 'A1:B2', values: [[1, 2]] }, { op: 'set_range', range: 'A1:B2', values: [[1, 2], [3]] },
  { op: 'set_range', range: 'A1:B2', values: [[1, 2], 'x'] }, { op: 'set_range', range: 'A1:B2', values: 'x' }, { op: 'set_range', range: 'A1', values: [[1]] }, { op: 'set_range', range: 'A1:A200000', values: [] }, { op: 'set_range', range: 5 },
  { op: 'add_table', range: 'A1:C9' }, { op: 'add_table', range: 'A1:C9:D1' }, { op: 'add_table', range: 'A1' },
  { op: 'add_chart', range: 'A1:B7' }, { op: 'add_chart', range: 'A1:D2' }, { op: 'add_chart', range: 'A1:C2' }, { op: 'add_chart', range: 'A1:A7,D1:D7' }, { op: 'add_chart', range: 'A1:A2,B1:B2,C1:C2,D1:D2' },
  { op: 'add_chart', range: "'월별 계산'!A1:A7,'월별 계산'!D1:D7" }, { op: 'add_chart', range: "'월별 계산'!A1:A7,D1:D7" }, { op: 'add_chart', range: 'Data!A1:A7,Other!D1:D7' }, { op: 'add_chart', range: 'Data!A1:A7,data!D1:D7' },
  { op: 'add_chart', range: 'A1:D2', plotBy: 'rows' }, { op: 'add_chart', range: 'A1:D2', plotBy: 'ROWS' }, { op: 'add_chart', range: 'A1:A5', plotBy: 'rows' }, { op: 'add_chart', range: 'A1:D1', plotBy: 'rows' }, { op: 'add_chart', range: 'A1:B3,D1:E3', plotBy: 'rows' },
  { op: 'add_chart', range: 'A1:A2,B1:B2,bad' }, { op: 'add_chart', range: 'A1:B2,C1:D2,E1:F2' }, { op: 'add_chart', range: 'A1:A3,B1:B3,C1:C3,D1:D3' },
  { op: 'autofit_range' }, { op: 'autofit_range', range: 'A:C' }, { op: 'autofit_range', range: '2:9' }, { op: 'autofit_range', range: 'A1:C9' }, { op: 'autofit_range', range: 'C:A' }, { op: 'autofit_range', range: 'bad' }, { op: 'autofit_range', range: ' 1:3 ' },
  { op: 'append_row' }, { op: 'append_row', values: [1, 2, 3] }, { op: 'append_row', values: 'x' }, { op: 'append_row', values: [] }, { op: 'append_row', values: new Array(16385).fill(0) },
  { op: 'insert_rows', row: 2 }, { op: 'insert_rows', row: 2, count: 3 }, { op: 'insert_rows' }, { op: 'insert_rows', row: 0 }, { op: 'insert_rows', row: 1048576 }, { op: 'insert_rows', row: 1048576, count: 2 }, { op: 'delete_rows', row: 2, count: 0 },
  { op: 'delete_rows', row: 2, count: 1.5 }, { op: 'delete_rows', row: '2' }, { op: 'delete_rows', row: 2, count: null }, { op: 'delete_rows', row: null }, { op: 'delete_rows', row: 1.5 }, { op: 'delete_rows', row: 2, count: '3' },
  { op: 'insert_columns', column: 3 }, { op: 'insert_columns', column: 'C' }, { op: 'insert_columns', column: ' ab ' }, { op: 'insert_columns', column: 'abcd' }, { op: 'insert_columns', column: 'XFD', count: 1 }, { op: 'insert_columns', column: 'XFD', count: 2 },
  { op: 'delete_columns', column: 'ZZZ' }, { op: 'delete_columns', column: 0 }, { op: 'delete_columns' }, { op: 'delete_columns', column: 16384, count: 1 }, { op: 'delete_columns', column: 16385 }, { op: 'delete_columns', column: 'a1' },
  { op: 'merge_cells' }, { op: 'merge_cells', range: 'A1:B2' }, { op: 'unmerge_cells', range: 'A1:B2' }, { op: 'set_autofilter', range: 'A1:D9' }, { op: 'set_autofilter', range: 'bad' }, { op: 'merge_cells', range: 'B2:A1' }, { op: 'set_autofilter' },
  { op: 'unknown_operation', cell: 'bad', range: 'bad' }, { op: 'rename_sheet', name: 'x' }, {}, [], [1, 2], null, 5, 'text', true, false, 0,
  { op: 5 }, { op: null, cell: 'bad' },
];
for (const operation of OPERATIONS) pure('validateXlsxOperation', [operation], (v) => contract.validateXlsxOperations([structuredClone(v)]));
pure('validateXlsxOperations', [[{ op: 'add_validation', range: 'A1', formula1: 'x,y' }, { op: 'insert_columns', column: 'b' }, { op: 'add_conditional_format', range: 'A1', type: 'bar' }]], (v) => contract.validateXlsxOperations(structuredClone(v)));
pure('validateXlsxOperations', [[{ op: 'set_cell', cell: 'A1' }, { op: 'set_cell', cell: 'bad' }, { op: 'set_cell', cell: 'worse' }]], (v) => contract.validateXlsxOperations(structuredClone(v)));
pure('validateXlsxOperations', [null], (v) => contract.validateXlsxOperations(v));
pure('validateXlsxOperations', [[]], (v) => contract.validateXlsxOperations(v));

const pureOut = [];
for (const [fn, args, run] of PURE) pureOut.push({ fn, args, ...(await attempt(() => run(...args))) });

// ---- audits over fixture workbooks
const text = (ref, value, extra = {}) => ({ ref, value, dataType: 'text', ...extra });
const num = (ref, value, extra = {}) => ({ ref, value, dataType: 'number', ...extra });
const calc = (ref, formula, cachedValue, extra = {}) => ({ ref, formula, cachedValue, value: cachedValue, dataType: 'number', ...extra });
const INPUT = { fontName: 'Arial', fontSize: 10, color: '0000FF', numberFormat: '#,##0' };
const PERCENT_INPUT = { fontName: 'Arial', fontSize: 10, color: '0000FF', numberFormat: '0.0%' };
const OUTPUT = { fontName: 'Arial', fontSize: 10, numberFormat: '#,##0' };
const HEADER = { fontName: 'Arial', fontSize: 10, bold: true, fillColor: 'D9E1F2' };

const financial = {
  defaultStyle: { fontName: 'Arial' },
  definedNames: [{ name: 'TaxRate', refersTo: '=Assumptions!$B$3' }, { name: 'Libor', refersTo: "='[rates.xlsx]Sheet1'!$A$1" }, { name: 'Ext', refersTo: '=[1]Rates!$A$1' }, { refersTo: '=[2]X!A1' }],
  sheets: [
    {
      name: 'Assumptions',
      cells: [
        text('A1', 'Driver', { style: HEADER }), text('B1', 'Value', { style: HEADER }), text('A2', 'Revenue growth'), num('B2', 0.08, { style: PERCENT_INPUT }),
        text('A3', 'Tax rate'), num('B3', 25, { style: PERCENT_INPUT }), text('A4', 'Opening revenue'), num('B4', 1200000, { style: INPUT }),
        text('A5', 'Base year'), num('B5', 2024, { style: { ...INPUT, color: '0000FF' } }), text('A6', 'Discount'), num('B6', 0.1, { style: { numberFormat: '0.0%', color: 255 } }),
        text('A7', 'Headcount'), text('B7', '1,200'), text('A8', 'Margin'), text('B8', '15%'), text('A9', 'Year label'), text('B9', '2024'),
      ],
      freezePanes: { frozen: true, row: 2 },
    },
    {
      name: '월별 계산',
      cells: [
        text('A1', 'Month', { style: HEADER }), text('B1', 'Revenue', { style: HEADER }), text('C1', 'Tax', { style: HEADER }),
        ...Array.from({ length: 24 }, (_, index) => num(`A${index + 2}`, 2000 + index, { style: { numberFormat: '#,##0' } })),
        calc('B2', '=Assumptions!B4*(1+Assumptions!B2)', 1296000, { style: OUTPUT }),
        calc('B3', '=B2*(1+Assumptions!B2)', 1399680, { style: OUTPUT }),
        calc('C2', '=B2*TaxRate', 324000, { style: OUTPUT }),
        calc('C3', '=B3*Libor', 0, { style: OUTPUT }),
        calc('C4', "='월별 계산'!B2*2", 2592000, { style: OUTPUT }),
        calc('C5', '=월별 계산!B2*2', 2592000),
        calc('C6', '=Summary Data!B2+Plain!A1', 10),
        calc('C7', '=[1]Rates!A1*B2', 5), calc('C8', '=[rates.xlsx]Sheet1!A1', 5), calc('C9', '="[1]"&A1', 5),
        calc('C10', '=Ext+1', 5), calc('C11', '=XExt+Ext2', 5), calc('C12', '=IF(A1="Ext",1,2)', 1),
      ],
      tables: [{ name: 'Monthly', range: 'A1:C26' }],
      freezePanes: { frozen: false },
    },
    { name: 'Summary Data', cells: [num('B2', 100, { style: { numberFormat: '0%' } }), num('B3', 12.5, { style: { numberFormat: '0.0%;[Red]-0.0%' } }), num('B4', 9, { style: { numberFormat: '"%"0' } })] },
  ],
};

const rows = (count, make) => Array.from({ length: count }, (_, index) => make(index + 2));
const report = {
  sheets: [
    {
      name: 'Report',
      mergedRanges: ['A1:D1', 'A2:B3'],
      cells: [
        text('A1', 'Quarterly report 1,234', { style: { bold: true, fontSize: 18 } }), text('A2', '45%'), text('C2', '98'),
        text('A5', 'Region', { style: HEADER }), text('B5', 'Units', { style: HEADER }), text('C5', 'Share', { style: HEADER }), text('D5', 'Year', { style: HEADER }), text('E5', 'Note', { style: HEADER }),
        ...rows(30, (row) => num(`B${row + 4}`, 100 * row, { style: { numberFormat: row % 7 === 0 ? '0.0' : '#,##0' } })),
        ...rows(30, (row) => num(`C${row + 4}`, row / 100)),
        ...rows(30, (row) => num(`D${row + 4}`, 2000 + row)),
        ...rows(30, (row) => text(`A${row + 4}`, `Region ${row}`)),
        ...rows(8, (row) => num(`F${row + 4}`, row, { style: { numberFormat: '#,##0' } })),
        ...rows(8, (row) => num(`G${row + 4}`, 1990 + row * 15, { style: { numberFormat: '#,##0' } })),
        ...rows(8, (row) => num(`H${row + 4}`, 2000 + row, { style: { numberFormat: '#,##0' } })),
      ],
      tables: [{ name: 'Regions', range: 'A5:D35' }, { range: 'F5:H12' }, { range: 'A:A' }],
      freezePanes: { frozen: false },
      truncated: true,
      lastRow: 60,
    },
    {
      name: 'Short',
      cells: [text('A1', 'a'), text('B1', 'b'), num('A2', 1), num('B2', 2), num('A30', 3, { style: { numberFormat: '0.00' } })],
      freezePanes: { frozen: false },
    },
    {
      name: 'Pinned',
      cells: [text('A1', 'a'), text('B1', 'b'), num('A40', 3)],
      freezePanes: { frozen: true },
    },
    { name: 'Notes', cells: [], tables: [], notes: [{ cell: '$A$1', text: 'n' }] },
  ],
};

const messy = {
  sheets: [
    {
      name: "It's a sheet",
      cells: [
        { value: 5 }, { ref: 'nonsense', value: 6, style: [] }, { ref: 'A1', value: 7, style: 'bold' }, { ref: 'B1', value: 8, style: { color: 'FFFF0000', fontName: 'Calibri' } },
        { ref: 'B2', value: 9, style: { color: 255, fillColor: 65535, fontName: 'Calibri', numberFormat: 5 } }, { ref: 'C1', value: '12', style: { fillColor: 'FFFF00', numberFormat: '0%' } },
        { ref: 'c2', value: 'ten', style: { fontName: 'Courier New' } }, { ref: 'D1', formula: '=A1', value: 7, style: { fontName: 'Courier New', numberFormat: '0%' } },
        { ref: 'D2', value: 2025, style: { numberFormat: '#,##0' } }, { ref: 'E2', value: 1850, style: { numberFormat: '#,##0' } }, { ref: 'E3', value: 2050, style: { numberFormat: '0,0' } },
        { ref: 'F1', formula: '=Other Sheet!A1', value: 1 }, { ref: 'F2', formula: '=\'Other Sheet\'!A1', value: 1 }, { ref: 'F3', formula: 'Other Sheet!A1+1', value: 1 },
        { ref: 'G1', path: '/custom/G1', value: '1,5', dataType: 'text' }, { ref: 'G2', value: '1.5e3', dataType: 'text' }, { ref: 'G3', value: ' 7 ', dataType: 'text' }, { ref: 'G4', value: '+8%', dataType: 'text' },
        { ref: 'G5', value: '2019', dataType: 'text' }, { ref: 'G6', value: '1,23', dataType: 'text' }, { ref: 'G7', value: 5, dataType: 'text' },
        { ref: 'H1', value: 15, style: { numberFormat: '0.0\\%' } }, { ref: 'H2', value: -30, style: { numberFormat: '0%' } }, { ref: 'H3', value: 9.99, style: { numberFormat: '0%' } },
        { ref: 'H4', value: 12.3, style: { numberFormat: '#,##0.0"%"' } },
      ],
      mergedRanges: ['G1:G3'],
      tables: [{ name: 'T', range: 'A1:E4', path: '/tbl/1' }, { range: 'bad' }],
      freezePanes: { frozen: false, row: 0 },
    },
    { name: 'Other Sheet', cells: [num('A1', 1)] },
    { name: '모델', cells: [{ ref: 'A1', formula: '=모델!B8', value: 1 }, { ref: 'A2', formula: '=Ünïcode!A1', value: 1 }] },
    { cells: [{ ref: 'A1', value: 1 }] },
    {},
  ],
  definedNames: [],
};

// A sheet of 130 text figures: the per-code cap lists 100 and counts the rest.
const capped = { sheets: [{ name: 'Capped', cells: Array.from({ length: 130 }, (_, index) => text(`A${index + 1}`, `${index + 1},234`)) }] };
// Cells that all carry a style, a default font only, and none of either.
const plain = { sheets: [{ name: 'Plain', cells: [num('A1', 1), text('B1', 'x'), calc('C1', '=A1', 1)] }] };
const defaultOnly = { defaultStyle: { fontName: 'Meiryo' }, sheets: [] };
const empty = {};

const audits = [];
for (const [name, document] of [['financial model', financial], ['report', report], ['messy sheets', messy], ['capped', capped], ['unstyled', plain], ['default font only', defaultOnly], ['empty', empty]]) {
  const sheetNames = (document.sheets || []).map((sheet) => sheet.name);
  const externalNames = hygiene.externalDefinedNames(document.definedNames);
  const sheets = [];
  for (const sheet of document.sheets || []) {
    const list = new support.IssueList();
    const cells = sheet.cells || [];
    hygiene.auditSheetHygiene(list, sheet, cells, sheetNames, externalNames);
    hygiene.auditSheetLayout(list, sheet, cells);
    sheets.push({ issues: list.issues, omitted: list.omitted });
  }
  audits.push({ name, document, externalNames, sheets, conventions: conventions.summarizeXlsxConventions(document) ?? null });
}

writeJson(join(stage, 'golden.json'), { pure: pureOut, audits });
writeSetManifest(stage, { set: 'office-xlsx-contract', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
