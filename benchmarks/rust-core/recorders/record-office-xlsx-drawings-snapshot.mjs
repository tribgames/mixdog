#!/usr/bin/env node
// What the portable workbook read model, the sheet audits and the drawing operations answer
// (src/runtime/office/portable/portable-snapshot-xlsx.mjs, portable-sheet-audits.mjs, portable-xlsx-drawings.mjs), run through
// Node: the snapshot of fixture workbooks (Excel-saved, portable-made, with drawings, charts, pivots, notes, tables, a sheet of
// thousands of cells) at several page requests; the issue lists of the four audits; and the move / resize / delete / add of a
// picture or chart frame on a sheet's drawing, step by step. Rust `mixdog-ooxml` must answer the same: snapshot JSON text, issue
// lists and drawing XML equal as text, key order included (crates/mixdog-ooxml/tests/twin_xlsx_drawings_snapshot.rs).
//
//   node benchmarks/rust-core/recorders/record-office-xlsx-drawings-snapshot.mjs --tree <dir with node_modules> [--faces <dir>]
//
// `--faces` names the folder of the fixture faces when this checkout does not hold native/core/fixtures/office-measure.
// Output: native/core/fixtures/office-xlsx-drawings-snapshot/golden.json: `faces`, `snapshots`, `audits`, `drawings`, `pure`. Texts
// are measured in the fixture faces of office-measure registered on both sides. A path in a drawing step is `$DIR/name`, the
// work directory of the side that runs it.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const recorder = 'benchmarks/rust-core/recorders/record-office-xlsx-drawings-snapshot.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-xlsx-drawings-snapshot');
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
const snapshotModule = await importFrom(tree, `${portable}portable-snapshot-xlsx.mjs`);
const audits = await importFrom(tree, `${portable}portable-sheet-audits.mjs`);
const drawings = await importFrom(tree, `${portable}portable-xlsx-drawings.mjs`);
const cells = await importFrom(tree, `${portable}portable-cells.mjs`);
const opc = await importFrom(tree, `${portable}portable-opc.mjs`);
const page = await importFrom(tree, `${portable}portable-sheet-page.mjs`);

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-xlsx-snapshot-'));
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
const worksheet = (inner) => `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${inner}</worksheet>`;
const rels = (...entries) =>
  `${HEAD}<Relationships xmlns="${PKG}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const str = (reference, index, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`} t="s"><v>${index}</v></c>`;
const num = (reference, value, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`}><v>${value}</v></c>`;
const inline = (reference, value, style) =>
  `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t>${value}</t></is></c>`;
const row = (index, inner, attributes = '') => `<row r="${index}"${attributes}>${inner}</row>`;

const STYLES =
  `${HEAD}<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="&quot;&#8361;&quot;#,##0"/></numFmts>' +
  '<fonts count="5"><font><sz val="11"/><name val="Twin Miriam"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Twin Miriam"/></font>' +
  '<font><b/><sz val="27"/><name val="Twin Lisu"/></font>' +
  '<font><sz val="10"/><color rgb="FFEEEEEE"/><name val="Twin Miriam"/></font>' +
  '<font><i/><sz val="14"/><color rgb="FF1F3864"/><name val="Twin Lisu"/></font></fonts>' +
  '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellXfs count="12">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 default
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 1 percent
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"/>' + // 2 header: white on navy
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0"><protection locked="0"/></xf>' + // 3 unlocked input
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf>' + // 4 wrapped
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment horizontal="left" indent="1"/></xf>' + // 5 indented
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment horizontal="right"/></xf>' + // 6 right
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 7 won
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>' + // 8 big bold
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0"/>' + // 9 pale ink
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"><protection locked="false"/></xf>' + // 10 dark on dark inverse, unlocked
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0"><alignment horizontal="center"/></xf>' + // 11 italic centred
  '</cellXfs></styleSheet>';

// A workbook package: the sheets (with their relationships), the shared strings, the defined names and any extra part.
function book({ sheets, strings = [], names = '', calc = '', styles = STYLES, parts = {} }) {
  const files = {};
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  files['[Content_Types].xml'] =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides.join('')}</Types>`;
  files['_rels/.rels'] = rels(['rId1', 'officeDocument', 'xl/workbook.xml']);
  files['xl/workbook.xml'] =
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
    sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${index + 1}"/>`).join('') +
    `</sheets>${names}${calc}</workbook>`;
  files['xl/_rels/workbook.xml.rels'] = rels(...sheets.map((_, index) => [`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`]), [`rId${sheets.length + 1}`, 'styles', 'styles.xml']);
  if (styles) files['xl/styles.xml'] = styles;
  if (strings.length) files['xl/sharedStrings.xml'] = `${HEAD}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`;
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml;
    if (sheet.rels) files[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = sheet.rels;
  });
  return { ...files, ...parts };
}
const zipOf = (files) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip;
};

