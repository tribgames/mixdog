#!/usr/bin/env node
// Golden of the office operation contract engine (crate mixdog-office, modules `contracts` and `describe`): what Node's
// `runtime/office/capabilities.mjs` answers to recorded operation batches and describe queries. Writes
// native/core/fixtures/office-contracts/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-contracts.mjs --tree <product tree>
//
// A batch scenario is { name, format, backend, operations }: `assertOfficeOperationContracts` runs on a copy of the
// operations; the recording holds `mutated` (the exact JSON text of the operations after the call, which the contract
// rewrites in place, also when it then refuses) and `error` (the message) or `ok`. A describe scenario is
// { name, request: { format, backend, target, operation } } with `result` (the exact JSON text) or `error`.
// Besides the hand-written cases, every operation of every format is run bare and with an unknown field and an unknown
// property, so every signature's required-input and property-list message is recorded.
// The corpus is constants: the output is byte-stable.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-contracts.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const capabilities = await importFrom(tree, 'src/runtime/office/capabilities.mjs');
const { assertOfficeOperationContracts, describeOfficeCapabilities } = capabilities;

const COM = 'microsoft-office-com';
const OOXML = 'mixdog-ooxml';
const PDF = 'mixdog-pdf';
const TABULAR = 'mixdog-tabular';
const FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv'];
const BACKENDS = { docx: [COM, OOXML], xlsx: [COM, OOXML], pptx: [COM, OOXML], pdf: [PDF], csv: [TABULAR], tsv: [TABULAR] };

const batches = [];
const batch = (name, format, backend, operations) => batches.push({ name, format, backend, operations });

// ---- unknown formats and names ----
batch('no format', '', '', []);
batch('unknown format', 'odt', OOXML, [{ op: 'append_text' }]);
batch('empty batch', 'docx', OOXML, []);
batch('operation without op', 'docx', OOXML, [{ text: 'x' }]);
batch('operation with a blank op', 'docx', OOXML, [{ op: '   ' }]);
batch('operation is not an object', 'xlsx', OOXML, [7, null, 'set_cell', ['set_cell']]);
batch('op is a number', 'xlsx', OOXML, [{ op: 12 }]);
batch('unknown name with a typo', 'xlsx', OOXML, [{ op: 'add_chrt', range: 'A1:B5' }]);
batch('unknown name resolved by its subject', 'docx', OOXML, [{ op: 'add_toc' }]);
batch('unknown name with no suggestion', 'xlsx', '', [{ op: 'frobnicate' }]);
batch('unknown name on a backend', 'pptx', COM, [{ op: 'add_slde', layout: 'blank' }]);
batch('unknown name, Hangul', 'docx', OOXML, [{ op: '문단_추가' }]);
batch('operation another backend runs', 'pdf', COM, [{ op: 'add_text' }]);
batch('csv operation under the xlsx backend', 'csv', OOXML, [{ op: 'set_range', range: 'A1:B2', values: [['a', 'b'], ['c', 'd']] }]);
batch('tabular operation accepted', 'csv', TABULAR, [{ op: 'append_row', values: ['a', 1] }, { op: 'set_cell', cell: 'B2', value: 'x' }]);

// ---- operation aliases ----
batch('docx operation aliases', 'docx', OOXML, [
  { op: 'add_paragraph', text: '허브 운영 요약' },
  { op: 'insert_paragraph', text: 'b' },
  { op: 'add_text', text: 'c' },
  { op: 'add_link', find: '허브 운영 요약', address: 'https://example.com/ops' },
  { op: 'set_hyperlink', find: 'b', address: 'https://example.com/b' },
  { op: 'add_footnote', find: 'c', text: 'note' },
]);
batch('xlsx operation aliases', 'xlsx', OOXML, [
  { op: 'add_row', values: [1, 2] },
  { op: 'add_link', range: 'A1', url: 'https://example.com/ops' },
  { op: 'add_hyperlink', range: 'A2', address: 'https://example.com/ops' },
]);
batch('pptx operation aliases', 'pptx', OOXML, [
  { op: 'add_link', slide: 1, find: 'x', url: 'https://example.com' },
  { op: 'add_hyperlink', slide: 1, find: 'x', address: 'https://example.com' },
  { op: 'add_notes', slide: 1, text: 'n' },
  { op: 'set_note', slide: 1, text: 'n' },
]);
batch('pdf operation aliases', 'pdf', PDF, [
  { op: 'set_hyperlink', page: 1, find: '허브', url: 'https://example.com/ops' },
  { op: 'add_hyperlink', page: 1, find: 'x', url: 'https://example.com' },
]);

