#!/usr/bin/env node
// What the portable pptx base modules answer (src/runtime/office/portable: portable-slide-shapes, pptx-targets,
// portable-pptx-package, portable-pptx-core, portable-pptx-chart, portable-snapshot-shared, image-layout, review-editability),
// run through Node. Rust `mixdog-ooxml` must answer the same: the XML text of every shape builder, the ids and relationship ids
// allocated by every slide operation, the text of every changed part and the returned JSON
// (crates/mixdog-ooxml/tests/twin_pptx_base.rs).
//
//   node benchmarks/rust-core/recorders/record-office-pptx-base.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-pptx-base/golden.json. The recording holds `pure` (a function name, its arguments and its
// result or error) and `sequences` (steps over one deck: each step's output, then the deck's part names and the text of every
// part).
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-pptx-base');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-pptx-base.mjs';
const portable = (name) => importFrom(tree, `src/runtime/office/portable/${name}.mjs`);
const shapes = await portable('portable-slide-shapes');
const targets = await portable('pptx-targets');
const deck = await portable('portable-pptx-package');
const core = await portable('portable-pptx-core');
const chart = await portable('portable-pptx-chart');
const shared = await portable('portable-snapshot-shared');
const layout = await portable('image-layout');
const editability = await portable('review-editability');
const opc = await portable('portable-opc');
const pkg = await portable('portable-package');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-pptx-base-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const b64 = (list) => Buffer.from(list).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 4, 8, 6, 0, 0, 0]);