// ---- the drawing part: a chart frame, three pictures ------------------------------------------------------------------
const DRAWING =
  `${HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  '<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>' +
  '<xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>95250</xdr:rowOff></xdr:to>' +
  '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>` +
  '<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1905000" cy="952500"/>' +
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Logo &amp; mark" descr="Company &quot;logo&quot;"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId2"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>` +
  '<xdr:absoluteAnchor><xdr:pos x="1270000" y="254000"/><xdr:ext cx="2540000" cy="1270000"/>' +
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="4" name="Picture 3"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId3"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:absoluteAnchor>` +
  '<xdr:oneCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>30</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="635000" cy="635000"/>' +
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="5" name="Seal"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId4"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>` +
  '</xdr:wsDr>';
const CHART =
  `${HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>` +
  '<c:title><c:tx><c:rich><a:p><a:r><a:t>Throughput</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' +
  '<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Summary!$B$1</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>Summary!$A$2:$A$5</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Summary!$B$2:$B$5</c:f><c:numCache><c:ptCount val="4"/></c:numCache></c:numRef></c:val></c:ser>' +
  '<c:ser><c:idx val="1"/><c:tx><c:v>Target &amp; plan</c:v></c:tx><c:val><c:numRef><c:f>Summary!$C$2:$C$5</c:f></c:numRef></c:val></c:ser>' +
  '</c:barChart></c:plotArea><c:legend/></c:chart></c:chartSpace>';
const DRAWING_PARTS = {
  'xl/drawings/drawing1.xml': DRAWING,
  'xl/drawings/_rels/drawing1.xml.rels': rels(['rId1', 'chart', '../charts/chart1.xml'], ['rId2', 'image', '../media/image1.png'], ['rId3', 'image', '../media/image1.png'], ['rId4', 'image', '../media/seal.png']),
  'xl/charts/chart1.xml': CHART,
  'xl/charts/_rels/chart1.xml.rels': rels(['rId1', 'package', '../embeddings/Microsoft_Excel_Worksheet1.xlsx'], ['rId2', 'chartStyle', 'style1.xml'], ['rId3', 'chartColorStyle', 'colors1.xml']),
  'xl/charts/style1.xml': '<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle"/>',
  'xl/charts/colors1.xml': '<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle"/>',
  'xl/embeddings/Microsoft_Excel_Worksheet1.xlsx': 'embedded workbook bytes',
  'xl/media/image1.png': 'png-one',
  'xl/media/seal.png': 'png-seal',
};
const TYPED_PARTS = {
  '[Content_Types].xml': (types) =>
    types.replace(
      '</Types>',
      '<Default Extension="png" ContentType="image/png"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>' +
        '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
        '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' +
        '<Override PartName="/xl/charts/style1.xml" ContentType="application/vnd.ms-office.chartstyle+xml"/>' +
        '<Override PartName="/xl/charts/colors1.xml" ContentType="application/vnd.ms-office.chartcolorstyle+xml"/></Types>'
    ),
};
const withDrawing = (files) => {
  const next = { ...files, ...DRAWING_PARTS };
  for (const [name, change] of Object.entries(TYPED_PARTS)) next[name] = change(next[name]);
  return next;
};

