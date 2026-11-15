#!/usr/bin/env node
// Golden of the page rasteriser (crate mixdog-pdf: render/). Each case is a generated one-page PDF that pdf.js 6.4.299 (the
// legacy build the office engine loads, opened with the rendering configuration of src/runtime/office/pdf/pdf-render.mjs:
// no worker, no system fonts, the bundled standard fonts, no eval) draws on an @napi-rs/canvas canvas the way
// `renderPdfPageDirect` does: a canvas of the ceiling of the viewport at the case's scale, `page.render({ canvas,
// canvasContext, viewport, background: 'rgb(255,255,255)' })`. The recording holds the PDF and, per scale, the size of the
// canvas and the PNG of what it shows. Rust `mixdog-pdf` opens the same bytes and must draw an image of exactly the same
// size whose pixels are within the tolerance of the case (crates/mixdog-pdf/tests/twin_render_core.rs).
//
// The pages are the ones the core rasteriser paints: fills and strokes with every line state and dash, clipping, images and
// image masks, forms, optional content, page rotation. They hold no text (the glyph outlines of the fonts are the font
// bridge's), no shading, no pattern, no soft mask, no transparency group and no blend mode (the paint stage records those).
//
//   node benchmarks/rust-core/recorders/record-office-render-core.mjs --tree <product tree with node_modules>
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-render-core.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const requireFromTree = createRequire(path.join(tree, 'package.json'));
const { createCanvas, DOMMatrix, ImageData, Path2D } = requireFromTree('@napi-rs/canvas');
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;
const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const standardFontDataUrl = `${path.join(tree, 'node_modules', 'pdfjs-dist', 'standard_fonts').split(path.sep).join('/')}/`;

// ---- bytes ---------------------------------------------------------------------------------------------------------

const lcg = (count, seed) => {
  let state = seed >>> 0;
  return Buffer.from(
    Array.from({ length: count }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 24) & 255;
    }),
  );
};
const stream = (dict, bytes) => ({ dict, bytes: Buffer.from(bytes) });
const flate = (bytes) => deflateSync(Buffer.from(bytes));
/** A gradient picture: `width` by `height` RGB bytes. */
const gradient = (width, height) =>
  Buffer.from(
    Array.from({ length: width * height }, (_, i) => {
      const x = i % width;
      const y = Math.floor(i / width);
      return [Math.round((255 * x) / (width - 1)), Math.round((255 * y) / (height - 1)), (x * 37 + y * 91) & 255];
    }).flat(),
  );
const ascii = (text) => Buffer.from(text, 'latin1');

