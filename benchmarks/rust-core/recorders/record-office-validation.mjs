#!/usr/bin/env node
// What the portable validation answers (src/runtime/office/portable/portable-validation.mjs: issuesPortableOoxml,
// removeOrphanPackageParts, pictureDescriptionIssues; portable-snapshot.mjs: snapshotPortableOoxml), run through Node on
// fixture documents: a deck (text that overflows, ink that cannot be read, a table that outgrows its frame, pictures that are
// soft, stretched, blank or undescribed, a chart PowerPoint refuses, a bar chart drawn from rectangles, a stack of one-line
// boxes), a workbook of every state a formula can be in, a Word report (ink, tables wider than the page, a word that breaks
// in its cell, revisions, comments, font pairing, a header with a leftover) and packages that are faulty in the ways the
// package check names. Rust `mixdog-ooxml` must answer the same: the issue lists and the snapshots as JSON text, key order
// included, and the package after the orphan sweep (crates/mixdog-ooxml/tests/twin_validation.rs).
//
//   node benchmarks/rust-core/recorders/record-office-validation.mjs --tree <dir with node_modules> [--faces <dir>]
//
// `--faces` names the folder of the fixture faces when this checkout does not hold native/core/fixtures/office-measure.
// Output: native/core/fixtures/office-validation/golden.json: `faces`, `packages`, `issues`, `snapshots`, `orphans`, `pure`.
// Texts are measured in the fixture faces of office-measure registered on both sides (the fixture Miriam face also under the
// name Calibri, which is what a run that names no face is measured in). The structure review of a deck belongs to the quality
// crate: each deck case records the snapshot it was handed and the findings it answered, and the Rust test hands the recorded
// findings back (after checking it was handed the same snapshot).
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const recorder = 'benchmarks/rust-core/recorders/record-office-validation.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-validation');
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
  Calibri: [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const portable = 'src/runtime/office/portable/';
const validation = await importFrom(tree, `${portable}portable-validation.mjs`);
const snapshots = await importFrom(tree, `${portable}portable-snapshot.mjs`);
const deckSnapshot = await importFrom(tree, `${portable}portable-snapshot-pptx.mjs`);
const structure = await importFrom(tree, 'src/runtime/office/quality/assurance-structure.mjs');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-validation-'));
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

// ---- rasters --------------------------------------------------------------------------------------------------------
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
};
const png = (width, height, [r, g, b, a]) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b, a]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
};
const MEDIA = {
  logo: png(16, 16, [200, 30, 30, 255]),
  blank: png(8, 8, [0, 0, 0, 0]),
  sharp: png(1500, 750, [30, 90, 200, 255]),
};

