#!/usr/bin/env node
// Golden of the office PDF writer (crate mixdog-office-pdf: writer). Node (src/runtime/office/pdf/pdf-writer.mjs over
// pdf-lib) runs the block lists of the office PDF runtime test (a report with every block type, long tables, long
// prose with headings and lists that must keep together at a page edge, charts, forms, pictures, a page set up by the
// properties, an embedded face) and the chart inputs of the docx add_chart path (createChartPdf), and records what Rust
// must equal:
//   - the result JSON of createPdf / createChartPdf (the path is replaced by the file name, the font file by <font>);
//   - per page of the written file, its size and the text items the PDF reader finds with their positions
//     (text, x, top, width, height), which is the layout the writer decided;
//   - for the cases with fields, the field descriptions of the written file (describeFormField of every field);
//   - the refusals, with the texts Node gives.
// The spec of every case is stored in the golden, so the test replays exactly what was recorded; a picture is stored as
// base64 and written beside the output. Positions are compared within 1e-3 pt, the rest exactly.
//
//   node benchmarks/rust-core/recorders/record-office-writer.mjs --tree <product tree> [--fixtures <fixtures dir>]
//
// --fixtures names the folder that holds office-measure/faces (the embedded-face case); it defaults to this checkout's.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-writer.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const fixturesRoot = path.resolve(args.get('fixtures') ?? FIXTURES_ROOT);
const writer = await importFrom(tree, 'src/runtime/office/pdf/pdf-writer.mjs');
const analysis = await importFrom(tree, 'src/runtime/office/pdf/pdf-analysis.mjs');
const forms = await importFrom(tree, 'src/runtime/office/pdf/pdf-forms.mjs');
const { PDFDocument } = createRequire(path.join(tree, 'package.json'))('pdf-lib');

const work = mkdtempSync(path.join(tmpdir(), 'mixdog-office-writer-'));

