#!/usr/bin/env node
// What the portable range-layout, pivot-operation, formula-audit and assertion modules answer (src/runtime/office/portable:
// portable-xlsx-range-layout, portable-xlsx-pivot-ops, xlsx-formula-audit, xlsx-assertions), run through Node. Rust
// `mixdog-ooxml` must answer the same: the worksheet text a sort, an autofit and a pivot table leave, the result of each,
// every finding of the formula audit in Node's order and wording, the merge of the audit into a host's result and the
// verdict of each workbook assertion (crates/mixdog-ooxml/tests/twin_xlsx_layout_audits.rs).
//
//   node benchmarks/rust-core/recorders/record-office-xlsx-layout-audits.mjs --tree <dir with node_modules> [--faces <dir>]
//
// Output: native/core/fixtures/office-xlsx-layout-audits/golden.json. The recording holds `workbooks` (the parts of each input
// package, by name), `layouts` (a workbook and the steps run over it: each step's answer, then the names of the package and
// every part that changed), `audits`, `merges` and `assertions` (snapshot documents and what the audit or the assertions
// answered) and `pure` (a helper over plain arguments). Column widths come from the fixture faces of office-measure, so the
// workbooks measure ASCII text in the Twin faces only. `--faces` names the folder of the faces when this checkout does not
// hold native/core/fixtures/office-measure.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-xlsx-layout-audits');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-xlsx-layout-audits.mjs';
const require = createRequire(join(tree, 'package.json'));
const JSZip = require('jszip');
const { GlobalFonts } = require('@napi-rs/canvas');

const FACES = args.has('faces') ? resolve(args.get('faces')) : join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const opc = await importFrom(tree, 'src/runtime/office/portable/portable-opc.mjs');
const pkg = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const cells = await importFrom(tree, 'src/runtime/office/portable/portable-cells.mjs');
const xlsx = await importFrom(tree, 'src/runtime/office/portable/portable-xlsx.mjs');
const layout = await importFrom(tree, 'src/runtime/office/portable/portable-xlsx-range-layout.mjs');
const pivotOps = await importFrom(tree, 'src/runtime/office/portable/portable-xlsx-pivot-ops.mjs');
const audit = await importFrom(tree, 'src/runtime/office/portable/xlsx-formula-audit.mjs');
const assertions = await importFrom(tree, 'src/runtime/office/portable/xlsx-assertions.mjs');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- the workbooks: a portable workbook whose every face is the fixture face, with what the operations write into it
async function dump(zip) {
  const parts = [];
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const text = await entry.async('string');
    if (text.includes('�')) continue;
    parts.push([name, text]);
  }
  return parts;
}

