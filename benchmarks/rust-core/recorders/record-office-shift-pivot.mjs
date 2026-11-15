#!/usr/bin/env node
// What the portable reference-shift and pivot modules answer (src/runtime/office/portable: portable-xlsx-reference-shift,
// portable-pivot), run through Node. Rust `mixdog-ooxml` must answer the same: every rewritten formula, name, range and
// part of a workbook after rows or columns are inserted or deleted, a sheet is renamed, deleted or copied; the formulas
// a sort moves; the fields and the part XML of a pivot table (crates/mixdog-ooxml/tests/twin_shift_pivot.rs).
//
//   node benchmarks/rust-core/recorders/record-office-shift-pivot.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-shift-pivot/golden.json. The recording holds `workbooks` (the parts of each input
// package, by name, as Node built them with the portable operations or as written by hand here), `cases` (a workbook and
// the steps run over it: each step's answer, then the names of the package and every part that changed) and `pure` (a
// helper over plain arguments).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-shift-pivot');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-shift-pivot.mjs';
const JSZip = createRequire(join(tree, 'package.json'))('jszip');
const opc = await importFrom(tree, 'src/runtime/office/portable/portable-opc.mjs');
const pkg = await importFrom(tree, 'src/runtime/office/portable/portable-package.mjs');
const cells = await importFrom(tree, 'src/runtime/office/portable/portable-cells.mjs');
const xlsx = await importFrom(tree, 'src/runtime/office/portable/portable-xlsx.mjs');
const shift = await importFrom(tree, 'src/runtime/office/portable/portable-xlsx-reference-shift.mjs');
const pivot = await importFrom(tree, 'src/runtime/office/portable/portable-pivot.mjs');

const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- the workbooks: those the Node tests build with the portable operations, and one written by hand
const DATA = [
  ['권역', '7월', '8월', '9월', '지연률', '가동률'],
  ['수도권', 26100, 27300, 29000, 0.009, 0.81],
  ['부산', 21400, 23800, 26400, 0.019, 0.94],
  ['호남', 9400, 10100, 10700, 0.011, 0.67],
  ['강원', 4100, 4300, 4600, 0.007, 0.58],
  ['제주', 2100, 2300, 2500, 0.013, 0.62],
];
const REPORT = [
  '=SUM(Data!D2:D6)',
  '=Data!A6',
  '=Data!$B$6+Data!B5',
  '=SUM(Data!6:6)',
  '=SUM(Data!C:C)',
  '=IF(Data!A6="Data!A6","same",Data!A6)',
  '=SUM(Sept)',
  '=SUM(Data!D6:D7)',
  '=COUNTA(Data!A1:F1)',
  '=SUM(Data!B2:D3)',
];

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

async function operationsWorkbook(sheetName = 'Data') {
  const zip = await JSZip.loadAsync(await pkg.createPortableChartWorkbook(DATA, { sheetName }));
  await xlsx.applyXlsx(zip, [
    { op: 'add_sheet', name: 'Report' },
    ...[2, 3, 4, 5, 6].map((row) => ({ op: 'set_formula', sheet: 'Data', cell: `G${row}`, formula: `=D${row}/B${row}-1` })),
    { op: 'set_formula', sheet: 'Data', cell: 'D7', formula: '=SUM(D2:D6)' },
    { op: 'add_conditional_format', sheet: 'Data', range: 'D2:D6', formula: '$D2>AVERAGE($D$2:$D$6)', fillColor: 'FFF2CC' },
    { op: 'add_validation', sheet: 'Data', range: 'E2:E6', type: 'decimal', formula1: '0', formula2: '1' },
    { op: 'add_chart', sheet: 'Data', range: 'A1:A6,D1:D6', cell: 'I2', chartType: 'bar', title: '9월' },
    { op: 'set_page_setup', sheet: 'Data', printArea: 'A1:G7', printTitleRows: '1' },
    { op: 'define_name', name: 'Sept', refersTo: '=Data!$D$2:$D$6' },
    { op: 'define_name', name: 'Jeju', refersTo: '=Data!$A$6' },
    ...REPORT.map((formula, index) => ({ op: 'set_formula', sheet: 'Report', cell: `A${index + 1}`, formula })),
  ]);
  return zip;
}

async function sheetPath(zip, name) {
  return (await cells.workbookSheets(zip)).find((entry) => entry.name === name).path;
}

const workbooks = {};

workbooks.operations = await dump(await operationsWorkbook());

{
  const zip = await operationsWorkbook();
  await xlsx.applyXlsx(zip, [
    { op: 'add_note', sheet: 'Data', cell: 'A6', text: '신규 권역 검토 중' },
    { op: 'add_note', sheet: 'Data', cell: 'B3', text: '7월 잠정치' },
  ]);
  workbooks.notes = await dump(zip);
}

