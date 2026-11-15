#!/usr/bin/env node
// What the portable pptx shape operations answer (src/runtime/office/portable/portable-pptx-shapes.mjs: text boxes and shapes,
// text, tables and table cells, pictures and media, text fitting, grouping, z-order, alignment, hyperlinks, animations),
// run through Node on decks. Rust `mixdog-ooxml` must answer the same: the JSON each operation returns (or the error it
// throws) and the text of every part of the deck afterwards (crates/mixdog-ooxml/tests/twin_pptx_shapes.rs).
//
// The same font files are registered on both sides for `fit_text`: the three small OFL faces kept beside the office-measure
// recording (native/core/fixtures/office-measure/faces) under names no installed font has.
//
//   node benchmarks/rust-core/recorders/record-office-pptx-shapes.mjs --tree <dir with node_modules> [--faces <dir>]
//
// `--faces` names the folder of the faces when this checkout does not hold native/core/fixtures/office-measure.
// Output: native/core/fixtures/office-pptx-shapes/golden.json. The recording holds `faces` and `sequences` (steps over one
// deck: each step's output, then the deck's part names and the text of every part).
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-pptx-shapes');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-pptx-shapes.mjs';
const { GlobalFonts } = createRequire(join(tree, 'package.json'))('@napi-rs/canvas');

const FACES = args.has('faces') ? resolve(args.get('faces')) : join(FIXTURES_ROOT, 'office-measure', 'faces');
const FIXTURE_FACES = {
  'Twin Lisu': [
    { file: 'NotoSansLisu-Regular.ttf', weight: 400 },
    { file: 'NotoSansLisu-Bold.ttf', weight: 700 },
  ],
  'Twin Hebrew': [{ file: 'NotoSansHebrew-Regular.ttf', weight: 400 }],
  'Twin Miriam': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
  'Liberation Sans': [{ file: 'MiriamLibre-Regular.otf', weight: 400 }],
};
for (const [alias, list] of Object.entries(FIXTURE_FACES)) for (const { file } of list) GlobalFonts.registerFromPath(join(FACES, file), alias);

const portable = (name) => importFrom(tree, `src/runtime/office/portable/${name}.mjs`);
const shapes = await portable('portable-slide-shapes');
const ops = await portable('portable-pptx-shapes');
const deck = await portable('portable-pptx-package');
const opc = await portable('portable-opc');
const pkg = await portable('portable-package');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-pptx-shapes-'));
const scrub = (text) => String(text).split(work).join('<work>');
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: scrub(error?.message ?? error) };
  }
};
const b64 = (list) => Buffer.from(list).toString('base64');
// A PNG header with the size given: all the size reader looks at.
const png = (width, height) => {
  const word = (value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  return b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...word(width), ...word(height), 8, 6, 0, 0, 0]);
};
const PNG_WIDE = png(400, 100);
const PNG_TALL = png(100, 400);
const PNG_SQUARE = png(200, 200);
const MEDIA = b64([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3]);