// The shapes the sequences and the pure cases share, written by the Node builders.
const title = shapes.shapeXml({
  id: 2,
  name: 'Title',
  left: 40,
  top: 30,
  width: 880,
  height: 60,
  textBox: true,
  textBody: shapes.textBodyXml({ paragraphs: [{ text: 'Quarterly 매출 & results', fontSize: 32, bold: true, color: '#112233', fontName: 'Calibri' }], anchor: 'middle' }),
});
const card = shapes.shapeXml({
  id: 3,
  name: 'Card',
  geometry: 'rounded_rectangle',
  left: 40,
  top: 120,
  width: 400,
  height: 200,
  properties: { fillColor: '0A1B2C', lineColor: 'ffffff', lineWidth: 2, shadow: true },
  textBody: shapes.textBodyXml({ paragraphs: [{ text: 'Revenue', fontSize: 24, color: 'FFFFFF' }, { text: '1,420', fontSize: 40, bold: true, color: 'FFFFFF' }], anchor: 'center' }),
});
const wash = shapes.shapeXml({
  id: 4,
  name: 'Wash',
  left: 60,
  top: 140,
  width: 200,
  height: 80,
  properties: { fillColor: 'FF0000', fillTransparency: 50 },
  textBody: shapes.textBodyXml({ paragraphs: [{ text: ' padded text ', fontSize: 14, color: '000000' }] }),
});
const hidden = shapes.shapeXml({ id: 5, name: 'Hidden', left: 0, top: 0, width: 50, height: 50, textBody: shapes.textBodyXml({ paragraphs: [{ text: 'never seen', fontSize: 12 }] }) }).replace('<p:cNvPr id="5"', '<p:cNvPr hidden="1" id="5"');
const picture = shapes.pictureXml({ id: 6, embedId: 'rId2', left: 500, top: 120, width: 200, height: 100, crop: { left: 0.1, right: 0.2 }, altText: 'A "logo"' });
const table = shapes.tableXml({
  id: 7,
  name: 'Table',
  values: [['Region', 'Sales', 'Share'], ['North', '1,420', '34%'], ['South', '−12', '8.4%'], ['East', '2,840원', '-']],
  left: 40,
  top: 340,
  width: 600,
  height: 160,
  properties: { columnWidths: [200, 200, 200], headerFillColor: '#223344', headerColor: 'FFFFFF', fontSize: 12 },
});
const related = shapes.shapeXml({ id: 8, name: `mixdog-relation:${encodeURIComponent(JSON.stringify({ id: 'k1', role: 'label' }))}`, left: 700, top: 340, width: 200, height: 30, textBody: shapes.textBodyXml({ paragraphs: [{ text: 'Label', fontSize: 12 }] }) });
const SLIDE_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slideWith = (items, extra = '', root = '') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${SLIDE_NS}${root}><p:cSld>${extra}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${items.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales &amp; costs</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="336699"/></a:solidFill></c:spPr><c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="FF8800"/></a:solidFill></c:spPr></c:dPt><c:dLbls><c:dLbl><c:idx val="0"/><c:txPr><a:p><a:r><a:srgbClr val="111111"/></a:r></a:p></c:txPr></c:dLbl><c:txPr><a:bodyPr/><a:p><a:srgbClr val="FFFFFF"/></a:p></c:txPr><c:dLblPos val="ctr"/><c:showVal val="1"/></c:dLbls><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1 &amp; Q2</c:v></c:pt><c:pt idx="1"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:ser><c:idx val="1"/><c:tx><c:v>Costs</c:v></c:tx><c:spPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f></c:numRef></c:val></c:ser></c:barChart><c:catAx><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="1"/></c:catAx><c:valAx><c:scaling><c:orientation val="minMax"/><c:max val="100"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:majorGridlines/><c:numFmt formatCode="#,##0&quot;원&quot;" sourceLinked="0"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart><c:txPr><a:bodyPr/></c:txPr></c:chartSpace>`;
const CHART_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/chartStyle" Target="style1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/old.xlsx"/></Relationships>`;
const TABLE_SHAPE = table;

const DOCX_RUN = '<w:r><w:rPr><w:rFonts w:ascii="Malgun &amp; Gothic"/><w:b/><w:caps/><w:color w:val="1a2b3c"/><w:spacing w:val="40"/><w:sz w:val="28"/></w:rPr><w:t>Hi</w:t></w:r>';
const SHAPE_PARAGRAPHS = '<p:sp><p:txBody><a:bodyPr lIns="91440" wrap="none"/><a:p><a:pPr><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef><a:spcAft><a:spcPts val="1200"/></a:spcAft></a:pPr><a:r><a:rPr lang="en-US" sz="4000" b="1" i="1" spc="-50"><a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>1,420</a:t></a:r><a:r><a:rPr sz="1400"/><a:t xml:space="preserve"> units &amp; more</a:t></a:r><a:br/><a:r><a:t>second</a:t></a:r></a:p><a:p><a:r><a:rPr sz="1800"/><a:t></a:t></a:r></a:p></p:txBody></p:sp>';

const rect = (slide, shape, left, top, width, height) => ({ slide, shape, kind: 'p:sp', left, top, width, height });
const line = (slide, shape, top, text, { left = 72, width = 400, size = 18, bold = false } = {}) => ({
  slide,
  shape,
  left,
  top,
  width,
  height: size * 1.4,
  paragraphs: [{ text, fontSize: size, bold, fontName: 'Calibri' }],
});

const LAYOUTS = [
  { path: 'ppt/slideLayouts/slideLayout1.xml', name: '제목 슬라이드', type: 'title' },
  { path: 'ppt/slideLayouts/slideLayout2.xml', name: '제목 및 내용', type: 'obj' },
  { path: 'ppt/slideLayouts/slideLayout3.xml', name: '구역 머리글', type: 'secHead' },
  { path: 'ppt/slideLayouts/slideLayout4.xml', name: '제목만', type: 'titleOnly' },
  { path: 'ppt/slideLayouts/slideLayout5.xml', name: '빈 화면', type: 'blank' },
  { path: 'ppt/slideLayouts/slideLayout6.xml', name: '', type: '' },
];
const PRESENTATION = '<p:presentation xmlns:p="x"><p:sldMasterIdLst/><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="300" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>';

const PURE = [
  ['toEmu', [12.5], (v) => shapes.toEmu(v)],
  ['toEmu', ['7'], (v) => shapes.toEmu(v)],
  ['toEmu', [null], (v) => shapes.toEmu(v)],
  ['toEmu', ['abc'], (v) => shapes.toEmu(v)],
  ['toEmu', [0.00001], (v) => shapes.toEmu(v)],
  ['fromEmu', [127000, 5], (...a) => shapes.fromEmu(...a)],
  ['resolveGeometry', ['Rounded Rectangle'], (v) => shapes.resolveGeometry(v)],
  ['resolveGeometry', ['  right-arrow '], (v) => shapes.resolveGeometry(v)],
  ['resolveGeometry', ['nothing'], (v) => shapes.resolveGeometry(v)],
  ['resolveGeometry', [''], (v) => shapes.resolveGeometry(v)],
  ['supportedShapeTypes', [], () => shapes.supportedShapeTypes()],
  ['textBodyXml', [{ paragraphs: [{ text: 'Plain' }, { text: ' lead and trail ', bullet: true, level: 2, align: 'Centre', fontSize: 14.5, italic: true, bold: true, fontName: 'Malgun "Gothic"', color: 'abc', paragraphSpacing: 6 }, { text: '' }, { text: 'a & b <c>', level: 99, align: 'nope', fontSize: -3 }], defaults: { fontSize: 20, color: '#334455', align: 'right' }, anchor: 'Bottom', wrap: false, margins: { marginLeft: 5, marginTop: 0, marginRight: null, marginBottom: 2.5 }, autofit: 'shrink' }], (o) => shapes.textBodyXml(o)],
  ['textBodyXml', [{}], (o) => shapes.textBodyXml(o)],
  ['textBodyXml', [{ paragraphs: [{ text: 'x' }], autofit: 'resize', anchor: 'weird' }], (o) => shapes.textBodyXml(o)],
  ['shapeXml', [{ id: 9, name: 'A "box" & <more>', geometry: 'ellipse', left: 10.4, top: 20.6, width: 0, height: -5, properties: { fillColor: '#abc', fillTransparency: 30, lineColor: '00ff00', lineWidth: 1.5, lineTransparency: 20, rotation: 45.5, altText: 'Alt <&>', shadow: { color: 'ff0000', transparency: 0.4, blur: 8, offsetX: 3, offsetY: -4 } }, textBody: '<a:p/>' }], (o) => shapes.shapeXml(o)],
  ['shapeXml', [{ id: 10, textBox: true }], (o) => shapes.shapeXml(o)],
  ['shapeXml', [{ id: 11, textBox: true, properties: { fillColor: null, lineColor: null } }], (o) => shapes.shapeXml(o)],
  ['shapeXml', [{ id: 12, properties: { fillColor: 'nonsense', lineColor: 'nonsense', shadow: true } }], (o) => shapes.shapeXml(o)],
  ['pictureXml', [{ id: 3, embedId: 'rId4', crop: { left: 0.25, top: 2, right: -1, bottom: 'x' } }], (o) => shapes.pictureXml(o)],
  ['pictureXml', [{ id: 4, name: 'Logo', embedId: 'rId5', left: 1, top: 2, width: 3, height: 4, crop: { left: 0 }, altText: 'x' }], (o) => shapes.pictureXml(o)],
  ['tableXml', [{ id: 5, values: [['a']] }], (o) => shapes.tableXml(o)],
  ['tableXml', [{ id: 6, name: 'T', values: [['Item', 'Qty', 'Price'], ['Pen', 3, '$1.20'], ['Ink', 12, null], ['x']], width: 300, height: 90, properties: { headerRowHeight: 30, bodyRowHeight: 20, bodyFillColor: 'EEE', align: 'center', bold: true, color: '444444', fontName: 'Arial' } }], (o) => shapes.tableXml(o)],
  ['tableXml', [{ id: 7, values: [] }], (o) => shapes.tableXml(o)],
  ['tableXml', [{ id: 8, values: [[]] }], (o) => shapes.tableXml(o)],
  ['restyleShapeText', [card, { fillColor: 'ignored', lineColor: '#00FF00', alignment: 'center', fontName: 'Arial', fontSize: 11, bold: false, italic: true, color: '112233', verticalAlignment: 'top', marginLeft: 3, marginBottom: 1, paragraphSpacing: 8, shadow: { blur: 2 } }], (...a) => shapes.restyleShapeText(...a)],
  ['restyleShapeText', [card, { lineWidth: 4 }], (...a) => shapes.restyleShapeText(...a)],
  ['restyleShapeText', [card, { lineTransparency: 60, paragraphSpacing: 0 }], (...a) => shapes.restyleShapeText(...a)],
  ['restyleShapeText', [title, { lineColor: null, shadow: true, color: 'FF0000' }], (...a) => shapes.restyleShapeText(...a)],
  ['restyleShapeText', [picture, { alignment: 'left' }], (...a) => shapes.restyleShapeText(...a)],
  ['restyledParagraphs', ['<a:p><a:pPr algn="l"/><a:r><a:rPr lang="ko-KR"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="X"/><a:hlinkClick r:id="rId1"/></a:rPr><a:t>x</a:t></a:r><a:endParaRPr/></a:p><a:p><a:r><a:t>y</a:t></a:r></a:p>', { alignment: 'justify', fontName: 'Arial', color: 'abc', fontSize: 9, bold: true }], (...a) => shapes.restyledParagraphs(...a)],
  ['textAnchor', ['Middle'], (v) => shapes.textAnchor(v)],
  ['textAnchor', ['sideways'], (v) => shapes.textAnchor(v)],
  ['solidFillXml', ['#123456', 25], (...a) => shapes.solidFillXml(...a)],
  ['solidFillXml', ['zzz'], (...a) => shapes.solidFillXml(...a)],
  ['solidFillXml', ['abc', 100], (...a) => shapes.solidFillXml(...a)],
  ['backgroundXml', ['#0a0a0a'], (v) => shapes.backgroundXml(v)],
  ['backgroundXml', ['blue'], (v) => shapes.backgroundXml(v)],
  ['detectChartType', ['<c:pieChart/>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:doughnutChart/>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:lineChart/>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:areaChart/>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/></c:barChart>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/></c:barChart>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:barChart><c:barDir val="bar"/></c:barChart>'], (v) => chart.detectChartType(v)],
  ['detectChartType', ['<c:barChart/>'], (v) => chart.detectChartType(v)],
  ['readChartPresentation', [CHART], (v) => chart.readChartPresentation(v)],
  ['readChartPresentation', [''], (v) => chart.readChartPresentation(v)],
  ['readChartPresentation', ['<c:ser><c:dPt><c:idx val="3"/><a:srgbClr val="AA0000"/></c:dPt><c:dPt><c:idx val="x"/><a:srgbClr val="00AA00"/></c:dPt></c:ser><c:valAx><c:min val="abc"/><c:max val="2.5"/></c:valAx>'], (v) => chart.readChartPresentation(v)],
  ['chartFrameXml', [{ id: 9, relationshipId: 'rId7', left: 10, top: 20.5, width: 300, height: 0 }], (o) => chart.chartFrameXml(o)],
  ['chartCategories', [CHART], (v) => chart.chartCategories(v)],
  ['chartTitleText', [CHART], (v) => chart.chartTitleText(v)],
  ['chartPartSnapshot', [CHART], (v) => shared.chartPartSnapshot(v)],
  ['chartPartSnapshot', ['<c:chartSpace/>'], (v) => shared.chartPartSnapshot(v)],
  ['docxRunFont', [DOCX_RUN], (v) => shared.docxRunFont(v)],
  ['docxRunFont', ['<w:r><w:rPr><w:b w:val="0"/><w:caps w:val="false"/><w:color w:val="auto"/><w:sz w:val="21"/><w:sz w:val="40"/></w:rPr></w:r>'], (v) => shared.docxRunFont(v)],
  ['docxRunFont', ['<w:r/>'], (v) => shared.docxRunFont(v)],
  ['docxParagraphSpacing', ['<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:spacing w:after="999"/>'], (v) => shared.docxParagraphSpacing(v)],
  ['docxParagraphSpacing', ['<w:style><w:spacing w:after="60"/></w:style>'], (v) => shared.docxParagraphSpacing(v)],
  ['nextPageOffset', [0, 10, 25], (...a) => shared.nextPageOffset(...a)],
  ['nextPageOffset', [20, 5, 25], (...a) => shared.nextPageOffset(...a)],
  ['populatedCellPagination', [{ options: { offset: 10, limit: 5, range: 'A1:B2' }, page: { records: [1, 2, 3], total: 40 }, selectedSheets: [{ name: 'Data' }], sheets: [{}, {}], sheetOffset: 0 }], (o) => shared.populatedCellPagination(o)],
  ['populatedCellPagination', [{ options: {}, page: { records: [], total: 0 }, selectedSheets: [], sheets: [{}, {}, {}], sheetOffset: 0 }], (o) => shared.populatedCellPagination(o)],
  ['populatedCellPagination', [{ options: { sheet: 'X', offset: -3, limit: 0 }, page: null, selectedSheets: [{ name: 'X' }], sheets: [{}], sheetOffset: 0 }], (o) => shared.populatedCellPagination(o)],
  ['statedRunFont', [DOCX_RUN], (v) => shared.statedRunFont(v)],
  ['statedRunFont', ['<w:r><w:t>plain</w:t></w:r>'], (v) => shared.statedRunFont(v)],
  ['softBreakFacts', ['<w:r><w:br/><w:br w:type="page"/><w:br w:clear="all"/></w:r>'], (v) => shared.softBreakFacts(v)],
  ['softBreakFacts', ['<w:r><w:t>x</w:t></w:r>'], (v) => shared.softBreakFacts(v)],
  ['resolveImageLayout', [{ sourceWidth: 400, sourceHeight: 200, left: 10, top: 20, width: 100, height: 100, fit: 'contain' }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{ sourceWidth: 400, sourceHeight: 200, width: 100, height: 100, fit: 'Cover', focusX: 0.9 }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{ sourceWidth: 100, sourceHeight: 400, width: 200, height: 100, fit: 'cover', focusY: 0 }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{ sourceWidth: 100, sourceHeight: 100, width: 50, height: 50, fit: 'cover' }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{ width: 0, height: 'x', left: 'q' }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{ fit: 'contain' }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{ fit: 'tile' }], (o) => layout.resolveImageLayout(o)],
  ['resolveImageLayout', [{}], (o) => layout.resolveImageLayout(o)],
  ['reviewTextFragmentation', [[line(2, 1, 60, 'Title', { size: 36, bold: true }), line(2, 2, 140, 'one'), line(2, 3, 166, 'two'), line(2, 4, 192, 'three'), line(2, 5, 218, 'four'), line(2, 6, 400, 'caption', { size: 12 }), line(3, 1, 100, 'a'), line(3, 2, 126, 'b'), { slide: 3, shape: 3, left: 72, top: 152, width: 400, height: 25, relation: { id: 'v', role: 'value', label: 'l' }, paragraphs: [{ text: 'c', fontSize: 18, fontName: 'Calibri' }] }, { slide: 3, shape: 4, left: 72, top: 178, width: 400, height: 25, relation: { id: 'l', role: 'label' }, paragraphs: [{ text: 'd', fontSize: 18, fontName: 'Calibri' }] }]], (b) => editability.reviewTextFragmentation(b)],
  ['reviewTextFragmentation', [[line(1, 1, 10, 'a'), line(1, 2, 36, 'b')], { minimumRun: 2 }], (b, o) => editability.reviewTextFragmentation(b, o)],
  ['reviewDeadVectorChart', [[rect(3, 1, 72, 300, 40, 120), rect(3, 2, 132, 240, 40, 180), rect(3, 3, 192, 360, 40, 60), rect(3, 4, 252, 200, 40, 220), rect(3, 5, 72, 60, 500, 40)], [{ slide: 3, shape: 5, paragraphs: [{ text: 'Title', fontSize: 30 }] }]], (...a) => editability.reviewDeadVectorChart(...a)],
  ['reviewDeadVectorChart', [[rect(4, 1, 72, 100, 300, 24), rect(4, 2, 72, 140, 180, 24), rect(4, 3, 72, 180, 420, 24), rect(4, 4, 72, 220, 90, 24)], []], (...a) => editability.reviewDeadVectorChart(...a)],
  ['reviewDeadVectorChart', [[rect(5, 1, 72, 100, 200, 150), rect(5, 2, 300, 100, 200, 150), rect(5, 3, 528, 100, 200, 150), rect(5, 4, 756, 100, 200, 150), { slide: 5, shape: 5, kind: 'p:graphicFrame', left: 0, top: 0, width: 1, height: 1 }], []], (...a) => editability.reviewDeadVectorChart(...a)],
  ['shapeParagraphs', [SHAPE_PARAGRAPHS], (v) => core.shapeParagraphs(v)],
  ['shapeParagraphs', ['<p:sp><a:p><a:r><a:t>no size</a:t></a:r></a:p></p:sp>'], (v) => core.shapeParagraphs(v)],
  ['shapeParagraphs', ['<p:sp/>'], (v) => core.shapeParagraphs(v)],
  ['textInsets', [' lIns="91440" tIns="0" rIns="x"'], (v) => core.textInsets(v)],
  ['textInsets', [''], (v) => core.textInsets(v)],
  ['shapeFrame', [card], (v) => core.shapeFrame(v)],
  ['shapeFrame', ['<p:sp><a:off x="1" y="2"/></p:sp>'], (v) => core.shapeFrame(v)],
  ['setTableValues', [TABLE_SHAPE, [['R', 'S', 'T'], ['N', '1', '2']]], (...a) => core.setTableValues(...a)],
  ['setTableValues', [TABLE_SHAPE, [['R', 'S', 'T', 'U'], ['N', '1', '2', '3'], ['E', 'x'], ['W', 'y', 'z'], ['new', 'row', 'here', 'now', 'wide']]], (...a) => core.setTableValues(...a)],
  ['setTableValues', [TABLE_SHAPE, []], (...a) => core.setTableValues(...a)],
  ['setTableValues', [TABLE_SHAPE, ['bad', ['only row']]], (...a) => core.setTableValues(...a)],
  ['setTableValues', [card, [['x']]], (...a) => core.setTableValues(...a)],
  ['setTableValues', ['<a:tbl><a:tblGrid><a:gridCol w="100"/></a:tblGrid><a:tr h="10"><a:tc><a:txBody><a:p></a:p></a:txBody></a:tc></a:tr><a:tr h="12"><a:tc><a:txBody></a:txBody></a:tc></a:tr></a:tbl>', [[' lead & trail '], ['b'], ['c', 'd']]], (...a) => core.setTableValues(...a)],
  ['setTableValues', ['<a:tbl><a:tr><a:tc><a:tcPr/></a:tc></a:tr></a:tbl>', [['x']]], (...a) => core.setTableValues(...a)],
  ['setSlideBackground', [slideWith([title]), '#102030'], (...a) => core.setSlideBackground(...a)],
  ['setSlideBackground', [slideWith([title], '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>'), '000'], (...a) => core.setSlideBackground(...a)],
  ['setSlideBackground', ['<p:sld/>', '000000'], (...a) => core.setSlideBackground(...a)],
  ['setSlideBackground', [slideWith([]), 'red'], (...a) => core.setSlideBackground(...a)],
  ['appendSlideShape', [slideWith([title]), card], (...a) => core.appendSlideShape(...a)],
  ['appendSlideShape', ['<p:sld/>', card], (...a) => core.appendSlideShape(...a)],
  ['updateShapeGeometry', [card, { left: 1, top: 2, width: 3.5, height: 4, rotation: 90, altText: 'New "alt"' }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', [card, { width: 10, fillColor: '#FF00FF', fillTransparency: 40 }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', [card, { fillTransparency: 25, altText: '' }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', [card, { fillColor: null }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', [title, { fillColor: 'AA0000' }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', [table, { left: 5, top: 6, rotation: 10 }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', [picture, { left: 5, altText: 'pic' }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', ['<p:sp><p:nvSpPr><p:cNvPr id="1" name="x"/></p:nvSpPr><p:spPr/></p:sp>', { left: 7, fillColor: '123456' }], (...a) => core.updateShapeGeometry(...a)],
  ['updateShapeGeometry', ['<p:sp><p:nvSpPr><p:cNvPr id="1" name="x">hmm</p:cNvPr></p:nvSpPr><p:spPr><a:xfrm rot="600000"><a:off x="5" y="6"/><a:ext cx="7" cy="8"/></a:xfrm><a:ln><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:ln></p:spPr></p:sp>', { top: 9, fillColor: '123456', altText: 'd' }], (...a) => core.updateShapeGeometry(...a)],
  ['nextShapeId', [slideWith([title, card])], (v) => core.nextShapeId(v)],
  ['nextShapeId', ['<p:sld/>'], (v) => core.nextShapeId(v)],
  ['selectedShapeSpans', [{ start: 0, end: 0, inner: `${title}${card}${picture}` }, [3, 1]], (tree, numbers) => core.selectedShapeSpans(tree, numbers)],
  ['selectedShapeSpans', [{ start: 0, end: 0, inner: `${title}` }, [2]], (tree, numbers) => core.selectedShapeSpans(tree, numbers)],
  ['writeShapeTree', ['<p:sld><p:spTree>OLD</p:spTree></p:sld>', { start: 18, end: 21 }, ['<a/>', '<b/>']], (...a) => core.writeShapeTree(...a)],
  ['selectSlideLayout', [LAYOUTS, 'Title Only'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, 'comparison'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, '제목만'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, 'SECHEAD'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, ' 3 '], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, '0'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, '99'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, ''], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS.slice(0, 2), null], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [LAYOUTS, 'Agenda'], (...a) => deck.selectSlideLayout(...a)],
  ['selectSlideLayout', [[], 'x'], (...a) => deck.selectSlideLayout(...a)],
  ['writeSlideIdList', [PRESENTATION, ['<p:sldId id="1" r:id="rId9"/>']], (...a) => deck.writeSlideIdList(...a)],
  ['writeSlideIdList', ['<p:presentation><p:sldSz cx="1" cy="2"/></p:presentation>', []], (...a) => deck.writeSlideIdList(...a)],
  ['writeSlideIdList', ['<p:presentation></p:presentation>', ['<p:sldId id="7" r:id="rId1"/>']], (...a) => deck.writeSlideIdList(...a)],
  ['writeSlideIdList', ['<p:presentation><p:sldIdLst/></p:presentation>', ['<p:sldId id="7" r:id="rId1"/>']], (...a) => deck.writeSlideIdList(...a)],
  ['slideIdEntries', [PRESENTATION], (v) => deck.slideIdEntries(v)],
  ['slideIdEntries', ['<p:presentation/>'], (v) => deck.slideIdEntries(v)],
];

const pure = [];
for (const [fn, args, run] of PURE) pure.push({ fn, args, ...(await attempt(() => run(...args))) });

const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const parts = {};
  for (const name of names) if (!zip.files[name].dir) parts[name] = await opc.zipText(zip, name);
  return { names, parts };
};