{
  const zip = await operationsWorkbook();
  await xlsx.applyXlsx(zip, [{ op: 'add_table', sheet: 'Data', range: 'A1:F6', name: 'Hubs' }]);
  workbooks.table = await dump(zip);
}

{
  const zip = await operationsWorkbook();
  zip.file('xl/calcChain.xml', '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A1" i="2"/></calcChain>');
  const rels = await opc.zipText(zip, 'xl/_rels/workbook.xml.rels');
  zip.file(
    'xl/_rels/workbook.xml.rels',
    rels.replace('</Relationships>', '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>')
  );
  const types = await opc.zipText(zip, '[Content_Types].xml');
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'));
  workbooks.calcChain = await dump(zip);
}

{
  const zip = await JSZip.loadAsync(await pkg.createPortableChartWorkbook(DATA, { sheetName: '월별 자료' }));
  await xlsx.applyXlsx(zip, [
    { op: 'add_sheet', name: '데이터' },
    { op: 'set_range', sheet: '데이터', range: 'A1:A3', values: [[1], [2], [3]] },
    { op: 'add_sheet', name: '보고서' },
    { op: 'set_formula', sheet: '보고서', cell: 'A1', formula: "=SUM('월별 자료'!D2:D6)" },
    { op: 'set_formula', sheet: '보고서', cell: 'A2', formula: '=SUM(데이터!A1:A3)+데이터!A3' },
  ]);
  const report = await sheetPath(zip, '보고서');
  zip.file(report, (await opc.zipText(zip, report)).replace(/(?:'|&apos;)데이터(?:'|&apos;)!A3/, '데이터!A3'));
  workbooks.korean = await dump(zip);
}

{
  const zip = await JSZip.loadAsync(
    await pkg.createPortableChartWorkbook(
      [['권역', '9월'], ['수도권', 29000], ['부산', 26400], ['호남', 10700]],
      { sheetName: 'Data' }
    )
  );
  await xlsx.applyXlsx(zip, [
    { op: 'add_sheet', name: 'Report' },
    { op: 'add_sheet', name: 'Other' },
    { op: 'set_formula', sheet: 'Report', cell: 'A1', formula: '=SUM(Data!B2:B4)' },
    { op: 'set_formula', sheet: 'Report', cell: 'A2', formula: `='Data'!A2&"Data!A2"` },
    { op: 'set_formula', sheet: 'Report', cell: 'A3', formula: '=Other!A1+Data!$B$2' },
    { op: 'set_formula', sheet: 'Report', cell: 'A4', formula: '=SUM(Vals)' },
    { op: 'set_formula', sheet: 'Data', cell: 'C2', formula: '=B2/Data!B3' },
    { op: 'define_name', name: 'Vals', refersTo: '=Data!$B$2:$B$4' },
    { op: 'add_validation', sheet: 'Report', range: 'B1:B3', formula1: '=Data!$A$2:$A$4' },
    { op: 'add_conditional_format', sheet: 'Report', range: 'C1:C3', formula: 'C1>Data!$B$4', fillColor: 'FFF2CC' },
    { op: 'add_chart', sheet: 'Data', range: 'A1:B4', cell: 'E2', chartType: 'bar' },
  ]);
  workbooks.naming = await dump(zip);
}

{
  const zip = await JSZip.loadAsync(await pkg.createPortableChartWorkbook(DATA.map((row) => row.slice(0, 4)), { sheetName: 'Report' }));
  await xlsx.applyXlsx(zip, [
    { op: 'add_chart', sheet: 'Report', range: 'A1:A6,D1:D6', cell: 'F2', chartType: 'bar', title: '9월' },
    { op: 'add_note', sheet: 'Report', cell: 'A1', text: '자료: 운영관리시스템' },
    { op: 'set_page_setup', sheet: 'Report', printArea: 'A1:D6' },
    { op: 'set_formula', sheet: 'Report', cell: 'E2', formula: '=Report!D2*2+D3' },
    { op: 'define_name', name: 'Total', refersTo: '=Report!$D$2' },
  ]);
  workbooks.copyable = await dump(zip);
}

{
  const zip = await JSZip.loadAsync(await pkg.createPortableChartWorkbook(DATA, { sheetName: 'Data' }));
  await xlsx.applyXlsx(zip, [
    { op: 'set_style', sheet: 'Data', range: 'B2:D6', properties: { numberFormat: '#,##0' } },
    { op: 'set_row_height', sheet: 'Data', row: 5, height: 30 },
    { op: 'set_column_width', sheet: 'Data', column: 'B', width: 22, count: 3 },
  ]);
  workbooks.formatted = await dump(zip);
}