const SLIDE_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slideWith = (items, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${SLIDE_NS}><p:cSld>${extra}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${items.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const textShape = (id, name, left, top, width, height, paragraphs, extra = {}) =>
  shapes.shapeXml({
    id,
    name,
    left,
    top,
    width,
    height,
    textBox: extra.textBox ?? true,
    properties: extra.properties,
    textBody: shapes.textBodyXml({ paragraphs, anchor: extra.anchor, margins: extra.margins }),
  });
const title = textShape(2, 'Title', 40, 30, 880, 60, [{ text: 'Quarterly 매출 & results', fontSize: 32, bold: true, color: '#112233', fontName: 'Calibri' }], { anchor: 'middle' });
const card = shapes.shapeXml({
  id: 3,
  name: 'Card',
  geometry: 'rounded_rectangle',
  left: 40,
  top: 120,
  width: 400,
  height: 200,
  properties: { fillColor: '0A1B2C', lineColor: 'ffffff', lineWidth: 2 },
  textBody: shapes.textBodyXml({ paragraphs: [{ text: 'Revenue', fontSize: 24, color: 'FFFFFF' }, { text: '1,420', fontSize: 40, bold: true, color: 'FFFFFF' }, { text: 'up 12%', fontSize: 14, color: 'FFFFFF' }], anchor: 'center' }),
});
const wash = textShape(4, 'Wash', 500, 140, 200, 80, [{ text: ' padded text ', fontSize: 14, color: '000000' }], { properties: { fillColor: 'FF0000', fillTransparency: 50 } });
const note = textShape(5, 'Note', 720, 140, 180, 60, [{ text: 'Linked', fontSize: 14 }]);
const table = shapes.tableXml({
  id: 6,
  name: 'Table',
  values: [['Region', 'Sales', 'Share'], ['North', '1,420', '34%'], ['South', '−12', '8.4%']],
  left: 40,
  top: 340,
  width: 600,
  height: 120,
  properties: { columnWidths: [200, 200, 200], headerFillColor: '#223344', headerColor: 'FFFFFF', fontSize: 12 },
});
const pictureOf = (id, left, top, width, height, embedId) => shapes.pictureXml({ id, embedId, left, top, width, height, crop: { left: 0.1, right: 0.1 }, altText: 'A "logo"' });

const dispatch = {
  set_hyperlink: ops.handleSetHyperlink,
  z_order: ops.handleZOrder,
  align_shapes: ops.handleAlignShapesOrDistributeShapes,
  distribute_shapes: ops.handleAlignShapesOrDistributeShapes,
  set_text: ops.handleSetText,
  add_textbox: ops.handleAddTextboxOrAddShape,
  add_shape: ops.handleAddTextboxOrAddShape,
  delete_shape: ops.handleDeleteShape,
  add_table: ops.handleAddTable,
  add_image: ops.handleAddImage,
  fit_text: ops.handleFitText,
  set_table_cell_style: ops.handleSetTableCellStyle,
  set_table_data: ops.handleSetTableDataOrReplaceImage,
  replace_image: ops.handleSetTableDataOrReplaceImage,
  group_shapes: ops.handleGroupShapesOrUngroupShape,
  ungroup_shape: ops.handleGroupShapesOrUngroupShape,
  add_media: ops.handleAddMedia,
  crop_image: ops.handleCropImage,
  add_animation: ops.handleAddAnimation,
  set_shape: ops.handleSetShape,
};

// A file name written "@name" in an operation is a file of the work directory.
const placed = (operation) => {
  const resolved = { ...operation };
  for (const key of ['path', 'poster']) if (typeof resolved[key] === 'string' && resolved[key].startsWith('@')) resolved[key] = join(work, resolved[key].slice(1));
  return resolved;
};

const runStep = async (state, step) => {
  switch (step.op) {
    case 'create': {
      const path = join(work, 'created.pptx');
      await pkg.createPortableOoxmlDocument(path, { fileKind: 'pptx', title: step.title });
      state.zip = await opc.loadPackage(path);
      return null;
    }
    case 'addSlide':
      return await deck.addPresentationSlide(state.zip, step.operation ?? {});
    case 'set':
      state.zip.file(step.name, step.text);
      return null;
    case 'file':
      writeFileSync(join(work, step.name), Buffer.from(step.base64, 'base64'));
      return null;
    case 'run': {
      const operation = placed(step.operation);
      const context = { zip: state.zip, slides: await deck.presentationSlides(state.zip) };
      return await dispatch[operation.op](context, operation);
    }
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};

const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const parts = {};
  for (const name of names) if (!zip.files[name].dir) parts[name] = await opc.zipText(zip, name);
  return { names, parts };
};

const SEQUENCES = [];
const sequence = (name, steps) => SEQUENCES.push({ name, steps });
const start = (items, extra) => [
  { op: 'create', title: 'Shapes' },
  { op: 'addSlide', operation: {} },
  { op: 'set', name: 'ppt/slides/slide1.xml', text: slideWith(items, extra) },
];
const run = (operation) => ({ op: 'run', operation });

sequence('text boxes, shapes and tables added', [
  ...start([]),
  run({ op: 'add_textbox', slide: 1, text: 'Plain' }),
  run({ op: 'add_textbox', slide: 1, left: 40, top: 100, width: 300, height: 50, text: 'Right & bottom <b>', fontSize: 20, color: '#336699', fontName: 'Calibri', properties: { alignment: 'right', verticalAlignment: 'bottom', bold: true, italic: true, autofit: 'shrink', marginLeft: 4, marginTop: 2, paragraphSpacing: 6 } }),
  run({ op: 'add_textbox', slide: 1, name: '  Named  ', paragraphs: [{ text: 'First', bullet: true }, { text: 'Second', level: 1, fontSize: 12 }, { text: '' }], properties: { left: 10, top: 10, width: 100, height: 30, autofit: 'resize', anchor: 'middle' } }),
  run({ op: 'add_shape', slide: 1, shapeType: 'Rounded Rectangle', text: 'Dark card', fillColor: '#0A1B2C', lineColor: 'FFFFFF', properties: { lineWidth: 3, shadow: true, altText: 'A card' } }),
  run({ op: 'add_shape', slide: 1, shapeType: 'oval', text: 'Light', fillColor: 'F5F5F5', left: 300, top: 300, width: 80, height: 80 }),
  run({ op: 'add_shape', slide: 1, shapeType: 'circle', text: 'Theme', properties: { fillColor: 'abc', fillTransparency: 40, rotation: 15 } }),
  run({ op: 'add_shape', slide: 1, shapeType: 'star', fillColor: null, lineColor: null, color: '112233' }),
  run({ op: 'add_shape', slide: 1, shapeType: 'blob', text: 'x' }),
  run({ op: 'add_shape', slide: 1 }),
  run({ op: 'add_textbox', slide: 1, properties: 'text', text: null }),
  run({ op: 'add_textbox', slide: 9, text: 'nowhere' }),
  run({ op: 'add_textbox', text: 'no slide' }),
  run({ op: 'add_table', slide: 1, values: [['A', 'B'], ['1', '2']] }),
  run({ op: 'add_table', slide: 1, values: [['Name', 'Qty', 'Price'], ['Bolt', '12', '0.40'], ['Nut', '1,200', '0.10']], left: 40, top: 400, width: 500, height: 90, properties: { fontSize: 11, headerFillColor: '223344', columnWidths: [200, 150, 150], align: 'center' } }),
  run({ op: 'add_table', slide: 1, values: [] }),
  run({ op: 'add_table', slide: 1 }),
  run({ op: 'add_table', slide: 2, values: [['x']] }),
]);

sequence('shapes edited, ordered, aligned and grouped', [
  ...start([title, card, wash, note, table]),
  run({ op: 'set_shape', slide: 1, shape: 3, properties: { left: 100, top: 150, width: 220, height: 90, fillColor: '00AA55', fillTransparency: 20, lineColor: '112233', lineWidth: 1.5, altText: 'Tinted', alignment: 'center', verticalAlignment: 'top', fontSize: 16, bold: true, italic: false, color: '#FFFFFF', fontName: 'Georgia', shadow: true, paragraphSpacing: 4, marginLeft: 3 } }),
  run({ op: 'set_shape', slide: 1, shape: 2, properties: { lineWidth: 2 } }),
  run({ op: 'set_shape', slide: 1, shape: 4 }),
  run({ op: 'set_shape', slide: 1, shape: 40, properties: {} }),
  run({ op: 'set_text', slide: 1, shape: 2, text: 'Revenue & <more>' }),
  run({ op: 'set_text', slide: 1, shape: 1, text: '' }),
  run({ op: 'set_text', slide: 1, shape: 1 }),
  run({ op: 'set_text', slide: 1, shape: 5, text: 'No text here' }),
  run({ op: 'set_text', slide: 1, shape: 0, text: 'x' }),
  run({ op: 'z_order', slide: 1, shape: 1, command: 'front' }),
  run({ op: 'z_order', slide: 1, shape: 1, command: 'Forward' }),
  run({ op: 'z_order', slide: 1, shape: 3, command: 'backward' }),
  run({ op: 'z_order', slide: 1, shape: 5, command: 'back' }),
  run({ op: 'z_order', slide: 1, shape: 2, command: 'sideways' }),
  run({ op: 'z_order', slide: 1, shape: 9, command: 'front' }),
  run({ op: 'z_order', slide: 1, command: 'front' }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 2, 3], align: 'left' }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 2], align: 'center' }),
  run({ op: 'align_shapes', slide: 1, shapes: [2, 3], align: 'right', relativeToSlide: true }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 3], align: 'top' }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 3], align: 'Middle', relativeToSlide: true }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 3], align: 'bottom' }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 3], align: 'diagonal' }),
  run({ op: 'align_shapes', slide: 1, shapes: [1], align: 'left' }),
  run({ op: 'align_shapes', slide: 1, align: 'left' }),
  run({ op: 'align_shapes', slide: 1, shapes: [1, 9], align: 'left' }),
  run({ op: 'distribute_shapes', slide: 1, shapes: [1, 2, 3], direction: 'horizontal' }),
  run({ op: 'distribute_shapes', slide: 1, shapes: [1, 2, 3, 4], direction: 'vertical', relativeToSlide: true }),
  run({ op: 'distribute_shapes', slide: 1, shapes: [1, 2], direction: 'diagonal' }),
  run({ op: 'distribute_shapes', slide: 1, shapes: [3, 4], direction: 'Horizontal' }),
  run({ op: 'group_shapes', slide: 1, shapes: [2, 1, 2] }),
  run({ op: 'group_shapes', slide: 1, shapes: [1] }),
  run({ op: 'group_shapes', slide: 1, shapes: [1, 99] }),
  run({ op: 'group_shapes', slide: 1, shapes: ['x', 1] }),
  run({ op: 'ungroup_shape', slide: 1, shape: 4 }),
  run({ op: 'group_shapes', slide: 1, shapes: [1, 5] }),
  run({ op: 'ungroup_shape', slide: 1, shape: 1 }),
  run({ op: 'ungroup_shape', slide: 1, shape: 2 }),
  run({ op: 'ungroup_shape', slide: 1, shape: 9 }),
  run({ op: 'delete_shape', slide: 1, shape: 2 }),
  run({ op: 'delete_shape', slide: 1, shape: 20 }),
  run({ op: 'delete_shape', slide: 3, shape: 1 }),
]);

