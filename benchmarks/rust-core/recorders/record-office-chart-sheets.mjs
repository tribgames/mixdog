#!/usr/bin/env node
// What portable-chart.mjs, portable-sheet-page.mjs and portable-shared-formulas.mjs answer, run through Node: the chart
// part text for every chart family and option, the geometry and page-setup text of worksheets (with the widths measured in
// the fixture faces of office-measure), and the formulas a shared or array formula gives the cells it covers. Rust
// `mixdog-ooxml` must answer the same (crates/mixdog-ooxml/tests/twin_chart_sheets.rs): chart XML, worksheet XML and the
// workbook's defined names equal as text, expanded formulas equal, text widths within 1e-3.
//
//   node benchmarks/rust-core/recorders/record-office-chart-sheets.mjs --tree <dir with node_modules> [--faces <dir>]
//
// `--faces` names the folder of the fixture faces when this checkout does not hold native/core/fixtures/office-measure.
// Output: native/core/fixtures/office-chart-sheets/golden.json.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const recorder = 'benchmarks/rust-core/recorders/record-office-chart-sheets.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-chart-sheets');
const stage = stageSet(finalDir);
const { GlobalFonts } = createRequire(join(tree, 'package.json'))('@napi-rs/canvas');

const FACES = args.has('faces') ? resolve(args.get('faces')) : join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const chart = await importFrom(tree, 'src/runtime/office/portable/portable-chart.mjs');
const page = await importFrom(tree, 'src/runtime/office/portable/portable-sheet-page.mjs');
const shared = await importFrom(tree, 'src/runtime/office/portable/portable-shared-formulas.mjs');
const cells = await importFrom(tree, 'src/runtime/office/portable/portable-cells.mjs');
const opc = await importFrom(tree, 'src/runtime/office/portable/portable-opc.mjs');
const pkg = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-chart-sheets-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- charts ---------------------------------------------------------------------------------------------------------

