#!/usr/bin/env node
// What the office design template modules answer (src/runtime/office/design/library: design-template-index, -inspect,
// -induct and -fill, with the packaged executive deck), run through Node. Rust `mixdog-office-design` (module `templates`)
// must answer the same: the inspection of every fixture deck, the index of a template folder (and its reuse on a second
// run), the induced roles of drawn pages, the slide selections (every part of the new deck), the page choice and fill of
// the packaged template and the operation lists `use_template_page` expands to (crates/mixdog-office-design/tests/twin_templates.rs).
//
//   node benchmarks/rust-core/recorders/record-office-templates.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-templates/golden.json. The recording carries the fixture decks (base64), so the replay
// needs no Node. The clock is fixed, every template file and sidecar gets a fixed modification time, and every path is written
// against `<root>` with `/` separators. A recorded deck snapshot of the packaged template is what the replay hands to the
// fill (the snapshot reader is another module); the recorder takes it from the same Node reader the fill calls.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const JSZip = createRequire(join(tree, 'package.json'))('jszip');
const recorder = 'benchmarks/rust-core/recorders/record-office-templates.mjs';
const finalDir = join(FIXTURES_ROOT, 'office-templates');
const stage = stageSet(finalDir);

for (const name of [
  'MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG',
  'MIXDOG_OFFICE_DESIGN_PACK_URL',
  'MIXDOG_OFFICE_DESIGN_PACK_KEY_ID',
  'MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY',
  'MIXDOG_OFFICE_TEMPLATE_DIRS',
]) {
  delete process.env[name];
}

const CLOCK = Date.UTC(2024, 0, 2, 3, 4, 5, 6);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...given) {
    if (given.length === 0) super(CLOCK);
    else super(...given);
  }
  static now() {
    return CLOCK;
  }
};

const library = (name) => importFrom(tree, `src/runtime/office/design/library/${name}.mjs`);
const core = await library('design-library-core');
const indexModule = await library('design-template-index');
const inspectModule = await library('design-template-inspect');
const inductModule = await library('design-template-induct');
const fillModule = await library('design-template-fill');
const portable = await importFrom(tree, 'src/runtime/office/portable/portable-snapshot.mjs');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'office-templates-')));
process.chdir(root);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const scrubText = (text) => text.split(root).join('<root>').replaceAll('\\', '/');
const localIds = new Map();
const scrub = (value) => {
  if (typeof value === 'string') return localIds.get(value) ?? scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubText(key), scrub(item)]));
  return value;
};
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const attempt = async (run) => {
  try {
    return { value: plain(await run()) };
  } catch (error) {
    return { error: scrubText(String(error?.message ?? error)) };
  }
};
const MTIME = 1_700_000_000;