sequence('hyperlinks and animations', [
  ...start([title, card, note]),
  run({ op: 'set_hyperlink', slide: 1, shape: 3, address: ' https://example.com/a?b=1&c=2 ' }),
  run({ op: 'set_hyperlink', slide: 1, shape: 3, address: 'mailto:a@b.c' }),
  run({ op: 'set_hyperlink', slide: 1, shape: 2, subAddress: '#slide2' }),
  run({ op: 'set_hyperlink', slide: 1, shape: 1, address: 'https://x.y', subAddress: 'z' }),
  run({ op: 'set_hyperlink', slide: 1, shape: 1 }),
  run({ op: 'set_hyperlink', slide: 1, shape: 7, address: 'https://x.y' }),
  run({ op: 'add_animation', slide: 1, shape: 1 }),
  run({ op: 'add_animation', slide: 1, shape: 2, effect: 'Wipe', trigger: 'with_previous', duration: 1.5, delay: 0.25 }),
  run({ op: 'add_animation', slide: 1, shape: 3, effect: 'appear', trigger: 'after previous' }),
  run({ op: 'add_animation', slide: 1, shape: 1, effect: 'zoom', trigger: 'on_click', duration: 0 }),
  run({ op: 'add_animation', slide: 1, shape: 2, effect: 'fly' }),
  run({ op: 'add_animation', slide: 1, shape: 3, effect: 'float', trigger: 'withPrevious', duration: '2', delay: -1 }),
  run({ op: 'add_animation', slide: 1, shape: 1, effect: 'spin' }),
  run({ op: 'add_animation', slide: 1, shape: 1, trigger: 'sometimes' }),
  run({ op: 'add_animation', slide: 1, shape: 9 }),
]);