const slideOf = async (state, number) => (await deck.presentationSlides(state.zip))[Number(number) - 1];

// The blank deck holds one layout; these give it the default layouts a deck cut from a template has.
const EXTRA_LAYOUTS = [
  ['ppt/slideLayouts/slideLayout2.xml', 'title', 'Title Slide'],
  ['ppt/slideLayouts/slideLayout3.xml', 'obj', 'Title and Content'],
  ['ppt/slideLayouts/slideLayout4.xml', 'titleOnly', '제목만 &amp; more'],
];
const layoutXml = (type, name) => `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="${type}"><p:cSld name="${name}"/></p:sldLayout>`;
const LAYOUT_STEPS = EXTRA_LAYOUTS.map(([name, type, label]) => ({ op: 'set', name, text: layoutXml(type, label) }));

const buildDeck = async (name, slides) => {
  const path = join(work, name);
  await pkg.createPortableOoxmlDocument(path, { fileKind: 'pptx', title: 'Source deck' });
  const zip = await opc.loadPackage(path);
  for (const [layoutName, type, label] of EXTRA_LAYOUTS) zip.file(layoutName, layoutXml(type, label));
  for (const spec of slides) {
    const added = await deck.addPresentationSlide(zip, { layout: spec.layout });
    zip.file(added.part, slideWith(spec.items));
    if (spec.notes) await deck.setSlideNotes(zip, await deck.presentationSlides(zip), added.position, spec.notes);
    if (spec.image) {
      const image = join(work, `source-${name}.png`);
      writeFileSync(image, Buffer.from(PNG, 'base64'));
      const placed = await deck.addSlideImage(zip, added.part, image);
      zip.file(added.part, slideWith([...spec.items, shapes.pictureXml({ id: 9, embedId: placed.relationshipId, left: 1, top: 1, width: 10, height: 10 })]));
    }
  }
  await opc.savePackage(zip, path);
  return readFileSync(path).toString('base64');
};
const SOURCE_DECK = await buildDeck('source.pptx', [
  { layout: 'title', items: [title], notes: 'dropped notes' },
  { layout: 'Title Only', items: [card, table], image: true },
  { layout: 'blank', items: [wash] },
]);