// A small RGBA picture, a gradient with a see-through corner, made without a library.
function picture(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push((x * 255) / width, (y * 255) / height, 128, x === 0 && y === 0 ? 0 : 255);
    rows.push(Buffer.from(row));
  }
  const chunk = (kind, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WORDS = 'revenue growth margin costs budget forecast quarter customers delivery supply review approval schedule risk owner plan'.split(' ');
function sentence(seed, words) {
  return `${Array.from({ length: words }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ')}.`;
}
function prose(seed, sentences) {
  return Array.from({ length: sentences }, (_, i) => sentence(seed + i, 9 + ((seed + i) % 6))).join(' ');
}

const LOGO = picture(60, 40);
const WIDE = picture(300, 120);

const CASES = [];
const add = (name, spec, extra = {}) => CASES.push({ name, spec, ...extra });

add('report', {
  blocks: [
    { type: 'cover', eyebrow: 'Quarterly review', title: 'Sales and delivery report', subtitle: 'Prepared for the board', meta: ['Q3 2026', 'Finance'] },
    { type: 'heading', text: 'Summary' },
    { type: 'paragraph', text: prose(1, 5) },
    { type: 'heading', level: 2, text: 'Highlights' },
    { type: 'list', items: ['Revenue up', 'Costs flat', 'Two launches slipped, both now scheduled for the next quarter without further change'] },
    { type: 'list', ordered: true, items: Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: ${sentence(i, 4)}`) },
    { type: 'heading', level: 3, text: 'Figures' },
    {
      type: 'table',
      headers: ['Region', 'Units', 'Revenue', 'Note'],
      rows: [
        ['North', '1,200', '48,000', 'on plan'],
        ['South', '800', '31,500', 'late'],
        ['East', '2,050', '90,250', ''],
        ['Total', '4,050', '169,750', ''],
      ],
      totalRow: true,
      zebraFill: 'F6F7F9',
    },
    { type: 'caption', text: 'Table 1: units and revenue by region' },
    { type: 'quote', text: prose(3, 2), attribution: '- The CFO' },
    { type: 'callout', label: 'Decision needed', text: prose(5, 2) },
    { type: 'stats', items: [{ value: '42%', label: 'growth in the north' }, { value: '1.2M', label: 'units shipped' }, { value: '98.7', label: 'on-time delivery in percent' }] },
    { type: 'chart', title: 'Revenue by region', categories: ['North', 'South', 'East'], values: [48000, 31500, 90250], highlight: 'East', unit: ' USD' },
    { type: 'chart', chartType: 'column', title: 'Units per quarter', categories: ['Q1', 'Q2', 'Q3', 'Q4'], values: [1.5, 2.25, 3.125, 0], forecast: ['Q4'], highlight: 2 },
    { type: 'rule' },
    { type: 'paragraph', before: 14, text: prose(9, 3), size: 10 },
  ],
  properties: { title: 'Sales report', author: 'Finance', subject: 'Q3', keywords: ['sales', 'q3'], footer: 'Confidential', palette: { accent: '8B1E3F' } },
});

add('prose-paging', {
  blocks: Array.from({ length: 24 }, (_, i) => {
    if (i % 6 === 0) return { type: 'heading', level: (i / 6) % 3 + 1, text: `Section ${i / 6 + 1}: ${sentence(i, 3)}` };
    if (i % 6 === 3) return { type: 'list', items: Array.from({ length: 3 + (i % 5) }, (_, k) => `${sentence(i + k, 6 + k)}`) };
    return { type: 'paragraph', text: prose(i, 3 + (i % 5)) };
  }),
  properties: { footer: 'Paging', pageNumbers: true },
});

add('table-paging', {
  blocks: [
    { type: 'heading', text: 'Weekly log' },
    {
      type: 'table',
      headers: ['Week', 'Owner', 'Hours', 'Comment'],
      rows: Array.from({ length: 61 }, (_, i) => [`W${i + 1}`, ['Ana', 'Bo', 'Chen'][i % 3], String(30 + ((i * 7) % 15)), i % 9 === 0 ? sentence(i, 14) : 'ok']),
    },
    { type: 'caption', text: 'Table 1: the weekly log' },
    { type: 'heading', level: 2, text: 'Totals' },
    { type: 'table', headers: false, rows: [['Hours', '1,914'], ['Weeks', '61']], grid: true, columnWidths: [1, 2] },
    {
      type: 'table',
      headers: ['Code', 'Price', 'Qty'],
      rows: Array.from({ length: 30 }, (_, i) => [`C-${100 + i}`, `${(i + 1) * 12.5}`, String(i + 1)]),
      totalRow: true,
      repeatHeader: false,
      columnAlignments: ['left', 'right', 'center'],
      headerFill: 'DDE6F0',
      headerColor: '112233',
      borderColor: 'AAAAAA',
      fontSize: 10,
      rowHeight: 20,
    },
  ],
});

add('page-setup', {
  blocks: [
    { type: 'heading', text: 'Landscape page' },
    { type: 'paragraph', text: prose(2, 6), x: 100, width: 400 },
    { type: 'paragraph', text: prose(4, 4), before: 20, after: 30, color: '334455', size: 12, lineHeight: 20 },
    { type: 'quote', text: prose(6, 2), accent: 'AA3300', size: 11 },
    { type: 'callout', text: prose(8, 3), fill: 'FFF3CD', padding: 6, label: ' ' },
    { type: 'pagebreak' },
    { type: 'caption', text: 'After a page break' },
  ],
  properties: { pageSize: 'letter', orientation: 'landscape', margin: 36, background: 'F8F8F8', footer: 'Landscape', footerSize: 8, footerColor: '999999' },
});

add('charts', {
  blocks: [
    { type: 'chart', title: 'Across with long names', categories: ['A very long category name that must wrap inside the names column', 'Short', 'Medium length name'], values: [10, 250.456, 1234567.891], unit: '%' },
    { type: 'chart', chartType: 'bar', categories: ['a', 'b', 'c'], values: [0, 0, 0] },
    { type: 'chart', chartType: 'column', categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], values: [120, 90, 140, 170, 210, 190], height: 120, highlight: 'May', forecast: [4, 'Jun'] },
    { type: 'chart', chartType: 'COLUMN', categories: ['One', 'Two'], values: [5, 7], accent: '117744', size: 11, x: 80, width: 300 },
    { type: 'caption', text: 'Figure 1' },
    { type: 'heading', text: 'Chart under a heading' },
    { type: 'chart', title: 'Titled', categories: ['x'], values: [3] },
  ],
});

add('forms', {
  blocks: [
    { type: 'heading', text: 'Approval form' },
    { type: 'paragraph', text: prose(1, 2) },
    { type: 'field', name: 'full_name', label: 'Full name', value: 'Ada Lovelace' },
    {
      type: 'fieldRow',
      items: [
        { name: 'dept', label: 'Department', fieldType: 'dropdown', options: ['Sales', 'Finance', 'Ops'], value: 'Finance' },
        { name: 'date', label: 'Date', width: 90 },
      ],
      gutter: 20,
    },
    { type: 'fieldrow', items: [{ name: 'agree', type: 'checkbox', label: 'I agree', value: true }, { name: 'later', type: 'checkbox', label: 'Decide later' }] },
    { type: 'fieldRow', items: [{ name: 'size', type: 'radio', label: 'Size', options: [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, 'Large'], value: 'm' }] },
    { type: 'field', name: 'notes', label: 'Notes', multiline: true, height: 60, maxLength: 200 },
    { type: 'caption', text: 'Fields flow with the copy.' },
    ...Array.from({ length: 14 }, (_, i) => ({ type: 'field', name: `extra_${i}`, label: `Extra ${i + 1}` })),
  ],
  fields: [{ name: 'stamp', type: 'text', page: 1, x: 400, y: 40, width: 120, height: 20, value: 'APPROVED' }],
  properties: { footer: 'Form' },
});

add('images', {
  blocks: [
    { type: 'heading', text: 'Pictures' },
    { type: 'image', path: 'logo.png' },
    { type: 'caption', text: 'The logo at its own size' },
    { type: 'image', path: 'wide.png', width: 400, align: 'center' },
    { type: 'image', path: 'logo.png', width: 120, height: 60, align: 'right', after: 30 },
    { type: 'image', path: 'wide.png', x: 60, y: 300, width: 100 },
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'image', path: 'wide.png', width: 300 + i })),
    { type: 'heading', text: 'The last picture' },
    { type: 'image', path: 'wide.png', width: 500 },
    { type: 'caption', text: 'Travels with its heading' },
  ],
}, { images: { 'logo.png': LOGO.toString('base64'), 'wide.png': WIDE.toString('base64') } });

add('embedded-face', {
  blocks: [
    { type: 'heading', text: 'Embedded face' },
    { type: 'paragraph', text: prose(11, 4) },
    { type: 'table', headers: ['Item', 'Amount'], rows: [['Pens', '1,200'], ['Ink', '300']] },
    { type: 'field', name: 'who', label: 'Name', value: 'Ada' },
  ],
  properties: { fontPath: '<fixtures>/office-measure/faces/MiriamLibre-Regular.otf' },
});

const FAULTS = [
  { name: 'unknown-type', blocks: [{ type: 'pie' }] },
  { name: 'kind-for-type', blocks: [{ kind: 'table', rows: [] }] },
  { name: 'unknown-field', blocks: [{ type: 'paragraph', text: 'x', colour: 'red' }] },
  { name: 'missing-rows', blocks: [{ type: 'table' }] },
  { name: 'several', blocks: [{ type: 'list', items: 'a' }, { type: 'stats', items: [1] }, { type: 'cover', title: 't', meta: 'm' }, { type: 'table', rows: 5 }] },
  { name: 'chart-shape', blocks: [{ type: 'chart', categories: 'a', values: [-1] }, { type: 'chart', categories: ['a'], values: [1, 2], chartType: 'pie' }] },
  { name: 'chart-forecast', blocks: [{ type: 'chart', categories: ['Q1', 'Q2'], values: [1, 2], forecast: ['Q9', 7] }] },
  { name: 'not-an-object', blocks: [5, null, ['a']] },
  { name: 'bad-colour', blocks: [{ type: 'paragraph', text: 'x', color: 'zzz' }] },
  { name: 'bad-palette', blocks: [], properties: { palette: { accent: 'red', tint: '112233' } } },
  { name: 'palette-not-object', blocks: [], properties: { palette: 'x' } },
  { name: 'page-size', blocks: [], properties: { pageSize: 'b5' } },
  { name: 'unnamed-field', blocks: [], fields: [{ x: 10, y: 10, width: 50, height: 20 }] },
  { name: 'not-an-image', blocks: [{ type: 'image', path: 'notes.txt' }], files: { 'notes.txt': Buffer.from('plain text').toString('base64') } },
];
for (const fault of FAULTS) {
  const { name, ...spec } = fault;
  const { files, ...rest } = spec;
  add(`fault-${name}`, rest, files ? { files } : {});
}

const CHARTS = [
  { name: 'across', block: { categories: ['North', 'South', 'East'], values: [48000, 31500, 90250], title: 'Revenue', unit: ' USD', highlight: 'East' } },
  { name: 'column-forecast', block: { chartType: 'column', categories: ['Q1', 'Q2', 'Q3'], values: [3, 5.5, 4], forecast: 'Q3', height: 110 }, options: { width: 320 } },
  { name: 'palette', block: { categories: ['a', 'bb'], values: [1, 2], accent: '117744' }, options: { width: 300, palette: { line: 'AAAAAA', muted: '555555' } } },
  { name: 'refused', block: { categories: ['a'], values: [1, 2] } },
];

const attempt = async (run) => {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const substitute = (value, root) => JSON.parse(JSON.stringify(value).replaceAll('<fixtures>', root.replaceAll('\\', '/')));

async function layoutOf(file) {
  const layout = await analysis.extractPdfTextLayout(file, { shapes: false });
  return layout.pages.map((page) => ({
    width: page.width,
    height: page.height,
    items: page.items.map((item) => ({ text: item.text, x: item.x, top: item.top, width: item.width, height: item.height })),
  }));
}

async function fieldsOf(file) {
  const document = await PDFDocument.load(readFileSync(file));
  return document.getForm().getFields().map((field, index) => forms.describeFormField(field, document, index));
}

const normalise = (result, file) => {
  const copy = JSON.parse(JSON.stringify(result));
  if (copy.path === file) copy.path = 'out.pdf';
  if (copy.font?.path) copy.font.path = '<font>';
  return copy;
};

const out = { note: 'Node (pdf-writer.mjs over pdf-lib) writer; see the recorder header.', cases: [], charts: [] };

for (const entry of CASES) {
  const folder = mkdtempSync(path.join(work, 'case-'));
  for (const [name, data] of Object.entries(entry.images ?? {})) writeFileSync(path.join(folder, name), Buffer.from(data, 'base64'));
  for (const [name, data] of Object.entries(entry.files ?? {})) writeFileSync(path.join(folder, name), Buffer.from(data, 'base64'));
  const file = path.join(folder, 'out.pdf');
  const spec = substitute(entry.spec, fixturesRoot);
  const ran = await attempt(() => writer.createPdf(file, spec));
  const record = { name: entry.name, spec: entry.spec };
  if (entry.images) record.images = entry.images;
  if (entry.files) record.files = entry.files;
  if (ran.error) record.error = ran.error.replaceAll(folder, '<out>').replaceAll(folder.replaceAll('\\', '/'), '<out>').replaceAll(String.fromCharCode(92), '/');
  else {
    record.result = normalise(ran.value, file);
    record.pages = await layoutOf(file);
    if (ran.value.form?.fields?.length) record.fields = await fieldsOf(file);
  }
  out.cases.push(record);
}

for (const entry of CHARTS) {
  const folder = mkdtempSync(path.join(work, 'chart-'));
  const file = path.join(folder, 'chart.pdf');
  const ran = await attempt(() => writer.createChartPdf(file, entry.block, entry.options ?? {}));
  const record = { name: entry.name, block: entry.block, options: entry.options ?? null };
  if (ran.error) record.error = ran.error;
  else {
    record.result = normalise(ran.value, file);
    record.pages = await layoutOf(file);
  }
  out.charts.push(record);
}

rmSync(work, { recursive: true, force: true });
const fixtures = path.join(FIXTURES_ROOT, 'office-writer');
mkdirSync(fixtures, { recursive: true });
const data = `${JSON.stringify(out, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value))}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-writer', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases, ${out.charts.length} chart cases`);