{
  const zip = await JSZip.loadAsync(await pkg.createPortableChartWorkbook(DATA.map((row) => [row[0], row[1], row[3]]), { sheetName: 'Data' }));
  workbooks.plain = await dump(zip);
}

{
  const zip = await JSZip.loadAsync(
    await pkg.createPortableChartWorkbook(
      [['Region', 'Product', 'Revenue'], ['North', 'Widget', 10], ['South', 'Widget', 20], ['North', 'Gadget', 30]],
      { sheetName: 'Sheet1' }
    )
  );
  workbooks.pivotBase = await dump(zip);
}

// A workbook written by hand: what the portable operations do not write (array and data-table formulas, merges, links,
// filters with criteria, page breaks, Excel 2010 extensions, a pivot table and its cache, drawing anchors of every kind).
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RICH_DATA =
  `<worksheet ${NS} xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">` +
  '<dimension ref="A1:H10"/><cols><col min="1" max="1" width="12" customWidth="1"/><col min="3" max="5" width="9"/><col min="9" max="9" width="4"/></cols>' +
  '<sheetData>' +
  '<row r="1" ht="20" customHeight="1" s="2" customFormat="1"><c r="A1" t="inlineStr" s="3"><is><t>Head</t></is></c><c r="B1" s="3"><v>1</v></c><c r="C1" s="3"/><c r="D1"><v>4</v></c></row>' +
  '<row r="2"><c r="A2"><v>1</v></c><c r="B2" s="1"><f>SUM(A2:A9)+\'My Data\'!A1</f><v>0</v></c><c r="C2"><f>Data!B2*2</f><v>0</v></c><c r="D2"><f t="array" ref="D2:D3">A2:A3*2</f><v>2</v></c><c r="E2"><f t="shared" ref="E2:E5" si="0">B2+$A$2</f><v>0</v></c><c r="F2"><f t="shared" ref="F2:F4" si="1">$A$2*3</f><v>0</v></c></row>' +
  '<row r="3"><c r="A3"><v>2</v></c><c r="D3"><v>4</v></c><c r="E3"><f t="shared" si="0"/><v>0</v></c><c r="F3"><f t="shared" si="1"/><v>0</v></c></row>' +
  '<row r="4"><c r="A4"><v>3</v></c><c r="E4"><f t="shared" si="0"/><v>0</v></c><c r="F4"><f t="shared" si="1"/><v>0</v></c></row>' +
  '<row r="5"><c r="A5"><v>4</v></c><c r="E5"><f t="shared" si="0"/><v>0</v></c></row>' +
  '<row r="6" hidden="1"><c r="A6"><v>5</v></c><c r="B6"><v>1</v></c></row>' +
  '<row r="7"><c r="A7"><v>6</v></c></row>' +
  '<row r="8"><c r="A8"><v>7</v></c><c r="C8"><f>SUM(Rng)+COUNT(Cols)</f><v>0</v></c></row>' +
  '<row r="9"><c r="A9"><v>8</v></c></row>' +
  '<row r="10"/>' +
  '</sheetData>' +
  '<sortState ref="A2:D9"><sortCondition ref="B2:B9"/></sortState>' +
  '<autoFilter ref="A1:D9"><filterColumn colId="1"><filters><filter val="1"/></filters></filterColumn></autoFilter>' +
  '<mergeCells count="3"><mergeCell ref="A1:B1"/><mergeCell ref="C4:D4"/><mergeCell ref="B6:B7"/></mergeCells>' +
  '<conditionalFormatting sqref="B2:B9 D2:D4"><cfRule type="expression" dxfId="0" priority="1"><formula>$B2&gt;SUM($B$2:$B$9)</formula></cfRule></conditionalFormatting>' +
  '<conditionalFormatting sqref="C6"><cfRule type="expression" dxfId="0" priority="2"><formula>C6&gt;1</formula></cfRule></conditionalFormatting>' +
  '<dataValidations count="2"><dataValidation type="list" sqref="E2:E9" allowBlank="1"><formula1>\'My Data\'!$A$1:$A$3</formula1></dataValidation><dataValidation type="whole" sqref="C6" allowBlank="1"><formula1>0</formula1><formula2>Data!$A$2</formula2></dataValidation></dataValidations>' +
  '<hyperlinks><hyperlink ref="A2" location="Data!A5" display="five"/><hyperlink ref="A7:A8" r:id="rId9"/></hyperlinks>' +
  '<ignoredErrors><ignoredError sqref="B2:B3" formula="1"/><ignoredError sqref="A7" numberStoredAsText="1"/></ignoredErrors>' +
  '<protectedRanges><protectedRange sqref="A8:A9" name="locked"/></protectedRanges>' +
  '<rowBreaks count="2" manualBreakCount="2"><brk id="4" max="16383" man="1"/><brk id="8" max="16383" man="true"/></rowBreaks>' +
  '<colBreaks count="1" manualBreakCount="1"><brk id="2" max="1048575" man="1"/></colBreaks>' +
  '<drawing r:id="rId1"/><legacyDrawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId3"/></tableParts>' +
  '<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}"><x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="expression" priority="3"><xm:f>$B2&gt;Data!$B$9</xm:f></x14:cfRule><xm:sqref>B2:B9</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext>' +
  '<ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"><x14:dataValidations count="1"><x14:dataValidation type="list"><x14:formula1><xm:f>\'My Data\'!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>H2:H9</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>' +
  '</worksheet>';
