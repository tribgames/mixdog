#!/usr/bin/env node
// Golden of the paint stage of the page rasteriser (crate mixdog-pdf: render/shading.rs, pattern.rs, transparency.rs and
// the Type3, pattern and soft-mask parts of painter.rs, text.rs and images.rs). Each case is a generated one-page PDF that
// pdf.js 6.4.299 (the legacy build the office engine loads, opened with the rendering configuration of
// src/runtime/office/pdf/pdf-render.mjs: no worker, no system fonts, the bundled standard fonts, no eval) draws on an
// @napi-rs/canvas canvas the way `renderPdfPageDirect` does: a canvas of the ceiling of the viewport at the case's scale,
// `page.render({ canvas, canvasContext, viewport, background: 'rgb(255,255,255)' })`. The recording holds the PDF and, per
// scale, the size of the canvas and the PNG of what it shows. Rust `mixdog-pdf` opens the same bytes and must draw an
// image of exactly the same size whose pixels are within the tolerance of the case
// (crates/mixdog-pdf/tests/twin_render_paint.rs).
//
// The pages are the ones the paint stage draws: shadings of types 1 to 7 by `sh` and as pattern colours (fill and
// stroke), tiling patterns (coloured and uncoloured, steps larger and smaller than the cell, a matrix, a stroke, a
// constant alpha), constant alpha, every blend mode, transparency groups, and soft masks (luminosity and alpha, with a
// backdrop colour and a transfer function). They hold no text (the glyph outlines of the fonts are the font bridge's:
// Type3 glyph procedures are covered by unit tests of the crate), no knockout group and no radial shading whose
// circles overlap with a start radius and two centres (the canvas of mixdog-raster draws those as tiny-skia does).
//
//   node benchmarks/rust-core/recorders/record-office-render-paint.mjs --tree <product tree with node_modules>
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-render-paint.mjs';
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

const stream = (dict, bytes) => ({ dict, bytes: Buffer.from(bytes) });
const flate = (bytes) => deflateSync(Buffer.from(bytes));
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

// ---- the building blocks -------------------------------------------------------------------------------------------

/** An exponential function from `c0` to `c1`. */
const ramp = (c0, c1) => `<< /FunctionType 2 /Domain [0 1] /C0 [${c0}] /C1 [${c1}] /N 1 >>`;
const redBlue = ramp('1 0 0', '0 0 1');
/** Three stops with a bound at the middle. */
const stitched = `<< /FunctionType 3 /Domain [0 1] /Functions [${ramp('1 0 0', '1 1 0')} ${ramp('1 1 0', '0 0.4 1')}] /Bounds [0.4] /Encode [0 1 0 1] >>`;

const shading = (type, extra, fn = redBlue) => `<< /ShadingType ${type} /ColorSpace /DeviceRGB ${extra} /Function ${fn} >>`;
const shadingResources = (name = 'S1', objectNumber = 5) => `<< /Shading << /${name} ${objectNumber} 0 R >> >>`;
const patternResources = (extra = '') => `<< /Pattern << /P1 5 0 R >> ${extra} >>`;
const shadingPattern = (type, extra, matrix = '', fn = redBlue) => `<< /PatternType 2 ${matrix ? `/Matrix [${matrix}]` : ''} /Shading ${shading(type, extra, fn)} >>`;

/** `value` as `bits` bits scaled from `[0, range]`. */
const quantised = (value, range, bits = 8) => Math.round((value / range) * (2 ** bits - 1));
const vertex = (flag, x, y, [r, g, b]) => [flag, quantised(x, 100), quantised(y, 100), r, g, b];
const meshDict = (type, extra = '') =>
  `/ShadingType ${type} /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1 0 1 0 1] ${extra}`;
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