const MONTHS = ['1월', '2월', '3월', '4월'];
const ONE = [{ name: '처리량', values: [4610, 4720, 4580, 4900] }];
const TWO = [
  { name: 'A & B', values: [10, 20.5, 30, 40] },
  { name: 'C', values: [5, '7', null, 'x'] },
];
const LOSS = [{ name: '손익', values: [12, -8, 5, -1.5] }];
const THREE = [
  { name: 'North', values: [1, 2, 3, 4], color: '#c00', numberFormat: '0.0%' },
  { name: 'South', values: [4, 3, 2, 1], color: 'abc' },
  { name: 'East', values: [2, 2, 2, 2], color: 'not a colour' },
];
const CHARTS = [];
const add = (name, spec) => CHARTS.push({ name, spec });
for (const chartType of ['column', 'bar', 'stacked_column', 'stacked_bar', 'line', 'area', 'pie', 'doughnut']) {
  add(`${chartType}, one series`, { chartType, title: 'Throughput', categories: MONTHS, series: ONE });
  add(`${chartType}, two series with a legend and labels`, { chartType, categories: MONTHS, series: TWO, showValues: true, valueNumberFormat: '#,##0' });
  add(`${chartType}, three series coloured`, {
    chartType,
    title: 'T <&> "q"',
    categories: MONTHS,
    series: THREE,
    showLegend: true,
    showValues: true,
    dataLabelColor: '#336699',
  });
  add(`${chartType}, a loss`, { chartType, categories: MONTHS, series: LOSS, showValues: true, dataLabelPosition: 'outside_end' });
  add(`${chartType}, slide text and font`, { chartType, title: '제목', categories: MONTHS, series: ONE, font: 'Malgun Gothic', textKind: 'slide', showValues: true });
}
for (const position of ['inside_end', 'inside_base', 'outside_end', 'center', 'centre', 'best_fit', 'Best_Fit', 'nowhere', '']) {
  for (const chartType of ['column', 'stacked_column', 'line', 'pie']) {
    add(`labels ${position} on ${chartType}`, { chartType, categories: MONTHS, series: ONE, showValues: true, dataLabelPosition: position });
  }
}
for (const chartType of [' Stacked-Column ', 'STACKED  BAR', 'stacked-bar', 'Pie', '', undefined, 'Doughnut', 'scatter', 'radar', 'column chart']) {
  add(`chart type ${JSON.stringify(chartType)}`, { chartType, categories: MONTHS, series: ONE });
}
add('no series', { categories: MONTHS, series: [] });
add('series without values', { categories: MONTHS, series: [{ name: 'x' }, null, 'text', { values: 'abc' }] });
add('no categories', { series: [{ name: 'x', values: [1, 2] }] });
add('no chart at all', {});
const TWO_MONTHS = ['1월', '2월'];
const RISING = [{ name: '처리량', values: [4610, 4720] }];
add('bars: zero baseline by default', { chartType: 'column', categories: TWO_MONTHS, series: RISING });
add('bars: zoomed in', { chartType: 'column', categories: TWO_MONTHS, series: RISING, zeroBaseline: false });
add('line: zero baseline asked', { chartType: 'line', categories: TWO_MONTHS, series: RISING, zeroBaseline: true });
add('area: no baseline', { chartType: 'area', categories: TWO_MONTHS, series: RISING, zeroBaseline: false });
add('axis: hidden, zoomed, no gridlines', {
  chartType: 'column',
  categories: MONTHS,
  series: ONE,
  axis: { hideValueAxis: true, hideCategoryAxis: true, min: 4000, max: 5000, gridlines: false },
});
add('axis: min zero and max a string', { chartType: 'line', categories: MONTHS, series: ONE, axis: { min: 0, max: '6000' } });
add('axis: category order kept', { chartType: 'bar', categories: MONTHS, series: ONE, axis: { categoryOrientation: 'minMax' } });
add('axis: category order reversed on a column', { chartType: 'column', categories: MONTHS, series: ONE, axis: { categoryOrientation: 'maxMin' } });
add('axis: null limits', { chartType: 'column', categories: MONTHS, series: ONE, axis: { min: null, max: null, gridlines: true, categoryOrientation: '' } });
add('references', {
  chartType: 'column',
  categories: MONTHS,
  series: TWO,
  references: { sheet: "'월별 계산'", category: "'월별 계산'!$A$2:$A$5", names: ["'월별 계산'!$B$1"], values: ["'월별 계산'!$B$2:$B$5", ''] },
});
add('references: the sheet alone', { chartType: 'line', categories: MONTHS, series: TWO, references: { sheet: 'Data' } });
add('dated categories', {
  chartType: 'column',
  categories: ['2026-06-01', '2026-07-01'],
  series: [{ name: 'n', values: [1, 2] }],
  categoryDates: { values: [46174, 46204], format: 'm"월"' },
});
add('dated categories without a format', {
  chartType: 'line',
  categories: ['a', 'b'],
  series: [{ name: 'n', values: [1, 2] }],
  categoryDates: { values: [46174, 'x'], format: '' },
});
add('external data', { chartType: 'column', categories: MONTHS, series: ONE, externalDataId: 'rId3', font: 'Arial & Co', title: 'Face' });
add('point colours on a column', {
  chartType: 'column',
  categories: MONTHS,
  series: [{ name: 'p', values: [1, 2, 3, 4], pointColors: ['#112233', '', 'f00', 'zzz'] }],
  showValues: true,
});
add('point colours on a line', { chartType: 'line', categories: MONTHS, series: [{ name: 'p', values: [1, 2, 3, 4], pointColors: ['#112233'] }] });
add('point colours on a pie', {
  chartType: 'pie',
  categories: MONTHS,
  series: [{ name: 'p', values: [1, 2, 3, 4], pointColors: ['#0b2a4a', '#fafafa', '#c0392b', '#7f8c8d'] }],
  showValues: true,
});
add('a ring with more slices than colours', {
  chartType: 'doughnut',
  categories: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  series: [{ name: 'p', values: [1, 2, 3, 4, 5, 6, 7, 8] }],
  showValues: true,
  valueNumberFormat: '0.0',
});
add('a pie with a label colour', { chartType: 'pie', categories: MONTHS, series: ONE, showValues: true, dataLabelColor: 'FFF' });
add('a pie with no legend', { chartType: 'pie', categories: MONTHS, series: ONE, showLegend: false });
add('a single series asked for a legend', { chartType: 'column', categories: MONTHS, series: ONE, showLegend: true });
add('two series without a legend', { chartType: 'column', categories: MONTHS, series: TWO, showLegend: false });
add('series names: missing, null, a number', {
  chartType: 'column',
  categories: MONTHS,
  series: [{ values: [1] }, { name: null, values: [2] }, { name: 7, values: [3] }, { name: '', values: [4] }],
});
add('categories: numbers, null, objects', {
  chartType: 'column',
  categories: [1, null, 'x & y', true, { a: 1 }],
  series: [{ name: 'n', values: [1, 2, 3, 4, 5] }],
});
add('values: every kind', {
  chartType: 'column',
  categories: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  series: [{ name: 'n', values: [0.1, 1e21, -0, true, '', '12abc', [3]] }],
});
add('eight series cycle the palette', { chartType: 'column', categories: ['a'], series: Array.from({ length: 8 }, (_, index) => ({ name: `s${index}`, values: [index] })) });
add('number format of a series beats the chart', {
  chartType: 'column',
  categories: MONTHS,
  series: [
    { name: 'a', values: [1, 2, 3, 4], numberFormat: '0.00' },
    { name: 'b', values: [1, 2, 3, 4] },
  ],
  valueNumberFormat: '#,##0',
  showValues: true,
});