// ---- the workbooks --------------------------------------------------------------------------------------------------
const SUMMARY_STRINGS = ['Metric', 'Target', 'Actual', '정시 출고율', 'Quarterly logistics operations summary', 'Region &amp; area', 'Note: see tab'];
const SUMMARY_SHEET = worksheet(
  '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:F9"/>' +
    '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols><col min="1" max="1" width="14.7109375" customWidth="1"/><col min="2" max="2" width="6.7109375" customWidth="1"/><col min="3" max="3" width="9.7109375" hidden="1" customWidth="1"/><col min="4" max="6" width="11.7109375" customWidth="1"/></cols>' +
    '<sheetData>' +
    row(1, `${str('A1', 0, 2)}${str('B1', 1, 2)}${str('C1', 2, 2)}${inline('D1', 'Inline &amp; text', 4)}`) +
    row(2, `${str('A2', 3)}${num('B2', 0.928, 1)}<c r="C2"><f>B2*2</f><v>1.856</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="str"><f>IF(B2&gt;0,"ok","")</f><v>ok</v></c><c r="F2"><f t="array" ref="F2:F3">B2:B3*2</f><v>1</v></c>`) +
    row(3, `${num('A3', 12)}<c r="B3"><f t="shared" ref="B3:B5" si="0">B2+1</f><v>1.928</v></c>${num('C3', 3, 7)}<c r="E3" t="str"><f>IF(B3&gt;0,"","")</f><v/></c>${num('F3', 2)}`, ' hidden="1"') +
    row(4, `${num('A4', 7)}<c r="B4" s="3"><f t="shared" si="0"/><v>2.928</v></c><c r="C4" s="11"><f>SUM(B2:B4)</f></c><c r="D4" t="e"><v>#DIV/0!</v></c>`) +
    row(5, `${num('A5', 9)}<c r="B5"><f t="shared" si="0"/><v>3.928</v></c>${str('E5', 5, 9)}`) +
    row(6, `${str('A6', 4)}${num('B6', 123456789)}${num('C6', -4.5, 6)}`) +
    row(7, `${num('A7', 42)}${num('B7', 987654321)}${str('C7', 6, 5)}`) +
    row(8, `${str('A8', 3, 8)}${num('B8', 0.57, 1)}`) +
    row(9, `${num('A9', 1)}${num('B9', 2)}`) +
    '</sheetData>' +
    '<sheetProtection sheet="1" password="C258" formatCells="0" sort="0"/>' +
    '<mergeCells count="2"><mergeCell ref="A9:B9"/><mergeCell ref="D6:E6"/></mergeCells>' +
    '<conditionalFormatting sqref="B2:B5 C2"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>0.9</formula></cfRule><cfRule type="expression" priority="2"><formula>$A2="x &amp; y"</formula></cfRule></conditionalFormatting>' +
    '<conditionalFormatting sqref="D2"><cfRule type="top10" rank="3"/></conditionalFormatting>' +
    '<dataValidations count="3"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="B3 B4"><formula1>"a,b,c"</formula1></dataValidation>' +
    '<dataValidation type="whole" operator="between" allowBlank="true" sqref="E2:E3 G1:G2"><formula1>1</formula1><formula2>10</formula2></dataValidation><dataValidation sqref="H1"/></dataValidations>' +
    '<printOptions horizontalCentered="1" verticalCentered="false"/><pageSetup orientation="landscape" scale="80" fitToWidth="2" fitToHeight="0"/>' +
    '<headerFooter><oddHeader>&amp;CQuarter &amp;amp; report</oddHeader><oddFooter>Page &amp;P of &amp;N</oddFooter></headerFooter>' +
    '<drawing r:id="rId1"/><legacyDrawing r:id="rId2"/><tableParts count="2"><tablePart r:id="rId4"/><tablePart r:id="rId6"/></tableParts>'
);
const SUMMARY_RELS = rels(
  ['rId1', 'drawing', '../drawings/drawing1.xml'],
  ['rId2', 'vmlDrawing', '../drawings/vmlDrawing1.vml'],
  ['rId3', 'comments', '../comments1.xml'],
  ['rId4', 'table', '../tables/table1.xml'],
  ['rId5', 'pivotTable', '../pivotTables/pivotTable1.xml'],
  ['rId6', 'table', '../tables/table2.xml']
);
const COMMENTS =
  `${HEAD}<comments xmlns="${MAIN}"><authors><author>김철수 &amp; Co</author><author>Lee</author></authors><commentList>` +
  '<comment ref="B2" authorId="0"><text><r><t>Check this &amp; that</t></r><r><t xml:space="preserve"> twice</t></r></text></comment>' +
  '<comment ref="a3" authorId="1"><text><t>lower-case reference</t></text></comment>' +
  '<comment ref="C4" authorId="7"><text><t>no such author</t></text></comment><comment ref=""><text><t>no ref</t></text></comment>' +
  '<comment ref="B2" authorId="1"><text><t>the same cell again</t></text></comment><comment ref="B9" authorId="0"><text></text></comment></commentList></comments>';
