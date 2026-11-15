#!/usr/bin/env node
// Golden of the office PDF content operations (crate mixdog-office-pdf: content_ops, marks, flatten, batch). The Node
// batches of src/runtime/office/pdf/pdf-batch-content.mjs (add_text, watermark, highlight, add_link, stamp_image,
// fill_form, add_form_field, flatten_form, preview_fields) run through applyPdfBatch over generated PDFs and give the
// result JSON Rust must equal exactly, with a summary of every PDF a batch left behind: the text items of each page as
// the reader lays them out, the boxes and links it paints, the annotations as the file holds them, the placement of the
// images, and the form fields as the inspector describes them. Rust must equal the numbers within 1e-3 pt. The inputs
// are stored in the golden (hex), so a replay needs no Node.
//
// Not recorded: ocr_pages (the engine is a download on first use and needs the network); the text in these documents is
// Latin, so no installed Unicode face enters a result.
//
//   node benchmarks/rust-core/recorders/record-office-content-ops.mjs --tree <product tree>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-content-ops.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const adapter = await importFrom(tree, 'src/runtime/office/pdf/pdf-adapter.mjs');
const analysis = await importFrom(tree, 'src/runtime/office/pdf/pdf-analysis.mjs');
const forms = await importFrom(tree, 'src/runtime/office/pdf/pdf-forms.mjs');
const { applyPdfBatch } = adapter;
const pdfLib = createRequire(path.join(tree, 'package.json'))('pdf-lib');
const { PDFDocument, PDFName, PDFArray, PDFDict, StandardFonts, degrees, decodePDFRawStream } = pdfLib;

const work = mkdtempSync(path.join(tmpdir(), 'record-office-content-ops-'));
const shown = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .split(JSON.stringify(work).slice(1, -1))
      .join('<work>')
      .replace(/\\\\/g, '/')
      .replace(/<work>\/case-\d+/g, '<case>'),
  );

// ---- the generated inputs ------------------------------------------------------------------------------------------

const fixtures = {};
const fixture = async (name, build) => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await build(doc, font);
  fixtures[name] = Buffer.from(await doc.save());
};