const toNode = (spec) => {
  const { textKind, ...rest } = spec;
  return { ...rest, ...(textKind === 'slide' ? { text: chart.CHART_TEXT.slide } : {}) };
};
const charts = [];
for (const { name, spec } of CHARTS) charts.push({ name, spec, output: await attempt(() => chart.chartXml(toNode(spec))) });
const workbookRows = [];
for (const [categories, series] of [
  [MONTHS, TWO],
  [[], []],
  [['a', null, 3], [{ name: 'x', values: [1, 'y'] }, null, { values: [2, 3, 4] }, { name: null, values: [] }]],
]) {
  workbookRows.push({ categories, series, output: await attempt(() => chart.chartWorkbookRows(categories, series)) });
}

// ---- page geometry and setup ----------------------------------------------------------------------------------------

const styleOf = (fontName, size) =>
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="${size}"/><name val="${fontName}"/></font></fonts></styleSheet>`;
const STYLES = [
  styleOf('Twin Miriam', 11),
  styleOf('Twin Miriam', 14),
  styleOf('Twin Lisu', 9.5),
  '<styleSheet><fonts count="1"><font><name val="Twin Miriam"/></font></fonts></styleSheet>',
  '<styleSheet><fonts count="1"><font><sz val="0"/><name val="Twin Miriam"/></font></fonts></styleSheet>',
  '<styleSheet><fonts><font><sz val="12"/><name val="Twin Lisu"/></font><font><sz val="40"/><name val="Twin Miriam"/></font></fonts></styleSheet>',
];
const digitWidths = [];
for (const styles of STYLES) digitWidths.push({ styles, output: await attempt(() => page.maximumDigitWidth(styles)) });

const CHARACTERS = [
  ['Hello World', { fontName: 'Twin Miriam', fontSize: 11 }, 7],
  ['Hello World', { fontName: 'Twin Miriam', fontSize: 11, bold: true }, 7],
  ['Hello World', { fontName: 'Twin Miriam', fontSize: 11, italic: true }, 8],
  ['Total (USD)', { fontName: 'Twin Lisu', fontSize: 10, bold: true }, 8],
  ['', { fontName: 'Twin Miriam' }, 7],
  [null, { fontName: 'Twin Miriam', fontSize: 'x' }, 7],
  [12345.5, { fontName: 'Twin Miriam', fontSize: 14 }, 9],
];
const characters = [];
for (const [text, style, digit] of CHARACTERS) characters.push({ text, style, digit, output: await attempt(() => page.textCharacters(text, style, digit)) });

const widths = [];
for (const [count, digit] of [
  [9, 8],
  [8.43, 7],
  [0, 7],
  [-1, 7],
  [1, 7],
  [255, 8],
  [0.5, 7],
  [12.34, 9],
]) {
  const file = page.columnFileWidth(count, digit);
  widths.push({ characters: count, digit, file, pixels: page.columnPixels(file, digit), raw: page.columnPixels(count, digit) });
}

const GEOMETRY_SHEETS = [
  '<worksheet/>',
  '<worksheet><sheetFormatPr defaultRowHeight="20"/><cols><col min="1" max="2" width="12"/><col min="3" max="3" width="9" hidden="1"/><col min="5" max="6" customWidth="1"/></cols><sheetData><row r="1" ht="30"/><row r="2" hidden="1"><c r="A2"/></row><row r="4" ht="x"/></sheetData></worksheet>',
  '<worksheet><sheetFormatPr defaultColWidth="10" baseColWidth="6"/><sheetData/></worksheet>',
  '<worksheet><sheetFormatPr baseColWidth="12" defaultRowHeight="0"/><cols><col min="2" max="4" width="3.5"/></cols></worksheet>',
];
const geometries = [];
for (const xml of GEOMETRY_SHEETS) {
  for (const digit of [7, 8]) {
    const geometry = page.worksheetGeometry(xml, digit);
    const columnPoints = [1, 2, 3, 4, 5, 6, 7, 100].map((index) => geometry.columnPoints(index));
    const rowPoints = [1, 2, 3, 4, 5, 6, 1000].map((index) => geometry.rowPoints(index));
    const at = [];
    for (const points of [0, 0.5, 40, 48, 54, 90, 96.5, 300, 20000, 1e9]) {
      for (const trailing of [false, true]) {
        at.push({
          points,
          trailing,
          column: await attempt(() => geometry.columnAt(points, { trailing })),
          row: await attempt(() => geometry.rowAt(points, { trailing })),
        });
      }
    }
    geometries.push({ xml, digit, columnPoints, rowPoints, at });
  }
}

const FIT_SHEETS = [
  '<worksheet><sheetData/><pageMargins left="0.7"/></worksheet>',
  '<worksheet><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetData/></worksheet>',
  '<worksheet><sheetPr><pageSetUpPr fitToPage="true"/></sheetPr><sheetData/></worksheet>',
  '<worksheet><sheetData/><pageSetup scale="80"/></worksheet>',
  '<worksheet><sheetPr codeName="S"><tabColor rgb="FF0000FF"/><pageSetUpPr fitToPage="0"/></sheetPr><sheetData/><pageSetup orientation="landscape" fitToWidth="3" fitToHeight="2"></pageSetup></worksheet>',
  '<worksheet><sheetPr/><sheetData/><pageSetup orientation="landscape"/></worksheet>',
  '<worksheet><sheetPr outlinePr="1"/><sheetData/><drawing r:id="rId1"/></worksheet>',
  '<worksheet><sheetData/></worksheet>',
];
const fits = [];
for (const xml of FIT_SHEETS) fits.push({ xml, output: await attempt(() => page.fitDrawingSheetOnePageWide(xml)) });

const DRAWING_RELS =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>';
const anchorFrom = (col, row, colOff = 0, rowOff = 0) =>
  `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:from>`;
const anchorTo = (col, row, colOff = 0, rowOff = 0) =>
  `<xdr:to><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:to>`;
const drawingOf = (...anchors) => `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">${anchors.join('')}</xdr:wsDr>`;
const DRAWINGS = drawingOf(
  `<xdr:twoCellAnchor>${anchorFrom(1, 2)}${anchorTo(4, 9, 0, 6350)}<xdr:graphicFrame/></xdr:twoCellAnchor>`,
  `<xdr:oneCellAnchor>${anchorFrom(2, 3, 12700, 25400)}<xdr:ext cx="3810000" cy="1905000"/><xdr:pic/></xdr:oneCellAnchor>`,
  '<xdr:absoluteAnchor><xdr:pos x="1270000" y="635000"/><xdr:ext cx="2540000" cy="1270000"/><xdr:graphicFrame/></xdr:absoluteAnchor>'
);
const SHEET_BODY =
  '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Head</t></is></c><c r="C1"><v>3</v></c></row><row r="4"><c r="B4"><f>SUM(A1:C1)</f></c></row><row r="6"><c r="D6" t="inlineStr"><is><t></t></is></c></row></sheetData>';