sequence('animations on slides the deck did not write', [
  ...start([note]),
  { op: 'set', name: 'ppt/slides/slide1.xml', text: slideWith([note]).replace('</p:sld>', '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"><p:childTnLst/></p:cTn></p:par></p:tnLst></p:timing></p:sld>') },
  run({ op: 'add_animation', slide: 1, shape: 1 }),
  { op: 'set', name: 'ppt/slides/slide1.xml', text: slideWith([note.replace('<p:cNvPr id="5"', '<p:cNvPr id="0"')]) },
  run({ op: 'add_animation', slide: 1, shape: 1 }),
]);

sequence('tables refilled and restyled', [
  ...start([title, table, card]),
  run({ op: 'set_table_data', slide: 1, shape: 2, values: [['Region', 'Sales', 'Share'], ['North', '1,500', '35%'], ['South', '−20', '9%']] }),
  run({ op: 'set_table_data', slide: 1, shape: 2, values: [['Region', 'Sales', 'Share', 'Rank'], ['North', '1', '2', '3'], ['South', '4', '5', '6'], ['East', '7', '8', '9'], ['West']] }),
  run({ op: 'set_table_data', slide: 1, shape: 2, values: [] }),
  run({ op: 'set_table_data', slide: 1, shape: 2, values: 'nope' }),
  run({ op: 'set_table_data', slide: 1, shape: 3, values: [['x']] }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 1, col: 1, properties: { fillColor: '#FFEECC', verticalAlignment: 'top', horizontalAlignment: 'right', fontSize: 14, bold: true, color: '112233', fontName: 'Georgia' } }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 2, col: 2, properties: { fillColor: null } }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 2, col: 3, properties: { alignment: 'center', italic: true } }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 3, col: 1, properties: { verticalAlignment: 'bottom' } }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 2, col: 1 }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 9, col: 1, properties: {} }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, row: 1, col: 9, properties: {} }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 3, row: 1, col: 1, properties: {} }),
  run({ op: 'set_table_cell_style', slide: 1, shape: 2, properties: {} }),
  run({ op: 'set_table_data', slide: 1, shape: 2, values: [['Only', 'One'], 'skipped'] }),
]);