/** A PDF of one page: `objects` are numbered from 5 on (1 catalog, 2 pages, 3 page, 4 content). */
function buildPdf({ mediaBox = '0 0 100 100', pageExtra = '', catalogExtra = '', content, resources = '<< >>', objects = {} }) {
  const all = new Map([
    [1, `<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>`],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] ${pageExtra} /Contents 4 0 R /Resources ${resources} >>`],
    [4, stream('', Buffer.isBuffer(content) ? content : ascii(content))],
    ...Object.entries(objects).map(([num, body]) => [Number(num), body]),
  ]);
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

// ---- the cases -----------------------------------------------------------------------------------------------------

const cases = [];
const add = (name, spec, scales = [1, 2]) => cases.push({ name, pdf: buildPdf(spec), scales });

add('fills', {
  content: `
    1 0 0 rg 5 5 30 20 re f
    0 0.6 0 rg 40 5 25 25 re f
    0.5 g 70 5 25 25 re f
    0.2 0.4 0.6 0.1 k 5 35 30 20 re f
    0 0 1 rg 45 40 m 70 40 l 57.5 60 l f
    1 0.5 0 rg 75 40 m 75 60 95 60 95 40 c 95 25 75 25 75 40 c f
    0 0 0 rg 20 65 m 30 95 l 40 65 l 10 82 l 50 82 l f*
    0.3 0.3 0.8 rg 0 0 0 RG 2 w 60 65 30 25 re B
    0.8 0.8 0.2 rg 2 w 5 96 4 3 re b*
  `,
});

add('strokes', {
  content: `
    0 w 5 5 m 95 5 l S
    0.5 w 5 10 m 95 10 l S
    1 w 5 15 m 95 15 l S
    6 w 0 J 10 30 m 40 30 l S
    1 J 50 30 m 80 30 l S
    2 J 10 45 m 40 45 l S
    4 w 0 j 10 60 m 25 80 l 40 60 l S
    1 j 50 60 m 65 80 l 80 60 l S
    2 j 10 90 m 25 98 l 40 90 l S
    3 w 0 j 2 M 55 90 m 62 98 l 69 90 l S
    10 M 74 90 m 81 98 l 88 90 l S
  `,
});

add('dashes', {
  content: `
    2 w [6 3] 0 d 5 10 m 95 10 l S
    [6 3] 4 d 5 20 m 95 20 l S
    [10] 0 d 5 30 m 95 30 l S
    1 J [0 6] 0 d 3 w 5 40 m 95 40 l S
    0 J [8 4 2 4] 0 d 2 w 10 50 20 40 re S
    [] 0 d 2 w 1 0 0 RG 60 50 m 90 50 90 90 60 90 c s
  `,
});

add('stroke-nonuniform', {
  content: `
    q 3 0 0 1 0 0 cm 3 w 2 10 m 30 10 l 30 40 l S Q
    q 1 0 0 4 0 0 cm 0.2 w [2 1] 0 d 10 5 m 90 5 l S Q
    q 0.7 0.7 -0.7 0.7 50 20 cm 4 w 0 0 25 25 re S Q
    q 20 0 0 0.5 0 0 cm 0 w 0 0 1 RG 1 80 m 4 80 l S Q
  `,
});

add('clipping', {
  content: `
    q 10 10 40 40 re W n 1 0 0 rg 0 0 100 100 re f Q
    q 55 55 m 95 55 l 75 95 l h W n 0 0 1 rg 0 0 100 100 re f Q
    q 10 60 30 30 re 18 68 14 14 re W* n 0 0.6 0 rg 0 0 100 100 re f Q
    q 5 5 60 60 re W n 30 30 60 60 re W n 0.5 0 0.5 rg 0 0 100 100 re f Q
    q 60 10 m 60 40 90 40 90 10 c h W n 1 0.6 0 rg 0 0 100 100 re f Q
    q 80 90 10 8 re W n Q 0 g 2 2 2 2 re f
  `,
});

add('inline-images', {
  content: Buffer.concat([
    ascii('q 40 0 0 40 5 55 cm BI /W 4 /H 4 /CS /RGB /BPC 8 ID '),
    gradient(4, 4),
    ascii('\nEI Q\nq 40 0 0 40 55 55 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /I true ID '),
    gradient(4, 4),
    ascii('\nEI Q\nq 30 0 0 30 5 10 cm BI /W 8 /H 8 /CS /G /BPC 8 ID '),
    lcg(64, 3),
    ascii('\nEI Q\nq 30 0 0 -30 50 40 cm BI /W 3 /H 2 /CS /RGB /BPC 8 ID '),
    lcg(18, 5),
    ascii('\nEI Q\n'),
  ]),
});

const image = (width, height, dict = '', bytes = gradient(width, height), cs = '/DeviceRGB') =>
  stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /FlateDecode ${dict}`, flate(bytes));

add('image-xobjects', {
  resources: '<< /XObject << /Im1 5 0 R /Im2 6 0 R /Im3 7 0 R /Im4 8 0 R >> >>',
  objects: {
    5: image(16, 16),
    6: image(16, 16, '/Interpolate true'),
    7: image(80, 80, '', lcg(80 * 80 * 3, 9)),
    8: image(8, 8, '', lcg(64, 11), '/DeviceGray'),
  },
  content: `
    q 40 0 0 40 5 55 cm /Im1 Do Q
    q 40 0 0 40 55 55 cm /Im2 Do Q
    q 20 0 0 20 5 30 cm /Im3 Do Q
    q 30 0 0 30 35 25 cm /Im4 Do Q
    q 20 0 0 20 70 25 cm /Im1 Do Q
    q 0.87 0.5 -0.5 0.87 20 2 cm 20 0 0 20 0 0 cm /Im1 Do Q
    q 0 20 -20 0 85 2 cm /Im1 Do Q
  `,
}, [1, 2, 1.5]);

add('image-smask', {
  resources: '<< /XObject << /Im1 5 0 R >> >>',
  objects: {
    5: image(8, 8, '/SMask 6 0 R'),
    6: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', flate(Buffer.from([0, 85, 170, 255, 255, 170, 85, 0, 0, 85, 170, 255, 255, 170, 85, 0]))),
  },
  content: `
    0.9 0.9 0.2 rg 0 0 100 50 re f
    q 80 0 0 80 10 10 cm /Im1 Do Q
  `,
});

const mask = (width, height, bytes, dict = '') => stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ImageMask true /BitsPerComponent 1 ${dict}`, bytes);

add('image-masks', {
  resources: '<< /XObject << /M1 5 0 R /M2 6 0 R >> >>',
  objects: {
    5: mask(8, 8, Buffer.from([0xaa, 0x55, 0xaa, 0x55, 0xf0, 0xf0, 0x0f, 0x0f])),
    6: mask(8, 8, Buffer.from([0xaa, 0x55, 0xaa, 0x55, 0xf0, 0xf0, 0x0f, 0x0f]), '/Decode [1 0] /Interpolate true'),
  },
  content: `
    1 0 0 rg q 40 0 0 40 5 55 cm /M1 Do Q
    0 0 1 rg q 40 0 0 40 55 55 cm /M2 Do Q
    0 0.5 0 rg q 20 0 0 20 5 10 cm /M1 Do Q
    q 0.87 0.5 -0.5 0.87 50 5 cm 25 0 0 25 0 0 cm /M1 Do Q
    q 1 0 0 1 0 0 cm 0 0 0 rg 90 5 5 5 re f Q
  `,
}, [1, 2, 3]);

add('forms', {
  resources: '<< /XObject << /Fm1 5 0 R /Fm2 6 0 R >> >>',
  objects: {
    5: stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Matrix [1 0 0 1 10 10]', ascii('1 0 0 rg 0 0 30 30 re f 0 0 1 rg 5 5 5 5 re f')),
    6: stream('/Type /XObject /Subtype /Form /BBox [0 0 40 20] /Matrix [0.7 0.7 -0.7 0.7 60 20] /Resources << /XObject << /Fm1 5 0 R >> >>', ascii('0 0.6 0 rg 0 0 100 100 re f q 0.5 0 0 0.5 20 0 cm /Fm1 Do Q')),
  },
  content: '/Fm1 Do q 1.5 0 0 1.5 0 40 cm /Fm1 Do Q /Fm2 Do 0 g 90 90 5 5 re f',
});

add('optional-content', {
  catalogExtra: '/OCProperties << /OCGs [5 0 R 6 0 R 7 0 R] /D << /BaseState /ON /OFF [6 0 R] >> >>',
  resources: '<< /Properties << /On 5 0 R /Off 6 0 R /Mem 8 0 R >> >>',
  objects: {
    5: '<< /Type /OCG /Name (shown) >>',
    6: '<< /Type /OCG /Name (hidden) >>',
    7: '<< /Type /OCG /Name (view off) /Usage << /View << /ViewState /OFF >> >> >>',
    8: '<< /Type /OCMD /OCGs [5 0 R 6 0 R] /P /AllOn >>',
  },
  content: `
    /OC /On BDC 1 0 0 rg 5 5 30 30 re f EMC
    /OC /Off BDC 0 0 1 rg 40 5 30 30 re f EMC
    /OC /Mem BDC 0 0.6 0 rg 5 45 30 30 re f EMC
    /Span BMC 0.5 g 40 45 30 30 re f EMC
    /OC /Off BDC /OC /On BDC 0 g 75 75 20 20 re f EMC EMC
    0 g 75 5 20 20 re f
  `,
});

add('page-geometry-rotate90', { mediaBox: '0 0 99.5 60.25', pageExtra: '/Rotate 90', content: '1 0 0 rg 0 0 40 20 re f 0 0 1 rg 59.5 40.25 40 20 re f 0 g 2 w 0 0 m 99.5 60.25 l S' }, [1, 2, 1.5]);
add('page-geometry-rotate270', { mediaBox: '10 20 110 80', pageExtra: '/Rotate 270', content: '1 0 0 rg 10 20 30 20 re f 0 0 1 rg 80 60 30 20 re f' }, [1, 2]);
add('page-geometry-cropbox', { mediaBox: '0 0 200 200', pageExtra: '/CropBox [50.5 40 150.25 110.75]', content: '0 0.5 0 rg 50 40 100 70 re f 1 0 0 rg 0 0 60 60 re f 0 g 140 100 30 30 re f' }, [1, 2]);

// ---- run -----------------------------------------------------------------------------------------------------------

/** The page drawn the way `renderPdfPageDirect` draws it, at `scale`. */
async function render(bytes, scale) {
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: false,
    standardFontDataUrl,
    isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await loading.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
    return { scale, width: canvas.width, height: canvas.height, png: canvas.toBuffer('image/png').toString('hex') };
  } finally {
    await loading.destroy();
  }
}

const out = {
  note: 'pdf.js 6.4.299 (legacy build, no worker, no system fonts, the bundled standard fonts) on generated one-page PDFs drawn on @napi-rs/canvas 1.0.11 as renderPdfPageDirect draws them: a canvas of the ceiling of the viewport, white background. png is the canvas as a PNG file (hex). tolerance is the largest difference of any channel and the mean difference per channel that the Rust rasteriser is held to.',
  pdfjs: pdfjs.version,
  tolerance: { max: 8, mean: 0.8 },
  cases: [],
};
for (const spec of cases) {
  const renders = [];
  for (const scale of spec.scales) renders.push(await render(spec.pdf, scale));
  out.cases.push({ name: spec.name, pdf: spec.pdf.toString('hex'), renders });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-render-core');
mkdirSync(fixtures, { recursive: true });
const data = [
  '{',
  `  "note": ${JSON.stringify(out.note)},`,
  `  "pdfjs": ${JSON.stringify(out.pdfjs)},`,
  `  "tolerance": ${JSON.stringify(out.tolerance)},`,
  `  "cases": [\n${out.cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
  '}',
  '',
].join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-render-core', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases, ${out.cases.reduce((n, c) => n + c.renders.length, 0)} renders`);
