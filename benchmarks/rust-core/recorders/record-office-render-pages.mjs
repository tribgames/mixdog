#!/usr/bin/env node
// Golden of `renderPdfPages` (crate mixdog-office-pdf: render.rs and contact_sheets.rs). Each case is a generated PDF
// given to the product's `renderPdfPages(path, options)` of src/runtime/office/pdf/pdf-render.mjs (the render cases of
// office-runtime-pdf.slow.test.mjs and the page selections of document-preview-pages) in a scratch folder. The recording
// holds the PDF, the options, and either the error message the call threw or the result: the keys of every image, its
// file name, its size, its pages, the contact-sheet geometry, the thumbnails a sheet was composed from (their PNG), the
// visual coverage, the PNG of each page image, and the files that landed beside the PDF. Rust renders the same bytes and
// must equal the result exactly except the pixels: sizes, names, pages, coverage and sheet geometry exactly; the pixels
// of page images and thumbnails within the tolerance, outside the bottom band where a page-number repaint is set in a
// font the host decides, and outside every glyph the pages draw (the font bridge of the rasteriser draws the text).
//
//   node benchmarks/rust-core/recorders/record-office-render-pages.mjs --tree <product tree with node_modules>
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-render-pages.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const { renderPdfPages } = await importFrom(tree, 'src/runtime/office/pdf/pdf-render.mjs');

// ---- bytes ---------------------------------------------------------------------------------------------------------

const ascii = (text) => Buffer.from(text, 'latin1');
const stream = (dict, bytes) => ({ dict, bytes: Buffer.from(bytes) });

