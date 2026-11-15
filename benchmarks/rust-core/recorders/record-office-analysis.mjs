#!/usr/bin/env node
// Golden of the office PDF analysis (crate mixdog-office-pdf: analysis/layout, tables, images, outline, search). The Node
// functions of src/runtime/office/pdf/pdf-analysis.mjs and pdf-search.mjs run over
//   - generated PDFs (text lines and runs, rotated and offset pages, a ruled table with a shaded header and a merged
//     cell, an unruled table, shapes, a page with more shapes than the limit, images placed several times, an outline,
//     links) and give the layout, the tables, the images, the outline and the search results Rust must equal, and
//   - hand-built layouts (the functions findPdfText and inferPdfTables are pure over a layout), so wide characters,
//     astral characters, reversed vertical runs, jittered table edges and the rest do not depend on a font.
// Coordinates are compared within 1e-6 and table cell texts exactly. An image is recorded as its metadata and the raw
// pixels of the PNG Node made (decoded again, so the comparison does not depend on the encoder).
//
//   node benchmarks/rust-core/recorders/record-office-analysis.mjs --tree <product tree>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-analysis.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const analysis = await importFrom(tree, 'src/runtime/office/pdf/pdf-analysis.mjs');
const { extractPdfImages, extractPdfOutline, extractPdfTextLayout, findPdfText, inferPdfTables } = analysis;
const sharp = createRequire(path.join(tree, 'package.json'))('sharp');

// ---- PDF construction ----------------------------------------------------------------------------------------------

const latin1 = (text) => Buffer.from(text, 'latin1');
const lcg = (count, seed, mask = 255) => {
  let state = seed >>> 0;
  return Buffer.from(
    Array.from({ length: count }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 24) & mask;
    }),
  );
};
const esc = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);
const text = (x, y, string, size = 10, font = 'F1') => `BT /${font} ${size} Tf ${x} ${y} Td (${esc(string)}) Tj ET\n`;
const stream = (dict, bytes) => ({ dict, bytes: Buffer.isBuffer(bytes) ? bytes : latin1(bytes) });

/**
 * pages: [{ box, crop, rotate, content, annots: 'refs', xobjects: '/Im1 20 0 R' }]; extra: { number: body }; catalog:
 * extra catalog entries. Page k is object 10 + 2k with its content stream 11 + 2k.
 */