sequence('pictures added, cropped and replaced', [
  ...start([title]),
  { op: 'file', name: 'wide.png', base64: PNG_WIDE },
  { op: 'file', name: 'tall.png', base64: PNG_TALL },
  { op: 'file', name: 'square.png', base64: PNG_SQUARE },
  { op: 'file', name: 'noted.txt', base64: PNG_SQUARE },
  { op: 'file', name: 'opaque.webp', base64: 'AAEC' },
  run({ op: 'add_image', slide: 1, path: '@wide.png' }),
  run({ op: 'add_image', slide: 1, path: '@wide.png', left: 10, top: 20, width: 100, height: 100, fit: 'contain', altText: 'Wide "one"' }),
  run({ op: 'add_image', slide: 1, path: '@wide.png', left: 10, top: 20, width: 100, height: 100, fit: 'Cover', focusX: 0.2 }),
  run({ op: 'add_image', slide: 1, path: '@tall.png', width: 100, height: 100, fit: 'cover', focusY: 1 }),
  run({ op: 'add_image', slide: 1, path: '@square.png', fit: 'stretch' }),
  run({ op: 'add_image', slide: 1, path: '@tall.png', fit: 'tile' }),
  run({ op: 'add_image', slide: 1, path: '@opaque.webp', fit: 'cover' }),
  run({ op: 'add_image', slide: 1, path: '@opaque.webp' }),
  run({ op: 'add_image', slide: 1, path: '@noted.txt' }),
  run({ op: 'add_image', slide: 1, path: '@missing.png' }),
  run({ op: 'add_image', slide: 1 }),
  run({ op: 'add_image', slide: 5, path: '@wide.png' }),
  run({ op: 'crop_image', slide: 1, shape: 2, left: 10, top: 5.5, right: 120, bottom: -4 }),
  run({ op: 'crop_image', slide: 1, shape: 2 }),
  run({ op: 'crop_image', slide: 1, shape: 1, left: 10 }),
  run({ op: 'replace_image', slide: 1, shape: 2, path: '@wide.png' }),
  run({ op: 'replace_image', slide: 1, shape: 2, path: '@tall.png', altText: ' New <description> ' }),
  run({ op: 'replace_image', slide: 1, shape: 3, path: '@square.png' }),
  run({ op: 'replace_image', slide: 1, shape: 4, path: '@opaque.webp' }),
  run({ op: 'replace_image', slide: 1, shape: 4, path: '@noted.txt' }),
  run({ op: 'replace_image', slide: 1, shape: 4, path: '@missing.png' }),
  run({ op: 'replace_image', slide: 1, shape: 1, path: '@wide.png' }),
  run({ op: 'replace_image', slide: 1, shape: 2 }),
]);