const RICH_OTHER =
  `<worksheet ${NS}><dimension ref="A1:C12"/><sheetData>` +
  '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>SUM(Data!B2:B9)+Data!C2</f><v>0</v></c></row>' +
  '<row r="2"><c r="A2"><f>Data!E3+Rng</f><v>0</v></c><c r="B2"><f>#REF!B2+SUM(Data!#REF!)</f><v>0</v></c></row>' +
  '<row r="5"><c r="A5" t="inlineStr"><is><t>Region</t></is></c><c r="B5" t="inlineStr"><is><t>Sum</t></is></c></row>' +
  '<row r="6"><c r="A6" t="inlineStr"><is><t>North</t></is></c><c r="B6"><v>1</v></c></row>' +
  '<row r="7"><c r="A7" t="inlineStr"><is><t>Total</t></is></c><c r="B7"><v>1</v></c></row>' +
  '</sheetData><conditionalFormatting sqref="B1:B2"><cfRule type="cellIs" operator="greaterThan"><formula>Data!$B$2</formula></cfRule></conditionalFormatting></worksheet>';
const ANCHOR = (kind, editAs, from, to) =>
  `<xdr:${kind}${editAs ? ` editAs="${editAs}"` : ''}><xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>10</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>20</xdr:rowOff></xdr:from>` +
  (to ? `<xdr:to><xdr:col>${to[0]}</xdr:col><xdr:colOff>30</xdr:colOff><xdr:row>${to[1]}</xdr:row><xdr:rowOff>40</xdr:rowOff></xdr:to>` : '<xdr:ext cx="100" cy="100"/>') +
  `<xdr:sp/><xdr:clientData/></xdr:${kind}>`;
const RICH_DRAWING =
  '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
  ANCHOR('twoCellAnchor', '', [1, 2], [4, 6]) + ANCHOR('twoCellAnchor', 'oneCell', [2, 3], [5, 7]) + ANCHOR('twoCellAnchor', 'absolute', [3, 4], [6, 8]) +
  ANCHOR('oneCellAnchor', '', [4, 5], null) + ANCHOR('twoCellAnchor', 'twoCell', [0, 4], [2, 5]) + ANCHOR('twoCellAnchor', '', [6, 8], [8, 9]) +
  '</xdr:wsDr>';
const NOTE_SHAPE = (row, column) =>
  `<v:shape id="_x0000_s${1025 + row}" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:Anchor> ${column + 1}, 15, ${row}, 10, ${column + 3}, 15, ${row + 4}, 4</x:Anchor><x:Row>${row}</x:Row><x:Column>${column}</x:Column></x:ClientData></v:shape>`;
const RICH_VML = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">${NOTE_SHAPE(1, 0)}${NOTE_SHAPE(4, 1)}${NOTE_SHAPE(7, 2)}<v:shape id="plain"><x:ClientData ObjectType="Button"><x:Row>3</x:Row><x:Column>0</x:Column></x:ClientData></v:shape></xml>`;
const RICH_COMMENTS = `<comments ${NS}><authors><author>A</author></authors><commentList><comment ref="A2" authorId="0"><text><r><t>one</t></r></text></comment><comment ref="B5" authorId="0"><text><r><t>two</t></r></text></comment><comment ref="C8" authorId="0"><text><r><t>three</t></r></text></comment></commentList></comments>`;
const RICH_TABLE = `<table ${NS} id="1" name="T1" displayName="T1" ref="A1:D9" totalsRowShown="0"><autoFilter ref="A1:D9"/><tableColumns count="4"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/><tableColumn id="3" name="C"/><tableColumn id="4" name="D"/></tableColumns></table>`;
const RICH_PIVOT = `<pivotTableDefinition ${NS} name="P1" cacheId="1"><location ref="A5:B7" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/><pivotFields count="2"><pivotField axis="axisRow"/><pivotField dataField="1"/></pivotFields></pivotTableDefinition>`;
const RICH_CACHE = `<pivotCacheDefinition ${NS} r:id="rId1" recordCount="2"><cacheSource type="worksheet"><worksheetSource ref="A1:D9" sheet="Data"/></cacheSource><cacheFields count="1"><cacheField name="A"/></cacheFields></pivotCacheDefinition>`;
const RICH_CHART = '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:f>Data!$B$1</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>Data!$A$2:$A$9</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>\'My Data\'!$A$1:$A$3,Data!$B$2:$B$9</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>';
const rels = (items) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`)
    .join('')}</Relationships>`;
