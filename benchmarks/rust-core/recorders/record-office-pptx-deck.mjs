#!/usr/bin/env node
// What the portable pptx deck modules answer (src/runtime/office/portable: portable-pptx-deck, pptx-table-fit,
// portable-snapshot-pptx), run through Node. Rust `mixdog-ooxml` must answer the same: the answer of every deck operation,
// the text of every part it changed, the row heights of a table and the snapshot JSON of a deck
// (crates/mixdog-ooxml/tests/twin_pptx_deck.rs).
//
//   node benchmarks/rust-core/recorders/record-office-pptx-deck.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-pptx-deck/golden.json. The recording holds `fit` (a table row or table, its column
// widths and the heights it draws to) and `sequences` (steps over one deck: a deck operation, a snapshot read or a part
// written; each step's output, then the deck's part names and the text of every part).
//
// Table cells hold one short line in a wide column, so the height a row draws to does not depend on which face the machine
// measures with; the date of a comment and the id of a page-number field are replaced by a fixed name (<date>, <uuid>), and
// the folder the files of a step are written in by `@work`.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-pptx-deck');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-pptx-deck.mjs';
const portable = (name) => importFrom(tree, `src/runtime/office/portable/${name}.mjs`);
const shapes = await portable('portable-slide-shapes');
const deck = await portable('portable-pptx-deck');
const pack = await portable('portable-pptx-package');
const chart = await portable('portable-pptx-chart');
const fit = await portable('pptx-table-fit');
const snapshot = await portable('portable-snapshot-pptx');
const opc = await portable('portable-opc');
const pkg = await portable('portable-package');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-pptx-deck-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const b64 = (list) => Buffer.from(list).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 4, 8, 6, 0, 0, 0]);

// ---- slides ---------------------------------------------------------------------------------------------------------