const runStep = async (state, step) => {
  switch (step.op) {
    case 'create': {
      const path = join(work, 'created.pptx');
      const made = await pkg.createPortableOoxmlDocument(path, { fileKind: step.kind, title: step.title });
      state.zip = await opc.loadPackage(path);
      return { format: made.format, fileKind: made.fileKind, parts: made.parts };
    }
    case 'set':
      state.zip.file(step.name, step.text);
      return null;
    case 'remove':
      state.zip.remove(step.name);
      return null;
    case 'slides':
      return await deck.presentationSlides(state.zip);
    case 'layouts':
      return await deck.slideLayoutParts(state.zip);
    case 'selectLayout':
      return deck.selectSlideLayout(await deck.slideLayoutParts(state.zip), step.requested);
    case 'addSlide':
      return await deck.addPresentationSlide(state.zip, step.operation);
    case 'deleteSlide':
      await deck.deletePresentationSlide(state.zip, await deck.presentationSlides(state.zip), step.number);
      return null;
    case 'moveSlide':
      await deck.movePresentationSlide(state.zip, await deck.presentationSlides(state.zip), step.number, step.index);
      return null;
    case 'renumber':
      return await deck.renumberPresentationSlides(state.zip);
    case 'setNotes':
      await deck.setSlideNotes(state.zip, await deck.presentationSlides(state.zip), step.number, step.text);
      return null;
    case 'readNotes':
      return await deck.readSlideNotes(state.zip, await slideOf(state, step.number));
    case 'copyNotes':
      await deck.copySlideNotes(state.zip, (await slideOf(state, step.from)).path, (await slideOf(state, step.to)).path);
      return null;
    case 'commentAuthor':
      return await deck.ensureCommentAuthor(state.zip, step.author, step.initials);
    case 'slideComments':
      return await deck.ensureSlideComments(state.zip, await slideOf(state, step.number));
    case 'addImage': {
      const source = join(work, `picture.${step.extension}`);
      if (!step.missing) writeFileSync(source, Buffer.from(step.base64, 'base64'));
      const target = step.missing ? join(work, 'absent.png') : source;
      try {
        return await deck.addSlideImage(state.zip, (await slideOf(state, step.number)).path, target);
      } catch (error) {
        return { error: String(error.message).split(target).join('<path>') };
      }
    }
    case 'importSlides': {
      const source = join(work, 'import-source.pptx');
      writeFileSync(source, Buffer.from(step.base64, 'base64'));
      return await deck.importSlidesIntoPresentation(state.zip, source, step.numbers, step.after);
    }
    case 'clearSlides': {
      const path = join(work, 'cleared.pptx');
      await opc.savePackage(state.zip, path);
      const outcome = await deck.clearPortablePresentationSlides(path);
      state.zip = await opc.loadPackage(path);
      return outcome;
    }
    case 'inspect':
      return await core.inspectPptxTextBoxes(state.zip);
    case 'resolveTargets':
      return await targets.resolvePptxTargets({ zip: state.zip, slides: await deck.presentationSlides(state.zip) }, step.operation);
    case 'background': {
      const slide = await slideOf(state, step.number);
      return await core.resolveSlideBackground(state.zip, slide.path, await opc.zipText(state.zip, slide.path));
    }
    case 'themeColor':
      return await core.themeColor(state.zip, step.master, step.token);
    case 'relatedPart':
      return await core.pptxRelatedPart(state.zip, step.part, step.suffix);
    case 'relatedPartById':
      return await shared.relatedPartById(state.zip, step.part, step.id);
    case 'slideSize':
      return await core.presentationSlideSize(state.zip);
    case 'resolveChart':
      return await chart.resolveSlideChart(state.zip, await deck.presentationSlides(state.zip), step.operation);
    case 'writeChart':
      await chart.writePresentationChart(state.zip, step.args);
      return null;
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};

const SEQUENCES = [];
SEQUENCES.push({
  name: 'a blank deck and its layouts',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Base deck' },
    ...LAYOUT_STEPS,
    { op: 'slides' },
    { op: 'layouts' },
    ...['', 'Title Only', 'title slide', 'blank', 'content with caption', '2', '99', 'Agenda', 'obj'].map((requested) => ({ op: 'selectLayout', requested })),
    { op: 'slideSize' },
  ],
});
SEQUENCES.push({
  name: 'slides added, moved, deleted and renumbered',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Ops' },
    ...LAYOUT_STEPS,
    { op: 'addSlide', operation: { layout: 'title' } },
    { op: 'addSlide', operation: {} },
    { op: 'addSlide', operation: { layout: 'Title Only', index: 1 } },
    { op: 'addSlide', operation: { index: 2.5 } },
    { op: 'addSlide', operation: { index: 99, layout: '1' } },
    { op: 'addSlide', operation: { layout: 'Nope' } },
    { op: 'slides' },
    { op: 'moveSlide', number: 1, index: 5 },
    { op: 'moveSlide', number: 9, index: 1 },
    { op: 'moveSlide', number: 2, index: 0 },
    { op: 'moveSlide', number: 2, index: 2.5 },
    { op: 'slides' },
    { op: 'deleteSlide', number: 2 },
    { op: 'deleteSlide', number: 12 },
    { op: 'slides' },
    { op: 'renumber' },
    { op: 'renumber' },
    { op: 'slides' },
    { op: 'resolveTargets', operation: { slideId: 300, shape: 1 } },
    { op: 'resolveTargets', operation: { slideId: 'missing' } },
    { op: 'resolveTargets', operation: { shapeId: 2, slide: 1 } },
    { op: 'resolveTargets', operation: { slide: 2, text: 'kept' } },
    { op: 'deleteSlide', number: 1 },
    { op: 'deleteSlide', number: 1 },
    { op: 'deleteSlide', number: 1 },
    { op: 'deleteSlide', number: 1 },
    { op: 'deleteSlide', number: 1 },
  ],
});
SEQUENCES.push({
  name: 'speaker notes, comments and a duplicated slide',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Notes' },
    ...LAYOUT_STEPS,
    { op: 'addSlide', operation: { layout: 'title' } },
    { op: 'addSlide', operation: {} },
    { op: 'setNotes', number: 1, text: 'first line\r\nsecond & <line>\n\nlast\r' },
    { op: 'readNotes', number: 1 },
    { op: 'setNotes', number: 1, text: 'replaced' },
    { op: 'setNotes', number: 3, text: 'x' },
    { op: 'readNotes', number: 2 },
    { op: 'copyNotes', from: 1, to: 2 },
    { op: 'readNotes', number: 2 },
    { op: 'setNotes', number: 2, text: null },
    { op: 'commentAuthor', author: 'Ann <Lee>', initials: 'AL' },
    { op: 'commentAuthor', author: 'Bob', initials: 'B' },
    { op: 'commentAuthor', author: 'Ann <Lee>', initials: 'XX' },
    { op: 'slideComments', number: 1 },
    { op: 'slideComments', number: 1 },
    { op: 'slideComments', number: 2 },
    { op: 'deleteSlide', number: 1 },
    { op: 'slides' },
    { op: 'renumber' },
  ],
});
SEQUENCES.push({
  name: 'a picture added to a slide',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Pictures' },
    { op: 'addSlide', operation: {} },
    { op: 'addImage', number: 1, extension: 'png', base64: PNG },
    { op: 'addImage', number: 1, extension: 'PNG', base64: PNG },
    { op: 'addImage', number: 1, extension: 'jpeg', base64: PNG },
    { op: 'addImage', number: 1, extension: 'txt', base64: PNG },
    { op: 'addImage', number: 1, extension: 'png', missing: true },
    { op: 'addImage', number: 1, extension: 'webp', base64: 'AAEC' },
  ],
});
SEQUENCES.push({
  name: 'slides imported from another deck',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Target' },
    ...LAYOUT_STEPS.slice(0, 1),
    { op: 'addSlide', operation: { layout: 'blank' } },
    { op: 'importSlides', base64: SOURCE_DECK, numbers: [2, 1], after: 1 },
    { op: 'slides' },
    { op: 'importSlides', base64: SOURCE_DECK },
    { op: 'importSlides', base64: SOURCE_DECK, numbers: [7] },
    { op: 'renumber' },
    { op: 'slides' },
    { op: 'clearSlides' },
    { op: 'slides' },
  ],
});
SEQUENCES.push({
  name: 'a slide read as text boxes and content',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Inspect' },
    { op: 'addSlide', operation: {} },
    { op: 'addSlide', operation: {} },
    { op: 'addSlide', operation: {} },
    { op: 'set', name: 'ppt/slides/slide1.xml', text: slideWith([title, card, wash, hidden, picture, table, related], '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F0F0F0"/></a:solidFill></p:bgPr></p:bg>') },
    { op: 'set', name: 'ppt/slides/slide2.xml', text: slideWith([title], '', ' show="0"') },
    { op: 'set', name: 'ppt/slides/slide3.xml', text: slideWith([wash, card]) },
    { op: 'inspect' },
    { op: 'background', number: 1 },
    { op: 'background', number: 3 },
    { op: 'resolveTargets', operation: { slideId: 256, shapeId: 3 } },
    { op: 'resolveTargets', operation: { slide: 1, shapeId: '8', shape: 7 } },
    { op: 'resolveTargets', operation: { slide: 1, shapeId: 77 } },
    { op: 'resolveTargets', operation: { shapeId: 2 } },
    { op: 'resolveTargets', operation: { slide: 1, shapeId: 3, shape: 5 } },
    { op: 'relatedPart', part: 'ppt/slides/slide1.xml', suffix: 'slideLayout' },
    { op: 'relatedPart', part: 'ppt/slides/slide1.xml', suffix: 'nothing' },
    { op: 'themeColor', master: 'ppt/slideMasters/slideMaster1.xml', token: 'accent1' },
    { op: 'themeColor', master: 'ppt/slideMasters/slideMaster1.xml', token: 'bg1' },
    { op: 'themeColor', master: 'ppt/slideMasters/slideMaster1.xml', token: 'nope' },
    { op: 'themeColor', master: '', token: 'accent1' },
    { op: 'relatedPartById', part: 'ppt/slides/slide1.xml', id: 'rId1' },
    { op: 'relatedPartById', part: 'ppt/slides/slide1.xml', id: 'rId9' },
    { op: 'relatedPartById', part: 'ppt/slides/slide1.xml', id: '' },
  ],
});
SEQUENCES.push({
  name: 'a chart read and rewritten',
  steps: [
    { op: 'create', kind: 'pptx', title: 'Charts' },
    { op: 'addSlide', operation: {} },
    { op: 'set', name: 'ppt/charts/chart1.xml', text: CHART },
    { op: 'set', name: 'ppt/charts/_rels/chart1.xml.rels', text: CHART_RELS },
    { op: 'set', name: 'ppt/slides/_rels/slide1.xml.rels', text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/ppt/charts/chart1.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/gone.xml"/></Relationships>' },
    { op: 'set', name: 'ppt/slides/slide1.xml', text: slideWith([title, chart.chartFrameXml({ id: 9, relationshipId: 'rId5', left: 10, top: 20, width: 300, height: 200 }), chart.chartFrameXml({ id: 10, relationshipId: 'rId6', left: 0, top: 0, width: 1, height: 1 }), chart.chartFrameXml({ id: 11, relationshipId: 'rId7', left: 0, top: 0, width: 1, height: 1 }), chart.chartFrameXml({ id: 12, relationshipId: 'rId8', left: 0, top: 0, width: 1, height: 1 })]) },
    { op: 'resolveChart', operation: { slide: 1, shape: 2 } },
    { op: 'resolveChart', operation: { slide: 1, shape: 3 } },
    { op: 'resolveChart', operation: { slide: 1, shape: 4 } },
    { op: 'resolveChart', operation: { slide: 1, shape: 5 } },
    { op: 'resolveChart', operation: { slide: 1, shape: 1 } },
    { op: 'resolveChart', operation: { slide: 1, shape: 9 } },
    { op: 'resolveChart', operation: { slide: 4, shape: 1 } },
    { op: 'resolveChart', operation: { shape: 1 } },
    { op: 'writeChart', args: { chartPart: 'ppt/charts/chart1.xml', embeddingPart: 'ppt/embeddings/Microsoft_Excel_Sheet1.xlsx', chart: CHART, rows: [['Quarter', 'Sales'], ['Q1', 12.5], ['Q2', 0]] } },
    { op: 'writeChart', args: { chartPart: 'ppt/charts/chart2.xml', embeddingPart: 'ppt/embeddings/Microsoft_Excel_Sheet2.xlsx', chart: CHART.replace('</c:chartSpace>', '<c:externalData r:id="rId9"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>'), rows: [['A', 1]] } },
    { op: 'writeChart', args: { chartPart: 'ppt/charts/chart3.xml', embeddingPart: 'ppt/embeddings/Microsoft_Excel_Sheet3.xlsx', chart: '<c:chartSpace><c:printSettings/></c:chartSpace>', rows: [['A', 1]] } },
    { op: 'writeChart', args: { chartPart: 'ppt/charts/chart4.xml', embeddingPart: 'ppt/embeddings/Microsoft_Excel_Sheet4.xlsx', chart: '<c:chartSpace/>', rows: [['A', 1]] } },
  ],
});

const sequences = [];
for (const sequence of SEQUENCES) {
  const state = { zip: null };
  const outputs = [];
  for (const step of sequence.steps) outputs.push(await attempt(() => runStep(state, step)));
  sequences.push({ ...sequence, outputs, snapshot: state.zip ? await snapshotOf(state.zip) : null });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { pure, sequences });
writeSetManifest(stage, { set: 'office-pptx-base', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