// ---- field aliases ----
batch('docx field aliases', 'docx', OOXML, [
  { op: 'add_comment', anchoredText: '인력', text: 't', author: 'x' },
  { op: 'add_hyperlink', find: 'a', url: 'https://example.com' },
  { op: 'set_table_cell', table: 1, row: 3, column: 2, text: '58' },
  { op: 'merge_table_cells', table: 1, row: 1, column: 1, colSpan: 2 },
  { op: 'set_table_cell_style', table: 1, row: 1, column: 1, properties: { bold: true } },
]);
batch('field alias loses to the field itself', 'docx', OOXML, [{ op: 'set_table_cell', table: 1, row: 3, col: 1, column: 2, text: 'x' }]);
batch('xlsx field aliases', 'xlsx', OOXML, [
  { op: 'set_hyperlink', range: 'A1', url: 'https://example.com' },
  { op: 'set_formula', cell: 'B5', value: '=SUM(B2:B4)' },
]);
batch('pptx field aliases', 'pptx', OOXML, [
  { op: 'distribute_shapes', slide: 1, shapes: [2, 3, 4], distribute: 'horizontal' },
  { op: 'set_hyperlink', slide: 1, shape: 2, url: 'https://example.com' },
  { op: 'set_table_cell_style', slide: 1, shape: 2, row: 1, column: 1, properties: { bold: true } },
]);

// ---- author initials ----
batch('comment authors', 'docx', OOXML, [
  { op: 'add_comment', find: '인력', text: '다시 봅시다.', author: '검토자' },
  { op: 'add_comment', find: '인력', text: 'Later.', author: 'Jane van Doe' },
  { op: 'add_comment', find: '인력', text: 'Kept.', author: '검토자', initials: 'QA' },
  { op: 'add_comment', find: '인력', text: 'No author.' },
  { op: 'add_comment', find: 'x', text: 'y', author: '  a b c d e  ' },
  { op: 'add_comment_reply', comment: 1, text: 'r', author: 'Jean-Luc Picard' },
  { op: 'add_comment', find: 'x', text: 'y', author: 42 },
]);

// ---- worksheet rewrites ----
batch('single cell named as a range', 'xlsx', OOXML, [
  { op: 'set_formula', range: 'B5', formula: '=B2/B3' },
  { op: 'set_cell', range: "'운영 자료'!D5", value: 620 },
  { op: 'set_cell', range: 'Sheet1!$B$4', value: 1 },
  { op: 'set_formula', range: 'B5:B9', formula: '=A5' },
  { op: 'set_formula', cell: 'C1', range: 'B5', formula: '=A5' },
]);
batch('range handed to a single-cell operation', 'xlsx', OOXML, [{ op: 'set_cell', range: 'B2:E2', value: 4 }]);
batch('range of another kind handed to a single-cell operation', 'xlsx', COM, [{ op: 'clear_cell', range: 42 }, { op: 'add_note', range: null, text: 'n' }]);
batch('freeze panes spellings', 'xlsx', OOXML, [
  { op: 'freeze_panes', cell: 'B2' },
  { op: 'freeze_panes', row: 2, column: 'C' },
  { op: 'freeze_panes', cell: '$AA$10' },
  { op: 'freeze_panes', cell: 'B2', row: 4 },
  { op: 'freeze_panes', row: 1 },
  { op: 'freeze_panes', column: ' b ' },
]);
batch('compose_sheet table', 'xlsx', OOXML, [
  { op: 'compose_sheet', title: '야간 운영 지표', table: { headers: ['허브', '정시 출고율'], rows: [['서울', 0.941]] } },
  { op: 'compose_sheet', title: 't', table: { rows: [[1]] } },
  { op: 'compose_sheet', title: 't', table: { x: 1 } },
  { op: 'compose_sheet', title: 't', headers: ['a'], table: { headers: ['b'] } },
]);
batch('geometry under properties', 'pptx', OOXML, [
  { op: 'add_image', slide: 1, path: 'a.png', properties: { left: 10, top: 20, width: 30, height: 40 } },
  { op: 'add_image', slide: 1, path: 'a.png', left: 5, properties: { left: 10 } },
  { op: 'add_image', slide: 1, path: 'a.png', properties: {} },
]);