const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const SCENARIOS = [
  {
    name: 'a plain sheet',
    styles: STYLES[0],
    sheet: `<worksheet ${MAIN}>${SHEET_BODY}</worksheet>`,
    steps: [
      { op: 'set_page_setup', orientation: 'Landscape' },
      { op: 'set_page_setup', orientation: 'sideways' },
      { op: 'set_page_setup', fitToPagesWide: 1 },
      { op: 'set_page_setup', printArea: 'a1:d9' },
      { op: 'set_page_setup', leftMargin: 0.25, rightMargin: '1', topMargin: -1, bottomMargin: null, centerHorizontally: true, centerVertically: true },
      { op: 'set_page_setup', fitToPagesTall: 2, orientation: 'portrait' },
      { op: 'set_page_setup', fitToPagesWide: 'x' },
      { op: 'set_page_setup', printTitleRows: '1' },
      { op: 'set_page_setup', printTitleRows: '$2:$3', printArea: 'B2' },
      { op: 'set_page_setup', printTitleRows: '3:1' },
      { op: 'set_page_setup', printTitleRows: 'abc' },
      { op: 'set_page_setup', printArea: 'A1:B2:C3' },
      { op: 'set_page_setup', printArea: 'Data!A1:B2' },
      { op: 'set_page_setup' },
      { op: 'set_page_setup', fitToContent: true },
    ],
  },
  {
    name: 'a sheet with drawings and merged cells',
    styles: STYLES[1],
    sheet: `<worksheet ${MAIN}><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="3" width="14" customWidth="1"/></cols>${SHEET_BODY}<mergeCells count="1"><mergeCell ref="E2:G3"/></mergeCells><drawing r:id="rId1"/></worksheet>`,
    rels: DRAWING_RELS,
    drawing: DRAWINGS,
    steps: [
      { op: 'set_page_setup', fitToContent: true },
      { op: 'set_page_setup', fitToContent: true, fitToPagesWide: 1, fitToPagesTall: 0, orientation: 'landscape' },
      { op: 'set_page_setup', fitToContent: false, printArea: 'A1:C3' },
    ],
    drawings: true,
  },
  {
    name: 'a sheet that already declares its setup and names',
    styles: STYLES[2],
    sheet: `<worksheet ${MAIN}><sheetPr codeName="S"><tabColor rgb="FF00FF00"/><pageSetUpPr fitToPage="0"/></sheetPr>${SHEET_BODY}<printOptions gridLines="1"/><pageMargins left="1" right="1" top="1" bottom="1" header="0.5" footer="0.5"/><pageSetup paperSize="1" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`,
    definedNames:
      '<definedNames><definedName name="Keep">Data!$A$1</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$B$2</definedName><definedName name="_xlnm.Print_Area" localSheetId="1">Other!$A$1</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$1</definedName></definedNames>',
    steps: [
      { op: 'set_page_setup', printArea: 'C3:F8' },
      { op: 'set_page_setup', printTitleRows: '2:2' },
      { op: 'set_page_setup', orientation: 'portrait' },
      { op: 'set_page_setup', fitToPagesWide: 2, fitToPagesTall: 3 },
      { op: 'set_page_setup', fitToContent: true },
    ],
  },
  {
    name: 'drawings that leave the grid',
    styles: STYLES[0],
    sheet: `<worksheet ${MAIN}>${SHEET_BODY}<drawing r:id="rId1"/></worksheet>`,
    rels: DRAWING_RELS,
    drawing: drawingOf(`<xdr:twoCellAnchor>${anchorFrom(1, 1)}${anchorTo(16384, 2)}<xdr:graphicFrame/></xdr:twoCellAnchor>`),
    steps: [{ op: 'set_page_setup', fitToContent: true }],
    drawings: true,
  },
  {
    name: 'a drawing placed beyond the last column',
    styles: STYLES[0],
    sheet: `<worksheet ${MAIN}>${SHEET_BODY}<drawing r:id="rId1"/></worksheet>`,
    rels: DRAWING_RELS,
    drawing: drawingOf('<xdr:absoluteAnchor><xdr:pos x="9999999999999" y="0"/><xdr:ext cx="100" cy="100"/><xdr:pic/></xdr:absoluteAnchor>'),
    steps: [{ op: 'set_page_setup', fitToContent: true }],
    drawings: true,
  },
  {
    name: 'drawing relationships: external, other kinds, rooted',
    styles: STYLES[0],
    sheet: `<worksheet ${MAIN}>${SHEET_BODY}</worksheet>`,
    rels: '<Relationships xmlns="x"><Relationship Id="rId1" Type="t/drawing" Target="http://x/y.xml" TargetMode="External"/><Relationship Id="rId2" Type="t/hyperlink" Target="../drawings/drawing1.xml"/><Relationship Id="rId3" Type="t/drawing" Target="/xl/drawings/drawing1.xml"/><Relationship Id="rId4" Type="t/drawing" Target="../drawings/missing.xml"/></Relationships>',
    drawing: DRAWINGS,
    steps: [{ op: 'set_page_setup', fitToContent: true }],
    drawings: true,
  },
];
const scenarios = [];
for (const scenario of SCENARIOS) {
  const path = join(work, `scenario-${scenarios.length}.xlsx`);
  await pkg.createPortableOoxmlDocument(path, { fileKind: 'xlsx', title: 't', sheetName: 'Data' });
  const zip = await opc.loadPackage(path);
  zip.file('xl/styles.xml', scenario.styles);
  const sheets = await cells.workbookSheets(zip);
  const sheet = sheets[0];
  zip.file(sheet.path, scenario.sheet);
  if (scenario.definedNames) {
    zip.file('xl/workbook.xml', (await opc.zipText(zip, 'xl/workbook.xml')).replace('</sheets>', `</sheets>${scenario.definedNames}`));
  }
  if (scenario.rels) zip.file(opc.partRelationshipPath(sheet.path), scenario.rels);
  if (scenario.drawing) zip.file('xl/drawings/drawing1.xml', scenario.drawing);
  const outputs = [];
  for (const step of scenario.steps) {
    const xml = await opc.zipText(zip, sheet.path);
    outputs.push({
      result: await attempt(() => page.applyWorksheetPageSetup(zip, sheets, sheet, xml, step)),
      worksheet: await opc.zipText(zip, sheet.path),
      workbook: await opc.zipText(zip, 'xl/workbook.xml'),
    });
  }
  const { drawings, ...rest } = scenario;
  const found = drawings ? await attempt(async () => page.worksheetDrawings(zip, sheet, await opc.zipText(zip, sheet.path))) : null;
  scenarios.push({ ...rest, outputs, ...(found ? { drawingsOutput: found } : {}) });
}