workbooks.rich = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
  ['_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']])],
  [
    'xl/workbook.xml',
    `<workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="My Data" sheetId="2" r:id="rId2"/></sheets>` +
      '<definedNames><definedName name="Rng">Data!$B$2:$D$9</definedName><definedName name="Cols">Data!$B:$C</definedName><definedName name="Loc" localSheetId="1">\'My Data\'!$A$1:A3+B2</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$2</definedName><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$D$9</definedName><definedName name="Odd">SUM(Data!B2:B3)&amp;"Data!B2"</definedName></definedNames>' +
      '<pivotCaches><pivotCache cacheId="1" r:id="rId5"/></pivotCaches></workbook>',
  ],
  ['xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId5', 'pivotCacheDefinition', 'pivotCache/pivotCacheDefinition1.xml']])],
  ['xl/worksheets/sheet1.xml', RICH_DATA],
  ['xl/worksheets/sheet2.xml', RICH_OTHER],
  ['xl/worksheets/_rels/sheet1.xml.rels', rels([['rId1', 'drawing', '../drawings/drawing1.xml'], ['rId2', 'vmlDrawing', '../drawings/vmlDrawing1.vml'], ['rId3', 'table', '../tables/table1.xml'], ['rId4', 'comments', '../comments1.xml'], ['rId9', 'hyperlink', 'https://example.com/a', 'External']])],
  ['xl/worksheets/_rels/sheet2.xml.rels', rels([['rId1', 'pivotTable', '../pivotTables/pivotTable1.xml']])],
  ['xl/drawings/drawing1.xml', RICH_DRAWING],
  ['xl/drawings/vmlDrawing1.vml', RICH_VML],
  ['xl/comments1.xml', RICH_COMMENTS],
  ['xl/tables/table1.xml', RICH_TABLE],
  ['xl/pivotTables/pivotTable1.xml', RICH_PIVOT],
  ['xl/pivotCache/pivotCacheDefinition1.xml', RICH_CACHE],
  ['xl/charts/chart1.xml', RICH_CHART],
];

// ---- the cases: a workbook, the steps run over it
const cases = [];
const shiftStep = (sheet, rows, from, amount, insert) => ({
  kind: 'shift',
  sheet,
  rows,
  from,
  amount,
  insert,
  op: `${insert ? 'insert' : 'delete'}_${rows ? 'rows' : 'columns'}`,
});
const insertRows = (sheet, from, amount = 1) => shiftStep(sheet, true, from, amount, true);
const deleteRows = (sheet, from, amount = 1) => shiftStep(sheet, true, from, amount, false);
const insertColumns = (sheet, from, amount = 1) => shiftStep(sheet, false, from, amount, true);
const deleteColumns = (sheet, from, amount = 1) => shiftStep(sheet, false, from, amount, false);
const rename = (sheet, to, op = 'rename_sheet') => ({ kind: 'rename', sheet, to, op });