// ---- unknown fields and properties ----
batch('field typo', 'xlsx', OOXML, [{ op: 'add_chart', range: 'A1:B5', chartTipe: 'column' }]);
batch('unrelated field', 'xlsx', OOXML, [{ op: 'add_chart', range: 'A1:B5', source: 'A1:B5' }]);
batch('unknown field beside a missing one', 'pptx', OOXML, [{ op: 'set_chart_data', slide: 2, chart: 1, series: [{ name: 'n', values: [1] }] }]);
batch('style key one level up', 'xlsx', OOXML, [{ op: 'set_style', range: 'A1', bold: true, fillColor: 'FFFF00' }]);
batch('style key one level up beside properties', 'xlsx', OOXML, [{ op: 'set_style', range: 'A1', bold: true, properties: { italic: true } }]);
batch('style key contradicted by properties', 'xlsx', OOXML, [{ op: 'set_style', range: 'A1', bold: true, properties: { bold: false } }]);
batch('style keys and an unknown field', 'xlsx', OOXML, [{ op: 'set_style', range: 'A1', bold: true, italic: true, zzNope: 1 }]);
batch('properties is not an object', 'xlsx', OOXML, [{ op: 'set_style', range: 'A1', bold: true, properties: 'x' }]);
batch('several unknown fields', 'docx', OOXML, [{ op: 'append_text', text: 'x', colour: 'red', bld: true, zzNope: 1 }]);
batch('stable targets on pptx', 'pptx', OOXML, [{ op: 'set_text', slideId: 3, shapeId: 5, text: 'x' }, { op: 'delete_shape', slide: 1, shapeId: 'a' }]);
batch('slide ids on the Office backend', 'pptx', COM, [{ op: 'set_text', slideId: 3, shapeId: 5, text: 'x' }]);
batch('property typos', 'docx', OOXML, [{ op: 'add_table', values: [['a']], properties: { fontNme: 'x', repeatHeadr: true, zzNope: 1 } }]);
batch('font spellings in properties', 'docx', OOXML, [{ op: 'add_table', values: [['a']], properties: { name: 'Noto Sans KR', size: 10, repeatHeader: true } }]);
batch('font spellings accepted', 'docx', OOXML, [
  { op: 'add_table', values: [['a']], properties: { fontName: 'Noto Sans KR', fontSize: 10, repeatHeader: true } },
  { op: 'append_text', text: '정시 출고율', properties: { fontNameEastAsia: 'Noto Sans KR', fontSize: 11 } },
  { op: 'append_text', text: 'x', properties: { nameEastAsia: 'Noto Sans KR', name: 'Calibri' } },
]);
batch('document font properties', 'docx', OOXML, [
  { op: 'set_document_font', properties: { name: 'Malgun Gothic', nameEastAsia: '맑은 고딕', size: 11, color: '112233' } },
  { op: 'set_document_font', properties: { bold: true } },
]);
batch('table style on each backend', 'docx', COM, [
  { op: 'set_table_style', table: 1, properties: { columnWidths: [100, 200], alignment: 'left' } },
  { op: 'set_table_style', table: 1, properties: { fontSize: 12 } },
]);
batch('table style column widths on the portable backend', 'docx', OOXML, [{ op: 'set_table_style', table: 1, properties: { columnWidths: [100, 200] } }]);
batch('required fields missing', 'pptx', OOXML, [{ op: 'add_textbox', slide: 1 }, { op: 'add_textbox' }]);
batch('text or paragraphs', 'pptx', OOXML, [{ op: 'add_textbox', slide: 1, paragraphs: [{ text: '요점', bullet: true }] }, { op: 'add_textbox', slide: 1, text: 'x' }]);