sequence('pictures replaced in a frame', [
  ...start([title]),
  { op: 'file', name: 'wide.png', base64: PNG_WIDE },
  { op: 'file', name: 'square.png', base64: PNG_SQUARE },
  run({ op: 'add_image', slide: 1, path: '@square.png', left: 50, top: 50, width: 200, height: 100, fit: 'stretch' }),
  run({ op: 'replace_image', slide: 1, shape: 2, path: '@wide.png', altText: 'Described' }),
  run({ op: 'replace_image', slide: 1, shape: 2, path: '@square.png' }),
  run({ op: 'replace_image', slide: 1, shape: 2, path: '@wide.png' }),
]);

sequence('media added', [
  ...start([title]),
  { op: 'file', name: 'clip.mp4', base64: MEDIA },
  { op: 'file', name: 'song.MP3', base64: MEDIA },
  { op: 'file', name: 'poster.png', base64: PNG_WIDE },
  { op: 'file', name: 'clip.xyz', base64: MEDIA },
  { op: 'file', name: 'noext', base64: MEDIA },
  run({ op: 'add_media', slide: 1, path: '@clip.mp4', poster: '@poster.png' }),
  run({ op: 'add_media', slide: 1, path: '@clip.mp4', poster: '@poster.png', left: 10, top: 20, width: 200, height: 100, altText: 'A "clip"' }),
  run({ op: 'add_media', slide: 1, kind: 'Audio', path: '@song.MP3', poster: '@poster.png' }),
  run({ op: 'add_media', slide: 1, path: '@clip.xyz', poster: '@poster.png' }),
  run({ op: 'add_media', slide: 1, path: '@noext', poster: '@poster.png' }),
  run({ op: 'add_media', slide: 1, path: '@clip.mp4' }),
  run({ op: 'add_media', slide: 1, kind: 'image', path: '@clip.mp4', poster: '@poster.png' }),
  run({ op: 'add_media', slide: 1, path: '@gone.mp4', poster: '@poster.png' }),
  run({ op: 'add_media', slide: 1, path: '@clip.mp4', poster: '@gone.png' }),
  run({ op: 'add_media', slide: 1, poster: '@poster.png' }),
]);

const fitted = (id, name, left, top, width, height, paragraphs, fontName = 'Twin Miriam') =>
  textShape(id, name, left, top, width, height, paragraphs.map((paragraph) => ({ fontName, ...paragraph })));