/** The twelve boundary points of a patch from (10, 10) to (90, 90), the edges bowed a little. */
const boundary = [
  [10, 10], [4, 36], [16, 63], [10, 90],
  [36, 96], [63, 84], [90, 90],
  [96, 63], [84, 36], [90, 10],
  [63, 4], [36, 16],
];
const patch = (flag, points, colours) =>
  Buffer.from([flag, ...points.flatMap(([x, y]) => [quantised(x, 100), quantised(y, 100)]), ...colours.flat()]);
const COONS = patch(0, boundary, [RED, GREEN, BLUE, YELLOW]);
const TENSOR = patch(0, [...boundary, [36, 36], [30, 63], [63, 63], [70, 36]], [RED, GREEN, BLUE, YELLOW]);
const TRIANGLES = Buffer.from([
  ...vertex(0, 10, 10, RED),
  ...vertex(0, 90, 10, GREEN),
  ...vertex(0, 50, 90, BLUE),
  ...vertex(1, 90, 90, YELLOW),
]);
const LATTICE = Buffer.from(
  [
    [10, 10, RED], [50, 20, GREEN], [90, 10, BLUE],
    [10, 50, YELLOW], [50, 50, [255, 255, 255]], [90, 50, RED],
    [10, 90, BLUE], [50, 80, GREEN], [90, 90, YELLOW],
  ].flatMap(([x, y, c]) => [quantised(x, 100), quantised(y, 100), ...c]),
);

/** A form XObject with a transparency group. */
const group = (content, { bbox = '0 0 100 100', extra = '/I true', resources = '<< >>', matrix = '' } = {}) =>
  stream(`/Type /XObject /Subtype /Form /BBox [${bbox}] ${matrix ? `/Matrix [${matrix}]` : ''} /Group << /S /Transparency ${extra} >> /Resources ${resources}`, ascii(content));

/** A page whose soft mask is the group `mask`, painted with `paint` under it. */
const softMask = (mask, smaskExtra, paint, { objects = {}, resources = '' } = {}) => ({
  resources: `<< /ExtGState << /GS1 << /SMask << /Type /Mask ${smaskExtra} /G 5 0 R >> >> >> ${resources} >>`,
  objects: { 5: mask, ...objects },
  content: `${paint}`,
});

// ---- the cases -----------------------------------------------------------------------------------------------------

const cases = [];
const add = (name, spec, scales = [1, 2]) => cases.push({ name, pdf: buildPdf(spec), scales });