// ---- docx table alignment ----
const tableAlignment = (properties) => batch(`table alignment ${JSON.stringify(properties)}`, 'docx', OOXML, [{ op: 'add_table', values: [['a', '1']], properties }]);
tableAlignment({ alignment: ['left', 'right'] });
tableAlignment({ alignment: 'middle' });
tableAlignment({ alignment: 5 });
tableAlignment({ alignment: { a: 1 } });
tableAlignment({ alignment: ' RIGHT ' });
tableAlignment({ columnAlignments: ['left', 'top'] });
tableAlignment({ columnAlignments: ['left', 7, null, {}] });
tableAlignment({ columnAlignments: 'right' });
tableAlignment({ columnAlignments: [] });
tableAlignment({ alignment: ['x'], columnAlignments: 'right' });
batch('table alignment lowered', 'docx', OOXML, [{ op: 'set_table_style', table: 1, properties: { alignment: 'Center', columnAlignments: ['Left', 'RIGHT', ' Justify '] } }]);
batch('table alignment on another operation', 'docx', OOXML, [{ op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { alignment: 'middle' } }]);

// ---- define_styles ----
batch('define_styles valid', 'docx', OOXML, [{ op: 'define_styles', styles: { 'Heading 1': { size: 15, bold: true }, Title: { name: 'Malgun Gothic' } } }]);
batch('define_styles without styles', 'docx', OOXML, [{ op: 'define_styles' }, { op: 'define_styles', styles: {} }, { op: 'define_styles', styles: [] }, { op: 'define_styles', styles: null }, { op: 'define_styles', styles: 'x' }]);
batch('define_styles faults', 'docx', OOXML, [{ op: 'define_styles', styles: { A: { colour: 'red', fnt: 'x' }, B: 3, C: { bold: true }, D: [], E: null } }]);

// ---- add_validation ----
const validation = (name, backend, fields) => batch(name, 'xlsx', backend, [{ op: 'add_validation', range: 'A1', formula1: '0', ...fields }]);
for (const backend of [COM, OOXML]) {
  validation(`validation operator typo ${backend}`, backend, { type: 'whole', operator: 'greaterOrEqual' });
  validation(`validation unknown type ${backend}`, backend, { type: 'unknown' });
  validation(`validation between without formula2 ${backend}`, backend, { type: 'whole', operator: 'between' });
  validation(`validation notBetween without formula2 ${backend}`, backend, { type: 'whole', operator: 'notBetween' });
  validation(`validation default operator ${backend}`, backend, { type: 'whole' });
  validation(`validation custom with operator ${backend}`, backend, { type: 'custom', operator: 'equal' });
  validation(`validation list with operator ${backend}`, backend, { type: 'list', operator: 'equal' });
  validation(`validation upper case ${backend}`, backend, { type: 'WHOLE', operator: 'GREATERTHANOREQUAL' });
  validation(`validation formula2 blank ${backend}`, backend, { type: 'decimal', formula2: '  ' });
  validation(`validation formula1 blank ${backend}`, backend, { formula1: '  ' });
  validation(`validation formula1 absent ${backend}`, backend, { formula1: null });
  validation(`validation numeric formula1 ${backend}`, backend, { formula1: 0, type: 'whole', formula2: 50 });
  validation(`validation operator blank ${backend}`, backend, { type: 'date', operator: '  ', formula2: 'x' });
  for (const type of ['decimal', 'date', 'time', 'textLength']) validation(`validation ${type} ${backend}`, backend, { type, operator: 'greaterThanOrEqual' });
  for (const operator of ['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual']) {
    validation(`validation operator ${operator} ${backend}`, backend, { type: 'whole', operator, formula2: '50' });
  }
}
batch('validation formulas decide the type', 'xlsx', OOXML, [
  { op: 'add_validation', range: 'A3', formula1: '"서울,부산"' },
  { op: 'add_validation', range: 'A4', formula1: 'A4>0' },
  { op: 'add_validation', range: 'A5', formula1: '서울,부산' },
  { op: 'add_validation', range: 'A6', formula1: '=Sheet1!$A$1:$A$5' },
  { op: 'add_validation', range: 'A7', formula1: "'운영 자료'!B2:B9" },
  { op: 'add_validation', range: 'A8', formula1: 'a,b>1' },
  { op: 'add_validation', range: 'A9', formula1: ',' },
  { op: 'add_validation', range: 'A10', formula1: 'LEN(A10)<5' },
  { op: 'add_validation', range: 'A11', formula1: 'B2:B9', type: ' list ' },
]);
batch('validation faults and a fault beside it', 'xlsx', OOXML, [{ op: 'add_validation', range: 'A1', type: 'unknown', formula1: '0', zzNope: 1 }]);