// ---- shared formulas ------------------------------------------------------------------------------------------------

const sheetOf = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
const SHARED = [
  sheetOf(
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*$C$1</f><v>10</v></c><c r="C1"><v>10</v></c></row>' +
      '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>20</v></c></row>' +
      '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>30</v></c></row>'
  ),
  sheetOf(
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="array" ref="B1:B3">TREND(A1:A3)</f><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>2</v></c></row>' +
      '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>3</v></c></row>'
  ),
  sheetOf('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c><c r="B1"><v>3</v></c></row>'),
  sheetOf(
    '<row r="1"><c r="A1"><f t="shared" ref="A1:C2" si="7">SUM(Sheet2!A$1:B$2,$D1)+IF(E1="x",F1,"a&amp;b")</f></c><c r="B1"><f t="shared" si="7"/></c><c r="C1"><f t="shared" si="7"/></c></row>' +
      '<row r="2"><c r="A2"><f t="shared" si="7"/></c><c r="B2"><f t="shared" si="7"/></c></row>'
  ),
  sheetOf(
    '<row r="2"><c r="B3"><f t="shared" ref="B3:B4" si="1">A1+1</f></c></row><row r="3"><c r="B2"><f t="shared" si="1"/></c><c r="B4"><f t="shared" si="1"/></c></row>' +
      '<row r="5"><c r="B1"><f t="shared" si="1"/></c></row>'
  ),
  sheetOf(
    '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="1">B1</f></c></row><row r="2"><c r="A2"><f t="shared" si="2"/></c><c r="B2"><f t="shared"/></c><c r="C2"><f t="shared" si="1"/><v>5</v></c></row>'
  ),
  sheetOf(
    '<row r="1"><c r="A1"><f t="array" ref="A1:A3">1+1</f></c><c r="B1"><f t="array" ref="B1">2</f></c><c r="C1"><f t="array" ref="C1:C2"/></c></row><row r="2"><c r="A2"/><c r="C2"/></row><row r="3"><c r="A3"><v>9</v></c></row>'
  ),
  sheetOf('<row r="1"><c r="A1"><f t="array" ref="$A$1:$B$2">X1</f></c><c r="B1"/></row><row r="2"><c r="A2"/><c r="B2"/></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="array" ref="A1:Z1000">X1</f></c><c r="A2"/></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="array" ref="B2:A1">X1</f></c><c r="A2"/><c r="B1"/></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="array" ref="A0:A2">X1</f></c></row>'),
  sheetOf('<row r="1"><c r="A0"><f t="shared" ref="A0:A1" si="0">1</f></c></row><row r="2"><c r="A1"><f t="shared" si="0"/></c></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">LET(x,1,x)</f></c></row><row r="2"><c r="A2"><f t="shared" si="0"/></c></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="shared" si="0"/></c></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="shared" ref="A1:B1" si="0"> a &lt; b </f></c><c r="B1"><f t="shared" si="0"/></c></row>'),
  sheetOf('<row r="1"><c r="A1"><f t="shared" ref="A1:B1" si="0">A1</f></c><c r="A1"><f t="shared" si="0"/></c><c r="B1"><f t="shared" si="0"/></c></row>'),
  '<worksheet><sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B$1+Z9</f></c></row><row r="2"><c r="A2"><f t="shared" si="0"/></c></row></sheetData><x t="shared"/></worksheet>',
];
const sharedFormulas = [];
for (const xml of SHARED) {
  sharedFormulas.push({
    xml,
    output: await attempt(() => {
      const records = cells.cellRecords(xml, []);
      const failures = shared.expandSharedFormulas(xml, records);
      return { failures, formulas: records.filter((record) => record.formula).map((record) => [record.ref, record.formula]) };
    }),
  });
}

rmSync(work, { recursive: true, force: true });
writeJson(join(stage, 'golden.json'), {
  engine: '@napi-rs/canvas',
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  charts,
  workbookRows,
  digitWidths,
  characters,
  widths,
  geometries,
  fits,
  scenarios,
  sharedFormulas,
});
writeSetManifest(stage, { set: 'office-chart-sheets', recorder, command: `node ${recorder} --tree <dir with node_modules>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`wrote ${join(finalDir, 'golden.json')}`);