const CASES = [
  ['rows inserted inside the ranges a Data sheet is named by', 'operations', [insertRows('Data', 6)]],
  ['rows inserted before every range', 'operations', [insertRows('Data', 1, 2), insertRows('Data', 2, 3)]],
  ['rows inserted below every range', 'operations', [insertRows('Data', 20, 2)]],
  ['rows inserted at the second row', 'operations', [insertRows('Data', 2)]],
  ['a row deleted leaves #REF! and closes ranges, and the next edit reads the #REF!', 'operations', [deleteRows('Data', 6), insertRows('Data', 2)]],
  ['several rows deleted from the middle', 'operations', [deleteRows('Data', 3, 3)]],
  ['the first row deleted', 'operations', [deleteRows('Data', 1)]],
  ['a column inserted inside the ranges', 'operations', [insertColumns('Data', 3)]],
  ['columns inserted at the first column', 'operations', [insertColumns('Data', 1, 2)]],
  ['a column deleted leaves #REF!', 'operations', [deleteColumns('Data', 4)]],
  ['columns deleted from the middle', 'operations', [deleteColumns('Data', 2, 2)]],
  ['rows inserted on the Report sheet that names Data', 'operations', [insertRows('Report', 1), insertRows('Report', 4, 2)]],
  ['an inserted row and column take the formatting beside them', 'formatted', [insertRows('Data', 6), insertColumns('Data', 3)]],
  ['rows deleted from a formatted sheet', 'formatted', [deleteRows('Data', 3, 2), deleteColumns('Data', 2, 3)]],
  ['notes move with their cells and go with them', 'notes', [insertRows('Data', 4, 2), deleteRows('Data', 8), insertColumns('Data', 1)]],
  ['notes under a column delete', 'notes', [deleteColumns('Data', 1), deleteRows('Data', 3)]],
  ['a table a column insert would cut refuses the edit, and a row inside it widens it', 'table', [insertColumns('Data', 3), insertRows('Data', 4), deleteRows('Data', 2, 2), deleteRows('Data', 1)]],
  ['a table whose rows are all deleted refuses', 'table', [deleteRows('Data', 1, 6), deleteColumns('Data', 1, 7)]],
  ['a sheet named in Korean or in quotes is found', 'korean', [insertRows('월별 자료', 3, 2), deleteRows('데이터', 2)]],
  ['a renamed sheet is renamed everywhere', 'naming', [rename('Data', '자료 2026')]],
  ['a sheet renamed to a plain name and to a quoted one', 'naming', [rename('Data', 'Sales'), { kind: 'replace', part: 'xl/workbook.xml', find: '<sheet name="Data"', with: '<sheet name="Sales"' }, rename('Sales', "Sales 'Q1'")]],
  ['a deleted sheet leaves #REF!', 'naming', [rename('Data', null, 'delete_sheet')]],
  ['an open-workbook #REF! is read as the error it is', 'naming', [
    rename('Data', null, 'delete_sheet'),
    { kind: 'replace', part: 'xl/worksheets/sheet2.xml', find: '<f>SUM(#REF!)</f>', with: '<f>SUM(#REF!B2:B4)</f>' },
    insertRows('Report', 1),
  ]],
  ['deleting a sheet drops the calculation chain', 'calcChain', [rename('Report', null, 'delete_sheet'), { kind: 'dropchain' }]],
  ['the calculation chain dropped alone', 'calcChain', [{ kind: 'dropchain' }]],
  ['a sheet copied gets its own parts, pointed at the copy', 'copyable', [{ kind: 'copy', sheet: 'Report', name: 'Report 사본', path: 'xl/worksheets/sheet2.xml' }]],
  ['a sheet copied to a plain name', 'copyable', [{ kind: 'copy', sheet: 'Report', name: 'Copy2', path: 'xl/worksheets/sheet2.xml' }]],
  ['a rich workbook: rows inserted into Data', 'rich', [insertRows('Data', 5, 2)]],
  ['a rich workbook: rows inserted above everything', 'rich', [insertRows('Data', 1)]],
  ['a rich workbook: the header row deleted refuses', 'rich', [deleteRows('Data', 1, 2)]],
  ['a rich workbook: rows deleted from the middle', 'rich', [deleteRows('Data', 4, 2)]],
  ['a rich workbook: the last rows deleted', 'rich', [deleteRows('Data', 8, 3)]],
  ['a rich workbook: rows deleted through the array and every rule refuses', 'rich', [deleteRows('Data', 2, 8)]],
  ['a rich workbook: one row of the array block deleted refuses', 'rich', [deleteRows('Data', 3)]],
  ['a rich workbook: a row inside the array block refuses', 'rich', [insertRows('Data', 3)]],
  ['a rich workbook: a data table refuses', 'rich', [
    { kind: 'replace', part: 'xl/worksheets/sheet1.xml', find: '<c r="A7"><v>6</v></c>', with: '<c r="A7"><v>6</v></c><c r="B7"><f t="dataTable" ref="B7:B8" dt2D="0" dtr="0" r1="A1"/><v>1</v></c>' },
    insertRows('Data', 7),
  ]],
  ['a rich workbook: columns inserted after the table', 'rich', [insertColumns('Data', 5)]],
  ['a rich workbook: columns inserted through the table and the filter refuse', 'rich', [insertColumns('Data', 2), insertColumns('Data', 4)]],
  ['a rich workbook: columns deleted after the table', 'rich', [deleteColumns('Data', 5, 2)]],
  ['a rich workbook: the extension columns deleted', 'rich', [deleteColumns('Data', 8, 2)]],
  ['a rich workbook: rows inserted into My Data above the pivot', 'rich', [insertRows('My Data', 2, 2)]],
  ['a rich workbook: rows inserted through the pivot refuse', 'rich', [insertRows('My Data', 6)]],
  ['a rich workbook: rows deleted from My Data', 'rich', [deleteRows('My Data', 1)]],
  ['a rich workbook: columns inserted into My Data', 'rich', [insertColumns('My Data', 1)]],
  ['a rich workbook: Data renamed', 'rich', [rename('Data', 'Raw data')]],
  ['a rich workbook: My Data deleted', 'rich', [rename('My Data', null, 'delete_sheet')]],
  ['a rich workbook: My Data renamed', 'rich', [rename('My Data', 'Mine')]],
  ['a rich workbook: edits one after another', 'rich', [insertRows('Data', 5), deleteRows('Data', 8, 2), insertColumns('Data', 5, 2), deleteColumns('Data', 9)]],
  ['a rich workbook: Data copied', 'rich', [{ kind: 'copy', sheet: 'Data', name: 'Data 2', path: 'xl/worksheets/sheet3.xml' }]],
  ['a shared formula whose cells would read differently is written out; one that keeps its meaning stays shared', 'operations', [
    {
      kind: 'replace',
      part: 'xl/worksheets/sheet2.xml',
      find: '</sheetData>',
      with:
        [9, 10, 11, 12, 13]
          .map((row) => {
            const b = row === 9 ? `<c r="B9"><f t="shared" ref="B9:B13" si="0">Data!B2</f><v>0</v></c>` : `<c r="B${row}"><f t="shared" si="0"/><v>0</v></c>`;
            const e = row === 9 ? `<c r="E9"><f t="shared" ref="E9:E13" si="1">B9*2</f><v>0</v></c>` : `<c r="E${row}"><f t="shared" si="1"/><v>0</v></c>`;
            return `<row r="${row}">${b}${e}</row>`;
          })
          .join('') + '</sheetData>',
    },
    insertRows('Data', 4),
  ]],
];
for (const [name, workbook, steps] of CASES) cases.push({ name, workbook, steps });