const LONG = 'The quick brown fox jumps over the lazy dog and keeps running through the whole field.';
const bareShape = (id, body) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Bare ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody>${body}</p:txBody></p:sp>`;
sequence('text fitted to its box', [
  ...start([
    fitted(2, 'Fits', 40, 40, 400, 120, [{ text: 'Short', fontSize: 24 }]),
    fitted(3, 'Long', 40, 200, 220, 100, [{ text: LONG, fontSize: 36 }]),
    fitted(4, 'Two', 300, 200, 260, 120, [{ text: 'Headline here', fontSize: 40, bold: true }, { text: LONG, fontSize: 20 }], 'Twin Lisu'),
    fitted(5, 'Hopeless', 40, 340, 80, 30, [{ text: LONG, fontSize: 30 }]),
    fitted(6, 'Past the edge', 800, 400, 400, 300, [{ text: LONG, fontSize: 28 }]),
    fitted(7, 'Edge fits', 700, 450, 500, 200, [{ text: 'Short', fontSize: 20 }]),
    `<p:sp><p:nvSpPr><p:cNvPr id="8" name="Runs"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="508000" y="4318000"/><a:ext cx="3556000" cy="1016000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/><a:p><a:pPr><a:lnSpc><a:spcPct val="90000"/></a:lnSpc></a:pPr><a:r><a:rPr lang="en-US" sz="4000"><a:latin typeface="Twin Miriam"/></a:rPr><a:t>1,420</a:t></a:r><a:r><a:rPr lang="en-US" sz="1600"><a:latin typeface="Twin Miriam"/></a:rPr><a:t> units sold in the quarter across every region we cover</a:t></a:r><a:br/><a:r><a:rPr lang="en-US" sz="1400" b="1"><a:latin typeface="Twin Miriam"/></a:rPr><a:t>second line</a:t></a:r></a:p></p:txBody></p:sp>`,
    bareShape(9, '<a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>No size</a:t></a:r></a:p>'),
    bareShape(10, '<a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>No size stated</a:t></a:r></a:p>'),
    card,
  ]),
  run({ op: 'fit_text', slide: 1, shape: 1 }),
  run({ op: 'fit_text', slide: 1, shape: 2 }),
  run({ op: 'fit_text', slide: 1, shape: 3 }),
  run({ op: 'fit_text', slide: 1, shape: 3, minFontSize: 12 }),
  run({ op: 'fit_text', slide: 1, shape: 4 }),
  run({ op: 'fit_text', slide: 1, shape: 5 }),
  run({ op: 'fit_text', slide: 1, shape: 6 }),
  run({ op: 'fit_text', slide: 1, shape: 7 }),
  run({ op: 'fit_text', slide: 1, shape: 8 }),
  run({ op: 'fit_text', slide: 1, shape: 9 }),
  run({ op: 'fit_text', slide: 1, shape: 10 }),
  run({ op: 'fit_text', slide: 1, shape: 10, minFontSize: '10' }),
  run({ op: 'fit_text', slide: 1, shape: 11 }),
  run({ op: 'fit_text', slide: 2, shape: 1 }),
]);

const sequences = [];
for (const entry of SEQUENCES) {
  const state = { zip: null };
  const outputs = [];
  for (const step of entry.steps) {
    outputs.push(await attempt(() => runStep(state, step)));
  }
  sequences.push({ ...entry, outputs, snapshot: state.zip ? await snapshotOf(state.zip) : null });
}
rmSync(work, { recursive: true, force: true });

const faces = Object.fromEntries(Object.entries(FIXTURE_FACES).map(([alias, list]) => [alias, list.map(({ file, weight }) => ({ file: `faces/${file}`, weight }))]));
writeJson(join(stage, 'golden.json'), { faces, sequences });
writeSetManifest(stage, { set: 'office-pptx-shapes', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