function buildPdf({ pages, extra = {}, catalog = '' }) {
  const objects = new Map();
  objects.set(1, `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`);
  objects.set(2, `<< /Type /Pages /Kids [${pages.map((_, k) => `${10 + 2 * k} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, k) => {
    const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >> ${page.xobjects ? `/XObject << ${page.xobjects} >>` : ''} >>`;
    objects.set(
      10 + 2 * k,
      `<< /Type /Page /Parent 2 0 R /MediaBox [${(page.box ?? [0, 0, 612, 792]).join(' ')}] ${page.crop ? `/CropBox [${page.crop.join(' ')}]` : ''} ${
        page.rotate ? `/Rotate ${page.rotate}` : ''
      } /Contents ${11 + 2 * k} 0 R /Resources ${resources} ${page.annots ? `/Annots [${page.annots}]` : ''} >>`,
    );
    objects.set(11 + 2 * k, stream('', page.content));
  });
  for (const [number, body] of Object.entries(extra)) objects.set(Number(number), body);
  const parts = [latin1('%PDF-1.7\n')];
  const offsets = new Map();
  let size = parts[0].length;
  for (const [number, body] of [...objects].sort((a, b) => a[0] - b[0])) {
    offsets.set(number, size);
    const chunk =
      typeof body === 'string'
        ? latin1(`${number} 0 obj\n${body}\nendobj\n`)
        : Buffer.concat([latin1(`${number} 0 obj\n<< ${body.dict} /Length ${body.bytes.length} >>\nstream\n`), body.bytes, latin1('\nendstream\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  }
  const last = Math.max(...objects.keys());
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= last; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(latin1(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// ---- the cases -----------------------------------------------------------------------------------------------------

const cases = [];
const addCase = (name, pdf, { queries = [], layouts = [{}], tableLayouts = true, outline = null, images = false } = {}) =>
  cases.push({ name, pdf, queries, layouts, tableLayouts, outline, images });

// Text: lines, a wrapped phrase, a bold run, kerned runs, Latin-1 letters.
addCase(
  'text-basic',
  buildPdf({
    pages: [
      {
        content:
          text(72, 720, 'Hello World') +
          text(72, 700, 'Second line of body text') +
          text(300, 720, 'Bold heading', 14, 'F2') +
          text(72, 660, 'the committee will review the annual') +
          text(72, 648, 'report before the end of the quarter') +
          'BT /F1 10 Tf 72 620 Td [(Kern)-120(ed )30(text)] TJ ET\n' +
          text(72, 600, 'ABC abc 123 (nested) back\\slash'),
      },
      { content: text(72, 720, 'Caf\xe9 d\xe9j\xe0 vu \x97 Zo\xeb') + text(72, 700, 'Page two text hello again') + text(72, 680, 'hello') },
    ],
  }),
  {
    layouts: [{}, { pages: [2] }, { maxItems: 3 }, { shapes: false }],
    queries: [
      ['hello', {}],
      ['WORLD', {}],
      ['wor', { wholeWord: true }],
      ['world', { wholeWord: true }],
      ['ello wor', {}],
      ['w[a-z]+d', { regex: true }],
      ['(', { regex: true }],
      ['annual report', {}],
      ['annual   report', {}],
      ['quick brown', {}],
      ['the', { limit: 3 }],
      ['  second   line ', {}],
      ['', {}],
      ['caf\xe9', {}],
      ['caf', { wholeWord: true }],
      ['d\xe9j\xe0 vu', {}],
      ['ed text', {}],
      ['nested', {}],
      ['back\\slash', {}],
      ['bold', { wholeWord: true }],
      ['\\d+', { regex: true }],
      ['a', { limit: 1 }],
    ],
  },
);

// Rotated pages: the runs stand or read backwards.
for (const rotate of [90, 180, 270]) {
  addCase(
    `rotated-${rotate}`,
    buildPdf({ pages: [{ rotate, content: text(72, 720, `Rotated ${rotate} first line`) + text(72, 700, 'second row here') + text(300, 400, 'middle of the page') }] }),
    { queries: [['first line', {}], ['row here', {}], ['middle', {}], ['rotated', { wholeWord: true }]] },
  );
}

// Page boxes that do not start at 0,0.
addCase('cropbox', buildPdf({ pages: [{ crop: [50, 60, 400, 500], content: text(100, 400, 'Inside the crop box') + text(10, 10, 'Outside the crop box') }] }), {
  queries: [['crop box', {}]],
});
addCase('offset-mediabox', buildPdf({ pages: [{ box: [100, 100, 500, 600], content: text(150, 500, 'Offset page text') }] }), { queries: [['page text', {}]] });

// A bordered table: shaded header, a merged cell, a wrapped cell; a checkbox, rules and a bar beside it.
{
  const cols = [72, 172, 272, 372, 472];
  const rows = [
    [720, 20],
    [700, 20],
    [680, 20],
    [660, 40],
  ];
  let content = text(72, 740, 'Order summary', 12, 'F2');
  rows.forEach(([top, height], r) => {
    const bottom = top - height;
    const spans = r === 2 ? [[0, 1], [1, 3], [3, 4]] : [[0, 1], [1, 2], [2, 3], [3, 4]];
    for (const [from, to] of spans) {
      const paint = r === 0 ? '0.8 g' : '1 g';
      content += `${paint} ${cols[from]} ${bottom} ${cols[to] - cols[from]} ${height} re B\n0 g\n`;
    }
  });
  const cell = (c, r, string, line = 0) => text(cols[c] + 4, rows[r][0] - 14 - line * 12, string);
  content += ['Name', 'Qty', 'Unit', 'Total'].map((h, c) => cell(c, 0, h)).join('');
  content += ['Widget', '2', '3.50', '7.00'].map((h, c) => cell(c, 1, h)).join('');
  content += cell(0, 2, 'Gadget') + cell(1, 2, 'merged cell text') + cell(3, 2, '9.00');
  content += cell(0, 3, 'Gizmo') + cell(1, 3, 'wrapped') + cell(1, 3, 'cell text', 1) + cell(2, 3, '1') + cell(3, 3, '4.00');
  content += '72 560 10 10 re S\n72 540 m 300 540 l S\n72 520 200 1 re f\n400 480 1 60 re f\n300 500 m 310 500 320 510 320 520 c S\n0 0 m 50 30 l S\n';
  addCase('ruled-table', buildPdf({ pages: [{ content }] }), { queries: [['Widget', {}], ['merged cell', {}], ['wrapped cell', {}]] });
}

// An unruled table of aligned runs, prose above, a footer far below, and a name drawn as two runs.
{
  let content = text(72, 760, 'This page lists the order lines. Totals follow below.');
  const xs = [72, 250, 400];
  content += ['Item', 'Qty', 'Price'].map((h, c) => text(xs[c], 700, h, 10, 'F2')).join('');
  content += text(72, 688, 'Blue') + text(97, 688, 'Widget') + text(xs[1], 688, '4') + text(xs[2], 688, '12.50');
  content += text(72, 676, 'Red Gadget') + text(xs[1], 676, '10') + text(xs[2], 676, '3.00');
  content += text(72, 664, 'Gizmo') + text(xs[1], 664, '1') + text(xs[2], 664, '99.99');
  content += text(72, 652, 'Total') + text(xs[2], 652, '115.49');
  content += text(72, 40, 'Page') + text(400, 40, '3');
  addCase('aligned-table', buildPdf({ pages: [{ content }] }), { queries: [['Blue Widget', {}], ['Gadget', {}]] });
}

// Shapes: more than the per-page limit.
{
  let content = '';
  for (let i = 0; i < 2100; i += 1) content += `${10 + 14 * (i % 42)} ${760 - 14 * Math.floor(i / 42)} 4 4 re S\n`;
  addCase('many-shapes', buildPdf({ pages: [{ content }] }), { tableLayouts: false });
}

// Images: an image placed twice, gray, RGB with a soft mask, a one-bit image, a rotated placement, a form that paints an
// image, a small inline image and a large one. (An image object that two pages paint is left out: pdf.js's own
// extraction waits forever for the second page's copy, which it keeps in the document-wide cache.)
{
  const rgb2 = lcg(12, 1);
  const gray = lcg(6, 2);
  const xobjects = '/Im1 20 0 R /Im2 21 0 R /Im3 22 0 R /Im4 24 0 R /Fm1 25 0 R';
  const extra = {
    20: stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', rgb2),
    21: stream('/Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', gray),
    22: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 23 0 R', lcg(48, 3)),
    23: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8', lcg(16, 4)),
    24: stream('/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1', lcg(8, 5)),
    26: stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', lcg(12, 8)),
    25: stream('/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Matrix [1 0 0 1 20 20] /Resources << /XObject << /Im1 20 0 R >> >>', 'q 30 0 0 30 0 0 cm /Im1 Do Q'),
  };
  const bin = (bytes) => bytes.toString('latin1');
  const content =
    'q 50 0 0 40 100 600 cm /Im1 Do Q\n' +
    'q 60 0 0 60 200 600 cm /Im1 Do Q\n' +
    'q 60 0 0 45 300 500 cm /Im2 Do Q\n' +
    'q 80 0 0 80 100 400 cm /Im3 Do Q\n' +
    'q 40 0 0 40 300 400 cm /Im4 Do Q\n' +
    'q 0 30 -30 0 400 600 cm /Im2 Do Q\n' +
    'q 1 0 0 1 100 100 cm /Fm1 Do Q\n' +
    `q 20 0 0 20 10 10 cm\nBI /W 2 /H 2 /BPC 8 /CS /RGB ID ${bin(lcg(12, 6, 0x3f))}\nEI Q\n` +
    `q 50 0 0 60 400 100 cm\nBI /W 100 /H 120 /BPC 8 /CS /G ID ${bin(lcg(12000, 7, 0x3f))}\nEI Q\n`;
  addCase('images', buildPdf({ pages: [{ content, xobjects }, { content: 'q 30 0 0 30 50 50 cm /Im1 Do Q\n', xobjects: '/Im1 26 0 R' }], extra }), { images: true });
}

// An outline: nested bookmarks with explicit, named and numeric destinations, a URI action and a bookmark without one.
{
  const item = (title, { parent, prev, next, first, last, dest, action }) =>
    `<< /Title (${title}) /Parent ${parent} 0 R ${prev ? `/Prev ${prev} 0 R` : ''} ${next ? `/Next ${next} 0 R` : ''} ${first ? `/First ${first} 0 R /Last ${last} 0 R /Count 2` : ''} ${
      dest ? `/Dest ${dest}` : ''
    } ${action ? `/A ${action}` : ''} >>`;
  const extra = {
    100: '<< /Type /Outlines /First 101 0 R /Last 103 0 R /Count 6 >>',
    101: item('Chapter 1', { parent: 100, next: 102, first: 104, last: 105, dest: '[10 0 R /Fit]' }),
    102: item('Chapter 2', { parent: 100, prev: 101, next: 103, action: '<< /S /URI /URI (https://example.com/doc) >>' }),
    103: item('Chapter 3', { parent: 100, prev: 102 }),
    104: item('Section 1.1', { parent: 101, next: 105, dest: '(sec2)' }),
    105: item('R\xe9sum\xe9 1.2', { parent: 101, prev: 104, first: 106, last: 106, dest: '[14 0 R /XYZ 0 700 0]' }),
    106: item('Detail 1.2.1', { parent: 105, dest: '[2 /Fit]' }),
    111: '<< /sec2 [12 0 R /Fit] >>',
  };
  const pages = [10, 12, 14].map((_, k) => ({ content: text(72, 720, `Outline page ${k + 1}`) }));
  addCase('outline', buildPdf({ pages, extra, catalog: '/Outlines 100 0 R /Dests 111 0 R' }), { outline: [500, 3] });
}

// Links: a URI, a page, a named destination, a link without an action, a reversed rectangle, a mail link.
{
  const link = (rect, action) => `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] ${action} >>`;
  const extra = {
    30: link('72 700 200 712', '/A << /S /URI /URI (https://example.com/path) >>'),
    31: link('72 680 200 692', '/Dest [12 0 R /Fit]'),
    32: link('72 660 200 672', '/Dest (target1)'),
    33: link('72 640 200 652', ''),
    34: '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (note) >>',
    35: link('72 620 200 632', '/A << /S /GoTo /D [12 0 R /XYZ 0 0 0] >>'),
    36: link('300 700 250 690', '/A << /S /URI /URI (mailto:a@b.test) >>'),
    37: link('72 600 200 612', '/Dest [-1 /Fit]'),
    111: '<< /target1 [12 0 R /Fit] >>',
  };
  const content =
    text(75, 702, 'visit the site') + text(75, 682, 'go to page two') + text(75, 662, 'named target') + text(75, 642, 'no action') + text(75, 622, 'goto action');
  addCase(
    'links',
    buildPdf({ pages: [{ content, annots: '30 0 R 31 0 R 32 0 R 33 0 R 34 0 R 35 0 R 36 0 R 37 0 R' }, { content: text(72, 720, 'Second page') }], extra, catalog: '/Dests 111 0 R' }),
    { queries: [['named target', {}]] },
  );
}

// ---- running Node over them ----------------------------------------------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), 'office-analysis-'));
const slug = (name) => name.replace(/[^a-z0-9]+/gi, '-');
let written = 0;
const fileOf = (name, pdf, variant = '') => {
  const file = path.join(work, `${slug(name)}${variant}.pdf`);
  writeFileSync(file, pdf);
  written += 1;
  return file;
};
const attempt = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error: { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) } };
  }
};
const rawOf = async (png) => {
  const { data, info } = await sharp(Buffer.from(png, 'base64')).raw().toBuffer({ resolveWithObject: true });
  return { channels: info.channels, width: info.width, height: info.height, raw: data.toString('hex') };
};

const out = { note: 'Node (pdf-analysis.mjs, pdf-search.mjs) over generated PDFs and hand-built layouts; see the recorder header.', cases: [], synthetic: [], errors: [] };

for (const spec of cases) {
  const file = fileOf(spec.name, spec.pdf);
  const entry = { name: spec.name, pdf: spec.pdf.toString('hex'), layouts: [], searches: [] };
  for (const options of spec.layouts) {
    const run = await attempt(() => extractPdfTextLayout(file, options));
    const record = { options, ...run };
    if (run.result && spec.tableLayouts) record.tables = inferPdfTables(run.result);
    entry.layouts.push(record);
  }
  const base = entry.layouts[0].result;
  if (base) {
    for (const [query, options] of spec.queries) {
      const run = await attempt(() => findPdfText(base, query, options));
      entry.searches.push({ query, options, ...run });
    }
  }
  if (spec.outline) {
    entry.outline = [];
    for (const maxEntries of spec.outline) entry.outline.push({ maxEntries, ...(await attempt(() => extractPdfOutline(file, { maxEntries }))) });
  }
  if (spec.images) {
    const extracted = await extractPdfImages(file);
    const { _images, ...rest } = extracted;
    entry.images = { ...rest, pixels: await Promise.all(_images.map((image) => rawOf(image.data))) };
    entry.imagesOnPage2 = await (async () => {
      const second = await extractPdfImages(file, { pages: [2] });
      const { _images: picked, ...meta } = second;
      return { ...meta, pixels: await Promise.all(picked.map((image) => rawOf(image.data))) };
    })();
  }
  out.cases.push(entry);
}

// Errors of the selection and of damaged input.
{
  const basic = cases.find((c) => c.name === 'text-basic');
  const file = fileOf('text-basic', basic.pdf);
  const many = Array.from({ length: 101 }, (_, i) => i + 1);
  const selections = [[0], [3], [1.5], [1, 2, 2], [2, 1], many, [-1]];
  for (const pages of selections) {
    const layout = await attempt(() => extractPdfTextLayout(file, { pages }));
    const imagesRun = await attempt(async () => {
      const { _images, ...rest } = await extractPdfImages(file, { pages });
      return rest;
    });
    out.errors.push({ pages, layout: layout.error ? layout : { result: { pageNumbers: layout.result.pages.map((p) => p.page) } }, images: imagesRun.error ? imagesRun : { ok: true } });
  }
  const bad = fileOf('not-a-pdf', Buffer.from('this is not a pdf at all'));
  out.notPdf = { bytes: Buffer.from('this is not a pdf at all').toString('hex'), ...(await attempt(() => extractPdfTextLayout(bad))) };
  out.outlineMax = { maxEntries: 0, ...(await attempt(() => extractPdfOutline(file, { maxEntries: 0 }))) };
}

// Hand-built layouts for the pure functions.
const item = (textValue, x, top, width, extra = {}) => ({ text: textValue, x, top, width, height: 10, direction: 'ltr', font: 'f', ...extra });
const box = (x, top, width, height, extra = {}) => ({ x, top, width, height, filled: false, stroked: true, checkbox: false, ...extra });
const layoutOf = (pages) => ({
  pageCount: pages.length,
  pages: pages.map((page, k) => ({ page: k + 1, width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792], items: [], lines: [], boxes: [], links: [], ...page })),
  truncated: false,
});
const synthetic = [];
const addSynthetic = (name, layout, { queries = [], tables = true } = {}) => synthetic.push({ name, layout, queries, tables });

addSynthetic(
  'wide-and-astral',
  layoutOf([
    {
      items: [
        item('한국어 문장', 72, 100, 60),
        item('한국', 72, 112, 20),
        item('어가 나', 72, 124, 30),
        item('smile 😀 face', 72, 140, 90),
        item('😀', 72, 152, 10),
        item('word😀word', 72, 164, 80),
        item('Straße STRASSE', 72, 180, 100),
        item('İstanbul istanbul', 72, 192, 100),
        item('ΟΔΥΣΣΕΥΣ odysseus', 72, 204, 100),
      ],
    },
  ]),
  {
    tables: false,
    queries: [
      ['한국어', {}],
      ['한국어가', {}],
      ['어가 나', {}],
      ['😀', {}],
      ['smile', { wholeWord: true }],
      ['face', { wholeWord: true }],
      ['word', { wholeWord: true }],
      ['😀word', {}],
      ['strasse', {}],
      ['straße', {}],
      ['İstanbul', {}],
      ['istanbul', {}],
      ['οδυσσευς', {}],
      ['ODYSSEUS', {}],
      ['\\p{L}+', { regex: true }],
      ['\\p{Script=Hangul}+', { regex: true }],
      ['[', { regex: true }],
      ['.*', { regex: true }],
    ],
  },
);

addSynthetic(
  'vertical-runs',
  layoutOf([
    {
      width: 792,
      height: 612,
      items: [
        item('first vertical row', 100, 50, 12, { vertical: true, height: 120 }),
        item('second row', 120, 50, 12, { vertical: true, height: 70 }),
        item('upward reading', 300, 400, 12, { vertical: true, reversed: true, height: 100 }),
        item('more upward', 320, 400, 12, { vertical: true, reversed: true, height: 80 }),
        item('backwards left', 400, 200, 90, { reversed: true }),
        item('backwards right', 400, 212, 90, { reversed: true }),
        item('upright', 100, 500, 60),
        item('split', 100, 520, 30),
        item('line', 135, 520, 30),
      ],
    },
  ]),
  {
    tables: false,
    queries: [
      ['vertical row', {}],
      ['row second', {}],
      ['upward', {}],
      ['upward reading more', {}],
      ['left', {}],
      ['backwards', {}],
      ['upright', {}],
      ['split line', {}],
    ],
  },
);

addSynthetic(
  'phrases',
  layoutOf([
    {
      items: [
        item('the quick brown', 72, 100, 90),
        item('fox jumps over', 72, 112, 85),
        item('the lazy dog.', 72, 124, 70),
        item('A  B', 72, 136, 30),
        item('C', 72, 148, 10),
        item('same line ends with dash-', 72, 160, 120),
        item('continues here', 72, 172, 80),
      ],
    },
    { items: [item('page two quick', 72, 100, 70), item('brown fox', 72, 112, 50)] },
  ]),
  {
    tables: false,
    queries: [
      ['brown fox', {}],
      ['brown   fox', {}],
      ['over the', {}],
      ['dog. A', {}],
      ['dash-continues', {}],
      ['dash- continues', {}],
      ['quick brown', {}],
      ['quick brown fox', { wholeWord: true }],
      ['the', { limit: 2 }],
      ['the', { limit: 1 }],
      ['fox', {}],
      ['over the lazy', { limit: 1 }],
    ],
  },
);

// Tables from jittered edges: a ruled grid with edges a fraction of a point off, a merged cell and a finer row; an
// aligned table with runs to merge, a block that breaks apart and a column count that varies.
{
  const noise = lcg(400, 9);
  let n = 0;
  const jitter = (amount) => ((noise[n++ % noise.length] / 255) - 0.5) * amount;
  const boxes = [];
  const items = [];
  const cols = [60, 150, 250, 340];
  let top = 100;
  for (let r = 0; r < 5; r += 1) {
    const height = r === 3 ? 30 : 20;
    const spans = r === 2 ? [[0, 1], [1, 3]] : r === 4 ? [[0, 1], [1, 2], [2, 3]] : [[0, 1], [1, 2], [2, 3]];
    for (const [from, to] of spans) {
      const x = cols[from] + jitter(1.2);
      const width = cols[to] - cols[from] + jitter(1.2);
      boxes.push(box(Number(x.toFixed(2)), Number((top + jitter(1.5)).toFixed(2)), Number(width.toFixed(2)), height, { filled: r === 0, stroked: true }));
      items.push(item(`r${r}c${from}`, Number((x + 4).toFixed(2)), Number((top + 5).toFixed(2)), 28));
    }
    top += height;
  }
  // A second table on the same page, directly below with a different grid.
  const second = [60, 200, 300];
  top += 30;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 2; c += 1) boxes.push(box(second[c], top, second[c + 1] - second[c], 18, { filled: r === 0 }));
    top += 18;
  }
  addSynthetic('ruled-jitter', layoutOf([{ items, boxes }]), {});
}

{
  const items = [];
  const rows = [
    [['Total', 50, 28], ['amount', 83, 40], ['12', 300, 10], ['EUR', 400, 25]],
    [['Net', 50, 20], ['amount', 74, 40], ['9', 300, 10], ['EUR', 400, 25]],
    [['Tax', 50, 20], ['3', 300, 10], ['EUR', 400, 25]],
    [['Ship', 50, 24], ['ping', 74.4, 20], ['2', 300, 10], ['EUR', 400, 25], ['extra', 480, 30], ['more', 540, 30]],
  ];
  rows.forEach((row, r) => row.forEach(([value, x, width], c) => items.push(item(value, x, 100 + r * 12.4 + (c % 2) * 0.9, width))));
  items.push(item('Name', 50, 300, 30), item('Ann', 200, 300, 30), item('Page', 50, 500, 30), item('2', 200, 500, 10));
  items.push(item(' ', 120, 100, 4), item('', 130, 100, 4));
  addSynthetic('aligned-mixed', layoutOf([{ items }, { items: [item('only prose here', 50, 100, 120)] }]), {});
}

for (const entry of synthetic) {
  const record = { name: entry.name, layout: entry.layout, searches: [] };
  for (const [query, options] of entry.queries) record.searches.push({ query, options, ...(await attempt(() => findPdfText(entry.layout, query, options))) });
  if (entry.tables) record.tables = inferPdfTables(entry.layout);
  out.synthetic.push(record);
}

rmSync(work, { recursive: true, force: true });

const fixtures = path.join(FIXTURES_ROOT, 'office-analysis');
mkdirSync(fixtures, { recursive: true });
const data = `${JSON.stringify(out, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value))}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-analysis', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} PDF cases, ${out.synthetic.length} synthetic layouts, ${written} files read`);