// Axial and radial shadings by `sh`.
add('sh-axial-extend', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [20 0 80 0] /Extend [true true]') }, content: '/S1 sh' });
add('sh-axial-no-extend-background', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [20 0 80 0] /Background [0.9 0.9 0.2]') }, content: '/S1 sh' });
add('sh-axial-stitched', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [10 0 90 0] /Extend [false true]', stitched) }, content: '/S1 sh' });
add('sh-axial-diagonal', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [10 10 90 90] /Extend [true true]') }, content: '/S1 sh' });
add('sh-axial-bbox', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [0 0 100 0] /BBox [20 20 80 70] /Extend [true true]') }, content: '/S1 sh' });
add('sh-axial-rotated', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [0 0 40 0] /Extend [true true]') }, content: 'q 0.7 0.7 -0.7 0.7 50 10 cm /S1 sh Q' });
add('sh-axial-clipped', { resources: shadingResources(), objects: { 5: shading(2, '/Coords [20 0 80 0] /Extend [true true]') }, content: 'q 20 20 60 60 re W n /S1 sh Q' });
add('sh-radial-concentric', { resources: shadingResources(), objects: { 5: shading(3, '/Coords [50 50 0 50 50 40] /Extend [false true]') }, content: '/S1 sh' });
add('sh-radial-ring', { resources: shadingResources(), objects: { 5: shading(3, '/Coords [50 50 15 50 50 40] /Extend [true false]') }, content: '/S1 sh' });
add('sh-radial-focal', { resources: shadingResources(), objects: { 5: shading(3, '/Coords [35 50 0 55 50 35] /Extend [false false]') }, content: '/S1 sh' });
add('sh-function-based', {
  resources: shadingResources(),
  objects: {
    5: `<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [80 0 0 80 10 10] /Function 6 0 R >>`,
    6: stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]', ascii('{ 2 copy mul }')),
  },
  content: '/S1 sh',
});

// Mesh shadings.
add('sh-mesh-free-form', { resources: shadingResources(), objects: { 5: stream(meshDict(4), TRIANGLES) }, content: '/S1 sh' });
add('sh-mesh-lattice', { resources: shadingResources(), objects: { 5: stream(meshDict(5, '/VerticesPerRow 3'), LATTICE) }, content: '/S1 sh' });
add('sh-mesh-coons', { resources: shadingResources(), objects: { 5: stream(meshDict(6), COONS) }, content: '/S1 sh' });
add('sh-mesh-tensor', { resources: shadingResources(), objects: { 5: stream(meshDict(7), TENSOR) }, content: '/S1 sh' });
add('sh-mesh-function-colour', {
  resources: shadingResources(),
  objects: {
    5: stream(
      `/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1] /Function ${redBlue}`,
      Buffer.from([0, quantised(10, 100), quantised(10, 100), 0, 0, quantised(90, 100), quantised(10, 100), 128, 0, quantised(50, 100), quantised(90, 100), 255]),
    ),
  },
  content: '/S1 sh',
});

// Shadings as pattern colours.
add('pattern-axial-fill', { resources: patternResources(), objects: { 5: shadingPattern(2, '/Coords [20 0 80 0]') }, content: '/Pattern cs /P1 scn 20 20 60 60 re f' });
add('pattern-axial-matrix', { resources: patternResources(), objects: { 5: shadingPattern(2, '/Coords [0 0 60 0] /Extend [true true]', '1 0 0 1 20 0') }, content: '/Pattern cs /P1 scn 10 10 80 80 re f' });
add('pattern-axial-stroke', { resources: patternResources(), objects: { 5: shadingPattern(2, '/Coords [10 0 90 0]') }, content: '/Pattern CS /P1 SCN 12 w 15 15 70 70 re S' });
add('pattern-axial-origin-based', { resources: patternResources(), objects: { 5: shadingPattern(2, '/Coords [0 0 100 0] /Extend [true true]') }, content: '/Pattern cs /P1 scn 10 10 80 80 re f' });
add('pattern-radial-origin-based', { resources: patternResources(), objects: { 5: shadingPattern(3, '/Coords [0 0 0 0 0 130] /Extend [true true]') }, content: '/Pattern cs /P1 scn 10 10 80 80 re f' });
add('pattern-radial-matrix', { resources: patternResources(), objects: { 5: shadingPattern(3, '/Coords [0 0 5 0 0 30] /Extend [true true]', '1.5 0 0 1 50 50') }, content: '/Pattern cs /P1 scn 5 5 90 90 re f' });
add('pattern-mesh-fill', { resources: patternResources(), objects: { 5: '<< /PatternType 2 /Shading 6 0 R >>', 6: stream(meshDict(4, '/Background [0.8 0.9 0.8]'), TRIANGLES) }, content: '/Pattern cs /P1 scn 0 0 100 100 re f' });
add('pattern-mesh-matrix', { resources: patternResources(), objects: { 5: '<< /PatternType 2 /Matrix [0.7 0.3 -0.3 0.7 25 5] /Shading 6 0 R >>', 6: stream(meshDict(6), COONS) }, content: '/Pattern cs /P1 scn 0 0 100 100 re f' });
add('pattern-function-based-fill', {
  resources: patternResources(),
  objects: {
    5: `<< /PatternType 2 /Matrix [1 0 0 1 10 10] /Shading << /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [60 0 0 60 0 0] /Function 6 0 R >> >>`,
    6: stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]', ascii('{ 2 copy mul }')),
  },
  content: '/Pattern cs /P1 scn 5 5 80 80 re f',
});

// Tiling patterns.
const cell = '1 0 0 rg 0 0 5 5 re f 0 0 1 rg 5 5 5 5 re f 0 0.6 0 RG 1 w 0.5 0.5 9 9 re S';
const tiling = (extra, content = cell) => stream(`/PatternType 1 /PaintType 1 /TilingType 1 /Resources << >> ${extra}`, ascii(content));
add('tiling-coloured', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 10 10] /XStep 10 /YStep 10') }, content: '/Pattern cs /P1 scn 5 5 90 90 re f' });
add('tiling-step-larger', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 10 10] /XStep 16 /YStep 14') }, content: '/Pattern cs /P1 scn 0 0 100 100 re f' });
add('tiling-step-smaller', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 12 12] /XStep 8 /YStep 8', '1 0 0 rg 0 0 12 12 re f 0 0 1 rg 4 4 4 4 re f') }, content: '/Pattern cs /P1 scn 0 0 100 100 re f' });
add('tiling-matrix', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 10 10] /XStep 10 /YStep 10 /Matrix [0.8 0.6 -0.6 0.8 5 5]') }, content: '/Pattern cs /P1 scn 10 10 80 80 re f' });
add('tiling-scaled-matrix', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 10 10] /XStep 10 /YStep 10 /Matrix [2.5 0 0 2.5 0 0]') }, content: '/Pattern cs /P1 scn 0 0 100 100 re f' });
add('tiling-stroke', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 10 10] /XStep 10 /YStep 10') }, content: '/Pattern CS /P1 SCN 14 w 20 20 60 60 re S' });
add('tiling-uncoloured', {
  resources: `<< /ColorSpace << /CS1 [/Pattern /DeviceRGB] >> /Pattern << /P1 5 0 R >> >>`,
  objects: { 5: stream('/PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>', ascii('0 0 5 5 re f 5 5 5 5 re f')) },
  content: '/CS1 cs 0.8 0 0.6 /P1 scn 0 0 50 100 re f 0 0.5 0.8 /P1 scn 50 0 50 100 re f',
});
add('tiling-within-one-cell', { resources: patternResources(), objects: { 5: tiling('/BBox [0 0 100 100] /XStep 100 /YStep 100', '1 0 0 rg 0 0 50 50 re f 0 0 1 rg 50 50 50 50 re f') }, content: '/Pattern cs /P1 scn 10 10 30 30 re f 60 60 30 30 re f' });
add('tiling-alpha', {
  resources: `<< /ExtGState << /GS1 << /ca 0.5 >> >> /Pattern << /P1 5 0 R >> >>`,
  objects: { 5: tiling('/BBox [0 0 10 10] /XStep 10 /YStep 10') },
  content: '0.9 0.9 0.2 rg 0 0 100 50 re f /GS1 gs /Pattern cs /P1 scn 0 0 100 100 re f',
});
add('tiling-nested-shading', {
  resources: patternResources(),
  objects: {
    5: stream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 20 20] /XStep 20 /YStep 20 /Resources << /Shading << /S1 6 0 R >> >>', ascii('/S1 sh')),
    6: shading(2, '/Coords [0 0 20 0] /Extend [true true]'),
  },
  content: '/Pattern cs /P1 scn 0 0 100 100 re f',
});

// Constant alpha and blend modes.
add('constant-alpha', {
  resources: '<< /ExtGState << /GS1 << /ca 0.4 /CA 0.6 >> >> >>',
  content: '0.2 0.4 0.9 rg 0 0 60 60 re f /GS1 gs 1 0.3 0 rg 0 0 1 RG 10 w 30 30 50 50 re B',
});
const blendModes = ['Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion', 'Hue', 'Saturation', 'Color', 'Luminosity', 'Normal'];
add('blend-modes', {
  mediaBox: '0 0 160 160',
  resources: `<< /ExtGState << ${blendModes.map((mode, i) => `/B${i} << /BM /${mode} >>`).join(' ')} >> >>`,
  content: blendModes
    .map((_, i) => {
      const x = (i % 4) * 40;
      const y = Math.floor(i / 4) * 40;
      return `q 0.9 0.5 0.1 rg ${x} ${y} 40 20 re f 0.2 0.5 0.9 rg ${x} ${y + 20} 40 20 re f /B${i} gs 0.3 0.6 0.8 rg ${x + 5} ${y + 5} 30 30 re f Q`;
    })
    .join('\n'),
});
add('blend-alpha', {
  resources: '<< /ExtGState << /GS1 << /BM /Multiply /ca 0.6 >> >> >>',
  content: '1 0.8 0.2 rg 0 0 100 100 re f /GS1 gs 0.2 0.6 1 rg 20 20 60 60 re f',
});

// Transparency groups.
const overlap = '1 0 0 rg 10 10 50 50 re f 0 0 1 rg 40 40 50 50 re f';
add('group-isolated-alpha', {
  resources: '<< /ExtGState << /GS1 << /ca 0.5 >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group(overlap) },
  content: '0.9 0.9 0.2 rg 0 0 100 30 re f q /GS1 gs /Fm1 Do Q',
});
add('group-no-alpha', {
  resources: '<< /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group(overlap) },
  content: '0.9 0.9 0.2 rg 0 0 100 30 re f /Fm1 Do',
});
add('group-blend-inside', {
  resources: '<< /ExtGState << /GS1 << /BM /Multiply >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group('0.9 0.9 0.2 rg 0 0 100 100 re f /GS1 gs 0.2 0.6 1 rg 20 20 60 60 re f', { resources: '<< /ExtGState << /GS1 << /BM /Multiply >> >> >>' }) },
  content: '0.8 0.2 0.2 rg 0 0 100 50 re f /Fm1 Do',
});
add('group-blend-outside', {
  resources: '<< /ExtGState << /GS1 << /BM /Multiply >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group(overlap, { extra: '' }) },
  content: '0.9 0.9 0.2 rg 0 0 100 50 re f q /GS1 gs /Fm1 Do Q',
});
add('group-not-isolated', {
  resources: '<< /ExtGState << /GS1 << /ca 0.6 >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group(overlap, { extra: '/I false' }) },
  content: '0.9 0.9 0.2 rg 0 0 100 50 re f q /GS1 gs /Fm1 Do Q',
});
add('group-matrix-bbox', {
  resources: '<< /ExtGState << /GS1 << /ca 0.5 >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group('1 0 0 rg 0 0 40 40 re f 0 0 1 rg 20 20 40 40 re f', { bbox: '0 0 50 50', matrix: '0.9 0.4 -0.4 0.9 40 10' }) },
  content: 'q /GS1 gs /Fm1 Do Q',
});
add('group-nested', {
  resources: '<< /ExtGState << /GS1 << /ca 0.5 >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: {
    5: group('/GS1 gs /Fm2 Do 0 0.6 0 rg 60 60 30 30 re f', { resources: '<< /ExtGState << /GS1 << /ca 0.7 >> >> /XObject << /Fm2 6 0 R >> >>' }),
    6: group(overlap),
  },
  content: '0.9 0.9 0.2 rg 0 0 100 40 re f q /GS1 gs /Fm1 Do Q',
});
add('group-gray', {
  resources: '<< /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group('1 0 0 rg 10 10 50 50 re f 0 0 1 rg 40 40 50 50 re f', { extra: '/I true /CS /DeviceGray' }) },
  content: '/Fm1 Do',
});
add('group-transfer', {
  resources: '<< /ExtGState << /GS1 << /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> >> >> /XObject << /Fm1 5 0 R >> >>',
  objects: { 5: group(overlap) },
  content: 'q /GS1 gs /Fm1 Do Q 0.2 0.8 0.2 rg 0 80 100 20 re f',
});

// Soft masks.
const maskGradient = group('/S1 sh', { extra: '/CS /DeviceGray', resources: `<< /Shading << /S1 << /ShadingType 2 /ColorSpace /DeviceGray /Coords [10 0 90 0] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> >> >>` });
add('smask-luminosity-gradient', softMask(maskGradient, '/S /Luminosity', '0.9 0.9 0.2 rg 0 0 100 100 re f /GS1 gs 0.8 0.1 0.1 rg 0 0 100 100 re f'));
add('smask-luminosity-shapes', softMask(group('1 g 10 10 40 40 re f 0.5 g 50 50 40 40 re f', { extra: '/CS /DeviceGray' }), '/S /Luminosity', '/GS1 gs 0.1 0.3 0.9 rg 0 0 100 100 re f'));
add('smask-luminosity-backdrop', softMask(group('0 g 20 20 60 60 re f', { extra: '/CS /DeviceGray' }), '/S /Luminosity /BC [1]', '/GS1 gs 0.1 0.3 0.9 rg 0 0 100 100 re f'));
add('smask-luminosity-transfer', softMask(maskGradient, '/S /Luminosity /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >>', '/GS1 gs 0.8 0.1 0.1 rg 0 0 100 100 re f'));
add('smask-alpha-shapes', softMask(group('0 g 10 10 50 50 re f', { extra: '' }), '/S /Alpha', '/GS1 gs 0.1 0.6 0.2 rg 0 0 100 100 re f'));
add('smask-alpha-transfer', softMask(group('0 g 10 10 50 50 re f', { extra: '' }), '/S /Alpha /TR << /FunctionType 2 /Domain [0 1] /C0 [0.3] /C1 [1] /N 1 >>', '/GS1 gs 0.1 0.6 0.2 rg 0 0 100 100 re f'));
add('smask-reset', softMask(group('1 g 0 0 50 100 re f', { extra: '/CS /DeviceGray' }), '/S /Luminosity', 'q /GS1 gs 1 0 0 rg 0 0 100 40 re f Q 0 0.6 0 rg 0 60 100 40 re f'));
add('smask-strokes-and-paths', softMask(maskGradient, '/S /Luminosity', '/GS1 gs 0.1 0.1 0.8 RG 8 w 10 10 m 90 90 l S 0.8 0.5 0 rg 20 60 30 30 re f'));
add('smask-over-pattern', softMask(maskGradient, '/S /Luminosity', '/GS1 gs /Pattern cs /P1 scn 0 0 100 100 re f', {
  objects: { 6: tiling('/BBox [0 0 10 10] /XStep 10 /YStep 10') },
  resources: '/Pattern << /P1 6 0 R >>',
}));
add('smask-group-inside', softMask(maskGradient, '/S /Luminosity', '0.9 0.9 0.2 rg 0 0 100 100 re f /GS1 gs /Fm1 Do', {
  objects: { 6: group(overlap) },
  resources: '/XObject << /Fm1 6 0 R >>',
}));

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
  note: 'pdf.js 6.4.299 (legacy build, no worker, no system fonts, the bundled standard fonts) on generated one-page PDFs drawn on @napi-rs/canvas 1.0.11 as renderPdfPageDirect draws them: a canvas of the ceiling of the viewport, white background. png is the canvas as a PNG file (hex). tolerance is the largest difference of any channel and the mean difference per channel that the Rust rasteriser is held to, before the allowance of the case (gradient banding, mesh edges, blend arithmetic) that the replay writes down.',
  pdfjs: pdfjs.version,
  tolerance: { max: 8, mean: 0.8 },
  cases: [],
};
for (const spec of cases) {
  const renders = [];
  for (const scale of spec.scales) renders.push(await render(spec.pdf, scale));
  out.cases.push({ name: spec.name, pdf: spec.pdf.toString('hex'), renders });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-render-paint');
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
writeSetManifest(fixtures, { set: 'office-render-paint', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases, ${out.cases.reduce((n, c) => n + c.renders.length, 0)} renders`);