// pivot tables written into a base workbook
const RECORDS = [['North', 'Web', 10], ['South', 'Store', 20], ['North', 'Store', 5], ['East', 'Web', 7], [null, 'Web', 1]];
const pivotStep = (over) => ({
  kind: 'pivot',
  headers: ['Region', 'Channel', 'Sales'],
  records: RECORDS,
  axes: [0],
  sourceSheet: 'Sheet1',
  sourceRef: 'A1:C6',
  destinationSheetPath: 'xl/worksheets/sheet1.xml',
  destination: 'E1',
  name: 'Probe',
  rowField: 0,
  columnField: -1,
  valueFields: [2],
  ...over,
});
const YEARS = [['Channel Partners', 2014, 1026913.86], ['Government', 2013, 2886645.28], ['Channel Partners', 2013, 289889.28], ['Government', 2014, 8501527.89]];
const KOREAN = [['수도권', '7월', 100], ['부산', '8월', 200.5], ['수도권', '8월', 300], ['부산', '7월', 400], ['호남', '7월', '12']];
for (const [name, steps] of [
  ['a pivot table by region', [pivotStep({})]],
  ['a pivot table by region and channel', [pivotStep({ axes: [0, 1], columnField: 1, rowField: 0 })]],
  ['a pivot table with no row field', [pivotStep({ axes: [], rowField: -1 })]],
  ['a pivot table with a column field only', [pivotStep({ axes: [1], rowField: -1, columnField: 1 })]],
  ['two value fields', [pivotStep({ headers: ['Region', 'Channel', 'Sales', 'Cost'], records: RECORDS.map((row, index) => [...row, index + 0.5]), valueFields: [2, 3] })]],
  ['a numeric field across the top', [pivotStep({
    headers: ['Segment', 'Year', 'Profit'], records: YEARS, axes: [0, 1], rowField: 0, columnField: 1, valueFields: [2], sourceRef: 'A1:C5', destination: 'E1',
  })]],
  ['a numeric field down the side', [pivotStep({
    headers: ['Segment', 'Year', 'Profit'], records: YEARS, axes: [1, 0], rowField: 1, columnField: 0, valueFields: [2], sourceRef: 'A1:C5', destination: 'B3',
  })]],
  ['a Korean pivot', [pivotStep({
    headers: ['권역', '월', '매출'], records: KOREAN, axes: [0, 1], rowField: 0, columnField: 1, valueFields: [2], sourceRef: 'A1:C6', destination: 'AB10',
  })]],
  ['two pivot tables one after another', [pivotStep({}), pivotStep({ name: 'Second', destination: 'J1', axes: [1], rowField: 1 })]],
  ['source sheet name with markup characters', [pivotStep({ sourceSheet: 'Q&A <1>', sourceRef: 'A1:C6' })]],
]) cases.push({ name, workbook: 'pivotBase', steps });