const SUMMARY_PARTS = {
  'xl/comments1.xml': COMMENTS,
  'xl/tables/table1.xml': `${HEAD}<table xmlns="${MAIN}" id="1" name="T1" displayName="Sales &amp; Co" ref="a1:d5"><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>`,
  'xl/tables/table2.xml': `${HEAD}<table xmlns="${MAIN}" id="2" name="Plain" ref="F1:F4"/>`,
  'xl/pivotTables/pivotTable1.xml': `${HEAD}<pivotTableDefinition xmlns="${MAIN}" name="PivotTable1" cacheId="1"><location ref="h3:j9" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/></pivotTableDefinition>`,
};
const DATA_STRINGS = ['id', 'Name', 'Total'];
const dataSheet = (rows) => {
  let body = row(1, `${str('A1', 0)}${str('B1', 1)}${str('C1', 2)}${str('D1', 2)}${str('E1', 2)}`);
  for (let index = 2; index <= rows; index += 1) {
    body += row(index, `${num(`A${index}`, index)}${inline(`B${index}`, `item ${index}`)}${num(`C${index}`, index * 3)}${num(`D${index}`, index / 4)}<c r="E${index}"><f>C${index}+D${index}</f>${index % 7 === 0 ? '' : `<v>${index * 3 + index / 4}</v>`}</c>`);
  }
  return worksheet(`<sheetData>${body}</sheetData>`);
};
const NAMES =
  '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Summary!$A$1:$D$20,\'Data sheet\'!$F$1:$G$5</definedName>' +
  '<definedName name="Rate" hidden="1">Summary!$B$2</definedName><definedName name="_xlnm.Print_Area" localSheetId="2">Notes!$A$1:$B$2</definedName>' +
  '<definedName name="Quote &amp; name" localSheetId="x">1</definedName></definedNames>';
const excelSaved = withDrawing(
  book({
    sheets: [
      { name: 'Summary', xml: SUMMARY_SHEET, rels: SUMMARY_RELS },
      { name: 'Data sheet', xml: dataSheet(12), state: 'hidden' },
      { name: 'Notes', xml: worksheet('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>Rich </t></r><r><t>text</t></r></is></c></row></sheetData>'), state: 'veryHidden' },
    ],
    strings: SUMMARY_STRINGS,
    names: NAMES,
    calc: '<calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1"/>',
    parts: SUMMARY_PARTS,
  })
);