async function workbook(rows, operations = [], sheetName = 'Data') {
  const zip = await JSZip.loadAsync(await pkg.createPortableChartWorkbook(rows, { sheetName }));
  if (operations.length) await xlsx.applyXlsx(zip, operations);
  const styles = await opc.zipText(zip, 'xl/styles.xml');
  zip.file('xl/styles.xml', styles.replace(/<name val="[^"]*"\s*\/>/g, '<name val="Twin Miriam"/>'));
  return zip;
}

const workbooks = {};
const PEOPLE = [
  ['Name', 'Score', 'Region'],
  ['Tom', 30, 'North'],
  ['alice', 12.5, 'south'],
  ['Zed', 7, 'East'],
  ['bob', 12.5, 'West'],
  ['Ann', 100, 'north'],
];

workbooks.people = await dump(await workbook(PEOPLE));
workbooks.korean = await dump(
  await workbook([
    ['지역', '값'],
    ['제주', 3],
    ['강릉', 5],
    ['광주', 1],
    ['부산', 4],
  ])
);
workbooks.mixed = await dump(
  await workbook(
    [['Key', 'Note']],
    [
      { op: 'set_range', sheet: 'Data', range: 'A2:B8', values: [[10, 'ten'], ['9', 'nine text'], [null, 'blank'], ['abc', 'text'], [true, 'yes'], [2.5, 'frac'], ['', 'empty']] },
    ]
  )
);
workbooks.formulas = await dump(
  await workbook(
    PEOPLE.map((row, index) => (index === 0 ? [...row, 'Double', 'Ref'] : row)),
    [
      ...[2, 3, 4, 5, 6].map((row) => ({ op: 'set_formula', sheet: 'Data', cell: `D${row}`, formula: `=B${row}*2` })),
      ...[2, 3, 4, 5, 6].map((row) => ({ op: 'set_formula', sheet: 'Data', cell: `E${row}`, formula: `=Data!B${row}+Other!A1` })),
      { op: 'add_sheet', name: 'Other' },
      { op: 'set_cell', sheet: 'Other', cell: 'A1', value: 1 },
    ]
  )
);
workbooks.hidden = await dump(
  await workbook(PEOPLE, [{ op: 'set_row_visibility', sheet: 'Data', row: 4, visible: false }])
);
workbooks.merged = await dump(await workbook(PEOPLE, [{ op: 'merge_cells', sheet: 'Data', range: 'C3:C4' }]));
workbooks.offsheet = await dump(
  await workbook(
    [['Name', 'Prev'], ['x', 5], ['y', 3], ['z', 9]],
    [
      { op: 'set_formula', sheet: 'Data', cell: 'C2', formula: '=B2+1' },
      { op: 'set_formula', sheet: 'Data', cell: 'C3', formula: '=B1' },
      { op: 'set_formula', sheet: 'Data', cell: 'C4', formula: '=B3' },
    ]
  )
);

// A formula filled down is stored once, an array formula once for its block: the sort must refuse both where it would split them.
const SHEET_PATH = 'xl/worksheets/sheet1.xml';
workbooks.shared = await (async () => {
  const zip = await workbook([['Name', 'Qty'], ['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  const sheet = await opc.zipText(zip, SHEET_PATH);
  zip.file(
    SHEET_PATH,
    sheet.replace(
      /<row r="2"([^>]*)>([\s\S]*?)<\/row>/,
      (_all, attributes, inner) => `<row r="2"${attributes}>${inner}<c r="C2"><f t="shared" ref="C2:C5" si="0">B2*3</f><v>3</v></c></row>`
    ).replace(
      /<row r="3"([^>]*)>([\s\S]*?)<\/row>/,
      (_all, attributes, inner) => `<row r="3"${attributes}>${inner}<c r="C3"><f t="shared" si="0"/><v>6</v></c></row>`
    ).replace(
      /<row r="4"([^>]*)>([\s\S]*?)<\/row>/,
      (_all, attributes, inner) => `<row r="4"${attributes}>${inner}<c r="C4"><f t="shared" si="0"/><v>9</v></c></row>`
    ).replace(
      /<row r="5"([^>]*)>([\s\S]*?)<\/row>/,
      (_all, attributes, inner) => `<row r="5"${attributes}>${inner}<c r="C5"><f t="shared" si="0"/><v>12</v></c></row>`
    )
  );
  return dump(zip);
})();
workbooks.array = await (async () => {
  const zip = await workbook([['Name', 'Qty'], ['a', 1], ['b', 2], ['c', 3]]);
  const sheet = await opc.zipText(zip, SHEET_PATH);
  zip.file(
    SHEET_PATH,
    sheet
      .replace(/<row r="2"([^>]*)>([\s\S]*?)<\/row>/, (_all, attributes, inner) => `<row r="2"${attributes}>${inner}<c r="C2"><f t="array" ref="C2:C3">B2:B3*2</f><v>2</v></c></row>`)
      .replace(/<row r="3"([^>]*)>([\s\S]*?)<\/row>/, (_all, attributes, inner) => `<row r="3"${attributes}>${inner}<c r="C3"><v>4</v></c></row>`)
  );
  return dump(zip);
})();

// widths: ASCII text in the fixture face, figures under formats, a title alone in its row, a merged band, a wrapped line
workbooks.widths = await dump(
  await workbook(
    [
      ['Form title that runs on and on across the page', null, null, null],
      ['Item', 'Amount', 'Note', 'Share'],
      ['Short', 1234567.891, 'A longer note than the others carry', 0.25],
      ['Another row', 42, 'tiny', 0.5],
      ['X', 1000000, 'medium note', 0.125],
    ],
    [
      { op: 'set_style', sheet: 'Data', range: 'B3:B5', properties: { numberFormat: '#,##0.00' } },
      { op: 'set_style', sheet: 'Data', range: 'D3:D5', properties: { numberFormat: '0.0%' } },
      { op: 'set_style', sheet: 'Data', range: 'A2:D2', properties: { bold: true } },
      { op: 'set_style', sheet: 'Data', range: 'C3', properties: { fontSize: 16 } },
    ]
  )
);
workbooks.bands = await dump(
  await workbook(
    [
      ['Quarterly report banner text', null, null],
      ['Wrapped text that would be long but wraps in its cell', 'b', 'c'],
      ['Left', 'Middle column label', 'Right'],
    ],
    [
      { op: 'merge_cells', sheet: 'Data', range: 'A1:C1' },
      { op: 'set_style', sheet: 'Data', range: 'A2', properties: { wrapText: true } },
      { op: 'set_style', sheet: 'Data', range: 'B3', properties: { indent: 2 } },
    ]
  )
);
workbooks.formulaWidths = await (async () => {
  const zip = await workbook(
    [['Label', 'Sum'], ['row one', 1], ['row two', 2]],
    [{ op: 'set_formula', sheet: 'Data', cell: 'C2', formula: '=SUM(B2:B3)' }, { op: 'set_formula', sheet: 'Data', cell: 'C3', formula: '="a long computed result"' }]
  );
  const sheet = await opc.zipText(zip, SHEET_PATH);
  zip.file(SHEET_PATH, sheet.replace(/(<c r="C3"[^>]*>)<f>([^<]*)<\/f><v><\/v>/, '$1<f>$2</f><v>a long computed result</v>'));
  return dump(zip);
})();
workbooks.pivotSource = await dump(
  await workbook(
    [
      ['Region', 'Channel', 'Sales', 'Cost'],
      ['North', 'Web', 1204321, 10.5],
      ['South', 'Store', 20, 7.25],
      ['North', 'Store', 5000, 3],
      ['East', 'Web', 7, 1],
      ['South', 'Web', 301, 2],
    ],
    [
      { op: 'set_style', sheet: 'Data', range: 'C2:C6', properties: { numberFormat: '#,##0' } },
      { op: 'add_sheet', name: 'Report' },
    ]
  )
);
workbooks.pivotPlain = await dump(
  await workbook([['Region', 'Sales'], ['North', 10], ['South', 20], ['North', 5]], [{ op: 'add_sheet', name: 'Report' }])
);
workbooks.pivotBlankHeader = await dump(await workbook([['Region', null, 'Sales'], ['North', 'x', 10]]));

// ---- the cases: a workbook, the steps run over it
const sort = (sheet, op) => ({ kind: 'sort', sheet, op: { op: 'sort_range', ...op } });
const fit = (sheet, op) => ({ kind: 'autofit', sheet, op: { op: 'autofit_range', ...op } });
const pivot = (sheet, op) => ({ kind: 'pivot', sheet, op: { op: 'add_pivot_table', ...op } });

const LAYOUTS = [
  ['sort by the header named', 'people', [sort('Data', { range: 'A1:C6', by: 'Name' })]],
  ['sort descending by a letter', 'people', [sort('Data', { range: 'A1:C6', by: 'B', order: 'desc' })]],
  ['sort by the second column ascending then by the first', 'people', [sort('Data', { range: 'A1:C6', by: 'Score' }), sort('Data', { range: 'A1:C6' })]],
  ['sort by lower case letter and a descending word', 'people', [sort('Data', { range: 'A1:C6', column: 'c', order: ' DESCENDING ' })]],
  ['sort with no header row', 'people', [sort('Data', { range: 'A1:C6', hasHeader: false, by: 'A' })]],
  ['sort a sub range', 'people', [sort('Data', { range: 'A3:C5', hasHeader: false, byColumn: 'B' })]],
  ['sort a one cell range', 'people', [sort('Data', { range: 'A2' })]],
  ['sort a header only range', 'people', [sort('Data', { range: 'A1:C1' })]],
  ['sort case folding and numeric text', 'people', [sort('Data', { range: 'A1:C6', by: 'Region' })]],
  ['sort numbers before text and blanks last, both ways', 'mixed', [sort('Data', { range: 'A1:B8' }), sort('Data', { range: 'A1:B8', order: 'desc' })]],
  ['sort Korean text by the reader locale', 'korean', [sort('Data', { range: 'A1:B5' })]],
  ['sort by a header the range does not carry refuses', 'people', [sort('Data', { range: 'A1:C6', by: 'Missing' })]],
  ['sort by a letter outside the range refuses', 'people', [sort('Data', { range: 'A1:B6', by: 'C' })]],
  ['sort with no header row lists no headers', 'people', [sort('Data', { range: 'A2:C6', hasHeader: false, by: 'Nope', order: 'asc' })]],
  ['sort an invalid range refuses', 'people', [sort('Data', { range: 'A:C' }), sort('Data', {}), sort('Data', { range: 'B2' }), sort('Data', { range: 'Other!A1:B2' })]],
  ['sort carries formulas with their rows', 'formulas', [sort('Data', { range: 'A1:E6', by: 'Name' })]],
  ['sort that moves a formula off the sheet refuses', 'offsheet', [sort('Data', { range: 'A1:C4', by: 'Prev' })]],
  ['sort refuses a filled down formula it would split', 'shared', [sort('Data', { range: 'A1:C3', by: 'Name', order: 'desc' }), sort('Data', { range: 'A1:C5', by: 'B', order: 'desc' })]],
  ['sort refuses part of an array', 'array', [sort('Data', { range: 'A1:C4', by: 'Qty', order: 'desc' })]],
  ['sort refuses hidden rows', 'hidden', [sort('Data', { range: 'A1:C6', by: 'Name' }), sort('Data', { range: 'A1:C3', by: 'Name' })]],
  ['sort refuses merged cells', 'merged', [sort('Data', { range: 'A1:C6', by: 'Name' })]],
  ['autofit sizes every column to its text and figures', 'widths', [fit('Data', { range: 'A2:D5' })]],
  ['autofit a title alone in its row spills over its neighbours', 'widths', [fit('Data', { range: 'A1:D5' })]],
  ['autofit one column keeps a title in it', 'widths', [fit('Data', { range: 'A1:A5' })]],
  ['autofit whole columns and a minimum width', 'widths', [fit('Data', { range: 'A:D', minWidth: 14 })]],
  ['autofit a minimum width reaches the empty columns', 'widths', [fit('Data', { range: 'A1:F5', minWidth: 20 })]],
  ['autofit a huge minimum width is capped', 'widths', [fit('Data', { range: 'B2:B3', minWidth: 500 })]],
  ['autofit a row range sets no column', 'widths', [fit('Data', { range: '1:3', rows: true })]],
  ['autofit rows with columns named measures them', 'widths', [fit('Data', { range: 'A1:B3', rows: true })]],
  ['autofit skips merged bands, honours wrap and indent', 'bands', [fit('Data', { range: 'A1:C3' })]],
  ['autofit measures what a formula shows', 'formulaWidths', [fit('Data', { range: 'A1:C3' })]],
  ['autofit refuses a range it cannot read', 'widths', [fit('Data', { range: 'Data!A1:B2' }), fit('Data', {})]],
  ['a pivot table by region', 'pivotSource', [pivot('Data', { source: 'A1:D6', rows: 'Region', values: 'Sales' })]],
  ['a pivot table by region and channel formatted like its source', 'pivotSource', [pivot('Data', { source: 'A1:D6', rows: ['Region'], columns: 'Channel', values: ['Sales'], destination: 'F2', name: 'ByChannel' })]],
  ['a pivot table on another sheet with two value fields', 'pivotSource', [pivot('Data', { source: 'A1:D6', rows: 'Region', values: ['Sales', 'Cost'], destinationSheet: 'Report', destination: 'B3' })]],
  ['a pivot table with no row field', 'pivotSource', [pivot('Data', { source: 'A1:D6', columns: 'Channel', values: 'Sales' })]],
  ['a pivot table over a plain source and a second one', 'pivotPlain', [pivot('Data', { source: 'A1:B4', rows: 'Region', values: 'Sales', destination: 'E1' }), pivot('Data', { source: 'A1:B4', rows: 'Region', values: 'Sales', destination: 'H1', name: 'Again' })]],
  ['a pivot table refuses what it cannot lay out', 'pivotSource', [
    pivot('Data', { source: 'A1:D6', rows: 'Region' }),
    pivot('Data', { source: 'A1:D6', rows: ['Region', 'Channel'], values: 'Sales' }),
    pivot('Data', { source: 'A1:D6', columns: ['Region', 'Channel'], values: 'Sales' }),
    pivot('Data', { source: 'A1:D6', rows: 'Region', columns: 'Channel', values: ['Sales', 'Cost'] }),
    pivot('Data', { source: 'A1:D6', rows: 'Nope', values: 'Sales' }),
    pivot('Data', { source: 'A1:D6', rows: 'Region', values: 'Nope' }),
    pivot('Data', { source: 'A1:D6', rows: 'Region', values: 'Sales', destinationSheet: 'Missing' }),
    pivot('Data', { source: 'A1:D1', rows: 'Region', values: 'Sales' }),
    pivot('Data', { source: 'A:D', rows: 'Region', values: 'Sales' }),
    pivot('Data', { source: 'A1', rows: 'Region', values: 'Sales' }),
    pivot('Data', { rows: 'Region', values: 'Sales' }),
  ]],
  ['a pivot table needs a name in every header cell', 'pivotBlankHeader', [pivot('Data', { source: 'A1:C2', rows: 'Region', values: 'Sales' })]],
];

async function runStep(zip, step) {
  const sheets = await cells.workbookSheets(zip);
  const sheet = sheets.find((entry) => entry.name === step.sheet);
  const xml = await opc.zipText(zip, sheet.path);
  if (step.kind === 'sort') return layout.sortWorksheetRange(zip, sheet, xml, step.op);
  if (step.kind === 'autofit') return layout.autofitWorksheetRange(zip, sheet, xml, step.op);
  if (step.kind === 'pivot') return pivotOps.addWorksheetPivotTable(zip, sheet, xml, step.op);
  throw new Error(`unknown step ${step.kind}`);
}

const layouts = [];
for (const [name, workbookName, steps] of LAYOUTS) {
  const zip = await JSZip.loadAsync(await zipOf(workbooks[workbookName]));
  const before = new Map(workbooks[workbookName]);
  const outputs = [];
  for (const step of steps) outputs.push(await attempt(() => runStep(zip, step)));
  const after = await dump(zip);
  layouts.push({
    name,
    workbook: workbookName,
    steps,
    outputs,
    names: after.map(([part]) => part),
    changed: after.filter(([part, text]) => before.get(part) !== text),
  });
}

async function zipOf(parts) {
  const zip = new JSZip();
  for (const [name, text] of parts) zip.file(name, text);
  return zip.generateAsync({ type: 'uint8array' });
}

// ---- the audit: the snapshot sheets of xlsx-formula-audit.test.mjs and what else the rules read
const sheet = (name, list) => ({
  name,
  path: `/sheet[${name}]`,
  cells: list.map(([ref, entry]) => ({ ref, path: `/sheet[${name}]/cell[${ref}]`, ...entry })),
});

const model = sheet('Model', [
  ['A1', { value: 'Growth', style: { bold: true } }],
  ['B1', { value: 0.05 }],
  ['B2', { value: 100 }],
  ['C2', { formula: 'B2*(1+$B$1)', value: 105 }],
  ['D2', { formula: 'C2*(1+$B$1)', value: 110.25 }],
  ['E2', { formula: 'D2*1.1', value: 121.3 }],
  ['F2', { formula: 'E2*(1+$B$1)', value: 127.3 }],
  ['G2', { formula: 'F2*(1+$B$1)', value: 133.7 }],
  ['B3', { value: 10 }],
  ['C3', { formula: 'B3+1', value: 11 }],
  ['D3', { value: 12 }],
  ['E3', { formula: 'D3+1', value: 13 }],
  ['F3', { value: 14 }],
  ['B4', { formula: 'B2/B3', value: 10 }],
  ['B5', { value: 15, style: { numberFormat: '0.0%' } }],
  ['B6', { value: 2024, style: { numberFormat: '#,##0' } }],
  ['B7', { formula: "Input Sheet!B2+'Input Sheet'!B3", value: 3 }],
  ['B8', { formula: "'[1]Returns Analysis'!$B$2", value: 9 }],
  ['B9', { value: 7 }],
  ['B10', { value: 8 }],
]);
const tableOf = (style) => ({
  ...sheet('Sales', [
    ['A1', { value: 'Region' }],
    ['B1', { value: 'Revenue' }],
    ['A2', { value: '서울' }],
    ['B2', { value: 1200, style: { numberFormat: '#,##0' } }],
    ['A3', { value: '부산' }],
    ['B3', { value: 900, style: { numberFormat: '#,##0' } }],
    ['A4', { value: '대구' }],
    ['B4', { value: 640, style: { numberFormat: '#,##0' } }],
    ['A5', { value: '대전' }],
    ['B5', { value: 480, style }],
  ]),
  tables: [{ name: 'Sales', range: 'A1:B5' }],
});
const downward = sheet('Schedule', [
  ['A1', { value: '분기', dataType: 'text' }],
  ['B1', { value: '매출', dataType: 'text' }],
  ['C1', { value: '누계', dataType: 'text' }],
  ['A2', { value: '1분기', dataType: 'text' }],
  ['B2', { value: 100 }],
  ['C2', { formula: 'SUM($B$2:B2)', value: 100 }],
  ['A3', { value: '2분기', dataType: 'text' }],
  ['B3', { value: 110 }],
  ['C3', { formula: 'SUM($B$2:B3)', value: 210 }],
  ['A4', { value: '3분기', dataType: 'text' }],
  ['B4', { value: 120 }],
  ['C4', { value: 330 }],
  ['A5', { value: '4분기', dataType: 'text' }],
  ['B5', { value: 130 }],
  ['C5', { formula: 'SUM($B$2:B5)', value: 460 }],
]);
const longRows = [];
for (let row = 2; row <= 30; row += 1) {
  longRows.push([`A${row}`, { value: `item ${row}`, dataType: 'text' }], [`B${row}`, { value: row * 10 }], [`C${row}`, { value: 2000 + (row % 5) }]);
}
const long = {
  ...sheet('Long', [
    ['A1', { value: 'Item', dataType: 'text' }],
    ['B1', { value: 'Amount', dataType: 'text' }],
    ['C1', { value: 'Year', dataType: 'text' }],
    ...longRows,
  ]),
  freezePanes: { frozen: false, splitRow: 0, splitColumn: 0 },
  tables: [{ path: '/sheet[Long]/table[1]', index: 1, name: 'Items', range: 'A1:C30' }],
};
const formattedLong = {
  ...long,
  freezePanes: { frozen: true, splitRow: 1, splitColumn: 0 },
  cells: long.cells.map((cell) => (/^B(?:[2-9]|[1-3]\d)$/.test(cell.ref) ? { ...cell, style: { numberFormat: '#,##0' } } : cell)),
};
const reaching = sheet('Model', [
  ['A1', { value: 'Revenue', dataType: 'text' }],
  ['B1', { value: 100 }],
  ['B2', { value: 110 }],
  ['B3', { value: 120 }],
  ['C3', { formula: 'SUM(B1:B100)', value: 330 }],
  ['C4', { formula: 'B6*2', value: 0 }],
  ['C5', { formula: 'Other!Z99+D2', value: 0 }],
]);
const notesModel = sheet('Model', [
  ['B1', { value: 0.05, note: 'user brief 2026-09-06' }],
  ['B2', { value: 100 }],
  ['C2', { formula: 'B2*(1+$B$1)', value: 105 }],
  ['E9', { value: 42 }],
]);
const checks = {
  ...sheet('Checks', [
    ['A1', { value: 'Revenue ties' }],
    ['B1', { formula: 'ROUND(Model!C2-105,2)=0', value: true }],
    ['B2', { formula: 'Model!B2=99', cachedValue: false, value: false }],
    ['B3', { value: 3 }],
  ]),
  notes: [{ cell: 'B3', text: 'count of checks' }],
};
const dataTable = {
  ...sheet('Data', [
    ['A1', { value: 'Item' }],
    ['B1', { value: 'Qty' }],
    ['B2', { value: 4 }],
    ['B3', { value: 6 }],
    ['B4', { formula: 'SUM(B2:B3)', value: 10 }],
    ['B9', { value: 9 }],
  ]),
  tables: [{ path: '/sheet[Data]/table[1]', index: 1, name: 'Items', range: 'A1:B3', style: '' }],
};
const inputRow = sheet('Plan', [
  ['A1', { value: '항목' }],
  ['A2', { value: '출고 건수' }],
  ['B2', { value: 11800 }],
  ['C2', { value: 12100 }],
  ['D2', { value: 12400 }],
  ['A3', { value: '1인당' }],
  ['B3', { formula: 'B2/40', value: 295 }],
  ['C3', { formula: 'C2/40', value: 302 }],
  ['D3', { formula: 'D2/40', value: 310 }],
]);
const planCells = [
  ['A1', { value: '항목' }],
  ['B1', { value: '단가' }],
  ['B2', { value: 3200000 }],
  ['C2', { value: 12 }],
  ['B3', { value: 6000000 }],
  ['C3', { value: 2 }],
  ['B4', { value: 4500000 }],
  ['C4', { value: 2 }],
  ['D2', { formula: 'B2*C2', value: 38400000 }],
  ['D3', { formula: 'B3*C3', value: 12000000 }],
  ['D4', { formula: 'B4*C4', value: 9000000 }],
];
const recalculated = planCells.map(([ref, cell]) => [ref, { ...cell, style: { fontName: 'Calibri', fontSize: 11, numberFormat: 'General' } }]);
const designed = recalculated.map(([ref, cell]) =>
  ref.endsWith('1') ? [ref, { ...cell, style: { ...cell.style, bold: true, fillColor: '1F6F8B', color: 'FFFFFF' } }] : [ref, cell]
);
const manyIssues = sheet(
  'Wide',
  Array.from({ length: 120 }, (_, index) => [`A${index + 1}`, { value: `${index + 1},234`, dataType: 'text' }])
);

const AUDITS = [
  [
    'a formula reading a defined name that links to another workbook',
    [
      sheet('Plan', [
        ['B2', { formula: '=FxRate*A2', value: 1300 }],
        ['B3', { formula: '=FxRateLocal*A3', value: 1 }],
        ['B4', { formula: '="FxRate"&A4', value: 'FxRate1' }],
        ['B5', { formula: '=Local*A5', value: 2 }],
      ]),
    ],
    { definedNames: [{ name: 'FxRate', refersTo: '[1]Rates!$B$2' }, { name: 'FxRateLocal', refersTo: 'Plan!$A$1' }, { name: 'Local', refersTo: 'Plan!$A$1' }] },
  ],
  ['the same formulas with no defined names', [sheet('Plan', [['B2', { formula: '=FxRate*A2', value: 1300 }]])], {}],
  ['a table column where one row wears another number format', [tableOf({ numberFormat: '0.00' })], {}],
  ['a table column whose formats agree', [tableOf({ numberFormat: '#,##0' })], {}],
  [
    'a total whose range covers a subtotal',
    [sheet('Ops', [['A1', { value: 'Region' }], ['B2', { value: 10 }], ['B3', { value: 20 }], ['B4', { value: 30 }], ['B5', { formula: 'SUM(B2:B4)', value: 60 }], ['B6', { formula: 'SUM(B2:B5)', value: 120 }]])],
    {},
  ],
  [
    'running totals, detail totals and derived rows are not double counting',
    [sheet('Ops', [
      ['B2', { value: 10 }],
      ['B3', { formula: 'C3*D3', value: 20 }],
      ['B4', { value: 30 }],
      ['B5', { formula: 'SUM(B2:B4)', value: 60 }],
      ['C2', { formula: 'SUM($B$2:B2)', value: 10 }],
      ['C3', { formula: 'SUM($B$2:B3)', value: 30 }],
      ['C4', { formula: 'SUM($B$2:B4)', value: 60 }],
      ['E5', { formula: "SUM('Detail Rows'!B2:B4)", value: 60 }],
    ])],
    {},
  ],
  ['a subtotal counted twice across columns and by cell terms', [sheet('Ops', [
    ['B2', { value: 1 }], ['B3', { value: 2 }], ['B4', { formula: 'B2+B3', value: 3 }], ['B5', { formula: 'SUM(B2:B3,B4)', value: 6 }],
    ['C2', { value: 1 }], ['C3', { value: 2 }], ['C4', { formula: 'SUM(C2:C3)', value: 3 }], ['D6', { formula: 'SUM(B2:C5)', value: 9 }],
  ])], {}],
  ['the financial model sheet', [model], { auditProfile: 'financial-model', sheetNames: ['Model', 'Input Sheet'] }],
  ['the downward schedule', [downward], { auditProfile: 'financial-model', sheetNames: ['Schedule'] }],
  ['the model under no profile', [model], { sheetNames: ['Model', 'Input Sheet'] }],
  ['the model with a blue input', [{ ...model, cells: model.cells.map((cell) => (cell.ref === 'B2' ? { ...cell, style: { color: 16711680 } } : cell)) }], { auditProfile: 'financial-model' }],
  ['a column of quantities under a thousands separator', [sheet('Volume', [
    ['A1', { value: '월', dataType: 'text' }], ['B1', { value: '처리량 (건)', dataType: 'text' }],
    ['B2', { value: 1000, style: { numberFormat: '#,##0' } }], ['B3', { value: 2096, style: { numberFormat: '#,##0' } }], ['B4', { value: 2507, style: { numberFormat: '#,##0' } }],
  ])], {}],
  ['a column of years under a thousands separator', [sheet('Plan', [
    ['A1', { value: '연도', dataType: 'text' }], ['A2', { value: 2024, style: { numberFormat: '#,##0' } }], ['A3', { value: 2025, style: { numberFormat: '#,##0' } }],
  ])], {}],
  ['numbers stored as text', [sheet('Text', [
    ['A2', { value: '1,234', dataType: 'text' }], ['B2', { value: '15%', dataType: 'text' }], ['C2', { value: '2024', dataType: 'text' }],
    ['D2', { value: 'Q1 2024', dataType: 'text' }], ['E2', { value: '42' }],
  ])], {}],
  ['more findings of one code than are kept', [manyIssues], {}],
  ['a long sheet whose header scrolls away', [long], {}],
  ['a long sheet with two unformatted columns', [{ ...long, cells: long.cells.map((cell) => (/^C\d+$/.test(cell.ref) && cell.ref !== 'C1' ? { ...cell, value: Number(String(cell.value).slice(-2)) || 12 } : cell)) }], {}],
  ['a formatted long sheet is clean', [formattedLong], {}],
  ['a sheet whose freeze state is unknown', [{ ...formattedLong, freezePanes: null }], {}],
  ['a truncated read names the last row of the sheet', [{ ...long, truncated: true, lastRow: 400 }], {}],
  ['single references past the populated extent', [reaching], { auditProfile: 'financial-model' }],
  ['the same without a profile', [reaching], {}],
  ['notes, the Checks sheet and table bodies', [notesModel, checks], { auditProfile: 'financial-model' }],
  ['records inside a table', [dataTable], { auditProfile: 'financial-model' }],
  ['one unsourced input line is one finding', [inputRow], { auditProfile: 'financial-model' }],
  ['unmarked inputs of a plain sheet', [sheet('Plan', planCells)], { auditProfile: 'financial-model' }],
  ['unmarked inputs after a recalculation', [sheet('Plan', recalculated)], { auditProfile: 'financial-model' }],
  ['unmarked inputs of a designed sheet', [sheet('Plan', designed)], { auditProfile: 'financial-model' }],
  ['a Korean checks sheet', [{ ...sheet('검증', [['A1', { formula: '1=2', value: false }], ['A2', { formula: '1=1', value: 'FALSE' }]]) }], { auditProfile: 'financial-model' }],
  ['sheets without cells and cells without a reference', [{ name: 'Empty' }, { name: 'Bare', cells: [{ value: 1 }] }, sheet('One', [['B2', { formula: 'A1/A2', value: 1 }]])], { auditProfile: 'financial-model' }],
  ['a hardcode between formulas of a row and after them', [sheet('Row', [
    ['A1', { value: 5 }], ['B1', { formula: 'A1+1', value: 6 }], ['C1', { value: 9 }], ['D1', { formula: 'C1+1', value: 10 }], ['E1', { value: 4 }],
  ])], { auditProfile: 'financial-model' }],
  ['a lone formula inside a row of a pattern', [sheet('Line', [
    ['A5', { formula: 'A1*2', value: 2 }], ['B5', { formula: 'B1*2', value: 2 }], ['C5', { formula: 'C1+7', value: 2 }], ['D5', { formula: 'D1*2', value: 2 }], ['E5', { formula: 'E1*2', value: 2 }],
    ['A6', { value: 1 }], ['B6', { value: 1 }], ['C6', { value: 1 }], ['D6', { value: 1 }], ['E6', { value: 1 }],
  ])], { auditProfile: 'financial-model' }],
  ['no sheets', [], { auditProfile: 'financial-model' }],
];
const audits = [];
for (const [name, sheets, options] of AUDITS) {
  audits.push({ name, sheets, options, output: await attempt(() => audit.auditXlsxFormulas(sheets, options)) });
}

// ---- the merge of the audit into a host's answer
const MERGES = [
  [
    'a host verdict that the shared audit owns is replaced',
    { ok: true, issues: [
      { severity: 'warning', code: 'failed_check', path: '/sheet[Checks]/cell[B2]', message: 'host' },
      { severity: 'warning', code: 'hardcode_missing_source', path: '/sheet[Model]/cell[E9]', message: 'Hardcoded numeric input has no source comment.' },
    ] },
    { sheets: [notesModel, checks] },
    { auditProfile: 'financial-model' },
  ],
  ['a scoped request stays scoped', { issues: [] }, { sheets: [notesModel, checks] }, { auditProfile: 'financial-model', sheet: 'Checks' }],
  [
    'a sheet the shared audit never read keeps the host verdict',
    { ok: true, issues: [{ severity: 'warning', code: 'hardcode_missing_source', path: '/sheet[Big]/cell[B1501]', message: 'host' }] },
    { sheets: [{ name: 'Big', path: '/sheet[Big]', rows: 1501, columns: 10 }, notesModel] },
    { auditProfile: 'financial-model' },
  ],
  [
    'a truncated read replaces only the cells it read',
    { ok: true, issues: [
      { severity: 'warning', code: 'hardcode_missing_source', path: '/sheet[Big]/cell[B1501]', message: 'host' },
      { severity: 'warning', code: 'hardcode_missing_source', path: '/sheet[Big]/cell[B1]', message: 'host' },
    ] },
    { sheets: [{ ...sheet('Big', [['A1', { value: 'x' }], ['B1', { value: 21 }]]), truncated: true }] },
    { auditProfile: 'financial-model' },
  ],
  ['a result that is not an object and a document without sheets', null, {}, {}],
  ['a host result carrying its own fields', { ok: false, note: 'kept', issueCount: 9, issues: [{ code: 'x', path: '/', message: 'm' }] }, { sheets: [model], definedNames: [] }, { sheet: 'Model' }],
];
const merges = [];
for (const [name, result, document, options] of MERGES) {
  merges.push({ name, result, document, options, output: await attempt(() => audit.mergeXlsxFormulaAudit(result, document, options)) });
}

// ---- the assertions
const book = {
  sheets: [
    { name: 'Model', cells: [
      { ref: 'A1', value: 'Total', path: '/sheet[Model]/cell[A1]' },
      { ref: 'B1', value: 100, path: '/sheet[Model]/cell[B1]' },
      { ref: 'B2', value: '100.004', path: '/sheet[Model]/cell[B2]' },
      { ref: 'B3', formula: 'B1+B2', value: 200.004, cachedValue: 200.004, path: '/sheet[Model]/cell[B3]' },
      { ref: 'B4', formula: 'B1+C1', value: '', path: '/sheet[Model]/cell[B4]' },
      { ref: 'C2', value: '#DIV/0!', formula: 'B1/0' },
      { ref: 'C3', value: 3, formula: 'B1+B2' },
      { ref: 'C4', value: 4, formula: 'C3+C2' },
      { ref: 'C5', value: 5, formula: 'C4*C2' },
    ] },
    { name: 'Other Sheet', rowBlocks: [{ rows: [{ cells: [{ ref: 'A1', value: 7, path: '/sheet[Other Sheet]/cell[A1]' }, { ref: 'A2', value: '#REF!' }] }] }], cells: [{ ref: 'B1', value: false }] },
  ],
};
const ASSERTIONS = [
  ['cell values by number, text and tolerance', [
    { kind: 'cell-value', cell: 'B1', equals: 100 },
    { kind: 'CELL-VALUE', sheet: 'model', cell: 'b2', equals: 100, tolerance: 0.01 },
    { kind: 'cell-value', cell: 'B2', equals: 100 },
    { kind: 'cell-value', cell: 'A1', equals: 'Total' },
    { kind: 'cell-value', cell: 'A1', equals: 'total' },
    { kind: 'cell-value', cell: 'Z9', equals: 1 },
    { kind: 'cell-value', sheet: 'Other Sheet', cell: 'B1', equals: false },
    { kind: 'cell-value', sheet: 'Other Sheet', cell: 'A1', equals: '7' },
    { kind: 'cell-value', cell: 'B1', equals: 100, tolerance: 'x' },
  ]],
  ['a formula with no result is never compared', [
    { kind: 'cell-value', cell: 'B4', equals: 0 },
    { kind: 'cell-value', cell: 'B4', equals: 'x' },
    { kind: 'cell-value', cell: 'B4' },
  ]],
  ['formula assertions', [
    { kind: 'cell-formula', cell: 'B3', equals: '=B1+B2' },
    { kind: 'cell-formula', cell: 'B3', equals: 'B1+B2' },
    { kind: 'cell-formula', cell: 'B3', equals: 'B1+B3' },
    { kind: 'cell-formula', cell: 'B3', matches: '^B1\\+' },
    { kind: 'cell-formula', cell: 'B3', matches: '^=' },
    { kind: 'cell-formula', cell: 'B3', matches: '' },
    { kind: 'cell-formula', cell: 'B1', equals: null },
    { kind: 'cell-formula', cell: 'Q1', matches: 'x' },
  ]],
  ['a formula assertion with a pattern that is not one', [{ kind: 'cell-formula', cell: 'B3', matches: '(' }]],
  ['tie outs by reference, literal and object', [
    { kind: 'tie-out', left: 'B1', right: 100 },
    { kind: 'tie-out', left: 'Model!B1', right: "'Other Sheet'!A1" },
    { kind: 'tie-out', left: { sheet: 'Other Sheet', cell: 'a1' }, right: 7 },
    { kind: 'tie-out', left: '$B$3', right: 'B2', tolerance: 100 },
    { kind: 'tie-out', left: 'B1', right: 'B2', tolerance: 0.01 },
    { kind: 'tie-out', left: 'B4', right: 'B4' },
    { kind: 'tie-out', left: 'B1', right: 'B4' },
    { kind: 'tie-out', left: 'nothing', right: 'B1' },
    { kind: 'tie-out', left: 'Missing!B1', right: 'B1' },
    { kind: 'tie-out', right: 5 },
  ]],
  ['no errors', [
    { kind: 'no-errors' },
    { kind: 'no-errors', sheet: 'Other Sheet' },
    { kind: 'no-errors', range: 'B1:B4' },
    { kind: 'no-errors', sheet: 'Model', range: '$C$1:$C$5' },
    { kind: 'no-errors', range: 'C2:C2' },
  ]],
  ['formula consistency', [
    { kind: 'formula-consistency', range: 'C2:C5' },
    { kind: 'formula-consistency', range: 'B1:B4' },
    { kind: 'formula-consistency', sheet: 'Other Sheet' },
    { kind: 'formula-consistency' },
  ]],
  ['unknown and missing kinds', [{ kind: 'mystery' }, {}, { kind: '' }]],
  ['no assertions', []],
];
const assertionRuns = [];
for (const [name, list] of ASSERTIONS) {
  assertionRuns.push({ name, document: book, assertions: list, output: await attempt(() => assertions.evaluateXlsxAssertions(book, list)) });
}
assertionRuns.push({ name: 'a document without sheets', document: null, assertions: [{ kind: 'cell-value', cell: 'A1', equals: 1 }, { kind: 'no-errors' }], output: await attempt(() => assertions.evaluateXlsxAssertions(null, [{ kind: 'cell-value', cell: 'A1', equals: 1 }, { kind: 'no-errors' }])) });

// ---- the helpers over plain arguments
const PURE = [
  ['relativeFormulaSignature', ['=B2*(1+$B$10)', 'C2']],
  ['relativeFormulaSignature', ['=C2*(1+$B$10)', 'D2']],
  ['relativeFormulaSignature', ['=B2*1.1', 'C2']],
  ['relativeFormulaSignature', ['=IF(A1="B2",LOG10(A1),0)', 'C1']],
  ['relativeFormulaSignature', ['=sum(a1:b2)+$A$1+A$1+$A1', 'c3']],
  ['relativeFormulaSignature', ['=A1+B2', 'not a cell']],
  ['relativeFormulaSignature', ['', 'A1']],
  ['inlineConstants', ['=B5*1.05']],
  ['inlineConstants', ['=B5*(1+0.05)']],
  ['inlineConstants', ['=ROUND(B5/12,2)*100']],
  ['inlineConstants', ['=B5*(1+$B$6)']],
  ['inlineConstants', ['=B5 * 0.07 + 3 ^ 4 - 0.2']],
  ['inlineConstants', ['="1.05"*B1+Sheet1!A2*7.5']],
  ['unguardedDivision', ['=B5/C5']],
  ['unguardedDivision', ['=B5/(C5-D5)']],
  ['unguardedDivision', ['=B5/100']],
  ['unguardedDivision', ['=IFERROR(B5/C5,0)']],
  ['unguardedDivision', ['=IF(C5=0,0,B5/C5)']],
  ['unguardedDivision', ['=1/(1+Assumptions!$B$9)^(C$3-$B$3)']],
  ['unguardedDivision', ['=C7/(1+$B$9)']],
  ['unguardedDivision', ['=C7/(1+$B$9)/D7']],
  ['unguardedDivision', ['=A1/_x+B2/\'q\'']],
  ['singleCellReferences', ["=SUM(B2:B9)/B10+'Other Sheet'!Z99+Other!C40+$D$3"]],
  ['singleCellReferences', ['=a1+B$2*c$3+$D4']],
  ['isChecksSheetName', ['Checks']],
  ['isChecksSheetName', ['  CHECK ']],
  ['isChecksSheetName', ['검증']],
  ['isChecksSheetName', ['점검 ']],
  ['isChecksSheetName', ['Model']],
  ['isChecksSheetName', [null]],
];
const pure = [];
for (const [fn, fnArgs] of PURE) {
  const run = { relativeFormulaSignature: audit.relativeFormulaSignature, inlineConstants: audit.inlineConstants, unguardedDivision: audit.unguardedDivision, singleCellReferences: audit.singleCellReferences, isChecksSheetName: audit.isChecksSheetName }[fn];
  pure.push({ fn, args: fnArgs, ...(await attempt(() => run(...fnArgs))) });
}

writeJson(join(stage, 'golden.json'), {
  engine: '@napi-rs/canvas',
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  workbooks,
  layouts,
  audits,
  merges,
  assertions: assertionRuns,
  pure,
});
writeSetManifest(stage, { set: 'office-xlsx-layout-audits', recorder, command: `node ${recorder} --tree <dir with node_modules>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`wrote ${join(finalDir, 'golden.json')}`);