// ---- running a step
async function runStep(zip, step) {
  const sheets = await cells.workbookSheets(zip);
  const named = (name) => sheets.find((entry) => entry.name === name);
  switch (step.kind) {
    case 'shift': {
      const sheet = named(step.sheet);
      const xml = await opc.zipText(zip, sheet.path);
      return await shift.shiftWorksheetCells(zip, sheets, sheet, xml, { rows: step.rows, from: step.from, amount: step.amount, insert: step.insert, op: step.op });
    }
    case 'rename':
      return await shift.renameSheetReferences(zip, sheets, named(step.sheet), step.to, step.op);
    case 'copy': {
      const source = named(step.sheet);
      const copy = { name: step.name, path: step.path };
      zip.file(copy.path, shift.copiedSheetXml(await opc.zipText(zip, source.path), source.name, step.name));
      await shift.copySheetParts(zip, sheets, source, copy);
      return null;
    }
    case 'dropchain':
      await shift.dropCalculationChain(zip);
      return null;
    case 'replace':
      zip.file(step.part, (await opc.zipText(zip, step.part)).replace(step.find, () => step.with));
      return null;
    case 'pivot': {
      const fields = pivot.summarizePivotFields(step.headers, step.records, step.axes);
      const written = await pivot.writePivotTable(zip, {
        fields,
        records: step.records,
        sourceSheet: step.sourceSheet,
        sourceRef: step.sourceRef,
        destinationSheetPath: step.destinationSheetPath,
        destination: step.destination,
        name: step.name,
        rowField: step.rowField,
        columnField: step.columnField,
        valueFields: step.valueFields,
      });
      return { fields, written };
    }
    default:
      throw new Error(`unknown step ${step.kind}`);
  }
}

for (const entry of cases) {
  const zip = await JSZip.loadAsync(await buffer(workbooks[entry.workbook]));
  const before = new Map(workbooks[entry.workbook]);
  entry.outputs = [];
  for (const step of entry.steps) entry.outputs.push(await attempt(() => runStep(zip, step)));
  const after = await dump(zip);
  entry.names = after.map(([name]) => name);
  entry.changed = after.filter(([name, text]) => before.get(name) !== text);
}

async function buffer(parts) {
  const zip = new JSZip();
  for (const [name, text] of parts) zip.file(name, text);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

// ---- helpers over plain arguments
const pure = [];
const SORT = [
  ['=C6/B6-1', -4], ['=C6/B6-1', 4], ['$B6+B$2+$C$2:$C$6', -4], ['Report!C6+Data!C6+C6', -4], ['SUM(C2:C6)*2', 3], ['=A1', -1],
  ['A1+"A5"', 2], ['C:C+2:3', 5], ['SUM(\'My Data\'!A1)+A1', 2], ['', 3], ['1+2', 3], ['A1+', 3], ['A1', 0], ['IF(B2>1,B2,"x")', -1],
];
for (const [formula, delta] of SORT) pure.push({ fn: 'sortedFormula', args: [formula, delta], ...(await attempt(() => shift.sortedFormula(formula, delta))) });
const ROWS = '<worksheet><sheetData><row r="1"><c r="A1"/></row><row r="5" ht="30" customHeight="1" hidden="1" collapsed="1" s="4" customFormat="1"><c r="A5" s="2"><v>1</v></c><c r="B5" s="0"><v>2</v></c><c r="C5" s="7"/></row><row r="6"><c r="A6"><v>1</v></c></row></sheetData></worksheet>';
const PLAIN_ROWS = '<worksheet><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>';
for (const [xml, from, amount] of [[ROWS, 6, 2], [ROWS, 1, 2], [ROWS, 7, 1], [ROWS, 3, 1], [PLAIN_ROWS, 3, 2], [PLAIN_ROWS, 2, 1], [ROWS, 6, 0]])
  pure.push({ fn: 'inheritedRows', args: [xml, from, amount], ...(await attempt(() => shift.inheritedRows(xml, from, amount))) });
const FIELD_SETS = [
  [['Region', 'Channel', 'Sales'], RECORDS, []],
  [['Region', 'Channel', 'Sales'], RECORDS, [0, 1, 2]],
  [['a', 'b'], [[1, 'x'], [2.5, 'y'], ['3', 'x'], [true, 'z']], [0]],
  [['a', 'b'], [[1, ''], [2, null], [3, undefined]], [0, 1]],
  [['n'], [[-0], [0]], [0]],
  [['n'], [[2013], [2014], [2013]], [0]],
  [['n'], [['10'], ['9'], ['2']], [0]],
  [['t'], [['b'], ['a'], ['B'], ['A'], ['ä'], ['10'], ['9'], ['é'], ['Z']], [0]],
  [['t'], [], [0]],
  [['big'], [[1e21], [1e-7], [123456789012345680000]], [0]],
  [['x'], [[null], [null]], []],
  [['x', 'y'], [[1, 2], [3]], []],
];
for (const [headers, records, axes] of FIELD_SETS)
  pure.push({ fn: 'summarizePivotFields', args: [headers, records, axes], ...(await attempt(() => pivot.summarizePivotFields(headers, records, axes))) });

writeJson(join(stage, 'golden.json'), { workbooks, cases, pure });
writeSetManifest(stage, { set: 'office-shift-pivot', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