// ---- several faults in one batch ----
batch('several faults', 'xlsx', OOXML, [
  { op: 'add_chart', range: 'A1:B5', source: 'x' },
  { op: 'add_chart', range: 'A1:B5', source: 'y' },
  { op: 'no_such_op' },
  7,
  {},
  { op: 'set_cell', range: 'B2:E2', value: 4 },
  { op: 'set_range' },
]);
batch('two faults of one operation', 'docx', OOXML, [{ op: 'add_table', properties: { zzNope: 1, alignment: 'middle' }, colour: 1 }]);
batch('faults across formats of operations accepted before them', 'xlsx', OOXML, [
  { op: 'set_cell', cell: 'A1', value: 1 },
  { op: 'add_row', values: [1] },
  { op: 'set_cell', range: 'A2', value: 2 },
  { op: 'set_formula', cell: 'A3' },
]);

// ---- every operation of every format: bare, and with an unknown field and property ----
const operationsOf = (format, backend = '') => describeOfficeCapabilities({ format, backend }).operations;
for (const format of FORMATS) {
  for (const operation of operationsOf(format)) {
    batch(`${format} ${operation} bare`, format, '', [{ op: operation }]);
    for (const backend of BACKENDS[format]) {
      batch(`${format} ${operation} bare on ${backend}`, format, backend, [{ op: operation }]);
      batch(`${format} ${operation} unknown field and property on ${backend}`, format, backend, [{ op: operation, zzNope: 1, properties: { zzProp: 1 } }]);
    }
  }
}

// ---- describe ----
const describes = [];
const describe = (name, request) => describes.push({ name, request });
const query = (format = '', backend = '', target = '', operation = '') => ({ format, backend, target, operation });
describe('summary', query());
describe('summary with a target', query('', '', '/x'));
describe('summary with an operation', query('', '', '', 'add_chart'));
describe('unknown backend', query('xlsx', 'excel'));
describe('unknown backend, no format', query('', 'excel'));
describe('unknown format', query('odt'));
describe('unknown format with an operation', query('odt', '', '', 'x'));
describe('unknown operation', query('xlsx', '', '', 'add_chrt'));
describe('unknown operation, no suggestion', query('xlsx', '', '', 'frobnicate'));
describe('unknown operation, subject', query('docx', '', '', 'add_toc'));
describe('operation with blanks', query('xlsx', '', '', '  add_chart  '));
describe('blank operation', query('xlsx', '', '', '   '));
describe('alias', query('docx', OOXML, '', 'add_paragraph'));
describe('alias for another format', query('pdf', PDF, '', 'set_hyperlink'));
describe('target', query('docx', '', '/documents/a.docx'));
for (const format of FORMATS) {
  describe(`${format} format`, query(format));
  for (const backend of [COM, OOXML, PDF, TABULAR]) describe(`${format} format on ${backend}`, query(format, backend));
  for (const operation of operationsOf(format)) {
    describe(`${format} ${operation}`, query(format, '', '', operation));
    for (const backend of BACKENDS[format]) describe(`${format} ${operation} on ${backend}`, query(format, backend, '', operation));
  }
}
describe('operation on a backend that does not run it', query('docx', TABULAR, '', 'append_text'));
describe('virtual operation', query('xlsx', '', '', 'compose_sheet'));
describe('virtual operation, per format', query('docx', '', '', 'add_chart'));

// ---- record ----
const recordedBatches = batches.map((item) => {
  const operations = structuredClone(item.operations);
  const entry = { name: item.name, format: item.format, backend: item.backend, operations: item.operations };
  try {
    assertOfficeOperationContracts({ format: item.format, backend: item.backend, operations });
    entry.ok = true;
  } catch (error) {
    entry.error = String(error?.message ?? error);
  }
  entry.mutated = JSON.stringify(operations);
  return entry;
});
const recordedDescribes = describes.map((item) => {
  const entry = { name: item.name, request: item.request };
  try {
    const result = describeOfficeCapabilities(item.request);
    entry.result = JSON.stringify(result);
  } catch (error) {
    entry.error = String(error?.message ?? error);
  }
  return entry;
});

const out = {
  note: 'Recorded from the Node operation contract engine (runtime/office/capabilities.mjs); tests/twin_contracts.rs replays it.',
  batches: recordedBatches,
  describes: recordedDescribes,
};
const fixtures = path.join(FIXTURES_ROOT, 'office-contracts');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-contracts', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes, ${recordedBatches.length} batches, ${recordedDescribes.length} describes`);