// What the portable writer makes: inline strings, an absolute-anchored chart and picture, no shared strings, no calcPr.
const PORTABLE_DRAWING =
  `${HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  '<xdr:absoluteAnchor><xdr:pos x="2540000" y="254000"/><xdr:ext cx="4572000" cy="2743200"/>' +
  `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>` +
  '<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1270000" cy="635000"/>' +
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 2" descr="  spaced  "/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
const portableMade = withDrawing(
  book({
    sheets: [
      {
        name: "Q1 'plan'",
        xml: worksheet(
          '<sheetData>' +
            row(1, `${inline('A1', 'Region', 2)}${inline('B1', 'Sales', 2)}${inline('C1', 'Share', 2)}`) +
            row(2, `${inline('A2', 'North')}${num('B2', 120.5)}<c r="C2"><f>B2/SUM(B2:B3)</f><v></v></c>`) +
            row(3, `${inline('A3', 'South')}${num('B3', 80)}<c r="C3"><f>B3/SUM(B2:B3)</f><v></v></c>`) +
            '</sheetData><pageSetup orientation="portrait"/><drawing r:id="rId1"/>'
        ),
        rels: rels(['rId1', 'drawing', '../drawings/drawing1.xml']),
      },
    ],
    parts: {},
  })
);
portableMade['xl/drawings/drawing1.xml'] = PORTABLE_DRAWING;

// A sheet of thousands of cells, for the page requests and the display cap.
const large = book({
  sheets: [
    { name: 'Data', xml: dataSheet(410) },
    { name: 'Second', xml: dataSheet(5) },
    { name: 'Third', xml: worksheet('<sheetData/>') },
  ],
  strings: DATA_STRINGS,
});
// An anchor outside the Excel grid: the drawings are reported unreadable, the rest is read.
const unreadable = withDrawing(
  book({
    sheets: [
      {
        name: 'Broken',
        xml: worksheet(`<sheetData>${row(1, inline('A1', 'x'))}</sheetData><drawing r:id="rId1"/>`),
        rels: rels(['rId1', 'drawing', '../drawings/drawing1.xml']),
      },
    ],
  })
);
unreadable['xl/drawings/drawing1.xml'] = DRAWING.replace('<xdr:col>4</xdr:col>', '<xdr:col>99999</xdr:col>');
const noStyles = book({ sheets: [{ name: 'Bare', xml: worksheet(`<sheetData>${row(1, `${num('A1', 1)}${str('B1', 0, 3)}`)}</sheetData>`) }], strings: ['x'], styles: '' });
const noSheets = { '[Content_Types].xml': `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`, 'xl/workbook.xml': `${HEAD}<workbook xmlns="${MAIN}"/>` };
const badRange = book({ sheets: [{ name: 'S', xml: dataSheet(3) }], strings: DATA_STRINGS });

const WORKBOOKS = [
  ['excel-saved', excelSaved],
  ['portable-made', portableMade],
  ['large', large],
  ['unreadable-drawing', unreadable],
  ['no-styles', noStyles],
  ['no-sheets', noSheets],
  ['plain-data', badRange],
];
const LARGE_OPTIONS = [
  {},
  { full: true },
  { cellLimit: 5 },
  { cellLimit: null },
  { paged: true, offset: 3, limit: 4 },
  { paged: true, offset: 'x', limit: 300 },
  { paged: true, sheet: 'data', range: 'A1:B3' },
  { paged: true, sheet: 'Data', range: 'B2:C4', offset: 2, limit: 3 },
  { paged: true, sheet: 'Data', offset: 400, limit: 20 },
  { paged: true, sheetOffset: 1 },
  { paged: true, sheetOffset: 2 },
  { paged: true, sheetOffset: 9 },
  { paged: true, sheetOffset: 1.5 },
  { paged: true, sheet: 'nope' },
  { paged: true, sheet: 'Data', range: 'A0:B2' },
  { paged: true, limit: 2, range: 'not a range' },
  { paged: 'yes', cellLimit: 3 },
];
const SMALL_OPTIONS = [{}, { full: true }, { paged: true }, { paged: true, sheet: 'Summary', range: 'A1:B3' }, { paged: true, sheetOffset: 1 }, { paged: true, sheet: 'nope' }];
const snapshots = [];
for (const [name, files] of WORKBOOKS) {
  for (const request of name === 'large' ? LARGE_OPTIONS : SMALL_OPTIONS) {
    const zip = zipOf(files);
    snapshots.push({ workbook: name, options: request, output: await text(() => snapshotModule.snapshotXlsx(zip, request)) });
  }
}

// ---- the audits -----------------------------------------------------------------------------------------------------
const FIT_STRINGS = ['Quarterly logistics operations summary', 'Qty', '김서연', '박지훈', 'Wrapped description that is long enough to need a wide column', 'Total (USD)', 'Hidden label that is long', 'Name', 'Header'];
const FIT_SHEET = worksheet(
  '<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="8.7109375" customWidth="1"/><col min="2" max="2" width="6.7109375" customWidth="1"/>' +
    '<col min="3" max="4" width="9.7109375" customWidth="1"/><col min="5" max="6" width="6.7109375" customWidth="1"/><col min="7" max="7" width="3.7109375" hidden="1" customWidth="1"/></cols><sheetData>' +
    row(1, `${str('A1', 0)}${num('B1', 1234567)}${num('C1', 38)}${str('D1', 2, 0)}`) +
    row(2, `${str('A2', 1)}${num('B2', 123456789)}${num('C2', 38)}${inline('D2', '김서연')}${num('E2', 92.8, 8)}`) +
    row(3, `${str('A3', 4, 4)}${num('B3', 987654321)}${num('C3', 41, 6)}${str('D3', 3, 5)}${str('E3', 5)}${str('F3', 1)}`) +
    row(4, `${num('A4', 1)}${num('B4', 0.5, 1)}${num('C4', 7)}${str('D4', 3, 6)}${str('E4', 6)}${num('G4', 99999999)}`) +
    row(5, `${str('A5', 6)}${num('B5', 12345678, 7)}${num('C5', 5)}${str('D5', 7, 5)}${str('E5', 8, 2)}${str('F5', 7)}`) +
    row(6, `${str('A6', 6)}${num('B6', 1.5)}${num('C6', 5)}${num('E6', 123456, 8)}`, ' hidden="1"') +
    row(7, `${str('A7', 0, 5)}<c r="B7"><v></v></c>${num('C7', 3)}${num('F7', 4)}${inline('G7', 'x')}`) +
    '</sheetData><mergeCells count="2"><mergeCell ref="E2:F2"/><mergeCell ref=""/></mergeCells>'
);
const FORM_SHEET = (cells, validations, protectedSheet = true) =>
  worksheet(`<sheetData>${cells}</sheetData>${protectedSheet ? '<sheetProtection sheet="1"/>' : ''}<dataValidations count="1">${validations}</dataValidations>`);
const AUDIT_WORKBOOKS = [
  [
    'forms',
    book({
      sheets: [
        { name: 'Form', xml: FORM_SHEET(row(2, num('B2', 1)) + row(3, num('B3', 2, 3) + num('D3', 4)) + row(4, num('B4', 3) + num('D4', 5, 3)), '<dataValidation type="list" sqref="B2:B4 D3:D4"><formula1>"a,b"</formula1></dataValidation>') },
        { name: 'Locked', xml: FORM_SHEET(row(1, num('A1', 1) + num('A2', 2) + num('A3', 3) + num('B1', 1) + num('B2', 2) + num('B3', 3)), '<dataValidation sqref="A1:B3"/>') },
        { name: 'One', xml: FORM_SHEET(row(1, num('A1', 1)), '<dataValidation sqref="A1"/>') },
        { name: 'Open', xml: FORM_SHEET(row(1, num('A1', 1, 3)), '<dataValidation sqref="A1"/>') },
        { name: 'Unprotected', xml: FORM_SHEET(row(1, num('A1', 1)), '<dataValidation sqref="A1"/>', false) },
        { name: 'Wide', xml: FORM_SHEET(row(1, num('A1', 1)), '<dataValidation sqref="A1:Z700"/>') },
        { name: 'Elsewhere', xml: FORM_SHEET(row(1, num('Q1', 1)), '<dataValidation sqref="A1:C2"/>') },
      ],
    }),
  ],
  ['fit', book({ sheets: [{ name: 'Fit', xml: FIT_SHEET }, { name: 'Hidden fit', xml: FIT_SHEET, state: 'hidden' }, { name: 'Missing sheet part', xml: '' }], strings: FIT_STRINGS })],
  [
    'consistency',
    book({
      sheets: [
        {
          name: 'Plan',
          xml: worksheet(
            '<sheetData>' +
              row(1, `${num('A1', 100)}<c r="B1"><f>A1*1.1</f><v>110</v></c><c r="C1"><f>B1*1.1</f><v>121</v></c><c r="D1"><f>C1*1.1</f><v>133.1</v></c>${num('E1', 140)}${num('F1', 9)}${str('G1', 0)}<c r="H1"><f>G1</f></c>`) +
              row(2, `${num('A2', 1)}<c r="B2"><f>A2</f></c>${num('C2', 5)}<c r="D2"><f>A2</f></c>${num('E2', 6)}`) +
              row(3, `<c><f>A1</f></c>${num('B3', 5)}`) +
              '</sheetData>'
          ),
        },
      ],
      strings: ['x'],
    }),
  ],
  [
    'ink',
    book({
      sheets: [
        {
          name: 'Ink',
          xml: worksheet(
            '<sheetFormatPr defaultRowHeight="15"/><cols><col min="4" max="4" hidden="1"/></cols><sheetData>' +
              row(1, `${str('A1', 0, 9)}${str('B1', 1, 10)}${str('C1', 0, 2)}${str('D1', 0, 9)}${num('E1', 5, 9)}`) +
              row(2, `${str('A2', 0, 11)}${num('B2', 5, 9)}<c r="C2" s="9"/>${inline('D2', ' ', 9)}${inline('E2', 'Big', 8)}`) +
              row(3, `${str('A3', 0, 9)}${str('B3', 0, 9)}`, ' hidden="1"') +
              row(4, `${str('A4', 1, 9)}${str('B4', 1, 3)}${str('C4', 1, 99)}`) +
              '</sheetData><tableParts count="3"><tablePart r:id="rId1"/><tablePart r:id="rId9"/><tablePart r:id="rId2"/></tableParts>'
          ),
          rels: rels(['rId1', 'table', '../tables/table1.xml'], ['rId2', 'table', '../tables/table9.xml']),
        },
        { name: 'Hidden ink', xml: worksheet(`<sheetData>${row(1, str('A1', 0, 9))}</sheetData>`), state: 'hidden' },
      ],
      strings: ['pale', 'on navy'],
      parts: { 'xl/tables/table1.xml': `${HEAD}<table xmlns="${MAIN}" ref="A1:B2"/>`, 'xl/tables/table9.xml': `${HEAD}<table xmlns="${MAIN}"/>` },
    }),
  ],
  ['bad-validation-reference', book({ sheets: [{ name: 'Form', xml: FORM_SHEET(row(1, num('A1', 1)), '<dataValidation sqref="A1:B"/>') }] })],
  ['bad-merge', book({ sheets: [{ name: 'Fit', xml: worksheet('<sheetData>' + row(1, num('A1', 123456789)) + '</sheetData><mergeCells count="1"><mergeCell ref="1A:B2"/></mergeCells>') }] })],
  ['excel-saved', excelSaved],
  ['portable-made', portableMade],
  ['no-styles', noStyles],
  ['no-sheets', noSheets],
];
const auditRecords = [];
for (const [name, files] of AUDIT_WORKBOOKS) {
  const zip = zipOf(files);
  const sheets = await cells.workbookSheets(zip);
  auditRecords.push({
    workbook: name,
    protectedInputIssues: await text(() => audits.protectedInputIssues(zip, sheets)),
    columnFitIssues: await text(() => audits.columnFitIssues(zip, sheets)),
    formulaConsistencyIssues: await text(() => audits.formulaConsistencyIssues(zip, sheets)),
    cellInkIssues: await text(() => audits.cellInkIssues(zip, sheets)),
  });
}

// ---- the drawing operations -------------------------------------------------------------------------------------------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 64, 0, 0, 0, 32, 8, 6, 0, 0, 0, 0, 0, 0, 0])]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([30, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
const IMAGES = { 'logo.png': PNG, 'wide.GIF': GIF, 'blob.bmp': Buffer.from('not an image header at all, but long enough') };
for (const [name, data] of Object.entries(IMAGES)) writeFileSync(join(work, name), data);
const resolveOp = (op) => (typeof op.path === 'string' ? { ...op, path: op.path.replace('$DIR', work) } : op);

const STEPS = [
  ['set', { op: 'set_drawing', drawing: 1, left: 100, top: 40, width: 300, height: 150 }],
  ['set', { op: 'set_drawing', drawing: 1, width: 200 }],
  ['set', { op: 'set_drawing', name: 'chart 1', left: 5000 }],
  ['set', { op: 'set_drawing', drawing: '2', left: 10 }],
  ['set', { op: 'set_drawing', drawing: 'Logo & mark', left: 36, top: 72 }],
  ['set', { op: 'set_drawing', drawing: 'Logo & mark', width: 100.5, height: 50 }],
  ['set', { op: 'set_drawing', drawing: 3, left: 5 }],
  ['set', { op: 'set_drawing', drawing: 'picture 3', top: 8.5, width: 120 }],
  ['set', { op: 'set_drawing', drawing: 3 }],
  ['set', { op: 'set_drawing', drawing: 9, left: 1 }],
  ['set', { op: 'set_drawing', left: 1 }],
  ['set', { op: 'set_drawing', drawing: '   ', left: 1 }],
  ['set', { op: 'set_drawing', drawing: 'nothing', left: 1 }],
  ['set', { drawing: 1, left: null }],
  ['add', { op: 'add_image', path: '$DIR/logo.png', cell: 'd4', altText: '  A & B <chart>  ' }],
  ['add', { op: 'add_image', path: '$DIR/wide.GIF', left: 40, top: 20 }],
  ['add', { op: 'add_image', path: '$DIR/logo.png', left: 10, width: 90, height: 30, altText: '' }],
  ['add', { op: 'add_image', path: '$DIR/logo.png', cell: 'B2', left: null, top: 3 }],
  ['add', { op: 'add_image', path: '$DIR/blob.bmp', cell: 'Z1' }],
  ['add', { op: 'add_image', path: '$DIR/missing.png' }],
  ['add', { op: 'add_image', path: '$DIR/notes.txt' }],
  ['add', { op: 'add_image' }],
  ['add', { op: 'add_image', path: '$DIR/logo.png', cell: 'not a cell' }],
  ['delete', { op: 'delete_drawing', drawing: 'Picture 3' }],
  ['delete', { op: 'delete_drawing', drawing: 'Logo & mark' }],
  ['delete', { op: 'delete_drawing', drawing: 'Seal' }],
  ['delete', { op: 'delete_drawing', drawing: 1 }],
  ['delete', { op: 'delete_drawing', drawing: 7 }],
  ['delete', { op: 'delete_drawing' }],
];
const drawingScenarios = [];
for (const [name, workbookName, files, sheetName, steps] of [
  ['the drawing of an Excel-saved sheet', 'excel-saved', excelSaved, 'Summary', STEPS],
  ['the drawing of a portable-made sheet', 'portable-made', portableMade, "Q1 'plan'", STEPS.filter((_, index) => [0, 2, 4, 5, 8, 14, 15, 23, 24, 26].includes(index))],
  [
    'a sheet with no drawing',
    'bare-sheet',
    book({ sheets: [{ name: 'Plain', xml: worksheet('<sheetData/>') }] }),
    'Plain',
    [STEPS[0], ['delete', { op: 'delete_drawing', drawing: 1 }], ['add', { op: 'add_image', path: '$DIR/logo.png', cell: 'A1' }], STEPS[0], ['delete', { op: 'delete_drawing', drawing: 1 }]],
  ],
]) {
  const zip = zipOf(files);
  const sheet = (await cells.workbookSheets(zip)).find((entry) => entry.name === sheetName);
  const recordedSteps = [];
  for (const [kind, op] of steps) {
    const xml = await opc.zipText(zip, sheet.path);
    const run = { set: () => drawings.setWorksheetDrawing(zip, sheet, xml, resolveOp(op)), add: () => drawings.addWorksheetImage(zip, sheet, xml, resolveOp(op)), delete: () => drawings.deleteWorksheetDrawing(zip, sheet, xml, resolveOp(op)) }[kind];
    const output = await text(run);
    const names = Object.keys(zip.files).filter((entry) => !entry.endsWith('/')).sort();
    const found = await attempt(async () => (await page.worksheetDrawings(zip, sheet, await opc.zipText(zip, sheet.path))).map((entry) => ({ kind: entry.kind, startColumn: entry.startColumn, startRow: entry.startRow, endColumn: entry.endColumn, endRow: entry.endRow })));
    recordedSteps.push({
      kind,
      op,
      output,
      names,
      worksheet: await opc.zipText(zip, sheet.path),
      drawing: await opc.zipText(zip, 'xl/drawings/drawing1.xml'),
      drawingRels: await opc.zipText(zip, 'xl/drawings/_rels/drawing1.xml.rels'),
      types: await opc.zipText(zip, '[Content_Types].xml'),
      placed: found.error === undefined ? JSON.stringify(found.result) : found.error,
    });
  }
  drawingScenarios.push({ name, workbook: workbookName, sheet: sheetName, images: Object.fromEntries(Object.entries(IMAGES).map(([file, data]) => [file, data.toString('base64')])), steps: recordedSteps });
}

// ---- the pure helpers -------------------------------------------------------------------------------------------------
const FRAME = '<xdr:pic/>';
const pure = [];
for (const placement of [
  { cell: 'E9', width: 100, height: 50 },
  { cell: 'b2', width: 0, height: -3 },
  { cell: 'E9', left: 10, width: 100, height: 50 },
  { cell: 'E9', top: 0, width: 100, height: 50 },
  { cell: 'E9', left: null, width: 100, height: 50 },
  { left: 36, top: 72.25, width: 240, height: 180 },
  { width: 240, height: 180 },
  { cell: '', left: 'x', top: '12', width: '5', height: undefined },
  { cell: 'AA100', width: 1e-9, height: 1e9 },
  { cell: 'nope', width: 1, height: 1 },
]) {
  pure.push({ fn: 'frameAnchorXml', args: [placement, FRAME], output: await text(() => drawings.frameAnchorXml(placement, FRAME)) });
}
for (const xml of ['', '<xdr:oneCellAnchor/>', '<xdr:twoCellAnchor a="1"><xdr:absoluteAnchor/><xdr:absoluteCellAnchor/><xdr:oneCellAnchorX/>', DRAWING, PORTABLE_DRAWING]) {
  pure.push({ fn: 'countDrawingAnchors', args: [xml], output: await text(() => drawings.countDrawingAnchors(xml)) });
}
for (const xml of ['<worksheet/>', SUMMARY_SHEET, FIT_SHEET, '<dataValidation sqref="A1"/><dataValidation type="whole" sqref="B1  C1&#10;D1"><formula1 x="1">1</formula1></dataValidation>']) {
  pure.push({ fn: 'worksheetValidations', args: [xml, 'S&1'], output: await text(() => snapshotModule.worksheetValidations(xml, 'S&1')) });
}
pure.push({ fn: 'FULL_READ_CELL_LIMIT', args: [], output: await text(() => snapshotModule.FULL_READ_CELL_LIMIT) });

const workbooks = Object.fromEntries([...WORKBOOKS, ...AUDIT_WORKBOOKS]);
workbooks['bare-sheet'] = book({ sheets: [{ name: 'Plain', xml: worksheet('<sheetData/>') }] });
writeJson(join(stage, 'golden.json'), {
  workbooks,
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  snapshots,
  audits: auditRecords,
  drawings: drawingScenarios,
  pure,
});
writeSetManifest(stage, { set: 'office-xlsx-drawings-snapshot', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(work, { recursive: true, force: true });