// ---- the markup -----------------------------------------------------------------------------------------------------
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const rels = (...entries) =>
  `${HEAD}<Relationships xmlns="${PKG}">${entries.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const types = (defaults, overrides) =>
  `${HEAD}<Types xmlns="${CT}">${defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('')}${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')}</Types>`;
const RELS_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const OFFICE = 'application/vnd.openxmlformats-officedocument.';
const DEFAULTS = [['rels', RELS_TYPE], ['xml', 'application/xml'], ['png', 'image/png']];

// The packages: name -> { format, parts (text), media (part -> raster name) }.
const packages = {};
const add = (name, format, built) => {
  packages[name] = { format, parts: built.parts, media: built.media ?? {} };
};

// ---- the deck -------------------------------------------------------------------------------------------------------
const EMU = 12700;
const emu = (points) => Math.round(points * EMU);
const SLIDE_NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const run = (value, { size = 18, bold = false, color = '', face = 'Twin Miriam' } = {}) =>
  `<a:r><a:rPr lang="en-US" sz="${size * 100}"${bold ? ' b="1"' : ''}>${color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : ''}<a:latin typeface="${face}"/></a:rPr><a:t>${value}</a:t></a:r>`;
const paragraph = (value, options) => `<a:p>${run(value, options)}</a:p>`;
const frame = (x, y, w, h) => `<a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`;
const box = (id, name, [x, y, w, h], paragraphs, { fill = '', text = true, hidden = false } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"${hidden ? ' hidden="1"' : ''}/><p:cNvSpPr${text ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr>${frame(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : ''}</p:spPr>` +
  (paragraphs ? `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/>${paragraphs}</p:txBody>` : '') +
  '</p:sp>';
const picture = (id, name, [x, y, w, h], embed, { descr, crop = '' } = {}) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"${descr === undefined ? '' : ` descr="${descr}"`}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${frame(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
const cell = (value, { size = 12, bold = false, color = '', fill = '' } = {}) =>
  `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(value, { size, bold, color })}</a:p></a:txBody><a:tcPr>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : ''}</a:tcPr></a:tc>`;
const table = (id, name, [x, y, w, h], widths, rows) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${widths.map((width) => `<a:gridCol w="${emu(width)}"/>`).join('')}</a:tblGrid>` +
  `${rows.map(({ height, cells }) => `<a:tr h="${emu(height)}">${cells.join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const chartFrame = (id, embed) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(40)}" y="${emu(300)}"/><a:ext cx="${emu(300)}" cy="${emu(150)}"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${embed}"/></a:graphicData></a:graphic></p:graphicFrame>`;
const slide = (items, background = '') =>
  `${HEAD}<p:sld ${SLIDE_NS}><p:cSld>${background}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${items.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const background = (hex) => `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></p:bgPr></p:bg>`;

const CHART =
  `${HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>` +
  '<c:ser><c:idx val="0"/><c:order val="0"/><c:dLbls><c:dLblPos val="outEnd"/><c:showVal val="1"/></c:dLbls><c:val><c:numRef><c:f>S!$B$2:$B$3</c:f></c:numRef></c:val></c:ser>' +
  '<c:axId val="11"/><c:axId val="12"/></c:barChart><c:catAx><c:axId val="11"/></c:catAx><c:valAx><c:axId val="12"/></c:valAx></c:plotArea></c:chart></c:chartSpace>';

function deck(slides, { extra = {}, media = {}, slideRels = {}, overrides = [] } = {}) {
  const parts = {};
  parts['[Content_Types].xml'] = types(DEFAULTS, [
    ['/ppt/presentation.xml', `${OFFICE}presentationml.presentation.main+xml`],
    ['/ppt/slideMasters/slideMaster1.xml', `${OFFICE}presentationml.slideMaster+xml`],
    ['/ppt/slideLayouts/slideLayout1.xml', `${OFFICE}presentationml.slideLayout+xml`],
    ...slides.map((_, index) => [`/ppt/slides/slide${index + 1}.xml`, `${OFFICE}presentationml.slide+xml`]),
    ...overrides,
  ]);
  parts['_rels/.rels'] = rels(['rId1', 'officeDocument', 'ppt/presentation.xml']);
  parts['ppt/presentation.xml'] =
    `${HEAD}<p:presentation ${SLIDE_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>` +
    slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('') +
    '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
  parts['ppt/_rels/presentation.xml.rels'] = rels(['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, index) => [`rId${index + 2}`, 'slide', `slides/slide${index + 1}.xml`]));
  parts['ppt/slideMasters/slideMaster1.xml'] =
    `${HEAD}<p:sldMaster ${SLIDE_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
  parts['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']);
  parts['ppt/slideLayouts/slideLayout1.xml'] =
    `${HEAD}<p:sldLayout ${SLIDE_NS} type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`;
  parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = rels(['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']);
  slides.forEach((xml, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = xml;
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = rels(['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(slideRels[index + 1] ?? []));
  });
  return { parts: { ...parts, ...extra }, media };
}

const slideOne = slide([
  box(2, 'Title', [40, 30, 520, 50], paragraph('Quarterly results', { size: 32, bold: true, color: '111111' })),
  // Twelve words at 24pt in a 60 x 30 pt frame: the text needs more than the frame gives.
  box(3, 'Overflowing', [40, 100, 200, 30], paragraph('Revenue grew faster than anyone expected in every region we serve this quarter', { size: 24, color: '222222' })),
  // Dark ink on a dark card: the contrast of a text against the fill it sits on.
  box(4, 'Dark card', [300, 100, 240, 80], paragraph('Hard to read', { size: 20, color: '1A1A2E' }), { fill: '16213E', text: false }),
  box(5, 'Hidden note', [0, 0, 50, 50], paragraph('never seen', { size: 12 }), { hidden: true }),
  picture(6, 'Soft logo', [40, 220, 200, 100], 'rId2', { descr: 'logo.png' }),
  picture(7, 'Cropped chart image', [300, 220, 200, 100], 'rId3', { descr: 'Chart of regional revenue', crop: '<a:srcRect l="10000" r="20000"/>' }),
  picture(8, 'Empty icon', [560, 220, 60, 60], 'rId4'),
  picture(9, 'Sharp photo', [560, 300, 150, 75], 'rId5', { descr: 'A photograph of the harbour' }),
], background('FFFFFF'));

const slideTwo = slide([
  box(2, 'Headline', [40, 20, 600, 50], paragraph('Click to edit the title', { size: 28, color: '000000' })),
  box(3, 'Source', [40, 80, 300, 30], paragraph('TODO: confirm figures with finance', { size: 14, color: '333333' })),
  table(4, 'Plan', [40, 320, 500, 60], [60, 60, 60], [
    { height: 20, cells: [cell('Region', { bold: true, color: '222222', fill: '1F3864' }), cell('Quarter', { bold: true, color: 'FFFFFF', fill: '1F3864' }), cell('Total', { bold: true, color: 'FFFFFF', fill: '1F3864' })] },
    { height: 20, cells: [cell('Asia Pacific and the wider southern region with its many markets'), cell('Q1 results are reported in local currency before translation'), cell('1,420')] },
    { height: 20, cells: [cell('Europe, Middle East and Africa together'), cell('Q2 shows seasonal softness in every market'), cell('1,115')] },
    { height: 20, cells: [cell('Americas'), cell('Q3'), cell('980')] },
    { height: 20, cells: [cell('Other'), cell('Q4'), cell('310')] },
  ]),
], background('F4F4F4'));

const slideThree = slide([
  box(2, 'Bar 1', [60, 200, 40, 40], '', { fill: '2E75B6', text: false }),
  box(3, 'Bar 2', [120, 160, 40, 80], '', { fill: '2E75B6', text: false }),
  box(4, 'Bar 3', [180, 120, 40, 120], '', { fill: '2E75B6', text: false }),
  box(5, 'Bar 4', [240, 180, 40, 60], '', { fill: '2E75B6', text: false }),
  box(6, 'Line 1', [400, 100, 300, 22], paragraph('First line of a paragraph', { size: 14, color: '222222' })),
  box(7, 'Line 2', [400, 122, 300, 22], paragraph('second line of the same paragraph', { size: 14, color: '222222' })),
  box(8, 'Line 3', [400, 144, 300, 22], paragraph('and a third line that follows', { size: 14, color: '222222' })),
  chartFrame(9, 'rId2'),
]);

add(
  'deck',
  'pptx',
  deck([slideOne, slideTwo, slideThree], {
    slideRels: {
      1: [['rId2', 'image', '../media/logo.png'], ['rId3', 'image', '../media/sharp.png'], ['rId4', 'image', '../media/blank.png'], ['rId5', 'image', '../media/sharp.png']],
      3: [['rId2', 'chart', '../charts/chart1.xml']],
    },
    extra: { 'ppt/charts/chart1.xml': CHART },
    overrides: [['/ppt/charts/chart1.xml', `${OFFICE}drawingml.chart+xml`]],
    media: { 'ppt/media/logo.png': 'logo', 'ppt/media/sharp.png': 'sharp', 'ppt/media/blank.png': 'blank' },
  })
);

// ---- a deck that is whole and plain -------------------------------------------------
add(
  'plain-deck',
  'pptx',
  deck([slide([box(2, 'Title', [40, 30, 600, 60], paragraph('A plain title', { size: 32, color: '202020' })), box(3, 'Body', [40, 120, 600, 100], paragraph('Two short sentences. Nothing wrong here.', { size: 18, color: '303030' }))], background('FFFFFF'))])
);

// ---- the workbooks --------------------------------------------------------------------------------------------------
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const worksheet = (inner) => `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${inner}</worksheet>`;
const inline = (reference, value, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t>${value}</t></is></c>`;
const num = (reference, value, style) => `<c r="${reference}"${style === undefined ? '' : ` s="${style}"`}><v>${value}</v></c>`;
const formula = (reference, expression, cached) => `<c r="${reference}"><f>${expression}</f>${cached === undefined ? '' : `<v>${cached}</v>`}</c>`;
const failed = (reference, expression, code) => `<c r="${reference}" t="e"><f>${expression}</f><v>${code}</v></c>`;
const row = (index, inner) => `<row r="${index}">${inner}</row>`;
const STYLES =
  `${HEAD}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Twin Miriam"/></font><font><sz val="11"/><color rgb="FFEEEEEE"/><name val="Twin Miriam"/></font></fonts>` +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
function book({ sheets, calc = '', names = '', extra = {}, media = {}, overrides = [] }) {
  const parts = {};
  parts['[Content_Types].xml'] = types(DEFAULTS, [
    ['/xl/workbook.xml', `${OFFICE}spreadsheetml.sheet.main+xml`],
    ['/xl/styles.xml', `${OFFICE}spreadsheetml.styles+xml`],
    ...sheets.map((_, index) => [`/xl/worksheets/sheet${index + 1}.xml`, `${OFFICE}spreadsheetml.worksheet+xml`]),
    ...overrides,
  ]);
  parts['_rels/.rels'] = rels(['rId1', 'officeDocument', 'xl/workbook.xml']);
  parts['xl/workbook.xml'] =
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>${names}${calc}</workbook>`;
  parts['xl/_rels/workbook.xml.rels'] = rels(...sheets.map((_, index) => [`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`]), [`rId${sheets.length + 1}`, 'styles', 'styles.xml']);
  parts['xl/styles.xml'] = STYLES;
  sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml;
    if (sheet.rels) parts[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = sheet.rels;
  });
  return { parts: { ...parts, ...extra }, media };
}
const wideRows = (count) => Array.from({ length: count }, (_, index) => row(index + 2, num(`A${index + 2}`, index + 1) + formula(`B${index + 2}`, `A${index + 2}*2`))).join('');

add(
  'model',
  'xlsx',
  book({
      sheets: [
        { name: 'Inputs', xml: worksheet(`<sheetData>${row(1, inline('A1', 'Growth') + num('B1', 0.05))}${row(2, inline('A2', 'Price') + num('B2', 12))}</sheetData>`) },
        {
          name: 'Calc',
          xml: worksheet(
            `<cols><col min="1" max="1" width="6" customWidth="1"/></cols><sheetData>${row(1, inline('A1', 'A long label that does not fit the narrow first column of this sheet') + num('B1', 100))}` +
              `${row(2, formula('A2', 'SUM(B1:B1)') + failed('B2', '#REF!+1', '#REF!'))}${row(3, formula('A3', 'B1*Inputs!B2') + formula('B3', 'B1*2', 200))}` +
              `${row(4, formula('A4', 'B1+1') + formula('B4', 'B1+2'))}${row(5, formula('A5', 'B1+3'))}</sheetData>`
          ),
        },
      ],
    })
);
add(
  'stale',
  'xlsx',
  book({
      calc: '<calcPr calcId="191029" fullCalcOnLoad="1"/>',
      sheets: [{ name: 'Totals', xml: worksheet(`<sheetData>${row(1, num('A1', 5) + formula('B1', 'A1*2', 10))}${row(2, num('A2', 7) + formula('B2', 'A2*2', 14))}</sheetData>`) }],
    })
);
add(
  'checked',
  'xlsx',
  book({
      sheets: [
        { name: 'Model', xml: worksheet(`<sheetData>${row(1, num('A1', 5) + formula('B1', 'A1*2', 10))}</sheetData>`) },
        { name: 'Checks', xml: worksheet(`<sheetData>${row(1, inline('A1', 'Total ties') + formula('B1', 'Model!B1-10', 0))}</sheetData>`) },
      ],
    })
);
const SHEET_DRAWING = `${HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1905000" cy="952500"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId1"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor><xdr:oneCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1905000" cy="952500"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Mark" descr="Company mark"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${REL}" r:embed="rId1"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
add(
  'pictured',
  'xlsx',
  book({
      sheets: [{ name: 'Sheet1', xml: worksheet(`<sheetData>${row(1, inline('A1', 'Report') + num('B1', 1))}</sheetData><drawing r:id="rId1"/>`), rels: rels(['rId1', 'drawing', '../drawings/drawing1.xml']) }],
      extra: { 'xl/drawings/drawing1.xml': SHEET_DRAWING, 'xl/drawings/_rels/drawing1.xml.rels': rels(['rId1', 'image', '../media/image1.png']) },
      overrides: [['/xl/drawings/drawing1.xml', `${OFFICE}drawing+xml`]],
      media: { 'xl/media/image1.png': 'logo' },
    })
);
add(
  'long',
  'xlsx',
  book({ sheets: [{ name: 'Rows', xml: worksheet(`<sheetData>${row(1, inline('A1', 'n') + inline('B1', 'double'))}${wideRows(60)}</sheetData>`) }] })
);

// ---- the documents --------------------------------------------------------------------------------------------------
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOC_NS = `xmlns:w="${W}" xmlns:r="${REL}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const wrun = (value, { color = '', size = 22, face = 'Twin Miriam', bold = false, extra = '' } = {}) =>
  `<w:r><w:rPr><w:rFonts w:ascii="${face}" w:hAnsi="${face}"/>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/>${extra}</w:rPr><w:t xml:space="preserve">${value}</w:t></w:r>`;
const wpara = (inner, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${inner}</w:p>`;
const wcell = (inner, { width = 2000, fill = '', span = 0 } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span ? `<w:gridSpan w:val="${span}"/>` : ''}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${inner}</w:tc>`;
const wtable = (widths, rows) =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.map((cells) => `<w:tr>${cells.join('')}</w:tr>`).join('')}</w:tbl>`;
const SECTION = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
const drawing = (name, descr, [cx, cy], embed) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="${name}"${descr === undefined ? '' : ` descr="${descr}"`}/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${embed}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const STYLES_DOC = `${HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Twin Miriam" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
function word({ body, header = '', comments = '', rels: documentRels = [], media = {}, extra = {}, overrides = [] }) {
  const parts = {};
  parts['[Content_Types].xml'] = types(DEFAULTS, [
    ['/word/document.xml', `${OFFICE}wordprocessingml.document.main+xml`],
    ['/word/styles.xml', `${OFFICE}wordprocessingml.styles+xml`],
    ...(header ? [['/word/header1.xml', `${OFFICE}wordprocessingml.header+xml`]] : []),
    ...(comments ? [['/word/comments.xml', `${OFFICE}wordprocessingml.comments+xml`]] : []),
    ...overrides,
  ]);
  parts['_rels/.rels'] = rels(['rId1', 'officeDocument', 'word/document.xml']);
  parts['word/document.xml'] = `${HEAD}<w:document ${DOC_NS}><w:body>${body}</w:body></w:document>`;
  parts['word/_rels/document.xml.rels'] = rels(['rId1', 'styles', 'styles.xml'], ...(header ? [['rId2', 'header', 'header1.xml']] : []), ...(comments ? [['rId3', 'comments', 'comments.xml']] : []), ...documentRels);
  parts['word/styles.xml'] = STYLES_DOC;
  if (header) parts['word/header1.xml'] = `${HEAD}<w:hdr ${DOC_NS}>${header}</w:hdr>`;
  if (comments) parts['word/comments.xml'] = `${HEAD}<w:comments ${DOC_NS}>${comments}</w:comments>`;
  return { parts: { ...parts, ...extra }, media };
}
const longTable = wtable([9000], Array.from({ length: 26 }, (_, index) => [wcell(wpara(wrun(index === 0 ? 'Name' : `Row ${index}`, { bold: index === 0 })), { width: 9000 })]));
const report = word({
  header: wpara(wrun('TODO: put the company name here')),
  comments: '<w:comment w:id="0" w:author="Reviewer" w:date="2024-03-01T09:00:00Z" w:initials="R"><w:p><w:r><w:t>Please check this figure</w:t></w:r></w:p></w:comment>',
  rels: [['rId5', 'image', 'media/logo.png'], ['rId6', 'image', 'media/sharp.png']],
  media: { 'word/media/logo.png': 'logo', 'word/media/sharp.png': 'sharp' },
  body:
    wpara(wrun('A pale line that is hard to read', { color: 'CCCCCC' })) +
    wpara(wrun('Hidden working note', { color: 'DDDDDD', extra: '<w:vanish/>' }) + wrun('Shown again after a switch off', { color: 'DDDDDD', extra: '<w:vanish w:val="0"/>' }) + wrun('White on black', { color: 'FFFFFF', extra: '<w:highlight w:val="black"/>' })) +
    wpara(wrun('2024 매출 report', { face: 'Cambria', color: '222222' })) +
    wpara(wrun('Lorem ipsum dolor sit amet')) +
    wpara(`<w:ins w:id="1" w:author="Editor" w:date="2024-03-02T10:00:00Z">${wrun('added words')}</w:ins><w:del w:id="2" w:author="Editor" w:date="2024-03-02T10:00:00Z"><w:r><w:delText>gone words</w:delText></w:r></w:del>`) +
    wpara('<w:commentRangeStart w:id="0"/>' + wrun('A figure to check') + '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>') +
    wtable([1200, 1200, 10000], [
      [wcell(wpara(wrun('Internationalization', { bold: true })), { width: 1200, fill: 'D9E2F3' }), wcell(wpara(wrun('Status', { bold: true })), { width: 1200, fill: 'D9E2F3' }), wcell(wpara(wrun('Notes', { bold: true })), { width: 10000, fill: 'D9E2F3' })],
      [wcell(wpara(wrun('Short')), { width: 1200 }), wcell(wpara(wrun('Dark ink on dark', { color: '333333' })), { width: 1200, fill: '1F3864' }), wcell(wpara(wrun('Fine')), { width: 10000 })],
    ]) +
    longTable +
    wpara(drawing('Soft logo', undefined, [1828800, 1828800], 'rId5')) +
    wpara(drawing('Sharp photo', 'A photograph of the harbour', [3657600, 3657600], 'rId6')) +
    SECTION,
});
add('report', 'docx', report);
const empty = word({ body: SECTION });
add('empty', 'docx', empty);
const plainDoc = word({ body: wpara(wrun('One honest paragraph of body text.')) + SECTION });
add('plain-doc', 'docx', plainDoc);

// ---- packages that are faulty in the ways the package check names -------------------------------------------------------
const faulty = word({
  body: wpara(wrun('Body text')) + SECTION,
  rels: [['rId1', 'image', 'media/missing.png'], ['rId9', 'hyperlink', 'https://example.com/page', 'External']],
  extra: { 'word/extra.bin': 'x', 'word/theme/broken.xml': '<a:theme><a:unclosed></a:theme>' },
});
add('faulty-docx', 'docx', faulty);
const wanting = deck([slide([box(2, 'Title', [40, 30, 300, 40], paragraph('Missing parts', { size: 24, color: '202020' }))])]);
delete wanting.parts['ppt/presentation.xml'];
add('wanting-deck', 'pptx', wanting);

// ---- the files and the runs -----------------------------------------------------------------------------------------
const zipOf = (name) => {
  const zip = new JSZip();
  for (const [part, content] of Object.entries(packages[name].parts)) zip.file(part, content);
  for (const [part, raster] of Object.entries(packages[name].media)) zip.file(part, MEDIA[raster]);
  return zip;
};
const filePath = new Map();
for (const name of Object.keys(packages)) {
  const path = join(work, `${name}.${packages[name].format}`);
  writeFileSync(path, await zipOf(name).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  filePath.set(name, path);
}

const ISSUES = [
  ['deck', 'pptx', {}],
  ['deck', 'pptx', { printSheet: true }],
  ['deck', 'pptx', { pages: [1] }],
  ['deck', 'pptx', { pages: [3, 2] }],
  ['plain-deck', 'pptx', {}],
  ['wanting-deck', 'pptx', {}],
  ['model', 'xlsx', {}],
  ['model', 'xlsx', { auditProfile: 'financial-model' }],
  ['model', 'xlsx', { sheet: 'Calc' }],
  ['model', 'xlsx', { sheet: 'Inputs', range: 'A1:B2' }],
  ['stale', 'xlsx', {}],
  ['stale', 'xlsx', { auditProfile: 'financial-model' }],
  ['checked', 'xlsx', { auditProfile: 'financial-model' }],
  ['pictured', 'xlsx', {}],
  ['long', 'xlsx', {}],
  ['report', 'docx', {}],
  ['empty', 'docx', {}],
  ['plain-doc', 'docx', {}],
  ['faulty-docx', 'docx', {}],
];
const issueRecords = [];
for (const [name, format, options] of ISSUES) {
  const record = { package: name, format, options };
  if (format === 'pptx') {
    // What the structure review is handed and what it answers (the review itself is a module of the quality crate).
    const handed = await attempt(async () => {
      const zip = await JSZip.loadAsync(readFileSync(filePath.get(name)));
      const document = await deckSnapshot.snapshotPptx(zip);
      if (options.printSheet) document.printSheet = true;
      return { document, findings: structure.reviewOfficeStructure({ format: 'pptx', document }) };
    });
    record.structure = handed.error === undefined ? handed.result : null;
  }
  record.output = await text(() => validation.issuesPortableOoxml(filePath.get(name), format, options));
  issueRecords.push(record);
}

const SNAPSHOTS = [
  ['deck', 'pptx', {}],
  ['deck', 'pptx', { pages: [2] }],
  ['deck', 'pptx', { paged: true, offset: 1, limit: 1 }],
  ['model', 'xlsx', {}],
  ['model', 'xlsx', { full: true }],
  ['model', 'xlsx', { paged: true, sheet: 'Calc', offset: 0, limit: 3 }],
  ['pictured', 'xlsx', { full: true }],
  ['report', 'docx', {}],
  ['report', 'docx', { paged: true, offset: 2, limit: 3 }],
  ['empty', 'docx', {}],
  ['plain-doc', 'docx', {}],
  ['plain-doc', 'rtf', {}],
  ['plain-doc', 'docx', undefined],
];
const snapshotRecords = [];
for (const [name, format, options] of SNAPSHOTS) {
  snapshotRecords.push({ package: name, format, options: options ?? null, output: await text(() => snapshots.snapshotPortableOoxml(filePath.get(name), format, options)) });
}
const absent = join(work, 'absent.docx');
snapshotRecords.push({ package: null, format: 'docx', options: {}, missing: true, output: await text(() => snapshots.snapshotPortableOoxml(absent, 'docx', {})) });
const absentIssues = await text(() => validation.issuesPortableOoxml(absent, 'docx', {}));

// The sweep: a package whose media, chart and notes parts are partly referenced; each pass can orphan the next.
const orphanPackage = (variant) => {
  const built = deck([slide([picture(2, 'Logo', [40, 40, 100, 100], 'rId2', { descr: 'Logo of the company' })])], {
    slideRels: { 1: [['rId2', 'image', '../media/logo.png']] },
    extra: {
      'ppt/media/stray.png': 'x',
      'ppt/charts/chart9.xml': CHART,
      'ppt/charts/_rels/chart9.xml.rels': rels(['rId1', 'image', '../media/chained.png']),
      'ppt/media/chained.png': 'x',
      'ppt/notesSlides/notesSlide9.xml': '<p:notes/>',
      'ppt/slides/keep.xml': '<kept/>',
      ...(variant === 'external' ? { 'ppt/slides/_rels/slide2.xml.rels': rels(['rId1', 'hyperlink', 'https://example.com/', 'External']) } : {}),
    },
    overrides: [['/ppt/media/stray.png', 'image/png'], ['/ppt/charts/chart9.xml', `${OFFICE}drawingml.chart+xml`]],
  });
  built.media = { 'ppt/media/logo.png': 'logo' };
  const zip = new JSZip();
  for (const [part, content] of Object.entries(built.parts)) zip.file(part, content);
  for (const [part, raster] of Object.entries(built.media)) zip.file(part, MEDIA[raster]);
  return { zip, built };
};
const orphans = [];
for (const variant of ['plain', 'external']) {
  const { zip, built } = orphanPackage(variant);
  const output = await text(() => validation.removeOrphanPackageParts(zip));
  orphans.push({
    variant,
    parts: built.parts,
    media: built.media,
    output,
    names: Object.keys(zip.files).filter((name) => !name.endsWith('/')).sort(),
    types: await zip.file('[Content_Types].xml').async('string'),
  });
}
{
  const bare = new JSZip();
  bare.file('doc.xml', '<doc/>');
  orphans.push({ variant: 'no-relationships', parts: { 'doc.xml': '<doc/>' }, media: {}, output: await text(() => validation.removeOrphanPackageParts(bare)), names: ['doc.xml'], types: '' });
  const hollow = new JSZip();
  hollow.file('_rels/.rels', rels());
  hollow.file('ppt/media/a.png', 'x');
  orphans.push({ variant: 'nothing-resolves', parts: { '_rels/.rels': rels(), 'ppt/media/a.png': 'x' }, media: {}, output: await text(() => validation.removeOrphanPackageParts(hollow)), names: ['_rels/.rels', 'ppt/media/a.png'], types: '' });
}

const pure = [];
for (const snapshot of [
  {},
  { images: [] },
  { images: [{ path: '/body/picture[1]' }, { path: '/body/picture[2]', altText: '' }, { path: '/body/picture[3]', altText: '  image3.JPG ' }, { path: '/body/picture[4]', altText: 'logo.png' }, { path: '/body/picture[5]', altText: 'Company logo' }, { path: '/body/picture[6]', altText: 'a.b.png' }, { path: '/body/picture[7]', altText: 7 }, { path: '/body/picture[8]', altText: 'Zażółć.webp' }] },
]) {
  pure.push({ fn: 'pictureDescriptionIssues', args: [snapshot], output: await text(() => validation.pictureDescriptionIssues(snapshot)) });
}

const out = {
  faces: Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))])),
  packages: Object.fromEntries(
    Object.entries(packages).map(([name, { format, parts, media }]) => [name, { format, parts, media: Object.fromEntries(Object.entries(media).map(([part, raster]) => [part, MEDIA[raster].toString('base64')])) }])
  ),
  issues: issueRecords,
  absentIssues,
  snapshots: snapshotRecords,
  orphans: orphans.map((entry) => ({ ...entry, media: Object.fromEntries(Object.entries(entry.media).map(([part, raster]) => [part, MEDIA[raster].toString('base64')])) })),
  pure,
};
writeJson(join(stage, 'golden.json'), out);
writeSetManifest(stage, { set: 'office-validation', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(work, { recursive: true, force: true });