const SLIDE_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slideWith = (items, { background = '', root = '', trailer = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' } = {}) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${SLIDE_NS}${root}><p:cSld>${background}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${items.join('')}</p:spTree></p:cSld>${trailer}</p:sld>`;
const solidBackground = (hex) => `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></p:bgPr></p:bg>`;

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
const hiddenShape = shapes
  .shapeXml({ id: 5, name: 'Hidden', left: 0, top: 0, width: 50, height: 50, textBody: shapes.textBodyXml({ paragraphs: [{ text: 'never seen', fontSize: 12 }] }) })
  .replace('<p:cNvPr id="5"', '<p:cNvPr hidden="1" id="5"');
const picture = shapes.pictureXml({ id: 6, embedId: 'rId2', left: 500, top: 120, width: 200, height: 100, crop: { left: 0.1, right: 0.2 }, altText: 'A "logo"' });
const related = shapes.shapeXml({
  id: 8,
  name: `mixdog-relation:${encodeURIComponent(JSON.stringify({ id: 'k1', role: 'label' }))}`,
  left: 700,
  top: 340,
  width: 200,
  height: 30,
  textBody: shapes.textBodyXml({ paragraphs: [{ text: 'Label', fontSize: 12 }] }),
});
const brokenRelation = shapes.shapeXml({ id: 9, name: 'mixdog-relation:%7Bnot json', left: 0, top: 0, width: 10, height: 10, textBody: shapes.textBodyXml({ paragraphs: [{ text: 'x' }] }) });
// A table whose rows are as tall as their one line of text needs (the header, the 18 pt body) or shorter than it (the grown rows).
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
const cell = (text, { size = 1800, bold = false, margins = '', span = '' } = {}) =>
  `<a:tc${span}><a:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr${margins}/></a:tc>`;
const tableFrame = (id, name, rows, widths, { descr = '' } = {}) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"${descr ? ` descr="${descr}"` : ''}/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1828800"/><a:ext cx="${widths.reduce((sum, value) => sum + value, 0)}" cy="${rows.reduce((sum, row) => sum + row.h, 0)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${rows.map((row) => `<a:tr h="${row.h}">${row.cells.join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const grownTable = tableFrame(
  20,
  'Grown table',
  [
    { h: 370840, cells: [cell('Region', { bold: true }), cell('Sales', { bold: true })] },
    { h: 100000, cells: [cell('North'), cell('1,420')] },
    { h: 100000, cells: [cell('Tall', { size: 3600 }), '<a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>'] },
    { h: 200000, cells: [cell('Tight', { size: 2400, margins: ' marL="0" marR="0" marT="0" marB="0"' }), cell('Merged', { span: ' gridSpan="2"' })] },
    { h: 200000, cells: [cell('Span', { span: ' rowSpan="2"' }), cell('x')] },
    { h: 200000, cells: ['<a:tc vMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>', cell('y')] },
  ],
  [2743200, 2743200],
  { descr: 'Sales &amp; costs' }
);
const flatTable = tableFrame(21, 'No row heights', [{ h: 0, cells: [cell('a'), cell('b')] }], [1828800, 1828800]);
const chartFrame = (id, rid) => chart.chartFrameXml({ id, relationshipId: rid, left: 10, top: 20, width: 300, height: 200 });
const fonted = (id, face, size, color, text) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Styled ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm><a:prstGeom prst="chevron"><a:avLst/></a:prstGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="aa0000"/></a:gs></a:gsLst></a:gradFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ko-KR" sz="${size}" b="1"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${face}"/></a:rPr><a:t>${text}</a:t></a:r><a:br/><a:r><a:rPr sz="1200"><a:latin typeface="Arial"/></a:rPr><a:t>둘째 줄</a:t></a:r></a:p></p:txBody></p:sp>`;
const custom = '<p:sp><p:nvSpPr><p:cNvPr id="30" name="Free &amp; form"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1" y="-2"/><a:ext cx="3" cy="4"/></a:xfrm><a:custGeom><a:pathLst/></a:custGeom><a:solidFill><a:srgbClr val="00ff00"/></a:solidFill></p:spPr></p:sp>';
const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="40" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${fonted(41, 'Malgun Gothic', 1800, '112233', '묶음')}</p:grpSp>`;

const CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales &amp; costs</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
const CHART_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Sheet1.xlsx"/></Relationships>`;
const slideRels = (extra) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${extra}</Relationships>`;
const CHART_REL = '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/missing.xml"/>';

// The blank deck holds one layout; these give it the default layouts a deck cut from a template has.
const EXTRA_LAYOUTS = [
  ['ppt/slideLayouts/slideLayout2.xml', 'title', 'Title Slide', ''],
  ['ppt/slideLayouts/slideLayout3.xml', 'obj', 'Title and Content', solidBackground('1A2B3C')],
  ['ppt/slideLayouts/slideLayout4.xml', 'titleOnly', '제목만 &amp; more', ''],
];
const layoutXml = (type, name, background) =>
  `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="${type}"><p:cSld name="${name}">${background}</p:cSld></p:sldLayout>`;
const LAYOUT_STEPS = EXTRA_LAYOUTS.map(([name, type, label, background]) => ({ op: 'set', name, text: layoutXml(type, label, background) }));
const MASTER_STEPS = [
  { op: 'set', name: 'ppt/slideMasters/slideMaster1.xml', text: `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${solidBackground('EEEEEE')}</p:cSld></p:sldMaster>` },
];

// A deck of other decks' themes and slides, written into the work folder for the steps that read a file.
const buildDeck = async (name, slides, edit = async () => {}) => {
  const path = join(work, name);
  await pkg.createPortableOoxmlDocument(path, { fileKind: 'pptx', title: 'Source deck' });
  const zip = await opc.loadPackage(path);
  for (const [layoutName, type, label, background] of EXTRA_LAYOUTS) zip.file(layoutName, layoutXml(type, label, background));
  for (const spec of slides) {
    const added = await pack.addPresentationSlide(zip, { layout: spec.layout });
    zip.file(added.part, slideWith(spec.items));
    if (spec.notes) await pack.setSlideNotes(zip, await pack.presentationSlides(zip), added.position, spec.notes);
  }
  await edit(zip);
  await opc.savePackage(zip, path);
  return readFileSync(path).toString('base64');
};
const SOURCE_DECK = await buildDeck('source.pptx', [
  { layout: 'title', items: [title], notes: 'dropped notes' },
  { layout: 'Title Only', items: [card, table] },
  { layout: 'blank', items: [hiddenShape] },
]);
const THEME_DECK = await buildDeck('theme.pptx', [], async (zip) => {
  zip.file('ppt/theme/theme1.xml', (await opc.zipText(zip, 'ppt/theme/theme1.xml')).replace('</a:theme>', '<!--restyled--></a:theme>'));
});
const BARE_DECK = await buildDeck('bare.pptx', [], async (zip) => {
  zip.remove('ppt/theme/theme1.xml');
});
const FLAT_THEME_DECK = await buildDeck('flat.pptx', [], async (zip) => {
  zip.file('theme/theme3.xml', '<a:theme name="Flat"/>');
  zip.remove('ppt/theme/theme1.xml');
});

// ---- what a step does -------------------------------------------------------------------------------------------------

const HANDLERS = {
  add_slide: deck.handleAddSlide,
  delete_slide: deck.handleDeleteSlide,
  move_slide: deck.handleMoveSlide,
  keep_slides: deck.handleKeepSlides,
  add_comment: deck.handleAddCommentOrDeleteComment,
  delete_comment: deck.handleAddCommentOrDeleteComment,
  add_provenance: deck.handleAddProvenance,
  duplicate_slide: deck.handleDuplicateSlide,
  set_notes: deck.handleSetNotes,
  fill_template: deck.handleFillTemplate,
  replace_text: deck.handleReplaceText,
  import_slides: deck.handleImportSlides,
  set_slide_background: deck.handleSetSlideBackground,
  set_footer: deck.handleSetFooterOrSetSlideNumber,
  set_slide_number: deck.handleSetFooterOrSetSlideNumber,
  apply_theme: deck.handleApplyTheme,
  set_layout: deck.handleSetLayout,
  set_slide_visibility: deck.handleSetSlideVisibility,
  set_transition: deck.handleSetTransition,
};

const withWork = (value) => {
  if (typeof value === 'string') return value.startsWith('@work/') ? `${work}/${value.slice(6)}` : value;
  if (Array.isArray(value)) return value.map(withWork);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withWork(item)]));
  return value;
};
const withoutWork = (value) => {
  if (typeof value === 'string') return value.split(work).join('@work').replaceAll('@work\\', '@work/');
  if (Array.isArray(value)) return value.map(withoutWork);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutWork(item)]));
  return value;
};
const UUID = /\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/g;
const DATE = /dt="[^"]*"/g;
const fixed = (text) => text.replace(UUID, '{<uuid>}').replace(DATE, 'dt="<date>"');

const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const parts = {};
  for (const name of names) if (!zip.files[name].dir) parts[name] = fixed(await opc.zipText(zip, name));
  return { names, parts };
};

const runStep = async (state, step) => {
  switch (step.op) {
    case 'create': {
      const path = join(work, 'created.pptx');
      await pkg.createPortableOoxmlDocument(path, { fileKind: 'pptx', title: step.title });
      state.zip = await opc.loadPackage(path);
      state.context = { zip: state.zip, slides: await pack.presentationSlides(state.zip) };
      return null;
    }
    case 'set':
      state.zip.file(step.name, step.text);
      state.context.slides = await pack.presentationSlides(state.zip);
      return null;
    case 'remove':
      state.zip.remove(step.name);
      state.context.slides = await pack.presentationSlides(state.zip);
      return null;
    case 'file':
      writeFileSync(join(work, step.name), Buffer.from(step.base64, 'base64'));
      return null;
    case 'slides':
      return await pack.presentationSlides(state.zip);
    case 'snapshot':
      return await snapshot.snapshotPptx(state.zip, step.options);
    case 'handle': {
      const operation = withWork(step.operation);
      return withoutWork(await HANDLERS[operation.op](state.context, operation));
    }
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};

const handle = (operation) => ({ op: 'handle', operation });
const BASE = [
  { op: 'create', title: 'Deck' },
  ...LAYOUT_STEPS,
  ...MASTER_STEPS,
  handle({ op: 'add_slide', layout: 'title' }),
  handle({ op: 'add_slide', layout: 'Title and Content' }),
  handle({ op: 'add_slide' }),
  { op: 'set', name: 'ppt/slides/slide1.xml', text: slideWith([title, card, picture, related, brokenRelation], { background: solidBackground('f0f0f0') }) },
  { op: 'set', name: 'ppt/slides/slide2.xml', text: slideWith([title, grownTable, flatTable, hiddenShape], { root: ' show="0"' }) },
  { op: 'set', name: 'ppt/slides/slide3.xml', text: slideWith([fonted(10, 'Noto Sans KR', 4000, 'ABCDEF', '제목 & 소제목'), custom, group, chartFrame(11, 'rId5'), chartFrame(12, 'rId6'), chartFrame(13, 'rId9'), table]) },
  { op: 'set', name: 'ppt/slides/_rels/slide3.xml.rels', text: slideRels(CHART_REL) },
  { op: 'set', name: 'ppt/charts/chart1.xml', text: CHART },
  { op: 'set', name: 'ppt/charts/_rels/chart1.xml.rels', text: CHART_RELS },
  { op: 'set', name: 'ppt/embeddings/Microsoft_Excel_Sheet1.xlsx', text: 'workbook' },
  handle({ op: 'set_notes', slide: 1, text: 'Speaker line one\nline two & <more>' }),
];

const SEQUENCES = [];
SEQUENCES.push({
  name: 'a deck read whole and in windows',
  steps: [
    ...BASE,
    { op: 'snapshot', options: {} },
    { op: 'snapshot' },
    { op: 'snapshot', options: { paged: true } },
    { op: 'snapshot', options: { paged: true, offset: 1, limit: 1 } },
    { op: 'snapshot', options: { paged: true, offset: 2.5, limit: 1.5 } },
    { op: 'snapshot', options: { paged: true, offset: 7, limit: 2 } },
    { op: 'snapshot', options: { paged: true, limit: 0, offset: -4 } },
    { op: 'snapshot', options: { paged: true, pages: [3, 1, 9, 0, 'x', 1.5] } },
    { op: 'snapshot', options: { paged: true, pages: [] } },
    { op: 'snapshot', options: { pages: [2] } },
    { op: 'snapshot', options: { paged: 'yes', offset: 1 } },
    { op: 'snapshot', options: { paged: true, pages: 'ab', offset: 1, limit: 1 } },
  ],
});
SEQUENCES.push({
  name: 'a deck with nothing in it, and a slide with no shape tree',
  steps: [
    { op: 'create', title: 'Empty' },
    { op: 'snapshot', options: {} },
    handle({ op: 'add_slide' }),
    { op: 'set', name: 'ppt/slides/slide1.xml', text: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>' },
    { op: 'snapshot', options: { paged: true } },
    { op: 'set', name: 'ppt/presentation.xml', text: '<p:presentation/>' },
    { op: 'snapshot', options: {} },
  ],
});
SEQUENCES.push({
  name: 'slides added, moved, kept, duplicated and deleted',
  steps: [
    ...BASE,
    handle({ op: 'add_slide', layout: 'Title Only', index: 1 }),
    handle({ op: 'add_slide', index: 2.5 }),
    handle({ op: 'add_slide', layout: 'Nope' }),
    handle({ op: 'move_slide', slide: 1, index: 5 }),
    handle({ op: 'move_slide', slide: 9, index: 1 }),
    handle({ op: 'move_slide', slide: 2, index: 0 }),
    handle({ op: 'duplicate_slide', slide: 4 }),
    handle({ op: 'duplicate_slide', slide: 2, index: 1 }),
    handle({ op: 'duplicate_slide', slide: 3, index: 99 }),
    handle({ op: 'duplicate_slide', slide: 9 }),
    handle({ op: 'duplicate_slide', slide: 1, index: 2.5 }),
    { op: 'slides' },
    handle({ op: 'delete_slide', slide: 3 }),
    handle({ op: 'delete_slide', slide: 40 }),
    handle({ op: 'keep_slides', slides: [] }),
    handle({ op: 'keep_slides' }),
    handle({ op: 'keep_slides', slides: [1, '3', 'x'] }),
    handle({ op: 'keep_slides', slides: [1, 2, 3, 4, 5, 6, 7, 8] }),
    handle({ op: 'keep_slides', slides: [2] }),
    handle({ op: 'delete_slide', slide: 1 }),
    { op: 'slides' },
    { op: 'snapshot', options: {} },
  ],
});
SEQUENCES.push({
  name: 'comments, provenance and speaker notes',
  steps: [
    ...BASE,
    handle({ op: 'add_comment', slide: 1, text: 'Check this <figure> & the date' }),
    handle({ op: 'add_comment', slide: 1, text: 'Second', author: 'Ann <Lee>', initials: 'AL', left: 100.4, top: -5 }),
    handle({ op: 'add_comment', slide: 1, text: 'Third', left: null, top: 0 }),
    handle({ op: 'add_comment', slide: 2, text: 'Other page', author: 0 }),
    handle({ op: 'add_comment', slide: 1 }),
    handle({ op: 'add_comment', slide: 9, text: 'x' }),
    handle({ op: 'add_comment', text: 'x' }),
    handle({ op: 'delete_comment', slide: 1, comment: 2 }),
    handle({ op: 'delete_comment', slide: 1, comment: 7 }),
    handle({ op: 'delete_comment', slide: 3, comment: 1 }),
    handle({ op: 'delete_comment', slide: 1, comment: 'x' }),
    handle({ op: 'delete_comment', slide: 9, comment: 1 }),
    handle({ op: 'add_provenance', slide: 2, source: { document: 'Annual report 2025', target: 'p.12' } }),
    handle({ op: 'add_provenance', slide: 2, source: { document: 'Annual report 2025', target: 'p.12' } }),
    handle({ op: 'add_provenance', slide: 2, source: 'Ministry data', shape: 3 }),
    handle({ op: 'add_provenance', slide: 1, source: '출처: 통계청' }),
    handle({ op: 'add_provenance', slide: 3, source: { label: '시장 조사' } }),
    handle({ op: 'add_provenance', slide: 1, source: { target: 'only target' } }),
    handle({ op: 'add_provenance', slide: 1 }),
    handle({ op: 'add_provenance', slide: 9, source: 'x' }),
    handle({ op: 'set_notes', slide: 3, text: 'first\r\nsecond\n\nlast\r' }),
    handle({ op: 'set_notes', slide: 3 }),
    handle({ op: 'set_notes', slide: 9, text: 'x' }),
    { op: 'snapshot', options: {} },
  ],
});
SEQUENCES.push({
  name: 'text replaced and template tokens filled',
  steps: [
    ...BASE,
    { op: 'set', name: 'ppt/slides/slide2.xml', text: slideWith([shapes.shapeXml({ id: 2, textBox: true, textBody: shapes.textBodyXml({ paragraphs: [{ text: '{{company}}은 {{year}} 실적' }, { text: 'Total {{missing}}' }] }) })]) },
    handle({ op: 'replace_text', find: 'Revenue', replace: 'Turnover' }),
    handle({ op: 'replace_text', find: 'Speaker line', replace: 'Notes line' }),
    handle({ op: 'replace_text', find: 'Quarterly', replace: 'Annual', slide: 1 }),
    handle({ op: 'replace_text', find: 'Speaker', replace: '', slide: 1 }),
    handle({ op: 'replace_text', find: 'Quarterly', replace: 'Never', slide: 2 }),
    handle({ op: 'replace_text', find: '', replace: 'x' }),
    handle({ op: 'replace_text', replace: 'x' }),
    handle({ op: 'replace_text', find: 'nothing here', replace: 'x' }),
    handle({ op: 'replace_text', find: 'results', slide: 9, replace: 'x' }),
    handle({ op: 'fill_template', tokens: { company: '모아페이', year: 2025 } }),
    handle({ op: 'fill_template', tokens: { company: 'Acme' }, strict: true }),
    handle({ op: 'fill_template', tokens: { nothing: 'x' } }),
    handle({ op: 'fill_template', tokens: [] }),
    handle({ op: 'fill_template' }),
    { op: 'snapshot', options: {} },
  ],
});
SEQUENCES.push({
  name: 'background, footer, page number, layout, visibility and transition',
  steps: [
    ...BASE,
    handle({ op: 'set_slide_background', slide: 1, color: '#102030' }),
    handle({ op: 'set_slide_background', slide: 3, color: 'red' }),
    handle({ op: 'set_slide_background', slide: 9, color: '000000' }),
    handle({ op: 'set_footer', slide: 1, text: 'Confidential & draft' }),
    handle({ op: 'set_footer', slide: 1, text: 'Replaced' }),
    handle({ op: 'set_footer', slide: 2 }),
    handle({ op: 'set_footer', slide: 3, text: '푸터' }),
    handle({ op: 'set_slide_number', slide: 1 }),
    handle({ op: 'set_slide_number', slide: 2, visible: true }),
    handle({ op: 'set_slide_number', slide: 3, visible: false }),
    handle({ op: 'set_slide_number', slide: 2, visible: false }),
    handle({ op: 'set_footer', slide: 9, text: 'x' }),
    handle({ op: 'set_layout', slide: 1, layout: 'Title Only' }),
    handle({ op: 'set_layout', slide: 2, layout: 3 }),
    handle({ op: 'set_layout', slide: 3, layout: '제목만 & more' }),
    handle({ op: 'set_layout', slide: 1, layout: 'nothing' }),
    handle({ op: 'set_slide_visibility', slide: 1, visible: false }),
    handle({ op: 'set_slide_visibility', slide: 1, visible: false }),
    handle({ op: 'set_slide_visibility', slide: 2, visible: true }),
    handle({ op: 'set_slide_visibility', slide: 3, visible: 'no' }),
    handle({ op: 'set_slide_visibility', slide: 3 }),
    handle({ op: 'set_slide_visibility', slide: 9, visible: true }),
    ...['fade', 'Cut', 'push', 'wipe', 'split', 'dissolve', 'cover', 'zoom', 'none', '', undefined, 'spin', 'constructor'].map((effect) => handle({ op: 'set_transition', slide: 1, effect })),
    handle({ op: 'set_transition', slide: 2, effect: 'fade', duration: 2000 }),
    handle({ op: 'set_transition', slide: 2, effect: 'push', duration: 300, advanceOnTime: true, advanceTime: 4999.6 }),
    handle({ op: 'set_transition', slide: 2, effect: 'wipe', duration: 800, advanceOnTime: 'true', advanceTime: 3000 }),
    handle({ op: 'set_transition', slide: 2, effect: 'zoom', duration: 0, advanceOnTime: true, advanceTime: -1 }),
    handle({ op: 'set_transition', slide: 3, effect: 'cut' }),
    handle({ op: 'set_transition', slide: 9 }),
    { op: 'set', name: 'ppt/slides/slide3.xml', text: slideWith([title], { trailer: '' }) },
    handle({ op: 'set_transition', slide: 3, effect: 'dissolve' }),
    { op: 'set', name: 'ppt/slides/slide3.xml', text: '<p:other/>' },
    handle({ op: 'set_slide_visibility', slide: 3, visible: false }),
    handle({ op: 'set_footer', slide: 3, text: 'x' }),
    { op: 'snapshot', options: {} },
  ],
});
SEQUENCES.push({
  name: 'slides imported and a theme applied from other decks',
  steps: [
    ...BASE,
    { op: 'file', name: 'source.pptx', base64: SOURCE_DECK },
    { op: 'file', name: 'theme.pptx', base64: THEME_DECK },
    { op: 'file', name: 'bare.pptx', base64: BARE_DECK },
    { op: 'file', name: 'flat.pptx', base64: FLAT_THEME_DECK },
    { op: 'file', name: 'broken.pptx', base64: Buffer.from('not a zip at all, but long enough to be read').toString('base64') },
    handle({ op: 'import_slides', path: '@work/source.pptx', slides: [2, 1], after: 1 }),
    handle({ op: 'import_slides', path: '@work/source.pptx' }),
    handle({ op: 'import_slides', path: '@work/source.pptx', slides: [7] }),
    handle({ op: 'import_slides', path: '@work/absent.pptx' }),
    handle({ op: 'import_slides', path: '@work/broken.pptx' }),
    handle({ op: 'import_slides' }),
    handle({ op: 'import_slides', path: 5 }),
    handle({ op: 'apply_theme', path: '@work/theme.pptx' }),
    handle({ op: 'apply_theme', path: '@work/theme.pptx' }),
    handle({ op: 'apply_theme', path: '@work/bare.pptx' }),
    handle({ op: 'apply_theme', path: '@work/flat.pptx' }),
    handle({ op: 'apply_theme', path: '@work/absent.pptx' }),
    handle({ op: 'apply_theme', path: '@work/broken.pptx' }),
    handle({ op: 'apply_theme', path: null }),
    { op: 'remove', name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels' },
    handle({ op: 'apply_theme', path: '@work/flat.pptx' }),
    { op: 'slides' },
    { op: 'snapshot', options: { paged: true, offset: 2, limit: 3 } },
  ],
});

// ---- table fit --------------------------------------------------------------------------------------------------------

const rowXml = (h, cells) => `<a:tr${h === null ? '' : ` h="${h}"`}>${cells.join('')}</a:tr>`;
const korean = (margins) =>
  '<a:tr h="381000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"/><a:t>한 줄</a:t></a:r></a:p></a:txBody>' + `<a:tcPr${margins}/></a:tc></a:tr>`;
const FIT_ROWS = [
  [korean(''), [1828800]],
  [korean(' marL="0" marR="0" marT="0" marB="0"'), [1828800]],
  [rowXml(370840, [cell('Region', { bold: true }), cell('Sales')]), [2743200, 2743200]],
  [rowXml(100000, [cell('North'), cell('1,420', { size: 3600 })]), [2743200, 2743200]],
  [rowXml(null, [cell('No height')]), [2743200]],
  [rowXml(100000, [cell('Beyond the grid'), cell('b'), cell('c')]), [2743200, 2743200]],
  [rowXml(100000, [cell('Zero width')]), [0]],
  [rowXml(100000, [cell('Margins eat the width', { margins: ' marL="1371600" marR="1371600"' })]), [2743200]],
  [rowXml(10000, [cell('Margins eat the height', { margins: ' marT="91440" marB="91440"' })]), [2743200]],
  [rowXml(200000, [cell('Merged', { span: ' gridSpan="2"' }), cell('x')]), [1371600, 1371600, 1371600]],
  [rowXml(200000, [cell('Span', { span: ' rowSpan="3"' }), cell('x', { size: 2000 })]), [2743200, 2743200]],
  [rowXml(100000, ['<a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>', cell('after an empty cell')]), [2743200, 2743200]],
  [rowXml(100000, ['<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>two</a:t></a:r></a:p><a:p><a:r><a:t>paragraphs</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>']), [2743200]],
  ['<a:tr/>', [100]],
  [rowXml(100000, [cell('Default size').replace(' sz="1800"', '')]), [2743200]],
];
const TABLE_XML = [
  `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2743200"/><a:gridCol w="2743200"/></a:tblGrid>${rowXml(370840, [cell('Region'), cell('Sales')])}${rowXml(100000, [cell('North'), cell('1,420')])}${rowXml(100000, [cell('Tall', { size: 3600 }), cell('x')])}</a:tbl>`,
  '<a:tbl><a:tblPr/></a:tbl>',
  `<a:tbl><a:tblGrid><a:gridCol w="2743200"/></a:tblGrid>${rowXml(500000, [cell('Fits')])}</a:tbl>`,
  grownTable,
];
const fitOf = (found) => ({
  height: found.height,
  cells: found.cells.map((one) => ({
    columnOrdinal: one.columnOrdinal,
    size: one.size,
    bold: one.bold,
    fit: one.fit && { rowSpan: one.fit.rowSpan, available: one.fit.available, insets: one.fit.insets, lines: one.fit.measured.lines, height: one.fit.measured.height },
  })),
});
const fits = [];
for (const [xml, widths] of FIT_ROWS) fits.push({ kind: 'row', xml, widths, ...(await attempt(() => fitOf(fit.tableRowCells(xml, widths)))) });
for (const xml of TABLE_XML) fits.push({ kind: 'table', xml, ...(await attempt(() => fit.tableDrawnHeight(xml))) });

const sequences = [];
for (const sequence of SEQUENCES) {
  const state = { zip: null, context: null };
  const outputs = [];
  for (const step of sequence.steps) outputs.push(withoutWork(await attempt(() => runStep(state, step))));
  sequences.push({ ...sequence, outputs, snapshot: state.zip ? await snapshotOf(state.zip) : null });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { fit: fits, sequences });
writeSetManifest(stage, { set: 'office-pptx-deck', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