await fixture('marks', async (doc) => {
  for (let index = 0; index < 3; index += 1) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Section ${index + 1}`, { x: 40, y: 250, size: 14 });
    if (index === 1) page.drawText('Grand total due: 120 USD. Terms at mix.dog apply.', { x: 40, y: 200, size: 12 });
  }
});
await fixture('long', async (doc) => {
  for (let index = 0; index < 120; index += 1) doc.addPage([200, 100]).drawText(`Page ${index + 1}`, { x: 20, y: 50, size: 12 });
});
await fixture('rotated', async (doc) => {
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([400, 300]);
    page.setMediaBox(100, 50, 400, 300);
    page.drawText('Rotated', { x: 140, y: 250, size: 14 });
    page.setRotation(degrees(rotation));
  }
});
await fixture('reversed', async (doc, font) => {
  for (const angle of [180, 270]) {
    const page = doc.addPage([400, 300]);
    page.setMediaBox(100, 50, 400, 300);
    page.setRotation(degrees(angle));
    page.drawText('Alpha', { x: 140, y: 250, size: 14, font });
    page.drawText('beta', { x: 140 + font.widthOfTextAtSize('Alpha ', 14), y: 250, size: 14, font });
  }
});
await fixture('first-rotated', async (doc) => {
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([400, 300]);
    page.setRotation(degrees(rotation));
    page.drawText('Target second', { x: 40, y: 100, size: 14 });
    page.drawText('Target first', { x: 40, y: 240, size: 14 });
  }
});
await fixture('offset', async (doc) => {
  const page = doc.addPage([400, 300]);
  page.setMediaBox(100, 50, 400, 300);
  page.drawText('Offset', { x: 140, y: 250, size: 14 });
});
await fixture('sheets', async (doc) => {
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([400, 600]);
    page.drawText(`Sheet ${index + 1}`, { x: 40, y: 540, size: 12 });
    if (index === 1) page.setRotation(degrees(90));
  }
});
await fixture('blank', async (doc) => {
  doc.addPage([400, 600]);
});
await fixture('wrapped', async (doc) => {
  const page = doc.addPage([400, 200]);
  page.drawText('confirmed at the October', { x: 20, y: 150, size: 11 });
  page.drawText('planning review this week', { x: 20, y: 130, size: 11 });
});
await fixture('urls', async (doc) => {
  doc.addPage([500, 200]).drawText('See https://mix.dog/terms, then http://example.com. Dates: 2026-09-06 and 2026-10-01.', { x: 20, y: 120, size: 11 });
  doc.addPage([500, 200]).drawText('No links on this page.', { x: 20, y: 120, size: 11 });
});
await fixture('form', async (doc, font) => {
  const form = doc.getForm();
  const first = doc.addPage([612, 792]);
  first.drawText('Application form', { x: 72, y: 720, size: 12, font });
  form.createTextField('name').addToPage(first, { x: 72, y: 600, width: 200, height: 20 });
  form.createCheckBox('agree').addToPage(first, { x: 72, y: 560, width: 12, height: 12 });
  const dropdown = form.createDropdown('colour');
  dropdown.addOptions(['red', 'green', 'blue']);
  dropdown.addToPage(first, { x: 72, y: 520, width: 120, height: 20 });
  const second = doc.addPage([612, 792]);
  second.drawText('Second page', { x: 72, y: 720, size: 12, font });
  form.createTextField('email').addToPage(second, { x: 72, y: 600, width: 200, height: 20 });
});

// A PNG made by hand: `width` x `height` pixels, a gradient, opaque.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const png = (width, height) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = x % 256;
      raw[at + 1] = y % 256;
      raw[at + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
fixtures['logo-small.png'] = png(60, 30);
fixtures['photo-wide.png'] = png(700, 350);
fixtures['logo.svg'] = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#d32f2f"/></svg>',
);

// ---- helpers -------------------------------------------------------------------------------------------------------

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const attempt = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error: { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) } };
  }
};

const numbers = (array) => array.asArray().map((entry) => entry.asNumber());

/** The matrix of every image painted on the page: a content-stream walk of q, Q, cm and Do. */
function imagePlacements(doc, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : contents ? [contents] : [];
  const text = streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const multiply = (m, n) => [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const placements = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === 'q') stack.push(matrix);
    else if (token === 'Q') matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (token === 'cm') matrix = multiply(tokens.slice(at - 6, at).map(Number), matrix);
    else if (token === 'Do') {
      const entry = xobjects?.get(PDFName.of(tokens[at - 1].slice(1)));
      const target = entry && doc.context.lookup(entry);
      if (target?.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image') placements.push(matrix);
    }
  }
  return placements;
}

/** What a PDF left behind looks like: layout, painted boxes and links, annotations, image placements, form fields. */
async function summarize(file) {
  const bytes = readFileSync(file);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  // One analysis call reads at most 100 pages: a longer document is read in runs of that size.
  const layout = { pages: [] };
  for (let from = 1; from <= doc.getPageCount(); from += 100) {
    const run = Array.from({ length: Math.min(100, doc.getPageCount() - from + 1) }, (_, at) => from + at);
    layout.pages.push(...(await analysis.extractPdfTextLayout(bytes, { shapes: true, pages: run })).pages);
  }
  const refs = doc.getPages().map((page) => page.ref.toString());
  const pages = doc.getPages().map((page, index) => {
    const read = layout.pages[index];
    const annotations = (page.node.Annots()?.asArray() ?? []).map((ref) => {
      const annotation = doc.context.lookup(ref);
      if (!(annotation instanceof PDFDict)) return null;
      const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
      const destination = annotation.lookupMaybe(PDFName.of('Dest'), PDFArray);
      return {
        subtype: annotation.get(PDFName.of('Subtype'))?.toString() ?? null,
        rect: numbers(annotation.lookup(PDFName.of('Rect'), PDFArray)),
        uri: action?.get(PDFName.of('URI'))?.decodeText?.() ?? null,
        destinationPage: destination ? refs.indexOf(destination.get(0)?.toString()) + 1 : null,
      };
    });
    return {
      rotation: page.getRotation().angle,
      width: read.width,
      height: read.height,
      items: read.items.map((item) => ({ text: item.text, x: item.x, top: item.top, width: item.width, height: item.height })),
      boxes: read.boxes.map((box) => ({ x: box.x, top: box.top, width: box.width, height: box.height, filled: Boolean(box.filled), stroked: Boolean(box.stroked) })),
      links: read.links.map((link) => ({ x: link.x, top: link.top, width: link.width, height: link.height, url: link.url ?? null, page: link.page ?? null })),
      annotations,
      images: imagePlacements(doc, page),
    };
  });
  const form = doc.getForm();
  return { pages, fields: form.getFields().map((field, index) => forms.describeFormField(field, doc, index)) };
}

const files = (directory) =>
  readdirSync(directory, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => !statSync(path.join(directory, entry)).isDirectory() && /\.pdf$/.test(entry))
    .sort();

let caseNumber = 0;
const caseDirectory = (inputs) => {
  caseNumber += 1;
  const directory = path.join(work, `case-${caseNumber}`);
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(inputs)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), fixtures[source] ?? source);
  }
  return directory;
};

// ---- the batches ---------------------------------------------------------------------------------------------------

const cases = [
  [
    'marks-batch',
    { 'doc.pdf': 'marks' },
    [
      { op: 'highlight', find: 'total due' },
      { op: 'add_link', find: 'mix.dog', url: 'https://mix.dog' },
      { op: 'add_link', find: 'Section 3', toPage: 1 },
      { op: 'add_text', text: '{page} / {pages}', align: 'center', y: 20, size: 9 },
      { op: 'highlight', find: '2 / 3' },
    ],
  ],
  ['highlight-missing', { 'doc.pdf': 'marks' }, [{ op: 'highlight', find: 'nowhere', pages: [1, 3] }]],
  ['highlight-missing-document', { 'doc.pdf': 'marks' }, [{ op: 'add_link', find: 'nowhere', url: 'https://mix.dog' }]],
  [
    'highlight-by-box',
    { 'doc.pdf': 'marks' },
    [
      { op: 'highlight', page: 1, x: 10, y: 20, width: 100, height: 14, color: 'ff0000', opacity: 0.3 },
      { op: 'add_link', page: 2, x: 10, y: 20, width: 100, height: 14, url: 'mailto:a@b.test' },
    ],
  ],
  ['highlight-box-refused', { 'doc.pdf': 'marks' }, [{ op: 'highlight', page: 1, x: 10, y: 20, width: 0, height: 14 }]],
  [
    'long-document',
    { 'doc.pdf': 'long' },
    [
      { op: 'highlight', find: 'Page 120' },
      { op: 'add_link', find: 'Page 7', toPage: 120 },
      { op: 'add_link', find: 'Page 7', wholeWord: true, toPage: 120 },
    ],
  ],
  ['rotated-partial', { 'doc.pdf': 'rotated' }, [{ op: 'highlight', find: 'tated' }, { op: 'add_link', find: 'tated', url: 'https://mix.dog' }]],
  ['reversed-runs', { 'doc.pdf': 'reversed' }, [{ op: 'highlight', find: 'pha beta' }, { op: 'add_link', find: 'pha beta', toPage: 1 }]],
  ['first-match', { 'doc.pdf': 'first-rotated' }, [0, 1, 2, 3].map((index) => ({ op: 'highlight', page: index + 1, find: 'Target', first: true }))],
  ['offset-box', { 'doc.pdf': 'offset' }, [{ op: 'highlight', find: 'Offset' }]],
  [
    'wrapped-phrase',
    { 'doc.pdf': 'wrapped' },
    [
      { op: 'highlight', find: 'October planning review' },
      { op: 'add_link', find: 'October planning review', url: 'https://mix.dog/ops', first: true },
    ],
  ],
  [
    'patterns-and-urls',
    { 'doc.pdf': 'urls' },
    [
      { op: 'highlight', find: '\\d{4}-\\d{2}-\\d{2}', regex: true },
      { op: 'highlight', find: '\\d{4}-\\d{2}-\\d{2}', regex: true, first: true, color: '8be9fd' },
      { op: 'add_link', urls: true },
    ],
  ],
  ['pattern-invalid', { 'doc.pdf': 'urls' }, [{ op: 'highlight', find: '(', regex: true }]],
  ['urls-none', { 'doc.pdf': 'urls' }, [{ op: 'add_link', urls: true, pages: [2] }]],
  ['link-needs-a-target', { 'doc.pdf': 'marks' }, [{ op: 'add_link', page: 1, x: 1, y: 1, width: 5, height: 5 }]],
  ['link-scheme-refused', { 'doc.pdf': 'marks' }, [{ op: 'add_link', url: 'ftp://x.test', page: 1, x: 1, y: 1, width: 5, height: 5 }]],
  ['link-page-out-of-range', { 'doc.pdf': 'marks' }, [{ op: 'add_link', toPage: 9, page: 1, x: 1, y: 1, width: 5, height: 5 }]],
  ['stamp-on-rotated-page', { 'doc.pdf': 'sheets' }, [{ op: 'add_text', text: '{page} / {pages}', align: 'center', y: 24, size: 10 }]],
  [
    'anchored-text',
    { 'doc.pdf': 'blank' },
    [
      { op: 'add_text', text: 'Centred on 200', align: 'center', x: 200, y: 300, size: 12 },
      { op: 'add_text', text: 'Ends at 380', align: 'right', x: 380, y: 200, size: 12 },
      { op: 'add_text', text: 'Starts at 40', x: 40, y: 100, size: 12 },
      { op: 'add_text', text: 'Footer right', align: 'right' },
      { op: 'add_text', text: 'Turned', rotation: 30, x: 100, y: 400, color: '#1565c0', opacity: 0.5, size: 20 },
    ],
  ],
  [
    'text-on-pages',
    { 'doc.pdf': 'sheets' },
    [
      { op: 'add_text', text: 'Only second', pages: [2], x: 50, y: 50 },
      { op: 'add_text', text: 'Numbered {page} of {pages}', page: 1, x: 50, y: 300 },
    ],
  ],
  ['text-with-a-tab', { 'doc.pdf': 'sheets' }, [{ op: 'add_text', text: 'tab\tbed', page: 1 }]],
  ['text-with-a-line-break', { 'doc.pdf': 'sheets' }, [{ op: 'add_text', text: 'two\nlines', page: 1, x: 50, y: 300 }]],
  [
    'watermarks',
    { 'doc.pdf': 'sheets' },
    [
      { op: 'watermark', text: 'DRAFT' },
      { op: 'watermark', text: 'COPY', rotation: 0, size: 30, color: 'ff0000', opacity: 0.1, align: 'left', x: 20, y: 20, pages: [1] },
    ],
  ],
  ['text-refused', { 'doc.pdf': 'blank' }, [{ op: 'add_text', text: '   ' }]],
  ['align-refused', { 'doc.pdf': 'blank' }, [{ op: 'add_text', text: 'x', align: 'middle' }]],
  ['opacity-refused', { 'doc.pdf': 'blank' }, [{ op: 'watermark', text: 'x', opacity: 2 }]],
  ['colour-refused', { 'doc.pdf': 'blank' }, [{ op: 'add_text', text: 'x', color: 'blue' }]],
  ['page-refused', { 'doc.pdf': 'blank' }, [{ op: 'add_text', text: 'x', page: 3 }]],
  ['image-default-size', { 'doc.pdf': 'blank', 'photo.png': 'photo-wide.png' }, [{ op: 'stamp_image', path: 'photo.png', x: 10, y: 10 }]],
  [
    'image-sized',
    { 'doc.pdf': 'sheets', 'logo.png': 'logo-small.png' },
    [{ op: 'stamp_image', path: 'logo.png', width: 120, x: 30, y: 400, opacity: 0.5, pages: [1, 2] }],
  ],
  ['image-height-only', { 'doc.pdf': 'blank', 'logo.png': 'logo-small.png' }, [{ op: 'stamp_image', path: 'logo.png', height: 90 }]],
  ['image-svg', { 'doc.pdf': 'blank', 'logo.svg': 'logo.svg' }, [{ op: 'stamp_image', path: 'logo.svg', x: 100, y: 100 }]],
  ['image-not-an-image', { 'doc.pdf': 'blank', 'note.txt': 'not an image' }, [{ op: 'stamp_image', path: 'note.txt' }]],
  ['fill', { 'doc.pdf': 'form' }, [{ op: 'fill_form', values: { name: 'Ada Lovelace', agree: true, colour: 'green', email: 'ada@example.test' } }]],
  ['fill-flatten', { 'doc.pdf': 'form' }, [{ op: 'fill_form', values: { name: 'Ada', agree: true }, flatten: true }]],
  [
    'fill-clipped',
    { 'doc.pdf': 'form' },
    [{ op: 'fill_form', values: { name: 'A very long value that cannot fit a two hundred point box at twelve points' } }],
  ],
  ['fill-unknown-field', { 'doc.pdf': 'form' }, [{ op: 'fill_form', values: { nope: 'x' } }]],
  ['fill-unknown-option', { 'doc.pdf': 'form' }, [{ op: 'fill_form', values: { colour: 'purple' } }]],
  ['flatten', { 'doc.pdf': 'form' }, [{ op: 'flatten_form' }]],
  ['flatten-no-form', { 'doc.pdf': 'marks' }, [{ op: 'flatten_form' }]],
  [
    'add-fields',
    { 'doc.pdf': 'marks' },
    [
      { op: 'add_form_field', name: 'full_name', type: 'text', page: 1, x: 50, y: 100, width: 200, height: 24, value: 'Grace' },
      { op: 'add_form_field', name: 'ok', type: 'checkbox', page: 2, x: 50, y: 100, width: 14, height: 14 },
      { op: 'add_form_field', name: 'size', type: 'dropdown', page: 3, x: 50, y: 100, width: 120, height: 24, options: ['S', 'M', 'L'], value: 'M' },
      { op: 'add_form_field', name: 'pick', type: 'radio', page: 3, x: 50, y: 150, width: 14, height: 14, options: ['a', 'b'] },
    ],
  ],
  ['add-field-refused', { 'doc.pdf': 'marks' }, [{ op: 'add_form_field', name: '', type: 'text', page: 1, x: 50, y: 100, width: 200, height: 24 }]],
  [
    'add-field-then-fill-and-flatten',
    { 'doc.pdf': 'marks' },
    [
      { op: 'add_form_field', name: 'full_name', type: 'text', page: 1, x: 50, y: 100, width: 200, height: 24 },
      { op: 'fill_form', values: { full_name: 'Grace Hopper' } },
      { op: 'flatten_form' },
    ],
  ],
  [
    'preview',
    { 'doc.pdf': 'form' },
    [
      {
        op: 'preview_fields',
        output: 'sub/form-check.pdf',
        boxes: [
          { page: 1, x: 100, y: 650, width: 150, height: 24, label: 'Date' },
          { page: 2, x: 10, y: 10, width: 50, height: 20 },
        ],
      },
    ],
  ],
  ['preview-needs-output', { 'doc.pdf': 'form' }, [{ op: 'preview_fields' }]],
  ['preview-same-file', { 'doc.pdf': 'form' }, [{ op: 'preview_fields', output: 'DOC.pdf' }]],
  ['preview-bad-box', { 'doc.pdf': 'form' }, [{ op: 'preview_fields', output: 'check.pdf', boxes: [{ page: 1, x: 1 }] }]],
  [
    'mark-after-stamp-after-mark',
    { 'doc.pdf': 'marks' },
    [
      { op: 'highlight', find: 'Section 1' },
      { op: 'watermark', text: 'DRAFT', page: 1 },
      { op: 'highlight', find: 'DRAFT' },
      { op: 'rotate_pages', page: 3, rotation: 90 },
      { op: 'highlight', find: 'Section 3' },
    ],
  ],
];

const out = { fixtures: {}, batches: [] };
for (const [name, inputs, operations] of cases) {
  const directory = caseDirectory(inputs);
  const document = path.join(directory, 'doc.pdf');
  const outcome = await attempt(() => applyPdfBatch(document, operations, {}));
  const outputs = {};
  for (const relative of files(directory)) outputs[relative] = await summarize(path.join(directory, relative));
  out.batches.push({ name, files: inputs, operations, ...shown(outcome), outputs });
}
for (const [name, bytes] of Object.entries(fixtures)) out.fixtures[name] = hex(bytes);

rmSync(work, { recursive: true, force: true });

const fixtureDirectory = path.join(FIXTURES_ROOT, 'office-content-ops');
mkdirSync(fixtureDirectory, { recursive: true });
const data = `${JSON.stringify(out, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value))}\n`;
writeFileSync(path.join(fixtureDirectory, 'golden.json'), data);
writeSetManifest(fixtureDirectory, { set: 'office-content-ops', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.batches.length} batches`);