// ---- fixture decks -----------------------------------------------------------------------------------------------------

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const paragraph = (text, size) => `<a:p><a:r><a:rPr lang="en-US"${size ? ` sz="${size * 100}"` : ''}/><a:t>${esc(text)}</a:t></a:r></a:p>`;
const frame = (x, y, cx, cy) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const box = (id, text, x, y, cx, cy, size, { name = `Box ${id}`, ph = '', prst = 'rect' } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${frame(x, y, cx, cy)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${text ? paragraph(text, size) : '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody></p:sp>`;
const picture = (id, x, y, cx, cy) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr>${frame(x, y, cx, cy)}</p:spPr></p:pic>`;
const graphicFrame = (id, inner, x, y, cx, cy) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Frame ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData>${inner}</a:graphicData></a:graphic></p:graphicFrame>`;
const chartFrame = (id, x, y, cx, cy) => graphicFrame(id, '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId8"/>', x, y, cx, cy);
const tableFrame = (id, x, y, cx, cy) => graphicFrame(id, '<a:tbl><a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>', x, y, cx, cy);
const group = (id, inner) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`;
const slideXml = (items) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${items.join('')}</p:spTree></p:cSld></p:sld>`;
const rels = (entries) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

/**
 * A deck: `slides` are slide XML texts; `order` is the slide numbers in presentation order with their relationship ids;
 * `notes` maps a slide number to its notes text.
 */
async function deck({ slides, order, notes = {}, extraRels = [], noPresentation = false, layouts = 1, appSlides = true }) {
  const zip = new JSZip();
  const slideTypes = slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  const noteTypes = Object.keys(notes).map((number) => `<Override PartName="/ppt/notesSlides/notesSlide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slideTypes.join('')}${noteTypes.join('')}</Types>`
  );
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  if (!noPresentation) {
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${order.map(([, id], index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId3', 'theme', 'theme/theme1.xml'], ['rId9', 'presProps', 'presProps.xml'], ...extraRels, ...order.map(([number, id]) => [id, 'slide', `slides/slide${number}.xml`])])
    );
  }
  slides.forEach((xml, index) => {
    const number = index + 1;
    zip.file(`ppt/slides/slide${number}.xml`, xml);
    const entries = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId8', 'chart', '../charts/chart1.xml'], ['rId9', 'image', '../media/image1.png']];
    if (notes[number] !== undefined) entries.push(['rId2', 'notesSlide', `../notesSlides/notesSlide${number}.xml`]);
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, rels(entries));
    if (notes[number] !== undefined) {
      zip.file(`ppt/notesSlides/notesSlide${number}.xml`, `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${box(2, notes[number], 0, 0, 100, 100, 12)}</p:spTree></p:cSld></p:notes>`);
      zip.file(`ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, rels([['rId1', 'slide', `../slides/slide${number}.xml`], ['rId2', 'notesMaster', '../notesMasters/notesMaster1.xml']]));
    }
  });
  for (let layout = 1; layout <= layouts; layout += 1) {
    zip.file(
      `ppt/slideLayouts/slideLayout${layout}.xml`,
      `<?xml version="1.0"?><p:sldLayout ${NS} type="${layout === 1 ? 'title' : 'obj'}"><p:cSld name="Layout ${layout} &amp; more"><p:spTree>${box(2, 'Click to edit', 100, 100, 500, 100, 24, { ph: '<p:ph type="title"/>' })}</p:spTree></p:cSld></p:sldLayout>`
    );
  }
  zip.file('ppt/theme/theme1.xml', '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture &amp; Theme"><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Malgun Gothic"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme></a:theme>');
  zip.file('ppt/media/image1.png', PNG);
  zip.file('ppt/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>');
  if (appSlides) zip.file('docProps/app.xml', `<?xml version="1.0"?><Properties><Slides>${slides.length}</Slides><Words>12</Words></Properties>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const W = 12_192_000;
const drawnSlides = [
  // 1: a cover: eyebrow, title, subtitle, a long body, a source line
  slideXml([
    box(2, 'ANNUAL REVIEW', 600_000, 700_000, 4_000_000, 300_000, 14),
    box(3, 'Quarterly operations review', 600_000, 1_100_000, 9_000_000, 1_100_000, 44),
    box(4, '2026 plan and what changed', 600_000, 2_300_000, 9_000_000, 500_000, 20),
    box(5, 'Prepared for the operating committee with the figures of the last four quarters.', 600_000, 3_200_000, 8_000_000, 900_000, 16),
    box(6, 'Source: finance close, October', 600_000, 6_200_000, 6_000_000, 300_000, 11),
  ]),
  // 2: columns with bodies, a chart and a picture
  slideXml([
    box(2, 'Three options compared', 600_000, 500_000, 9_000_000, 900_000, 32),
    box(3, 'Keep', 600_000, 1_800_000, 3_400_000, 500_000, 20),
    box(4, 'Change', 4_400_000, 1_800_000, 3_400_000, 500_000, 20),
    box(5, 'Stop', 8_200_000, 1_800_000, 3_400_000, 500_000, 20),
    box(6, 'Stay on the current vendor', 600_000, 2_400_000, 3_400_000, 1_200_000, 14),
    box(7, 'Move to the new platform', 4_400_000, 2_400_000, 3_400_000, 1_200_000, 14),
    box(8, 'Retire the service', 8_200_000, 2_400_000, 3_400_000, 1_200_000, 14),
    chartFrame(9, 600_000, 4_000_000, 4_000_000, 2_000_000),
    picture(10, 8_200_000, 4_000_000, 2_000_000, 2_000_000),
  ]),
  // 3: metrics (values over labels) with an aside row and a table
  slideXml([
    box(2, '3분기 지표', 600_000, 500_000, 8_000_000, 900_000, 28),
    box(3, '99.95%', 600_000, 2_000_000, 2_400_000, 800_000, 40),
    box(4, '320ms', 3_400_000, 2_000_000, 2_400_000, 800_000, 40),
    box(5, '14만 건', 6_200_000, 2_000_000, 2_400_000, 800_000, 40),
    box(6, '월 가용성', 600_000, 2_900_000, 2_400_000, 500_000, 12),
    box(7, 'p95 응답', 3_400_000, 2_900_000, 2_400_000, 500_000, 12),
    box(8, '처리량', 6_200_000, 2_900_000, 2_400_000, 500_000, 12),
    box(9, '확장', 600_000, 4_200_000, 2_400_000, 500_000, 18),
    box(10, '배포', 3_400_000, 4_200_000, 2_400_000, 500_000, 18),
    tableFrame(11, 6_200_000, 4_200_000, 3_000_000, 1_000_000),
  ]),
  // 4: a chevron flow, a group and a full-bleed background
  slideXml([
    box(2, 'Background', 0, 0, W, 6_858_000, 10, { name: 'Surface' }),
    box(3, 'How a request moves', 600_000, 500_000, 9_000_000, 800_000, 30),
    box(4, '', 600_000, 1_900_000, 2_200_000, 1_000_000, 10, { prst: 'chevron' }),
    box(5, 'Draft', 700_000, 1_900_000, 1_700_000, 1_000_000, 14),
    box(6, '', 2_900_000, 1_900_000, 2_300_000, 1_000_000, 10, { prst: 'chevron' }),
    box(7, 'Review', 3_000_000, 1_900_000, 1_800_000, 1_000_000, 14),
    box(8, '', 5_300_000, 1_900_000, 2_300_000, 1_000_000, 10, { prst: 'homePlate' }),
    box(9, 'Approve', 5_400_000, 1_900_000, 1_800_000, 1_000_000, 14),
    group(10, box(11, 'inside a group', 600_000, 4_000_000, 3_000_000, 500_000, 12)),
  ]),
  // 5: a closing page with notes
  slideXml([box(2, 'Thank you', 600_000, 2_000_000, 8_000_000, 1_200_000, 44), box(3, 'Questions and next steps', 600_000, 3_400_000, 8_000_000, 500_000, 18)]),
];
const drawnDeck = await deck({
  slides: drawnSlides,
  // presentation order swaps the first two slide parts; slide ids avoid the ids the non-slide relationships hold
  order: [[2, 'rId2'], [1, 'rId4'], [3, 'rId5'], [4, 'rId6'], [5, 'rId7']],
  notes: { 5: 'Close with the decision requested.', 2: 'Walk the three columns.' },
});

const tokenSlides = [
  slideXml([
    box(2, '{{TITLE}}', 600_000, 500_000, 9_000_000, 900_000, 36, { ph: '<p:ph type="ctrTitle"/>' }),
    box(3, 'Subtitle line', 600_000, 1_500_000, 9_000_000, 500_000, 20, { ph: '<p:ph type="subTitle" idx="1"/>' }),
    box(4, 'body words', 600_000, 2_200_000, 9_000_000, 900_000, 16, { ph: '<p:ph type="body" idx="2"/>' }),
    box(5, 'kicker {{EYEBROW}}', 600_000, 300_000, 3_000_000, 200_000, 12),
    box(6, '', 600_000, 3_300_000, 3_000_000, 1_000_000, 12, { ph: '<p:ph type="pic" idx="3"/>' }),
    box(7, 'no type', 600_000, 4_400_000, 3_000_000, 500_000, 12, { ph: '<p:ph idx="10"/>' }),
  ]),
  slideXml([
    box(2, '{{TITLE}}', 600_000, 500_000, 9_000_000, 900_000, 36, { ph: '<p:ph type="title"/>' }),
    box(3, '{{METRIC_1_VALUE}}', 600_000, 2_000_000, 2_400_000, 800_000, 40),
    box(4, '{{METRIC_1_LABEL}}', 600_000, 2_900_000, 2_400_000, 500_000, 12),
    box(5, '{{METRIC_2_VALUE}}', 3_400_000, 2_000_000, 2_400_000, 800_000, 40),
    box(6, '{{METRIC_2_DETAIL}}', 3_400_000, 2_900_000, 2_400_000, 500_000, 12),
    box(7, '{{COLUMN_2_BODY}} and {{COLUMN_1_TITLE}}', 600_000, 4_000_000, 3_000_000, 500_000, 12),
    box(8, '{{STEP_3_DETAIL}}', 600_000, 4_600_000, 3_000_000, 500_000, 12),
    box(9, '{{source_note}}', 600_000, 5_200_000, 3_000_000, 300_000, 10),
    chartFrame(10, 6_000_000, 2_000_000, 3_000_000, 2_000_000),
    tableFrame(11, 6_000_000, 4_200_000, 3_000_000, 1_000_000),
  ]),
  slideXml([picture(2, 600_000, 500_000, 4_000_000, 3_000_000), group(3, box(4, 'in a group', 5_000_000, 500_000, 3_000_000, 500_000, 12)), box(5, '', 0, 0, 10, 10, 0)]),
];
const tokenDeck = await deck({ slides: tokenSlides, order: [[1, 'rId2'], [2, 'rId4'], [3, 'rId5']], layouts: 2 });
const noPresentationDeck = await deck({ slides: drawnSlides.slice(0, 3), order: [], noPresentation: true, appSlides: false });
const sidecarDeck = await deck({ slides: tokenSlides, order: [[1, 'rId2'], [2, 'rId4'], [3, 'rId5']] });
const declaredDeck = await deck({ slides: drawnSlides.slice(0, 2), order: [[1, 'rId2'], [2, 'rId4']] });
const damaged = Buffer.from('this is not a zip archive at all');
const docx = Buffer.from('PK-not-read');

const packaged = join(tree, 'src/runtime/office/design/library/templates');

// ---- the template folder ----------------------------------------------------------------------------------------------

const folder = join(root, 'templates');
const nested = join(folder, 'a', 'b');
mkdirSync(nested, { recursive: true });
const place = (relative, data, { mtime = MTIME } = {}) => {
  const target = join(folder, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
  utimesSync(target, mtime, mtime);
  return target;
};
const files = {
  'drawn.pptx': drawnDeck,
  'tokens.potx': tokenDeck,
  'no-presentation.pptm': noPresentationDeck,
  'sidecar.pptx': sidecarDeck,
  'declared.pptx': declaredDeck,
  'damaged.pptx': damaged,
  'letter.docx': docx,
  'Sheet.XLSX': docx,
  'a/b/nested.pptx': drawnDeck,
  'ignored.mixdog-edit.pptx': drawnDeck,
  'notes.txt': Buffer.from('not a template'),
};
for (const [name, data] of Object.entries(files)) place(name, data);
const SIDECARS = {
  'sidecar.pptx.mixdog.json': {
    id: 'sidecar-deck',
    label: 'Sidecar Deck',
    profile: 'editorial',
    version: '2.1.0',
    samples: [
      { slide: 1, id: 'side-cover', kind: 'Cover', density: 'Light', variant: 'Hero', purposes: ['Explain'], expressionModes: ['conservative'], priority: 12, strict: true, defaults: { background: '101010' }, capacity: { textSlots: 9 }, roles: { 2: 'title', 3: 'subtitle', 5: 'eyebrow' } },
      { slide: 2, kind: 'metrics', roles: { 3: 'metric-value-1', 4: 'metric-label-1' } },
    ],
  },
  'declared.pptx.mixdog.json': {
    id: 'declared-deck',
    label: 'Declared',
    layouts: [
      { id: 'declared-cover', kind: 'cover', sourceSlide: 1, density: 'light', purposes: ['decide'] },
      { id: 'declared-orphan', kind: 'content', sourceSlide: 9 },
    ],
    samples: [{ slide: 2, kind: 'comparison' }],
  },
  'tokens.potx.mixdog.json': { id: 'tokens-deck', samples: [{ slide: 1, roles: { 2: 'title' } }] },
  'drawn.pptx.mixdog.json': { id: 'drawn-deck' },
  'no-presentation.pptm.mixdog.json': { id: 'bare-deck' },
  'damaged.pptx.mixdog.json': { id: 'damaged-deck' },
  'letter.docx.mixdog.json': { id: 'letter' },
  'Sheet.XLSX.mixdog.json': { id: 'sheet' },
  'a/b/nested.pptx.mixdog.json': { id: 'nested-deck' },
};
for (const [name, data] of Object.entries(SIDECARS)) place(name, JSON.stringify(data, null, 2));
copyFileSync(join(packaged, 'mixdog-executive.pptx'), join(folder, 'mixdog-executive.pptx'));
copyFileSync(join(packaged, 'mixdog-executive.pptx.mixdog.json'), join(folder, 'mixdog-executive.pptx.mixdog.json'));
for (const name of ['mixdog-executive.pptx', 'mixdog-executive.pptx.mixdog.json']) utimesSync(join(folder, name), MTIME, MTIME);

const hashedId = (file) => `local-${sha256(core.canonicalPath(file)).slice(0, 16)}`;
localIds.set(hashedId(join(folder, 'tokens.potx')), '<local tokens.potx>');

// ---- inspection -------------------------------------------------------------------------------------------------------

const inspections = [];
for (const [name, format] of [['drawn.pptx', ''], ['tokens.potx', 'pptx'], ['no-presentation.pptm', ''], ['sidecar.pptx', 'pptx'], ['damaged.pptx', ''], ['letter.docx', ''], ['mixdog-executive.pptx', ''], ['gone.pptx', '']]) {
  inspections.push({ name, format, ...(await attempt(() => indexModule.inspectOfficeTemplate(join(folder, name), { format }))) });
}
const coverage = await attempt(() => inspectModule.officeTemplateCoverage([
  { kind: 'cover', density: 'light', purposes: ['decide'], expressionModes: ['divergent'], capabilities: ['image', 'chart'] },
  { kind: 'content', density: 'dense', purposes: [], capabilities: ['table', 'diagram'] },
  { kind: '', density: 'balanced' },
]));
const emptyCoverage = await attempt(() => inspectModule.officeTemplateCoverage());

// ---- induced roles ----------------------------------------------------------------------------------------------------

const frameOf = (shape, left, top, width, height, text, fontSize, extra = {}) => ({ shape, type: 'text', text, geometry: { left, top, width, height }, ...(fontSize ? { fontSize } : {}), ...extra });
const inductCases = [
  { name: 'columns', canvas: null, shapes: [frameOf(1, 500_000, 300_000, 8_000_000, 900_000, 'A drawn page', 40), frameOf(2, 500_000, 2_000_000, 3_000_000, 400_000, 'Alpha', 20), frameOf(3, 4_500_000, 2_000_000, 3_000_000, 400_000, 'Beta', 20), frameOf(4, 500_000, 2_500_000, 3_000_000, 600_000, 'first body', 14), frameOf(5, 4_500_000, 2_500_000, 3_000_000, 600_000, 'second body', 14)] },
  { name: 'metrics with an aside row', canvas: { width: 12_192_000, height: 6_858_000 }, shapes: [frameOf(9, 600_000, 500_000, 8_000_000, 900_000, '3분기 지표', 28), frameOf(1, 600_000, 2_000_000, 2_400_000, 800_000, '38%', 40), frameOf(2, 3_400_000, 2_000_000, 2_400_000, 800_000, '12건', 40), frameOf(3, 600_000, 2_900_000, 2_400_000, 500_000, '재작업 비율', 12), frameOf(4, 3_400_000, 2_900_000, 2_400_000, 500_000, '지연 건수', 12), frameOf(5, 600_000, 4_200_000, 2_400_000, 500_000, '확장', 18), frameOf(6, 3_400_000, 4_200_000, 2_400_000, 500_000, '배포', 18)] },
  { name: 'steps', canvas: { width: 960, height: 540 }, shapes: [frameOf(9, 43, 20, 600, 60, 'Flow', 30), frameOf(1, 43, 148, 221, 101, '', 0, { preset: 'chevron' }), frameOf(2, 68, 148, 170, 101, '초안', 12), frameOf(3, 239, 148, 231, 101, '', 0, { preset: 'chevron' }), frameOf(4, 264, 148, 180, 101, '검토', 12), frameOf(5, 470, 148, 240, 101, '', 0, { preset: 'homePlate' }), frameOf(6, 495, 148, 190, 101, '승인', 12)] },
  { name: 'figure beside a statement', canvas: null, shapes: [frameOf(1, 500_000, 300_000, 2_000_000, 1_500_000, '18', 82), frameOf(2, 3_000_000, 600_000, 7_000_000, 700_000, 'What the number means for the quarter', 30)] },
  { name: 'frame words', canvas: null, shapes: [frameOf(1, 600_000, 300_000, 3_000_000, 250_000, 'KICKER', 12), frameOf(2, 600_000, 600_000, 8_000_000, 900_000, 'The headline of the page', 40), frameOf(3, 600_000, 1_600_000, 8_000_000, 400_000, 'a line under it', 18), frameOf(4, 600_000, 3_000_000, 8_000_000, 900_000, 'A sentence the page states about the quarter in full', 16), frameOf(5, 600_000, 4_100_000, 8_000_000, 900_000, 'Another sentence that makes a second block of prose', 16), frameOf(6, 600_000, 6_200_000, 5_000_000, 300_000, '출처: 재무 마감', 11)] },
  { name: 'no loud voice', canvas: null, shapes: [frameOf(1, 500_000, 300_000, 4_000_000, 600_000, 'First', 30), frameOf(2, 500_000, 1_500_000, 4_000_000, 600_000, 'Second', 28)] },
  { name: 'a long title', canvas: null, shapes: [frameOf(1, 500_000, 300_000, 9_000_000, 900_000, 'x'.repeat(141), 40), frameOf(2, 500_000, 2_000_000, 4_000_000, 600_000, 'small', 12)] },
  { name: 'full-bleed and unsized', canvas: null, shapes: [frameOf(1, 0, 0, 12_192_000, 6_858_000, 'Surface', 60), frameOf(2, 500_000, 300_000, 5_000_000, 800_000, 'Title', 36), frameOf(3, 500_000, 2_000_000, 0, 0, 'zero', 12), { shape: 4, type: 'image', text: '', geometry: { left: 1, top: 1, width: 100, height: 100 } }] },
  { name: 'empty', canvas: null, shapes: [] },
];
const induced = inductCases.map((entry) => {
  const roles = inductModule.inducePptxSampleRoles({ shapes: entry.shapes }, entry.canvas ?? undefined);
  return { ...entry, roles: Object.fromEntries([...roles.entries()].map(([shape, role]) => [String(shape), role])) };
});

// ---- annotated snapshots ---------------------------------------------------------------------------------------------

// Only what the roles and the fill read of a snapshot: the page size, each page's index and each shape's index, name, type,
// text, frame, type size, outline, chart title and table.
const reduced = (document) => ({
  slideWidth: document.slideWidth,
  slideHeight: document.slideHeight,
  slideCount: document.slideCount,
  slides: document.slides.map((slide) => ({
    index: slide.index,
    shapes: slide.shapes.map((shape) => ({
      index: shape.index,
      name: shape.name,
      type: shape.type,
      text: shape.text,
      left: shape.left,
      top: shape.top,
      width: shape.width,
      height: shape.height,
      font: { size: shape.font?.size },
      geometry: shape.geometry,
      ...(shape.chart ? { chart: { title: shape.chart.title } } : {}),
      ...(shape.table ? { table: true } : {}),
    })),
  })),
});
const snapshotOf = async (file) => plain(reduced(await portable.snapshotPortableOoxml(file, 'pptx')));
const annotate = (document) => {
  const copy = JSON.parse(JSON.stringify(document));
  inductModule.annotatePptxSnapshotRoles(copy);
  return copy;
};
const rawDocuments = {
  tokens: { slideWidth: W, slideHeight: 6_858_000, slideCount: 3, slides: [{ index: 1, shapes: [{ index: 1, text: 'Cover', left: 500_000, top: 300_000, width: 8_000_000, height: 900_000, font: { size: 44 } }] }, { index: 2, shapes: [{ index: 1, text: '', type: 3, left: 0, top: 0, width: 100, height: 100 }, { index: 2, type: 13, left: 1, top: 1, width: 50, height: 50 }, { index: 3, table: { rows: 1 }, left: 1, top: 1, width: 50, height: 50 }, { index: 4, chart: { title: 'Errors' }, left: 1, top: 1, width: 50, height: 50 }] }, { index: 3, shapes: [{ index: 1, text: 'Thank you', left: 500_000, top: 300_000, width: 8_000_000, height: 900_000, font: { size: 44 } }] }] },
  empty: { slideWidth: 0, slideHeight: 0, slides: [{ index: 1, shapes: [] }] },
  none: { slides: [] },
};
const annotated = {};
for (const [name, document] of Object.entries(rawDocuments)) annotated[name] = annotate(document);
const realSnapshots = {};
for (const name of ['drawn.pptx', 'mixdog-executive.pptx', 'sidecar.pptx']) {
  const raw = await snapshotOf(join(folder, name));
  realSnapshots[name] = { raw, annotated: annotate(raw) };
}
const goneSnapshot = await attempt(() => snapshotOf(join(folder, 'gone.pptx')));

// ---- slide selection --------------------------------------------------------------------------------------------------

const selectionSources = { drawn: join(folder, 'drawn.pptx'), executive: join(folder, 'mixdog-executive.pptx'), nopres: join(folder, 'no-presentation.pptm'), gone: join(folder, 'gone.pptx'), damaged: join(folder, 'damaged.pptx') };
const SELECTIONS = [
  ['drawn', [1]], ['drawn', [2, 1]], ['drawn', [3, 3, 3]], ['drawn', [5]], ['drawn', [2]], ['drawn', [1, 1, 1, 1, 1, 1, 1]], ['drawn', ['2', '4']],
  ['drawn', []], ['drawn', [0]], ['drawn', [6]], ['drawn', [1.5]], ['drawn', ['x']], ['drawn', null],
  ['executive', [2, 4]], ['executive', [1]], ['nopres', [1, 3]], ['gone', [1]], ['damaged', [1]],
];
const selections = [];
for (const [source, slides] of SELECTIONS) {
  const output = join(root, 'selected', `case-${selections.length}.pptx`);
  const outcome = await attempt(() => inspectModule.createPptxSlideSelection(selectionSources[source], slides, output));
  let package_ = null;
  if (outcome.value) {
    const zip = await JSZip.loadAsync(readFileSync(output));
    const parts = {};
    for (const name of Object.keys(zip.files)) parts[name] = zip.files[name].dir ? 'dir' : sha256(await zip.file(name).async('nodebuffer'));
    const texts = {};
    if (source === 'drawn' || source === 'nopres') {
      for (const name of Object.keys(zip.files)) if (/\.(xml|rels)$/.test(name) && /^(\[Content_Types\]|ppt\/(presentation|_rels\/presentation|slides|notesSlides)|docProps\/app)/.test(name)) texts[name] = await zip.file(name).async('string');
    }
    package_ = { names: Object.keys(zip.files), parts, texts };
  }
  selections.push({ source, slides, ...scrub(outcome), package: package_ });
}
// A package that cannot be written leaves nothing behind: the output is a directory that exists.
mkdirSync(join(root, 'selected', 'blocked.pptx'), { recursive: true });
const blocked = await attempt(() => inspectModule.createPptxSlideSelection(selectionSources.drawn, [1], join(root, 'selected', 'blocked.pptx')));

// ---- page choice and fill ---------------------------------------------------------------------------------------------

const page = (index, columns, role = 'comparison') => ({ index, role, shapes: [{ index: 1, slot: 'title', text: '' }, ...Array.from({ length: columns }, (_, position) => [{ index: 2 + position * 2, slot: `column-title-${position + 1}`, text: '' }, { index: 3 + position * 2, slot: `column-body-${position + 1}`, text: '' }]).flat()] });
const lowDocuments = {
  comparison: { slides: [page(1, 4), page(2, 2)] },
  bodies: { slides: [{ index: 3, role: 'comparison', shapes: [{ index: 1, slot: 'title', text: '' }, { index: 2, slot: 'column-title-1', text: '' }, { index: 3, slot: 'column-title-2', text: '' }] }, page(4, 2)] },
  mixed: { slides: [{ index: 1, role: 'cover', shapes: [{ index: 1, slot: 'eyebrow', text: 'EYEBROW' }, { index: 2, slot: 'title', text: 'T' }, { index: 3, slot: 'subtitle', text: 'S' }, { index: 4, slot: 'visual-text', text: 'MIXDOG' }, { index: 5, slot: 'visual-text', text: '→' }, { index: 6, slot: 'visual-text', text: '18' }, { index: 7, slot: 'chart', text: '', chart: { title: 'Cycle time · seconds' } }, { index: 8, slot: 'table', text: '' }, { index: 9, slot: 'image', text: '' }, { index: 10, slot: 'meta', text: 'date' }, { index: 11, slot: 'source', text: 'src' }, { index: 12, slot: 'body-2', text: 'x' }, { index: 13, slot: 'aside-1', text: 'x' }] }, { index: 2, role: 'summary', shapes: [{ index: 1, slot: 'title', text: '' }, { index: 2, slot: 'body', text: '' }, { index: 0, slot: 'meta', text: 'zero' }, { slot: 'meta', text: 'no index' }] }, { index: 5, shapes: [] }] },
  steps: { slides: [{ index: 1, role: 'process', shapes: [{ index: 1, slot: 'title', text: '' }, { index: 2, slot: 'step-title-1', text: '' }, { index: 3, slot: 'step-detail-1', text: '' }, { index: 4, slot: 'step-title-3', text: '' }] }, { index: 2, role: 'process', shapes: [{ index: 1, slot: 'title', text: '' }, { index: 2, slot: 'step-title-1', text: '' }, { index: 3, slot: 'step-title-4', text: '' }] }, { index: 3, role: 'metrics', shapes: [{ index: 1, slot: 'metric-value-1', text: '' }, { index: 2, slot: 'metric-label-1', text: '' }] }] },
  none: { slides: [] },
  absent: {},
};
const selectRequests = [
  { role: 'comparison', items: [{}, {}] }, { role: 'comparison', items: [{}, {}, {}] }, { role: 'comparison', items: [{}, {}, {}, {}, {}] }, { role: 'comparison' }, { role: 'comparison', items: [{ title: 'a', body: 'b' }, { title: 'c' }] },
  { role: 'comparison', items: [{ title: 'a' }, { title: 'c' }] }, { role: 'comparison', items: [{ title: 'a', body: '' }, { title: 'c', label: 'x' }] }, { role: 'comparison', items: [{ body: null, label: ' ', detail: 'd' }] },
  { slide: 2 }, { slide: 1 }, { slide: 0 }, { slide: 9 }, { slide: 1.5 }, { slide: '2' }, { role: 'metrics' }, { role: 'process', items: [{ title: 'a', detail: 'd' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] }, { role: 'process', items: [{ title: 'a' }] }, { role: 'cover' }, {}, { role: '' }, null,
];
const selects = [];
for (const [name, document] of Object.entries(lowDocuments)) {
  for (const request of selectRequests) {
    const outcome = await attempt(() => fillModule.selectTemplatePage(document, request)?.index ?? null);
    selects.push({ document: name, request, ...outcome });
  }
}
const fillContents = [
  {}, { title: 'T' }, { title: 'T', items: [{ title: 'a', body: 'b' }] }, { items: [{}, {}, {}] }, { items: [{ title: 'a' }] }, { items: [{ title: 'a', body: 'b' }, { title: 'c', body: 'd' }, { title: 'e', body: 'f' }, { title: 'g' }, { title: 'h' }] },
  { eyebrow: 'E', subtitle: 'S', body: 'B', source: 'X' }, { subtitle: 'S' }, { body: 'B' }, { eyebrow: 'E' }, { title: 'T', body: 'B', subtitle: '' }, { source: 'X' },
  { items: [{ value: '1', label: 'one' }, { value: '2' }, { label: 'three' }] }, { items: [{ title: 'a', detail: 'd' }] }, { items: [{ title: 0, body: false }] }, { title: 'T', items: [] },
];
const fills = [];
for (const [name, document] of Object.entries(lowDocuments)) {
  const pages = Array.isArray(document.slides) ? document.slides : [];
  for (const pageValue of pages) {
    for (const content of fillContents) {
      const outcome = await attempt(() => {
        const fill = fillModule.templatePageFill(pageValue, content);
        return { sets: fill.sets, deletes: fill.deletes, group: fill.group };
      });
      fills.push({ document: name, page: pageValue.index ?? null, content, ...outcome });
    }
  }
}

// ---- use_template_page expansion --------------------------------------------------------------------------------------

const executive = join(folder, 'mixdog-executive.pptx');
const drawnPath = join(folder, 'drawn.pptx');
const sidecarPath = join(folder, 'sidecar.pptx');
const expansions = [];
const expand = async (label, format, operations) => {
  const input = JSON.parse(JSON.stringify(operations));
  const carriers = [];
  const outcome = await attempt(() => fillModule.expandTemplatePageOperations(format, input, carriers));
  expansions.push({ label, format, operations: scrub(operations), ...scrub(outcome), carriers: scrub(carriers) });
};
await expand('not a pptx', 'docx', [{ op: 'use_template_page', path: executive, role: 'cover', after: 0 }]);
await expand('no template page', 'pptx', [{ op: 'set_text', slide: 1, shape: 1, text: 'x' }]);
const CONTENTS = [
  { title: 'A title' },
  { title: 'A title', eyebrow: 'Kicker', subtitle: 'A subtitle', body: 'Some prose', source: 'Source: us', notes: 'speaker note' },
  { title: 'A title', items: [{ title: 'One', value: '1' }] },
  { title: 'A title', items: [{ title: 'One', body: 'first', value: '1', label: 'l1', detail: 'd1' }, { title: 'Two', value: '2', label: 'l2' }] },
];
for (const role of ['cover', 'process', 'metrics', 'comparison', 'content', 'statement', 'closing', 'split']) {
  for (const [at, content] of CONTENTS.entries()) await expand(`executive ${role} ${at}`, 'pptx', [{ op: 'use_template_page', path: executive, role, after: 0, ...content }]);
}
for (let slide = 1; slide <= 19; slide += 1) {
  await expand(`executive slide ${slide}`, 'pptx', [{ op: 'use_template_page', path: executive, slide, after: slide - 1, title: `Page ${slide}`, notes: 'n' }]);
}
await expand('executive by slide', 'pptx', [{ op: 'use_template_page', path: executive, slide: 3, after: 2, title: 'Numbers' }, { op: 'set_notes', slide: 1, text: 'passes through' }, { op: 'use_template_page', path: executive, slide: 4, after: 3 }]);
await expand('executive too many items', 'pptx', [{ op: 'use_template_page', path: executive, role: 'process', after: 0, items: [{}, {}, {}, {}, {}, {}, {}, {}, {}] }]);
await expand('drawn deck by role', 'pptx', [{ op: 'use_template_page', path: drawnPath, role: 'comparison', after: 1, title: 'Options', items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }, { title: 'C', body: 'c' }] }, { op: 'use_template_page', path: drawnPath, role: 'metrics', after: 2, title: 'M', items: [{ value: '9', label: 'nine' }] }, { op: 'use_template_page', path: drawnPath, role: 'cover', after: 0, title: 'Cover', subtitle: 'Sub' }]);
await expand('drawn deck process', 'pptx', [{ op: 'use_template_page', path: drawnPath, role: 'process', after: 0, title: 'Flow', items: [{ title: 'x' }, { title: 'y' }] }]);
await expand('sidecar deck', 'pptx', [{ op: 'use_template_page', path: sidecarPath, role: 'cover', after: 0, title: 'Cover' }, { op: 'use_template_page', path: sidecarPath, slide: 2, after: 1, title: 'Metrics', items: [{ value: '1', label: 'l' }] }]);
await expand('after missing', 'pptx', [{ op: 'use_template_page', path: executive, role: 'cover' }]);
await expand('after negative', 'pptx', [{ op: 'use_template_page', path: executive, role: 'cover', after: -1 }]);
await expand('after fractional', 'pptx', [{ op: 'use_template_page', path: executive, role: 'cover', after: 1.5 }]);
await expand('after text number', 'pptx', [{ op: 'use_template_page', path: executive, role: 'cover', after: '2', title: 'x' }]);
await expand('missing role', 'pptx', [{ op: 'use_template_page', path: executive, role: 'nonexistent', after: 0 }]);
await expand('no page named', 'pptx', [{ op: 'use_template_page', path: executive, after: 0 }]);
await expand('template missing', 'pptx', [{ op: 'use_template_page', path: join(folder, 'gone.pptx'), role: 'cover', after: 0 }]);

// ---- the index --------------------------------------------------------------------------------------------------------
// Last: its steps change the folder. A step is data (`write` with base64 or text, `utimes`, `remove`) the replay applies too.

const dataDir = join(root, 'data');
const config = { templateDirectories: [folder], discoverInstalledTemplates: false };
const indexRuns = [];
const applyStep = (step) => {
  const target = join(folder, step.file);
  if (step.kind === 'write') {
    const data = step.base64 !== undefined ? Buffer.from(step.base64, 'base64') : Buffer.from(step.text, 'utf8');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
    utimesSync(target, step.mtime, step.mtime);
  } else if (step.kind === 'utimes') utimesSync(target, step.mtime, step.mtime);
  else rmSync(target);
};
// A run keeps its whole answer only where `full`; the others keep what identifies each entry (the entries themselves are the
// first run's and the last's, and the file the index wrote).
const summary = (value) => ({
  ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'templates')),
  templates: value.templates.map((entry) => Object.fromEntries(['id', 'path', 'sha256', 'version', 'mtimeMs', 'sidecarMtimeMs', 'inspectionWarning'].map((key) => [key, entry[key]]))),
});
const runIndex = async (label, steps = [], full = false) => {
  for (const step of steps) applyStep(step);
  const outcome = await attempt(() => indexModule.indexOfficeTemplates({ dataDir, config }));
  indexRuns.push({ label, steps, full, ...(outcome.value && !full ? { value: summary(outcome.value) } : outcome) });
};
const smallDeck = await deck({ slides: drawnSlides.slice(0, 2), order: [[1, 'rId2'], [2, 'rId4']] });
await runIndex('first', [], true);
await runIndex('unchanged');
await runIndex('sidecar touched', [{ kind: 'utimes', file: 'sidecar.pptx.mixdog.json', mtime: MTIME + 100 }]);
await runIndex('file replaced', [{ kind: 'write', file: 'drawn.pptx', base64: smallDeck.toString('base64'), mtime: MTIME + 5 }]);
await runIndex('invalid sidecar id', [{ kind: 'write', file: 'tokens.potx.mixdog.json', text: JSON.stringify({ id: 'Bad Id!' }), mtime: MTIME + 10 }]);
await runIndex('sidecar with a label that is not text', [{ kind: 'write', file: 'tokens.potx.mixdog.json', text: JSON.stringify({ id: 'tokens-deck', label: 7, profile: 'Editorial', samples: [{ slide: 1, roles: { 2: 'title' } }] }), mtime: MTIME + 11 }]);
await runIndex('sidecar names a missing shape', [{ kind: 'write', file: 'tokens.potx.mixdog.json', text: JSON.stringify({ id: 'tokens-deck', samples: [{ slide: 1, roles: { 99: 'title' } }] }), mtime: MTIME + 12 }]);
await runIndex('sidecar removed', [{ kind: 'remove', file: 'tokens.potx.mixdog.json' }]);
await runIndex('sidecar not an object', [{ kind: 'write', file: 'tokens.potx.mixdog.json', text: '[1, 2]', mtime: MTIME + 13 }], true);
const indexFile = JSON.parse(readFileSync(join(dataDir, 'office', 'design-library', 'template-index.json'), 'utf8'));

// A folder with one template and no sidecar: its id is a hash of its path.
const single = join(root, 'single');
mkdirSync(single, { recursive: true });
const singleFile = join(single, 'only.pptx');
writeFileSync(singleFile, drawnDeck);
utimesSync(singleFile, MTIME, MTIME);
localIds.set(hashedId(singleFile), '<local only.pptx>');
const singleRun = await attempt(() => indexModule.indexOfficeTemplates({ dataDir: join(root, 'data2'), config: { templateDirectories: [single], discoverInstalledTemplates: false } }));

// ---- write ------------------------------------------------------------------------------------------------------------

const b64 = (data) => data.toString('base64');
const executiveBytes = readFileSync(join(packaged, 'mixdog-executive.pptx'));
const out = {
  note: 'Recorded from the Node office design template modules; tests/twin_templates.rs replays it.',
  clock: CLOCK,
  mtime: MTIME,
  files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, b64(data)])),
  sidecars: SIDECARS,
  packaged: { sha256: sha256(executiveBytes), sidecarSha256: sha256(readFileSync(join(packaged, 'mixdog-executive.pptx.mixdog.json'))), editSha256: sha256(readFileSync(join(packaged, 'mixdog-executive.mixdog-edit.pptx'))) },
  inspections: scrub(inspections),
  coverage: { filled: coverage, empty: emptyCoverage },
  indexRuns: scrub(indexRuns),
  indexFile: scrub(indexFile),
  single: { file: b64(drawnDeck), run: scrub(singleRun) },
  induced,
  annotated: { raw: rawDocuments, annotated },
  realSnapshots,
  selections,
  blocked: scrub(blocked),
  selects,
  fills,
  lowDocuments,
  expansions,
  goneSnapshot: scrub(goneSnapshot),
};
rmSync(join(root, 'selected'), { recursive: true, force: true });
process.chdir(path.dirname(root));
rmSync(root, { recursive: true, force: true });
writeJson(join(stage, 'golden.json'), out);
writeSetManifest(stage, { set: 'office-templates', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log('office-templates golden written');