/** A PDF of `pages` pages: each is `{ width, height, content, resources }`; fonts and other objects are numbered from 3 + 2 * pages. */
function buildPdf(pages, extra = {}) {
  const first = 3;
  const kids = pages.map((_, index) => `${first + index * 2} 0 R`).join(' ');
  const all = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`],
  ]);
  pages.forEach((page, index) => {
    const num = first + index * 2;
    all.set(num, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${num + 1} 0 R /Resources ${page.resources ?? '<< >>'} >>`);
    all.set(num + 1, stream('', ascii(page.content ?? '')));
  });
  for (const [num, body] of Object.entries(extra)) all.set(Number(num), body);
  const parts = [ascii('%PDF-1.7\n')];
  const offsets = new Map();
  let size = parts[0].length;
  for (const [num, body] of [...all].sort((a, b) => a[0] - b[0])) {
    offsets.set(num, size);
    const chunk =
      typeof body === 'string'
        ? ascii(`${num} 0 obj\n${body}\nendobj\n`)
        : Buffer.concat([ascii(`${num} 0 obj\n<< ${body.dict} /Length ${body.bytes.length} >>\nstream\n`), body.bytes, ascii('\nendstream\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  }
  const last = Math.max(...all.keys());
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= last; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(ascii(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const blank = (count, width = 200, height = 120) => Array.from({ length: count }, () => ({ width, height }));
const painted = (width, height, content) => ({ width, height, content });

// ---- the cases -----------------------------------------------------------------------------------------------------

const cases = [];
const add = (name, pdf, options = {}) => cases.push({ name, pdf, options });

add('one-page-at-its-width', buildPdf([painted(200, 120, '1 0 0 rg 20 20 80 50 re f 0 0 1 rg 120 40 60 60 re f')]), { maxWidth: 200 });
add('scale-capped-at-two', buildPdf([painted(100, 100, '0 0.6 0 rg 10 10 50 50 re f')]), { maxWidth: 1400 });
add('scale-capped-at-three-for-a-chart', buildPdf([painted(100, 100, '0 0.6 0 rg 10 10 50 50 re f')]), { maxWidth: 1400, maximumScale: 3 });
add('scale-raised-to-a-quarter', buildPdf([painted(1000, 800, '0.5 g 100 100 400 300 re f')]), { maxWidth: 100 });
add('no-width-is-1400', buildPdf([painted(700, 500, '0.2 0.4 0.6 rg 50 50 300 200 re f')]), {});
add('pages-in-the-order-given-each-once', buildPdf(blank(5)), { pages: [3, 1, 3], maxWidth: 200 });
add('twelve-explicit-pages', buildPdf(blank(14)), { pages: [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3], maxWidth: 200 });
add('thirteen-explicit-pages-refused', buildPdf(blank(14)), { pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], maxWidth: 200 });
add('page-out-of-range', buildPdf(blank(3)), { pages: [4], maxWidth: 200 });
add('page-zero', buildPdf(blank(3)), { pages: [0], maxWidth: 200 });
add('page-fraction', buildPdf(blank(3)), { pages: [1.5], maxWidth: 200 });
add('thirteen-pages-into-seven-sheets', buildPdf(blank(13)), { maxWidth: 200 });
add(
  'twenty-five-pages-into-nine-sheets-of-three',
  buildPdf(Array.from({ length: 25 }, (_, index) => painted(200, 120, `${(index % 5) / 5} 0.5 0.5 rg 10 10 ${20 + index * 5} 40 re f`))),
  { maxWidth: 600 },
);
add('thirteen-pages-wide-sheet-with-pictures', buildPdf(Array.from({ length: 13 }, (_, index) => painted(300, 200, `0.${index} 0.2 0.8 rg 20 20 100 ${40 + index * 8} re f`))), { maxWidth: 1000 });
add('empty-pages-list-is-every-page', buildPdf(blank(3)), { pages: [], maxWidth: 200 });
add('images-are-not-written-when-asked-not-to', buildPdf(blank(2)), { maxWidth: 200, writeImages: false });
// The page number of an export: a Latin and a Korean form in the bottom band, away from other text.
const pageNumberFont = { 7: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' };
add(
  'page-number-in-the-bottom-band',
  buildPdf([{ width: 300, height: 200, content: '0.9 0.9 1 rg 0 0 300 200 re f 0 0 0 rg BT /F1 10 Tf 130 15 Td (Page 1 of 3) Tj ET', resources: '<< /Font << /F1 7 0 R >> >>' }], pageNumberFont),
  { maxWidth: 600 },
);

// ---- recording -----------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(path.join(FIXTURES_ROOT, 'office-render-pages-scratch-'));
const record = async (spec) => {
  const dir = path.join(scratch, spec.name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'doc.pdf');
  writeFileSync(file, spec.pdf);
  let outcome;
  try {
    const result = await renderPdfPages(file, spec.options);
    const images = result.images.map((image) => {
      const kept = {
        page: image.page,
        file: path.basename(image.path),
        directoryIsThePdfs: path.dirname(image.path) === dir,
        width: image.width,
        height: image.height,
        mimeType: image.mimeType,
        keys: Object.keys(image),
      };
      if (image.pages) kept.pages = image.pages;
      if (image.pageImages) {
        kept.pageImages = image.pageImages.map((p) => ({ page: p.page, width: p.width, height: p.height, mimeType: p.mimeType, png: Buffer.from(p.data, 'base64').toString('hex') }));
      } else {
        kept.png = Buffer.from(image.data, 'base64').toString('hex');
      }
      return kept;
    });
    outcome = { result: { pageCount: result.pageCount, keys: Object.keys(result), images, visualCoverage: result.visualCoverage } };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  const files = readdirSync(dir).filter((name) => name !== 'doc.pdf').sort();
  return { name: spec.name, pdf: spec.pdf.toString('hex'), options: spec.options, ...outcome, files };
};

const out = {
  note: 'renderPdfPages of src/runtime/office/pdf/pdf-render.mjs on generated PDFs in a scratch folder. keys are the keys of each result and image in Node order; file is the image file name and directoryIsThePdfs says it lands beside the PDF; files is what the call left beside the PDF. png is the PNG of the page image (hex); a contact sheet lists the PNG of each thumbnail it was composed from and its own geometry (the sheet pixels hold labels set in a host font and are not recorded). tolerance is the largest difference of any channel and the mean difference per channel that Rust page pixels are held to.',
  tolerance: { max: 8, mean: 0.8 },
  cases: [],
};
try {
  for (const spec of cases) out.cases.push(await record(spec));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-render-pages');
mkdirSync(fixtures, { recursive: true });
const data = [
  '{',
  `  "note": ${JSON.stringify(out.note)},`,
  `  "tolerance": ${JSON.stringify(out.tolerance)},`,
  `  "cases": [\n${out.cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
  '}',
  '',
].join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-render-pages', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases`);
