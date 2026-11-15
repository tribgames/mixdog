#!/usr/bin/env node
// Golden of pdf.js 6.4's image decoding (crate mixdog-pdf: image/). A generated PDF per case paints one image (or a few)
// and pdf.js (the legacy build the office engine loads, opened with the office engine's options and without a worker)
// turns each into the object it hands the renderer: the width, height and kind (`ImageKind`) of the image and its
// bytes, or nothing when the image cannot be decoded. The recorder reads `page.getOperatorList()` and, for every
// `paintImageXObject`, `paintInlineImageXObject`, `paintImageMaskXObject` and `paintSolidColorImageMask`, the object
// `page.objs` holds. The Rust side opens the same bytes, walks the same operator list and must give every image alike
// (dimensions and kinds exactly, pixels exactly, except where the case says `tolerance`: a DCT image is within 2
// levels of the recorded pixels, a lossy JPEG 2000 image within 1).
//
//   node benchmarks/rust-core/recorders/record-office-images.mjs --tree <product tree>
//
// Configuration. pdf.js runs without `OffscreenCanvas` and `ImageDecoder` (the Node configuration), so every image
// is decoded in JavaScript. The product's own opening options give no `wasmUrl`, and without it pdf.js cannot load
// the WebAssembly modules of JBIG2, CCITT and JPEG 2000: such an image is not decoded at all. The reference that
// these cases record is pdf.js with its wasm files supplied (`wasmUrl`), because that is the decoder the Rust code
// reproduces. The first case of each codec records, beside it, what the product's own configuration does
// (`withoutWasm`).
//
// Inputs besides the code: the JBIG2 and CCITT streams of native/core/fixtures/office-jbig2/cases.txt (written by
// record-office-jbig2.mjs) and the JPEG 2000 streams of native/core/fixtures/office-jpx (record-office-jpx.mjs);
// JPEG streams are made here with sharp.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-images.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const pdfjs = await importFrom(tree, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const sharp = createRequire(path.join(tree, 'package.json'))('sharp');
const { OPS } = pdfjs;
const wasmUrl = `${pathToFileURL(path.join(tree, 'node_modules', 'pdfjs-dist', 'wasm')).href}/`;
const corpus = (name) => path.join(FIXTURES_ROOT, name);

// ---- bytes ---------------------------------------------------------------------------------------------------------

const lcg = (count, seed, mask = 255) => {
  let state = seed >>> 0;
  return Buffer.from(
    Array.from({ length: count }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 24) & mask;
    }),
  );
};
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const stream = (dict, bytes) => ({ dict, bytes: Buffer.from(bytes) });
const flate = (bytes) => deflateSync(Buffer.from(bytes));
const asciiHex = (bytes) => Buffer.from(`${Buffer.from(bytes).toString('hex')}>`, 'latin1');
/** RunLengthDecode of literal runs only. */
const runLength = (bytes) => {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 100) {
    const chunk = bytes.subarray(i, i + 100);
    parts.push(Buffer.from([chunk.length - 1]), chunk);
  }
  parts.push(Buffer.from([128]));
  return Buffer.concat(parts);
};

function buildPdf(objects, content, resources) {
  const all = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources ${resources} >>`],
    [4, stream('', Buffer.from(content, 'latin1'))],
    ...Object.entries(objects).map(([num, body]) => [Number(num), body]),
  ]);
  const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets = new Map();
  let size = parts[0].length;
  for (const [num, body] of [...all].sort((a, b) => a[0] - b[0])) {
    offsets.set(num, size);
    const chunk =
      typeof body === 'string'
        ? Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1')
        : Buffer.concat([
            Buffer.from(`${num} 0 obj\n<< ${body.dict} /Length ${body.bytes.length} >>\nstream\n`, 'latin1'),
            body.bytes,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ]);
    parts.push(chunk);
    size += chunk.length;
  }
  const last = Math.max(...all.keys());
  let xref = `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= last; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

// ---- pdf.js --------------------------------------------------------------------------------------------------------

const typedHex = (data) => (data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex') : null);

async function objectOf(page, id) {
  const value = await Promise.race([
    new Promise((resolve) => page.objs.get(id, resolve)),
    new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
  ]);
  if (value === undefined) throw new Error(`image ${id} never arrived`);
  return value;
}

/** What pdf.js hands the renderer for every image the page paints, in order. */
async function run(bytes, options = {}) {
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: false,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    ...(options.wasm === false ? {} : { wasmUrl }),
  });
  const document = await loading.promise;
  const page = await document.getPage(1);
  const list = await page.getOperatorList();
  const out = [];
  for (let i = 0; i < list.fnArray.length; i += 1) {
    const fn = list.fnArray[i];
    const argv = list.argsArray[i];
    if (fn === OPS.paintSolidColorImageMask) out.push({ op: 'solid' });
    else if (fn === OPS.paintInlineImageXObject) out.push(describe('inline', argv[0]));
    else if (fn === OPS.paintImageXObject) out.push(describe('image', await objectOf(page, argv[0])));
    else if (fn === OPS.paintImageMaskXObject) out.push(describe('mask', await objectOf(page, argv[0].data)));
  }
  await loading.destroy();
  return out;
}

function describe(op, image) {
  if (!image) return { op, failed: true };
  const entry = { op, width: image.width, height: image.height };
  if (op !== 'mask') entry.kind = image.kind;
  if (image.interpolate !== undefined) entry.interpolate = image.interpolate;
  entry.data = typedHex(image.data);
  return entry;
}

// ---- cases ---------------------------------------------------------------------------------------------------------

const cases = [];
const XOBJECT = '<< /XObject << /Im0 10 0 R >> /ColorSpace << /CS0 20 0 R >> >>';
const DO = 'q 10 0 0 10 0 0 cm /Im0 Do Q\n';

/** An image XObject case: `dict` is the image dictionary text, `bytes` its data. */
function image(name, group, dict, bytes, extra = {}) {
  const objects = { 10: stream(`/Type /XObject /Subtype /Image ${dict}`, bytes), ...(extra.objects ?? {}) };
  cases.push({ name, group, tolerance: extra.tolerance ?? 0, inline: false, pdf: buildPdf(objects, extra.content ?? DO, extra.resources ?? XOBJECT) });
}

/** A case whose content stream is given whole (inline images, several images). */
function page(name, group, content, objects = {}, extra = {}) {
  cases.push({ name, group, tolerance: extra.tolerance ?? 0, inline: !!extra.inline, pdf: buildPdf(objects, content, extra.resources ?? XOBJECT) });
}

const gray = (w, h, seed = 1) => lcg(w * h, seed);
const rgbBytes = (w, h, seed = 2) => lcg(w * h * 3, seed);
const rowsOf1 = (w, h, seed) => lcg(((w + 7) >> 3) * h, seed);
const GRAY = '/ColorSpace /DeviceGray /BitsPerComponent 8';
const RGB = '/ColorSpace /DeviceRGB /BitsPerComponent 8';

// components and depths
image('gray8', 'raw', `/Width 5 /Height 3 ${GRAY}`, gray(5, 3));
image('gray8-decode-inverted', 'raw', `/Width 5 /Height 3 ${GRAY} /Decode [1 0]`, gray(5, 3));
image('gray8-decode-partial', 'raw', `/Width 5 /Height 3 ${GRAY} /Decode [0.2 0.7]`, gray(5, 3));
image('gray8-truncated', 'raw', `/Width 5 /Height 4 ${GRAY}`, gray(5, 2));
image('gray8-interpolate', 'raw', `/Width 3 /Height 3 ${GRAY} /Interpolate true`, gray(3, 3));
image('gray1-padded-rows', 'raw', '/Width 10 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 1', rowsOf1(10, 3, 3));
image('gray1-decode-inverted', 'raw', '/Width 10 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0]', rowsOf1(10, 3, 3));
image('gray1-byte-rows', 'raw', '/Width 16 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 1', rowsOf1(16, 2, 4));
image('gray2', 'raw', '/Width 7 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 2', lcg(2 * 3, 5));
image('gray4', 'raw', '/Width 5 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 4', lcg(3 * 3, 6));
image('gray4-decode', 'raw', '/Width 5 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 4 /Decode [1 0]', lcg(3 * 3, 6));
image('gray16', 'raw', '/Width 5 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 16', lcg(5 * 2 * 2, 7));
image('rgb8', 'raw', `/Width 4 /Height 3 ${RGB}`, rgbBytes(4, 3));
image('rgb8-decode-inverted', 'raw', `/Width 4 /Height 3 ${RGB} /Decode [1 0 1 0 1 0]`, rgbBytes(4, 3));
image('rgb8-decode-swapped-ranges', 'raw', `/Width 4 /Height 3 ${RGB} /Decode [0 0.5 0.25 1 0 1]`, rgbBytes(4, 3));
image('rgb4', 'raw', '/Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 4', lcg(5 * 2, 8));
image('rgb2', 'raw', '/Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 2', lcg(3 * 2, 9));
image('rgb16', 'raw', '/Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 16', lcg(2 * 2 * 6, 10));
image('rgb1', 'raw', '/Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 1', lcg(2 * 2, 11));
image('rgb-abbreviations', 'raw', '/Width 3 /Height 2 /CS /RGB /BPC 8', rgbBytes(3, 2));
image('cmyk8', 'raw', '/Width 3 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 8', lcg(3 * 2 * 4, 12));
image('cmyk8-decode-inverted', 'raw', '/Width 3 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Decode [1 0 1 0 1 0 1 0]', lcg(3 * 2 * 4, 12));
image('cmyk4', 'raw', '/Width 3 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 4', lcg(6 * 2, 13));
const PALETTE = '<ff0000 00ff00 0000ff ffff00 00ffff ff00ff 808080 000000>';
image('indexed8', 'raw', `/Width 6 /Height 2 /ColorSpace [/Indexed /DeviceRGB 7 ${PALETTE}] /BitsPerComponent 8`, lcg(12, 14, 7));
image('indexed4', 'raw', `/Width 5 /Height 2 /ColorSpace [/Indexed /DeviceRGB 7 ${PALETTE}] /BitsPerComponent 4`, lcg(3 * 2, 15, 0x77));
image('indexed2', 'raw', `/Width 7 /Height 2 /ColorSpace [/Indexed /DeviceRGB 3 <ff0000 00ff00 0000ff ffffff>] /BitsPerComponent 2`, lcg(2 * 2, 16));
image('indexed1', 'raw', `/Width 9 /Height 2 /ColorSpace [/Indexed /DeviceRGB 1 <000000 ffffff>] /BitsPerComponent 1`, rowsOf1(9, 2, 17));
image('indexed8-decode', 'raw', `/Width 6 /Height 2 /ColorSpace [/Indexed /DeviceRGB 7 ${PALETTE}] /BitsPerComponent 8 /Decode [7 0]`, lcg(12, 18, 7));
image('indexed8-large', 'raw', `/Width 20 /Height 20 /ColorSpace [/Indexed /DeviceRGB 7 ${PALETTE}] /BitsPerComponent 8`, lcg(400, 19, 7));
image('indexed-lookup-stream', 'raw', '/Width 4 /Height 2 /ColorSpace [/Indexed /DeviceRGB 3 21 0 R] /BitsPerComponent 8', lcg(8, 20, 3), {
  objects: { 21: stream('', Buffer.from('ff000000ff000000ffffffff', 'hex')) },
});
image('indexed-gray-base', 'raw', '/Width 4 /Height 2 /ColorSpace [/Indexed /DeviceGray 3 <00 55 aa ff>] /BitsPerComponent 8', lcg(8, 21, 3));
image('calgray', 'raw', '/Width 4 /Height 2 /ColorSpace [/CalGray << /WhitePoint [0.9505 1 1.089] /Gamma 2.2 >>] /BitsPerComponent 8', gray(4, 2, 22));
image('calrgb', 'raw', '/Width 4 /Height 2 /ColorSpace [/CalRGB << /WhitePoint [0.9505 1 1.089] /Gamma [2.2 2.2 2.2] /Matrix [0.4124 0.2126 0.0193 0.3576 0.7152 0.1192 0.1805 0.0722 0.9505] >>] /BitsPerComponent 8', rgbBytes(4, 2, 23));
image('lab', 'raw', '/Width 4 /Height 2 /ColorSpace [/Lab << /WhitePoint [0.9642 1 0.8249] /Range [-128 127 -128 127] >>] /BitsPerComponent 8', rgbBytes(4, 2, 24));
const TINT = '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 1 0] /N 1 >>';
image('separation', 'raw', `/Width 4 /Height 2 /ColorSpace [/Separation /Spot /DeviceCMYK ${TINT}] /BitsPerComponent 8`, gray(4, 2, 25));
image('separation-4bit', 'raw', `/Width 4 /Height 2 /ColorSpace [/Separation /Spot /DeviceCMYK ${TINT}] /BitsPerComponent 4`, lcg(4, 26));
image('iccbased-n3', 'raw', '/Width 4 /Height 2 /ColorSpace [/ICCBased 21 0 R] /BitsPerComponent 8', rgbBytes(4, 2, 27), {
  objects: { 21: stream('/N 3 /Alternate /DeviceRGB', Buffer.alloc(4)) },
});
image('iccbased-n1', 'raw', '/Width 4 /Height 2 /ColorSpace [/ICCBased 21 0 R] /BitsPerComponent 8', gray(4, 2, 28), {
  objects: { 21: stream('/N 1', Buffer.alloc(4)) },
});
image('colour-space-by-reference', 'raw', '/Width 4 /Height 2 /ColorSpace 21 0 R /BitsPerComponent 8', rgbBytes(4, 2, 29), { objects: { 21: '/DeviceRGB' } });
image('colour-space-named-in-resources', 'raw', '/Width 4 /Height 2 /ColorSpace /CS0 /BitsPerComponent 8', rgbBytes(4, 2, 30), {
  objects: { 20: '[/Indexed /DeviceRGB 1 <ff0000 0000ff>]' },
});
image('wide', 'raw', `/Width 300 /Height 2 ${GRAY}`, gray(300, 2, 31));
image('no-colour-space', 'failing', '/Width 4 /Height 2 /BitsPerComponent 8', gray(4, 2, 32));
image('no-bits-per-component', 'failing', '/Width 4 /Height 2 /ColorSpace /DeviceGray', gray(4, 2, 33));
image('zero-width', 'failing', `/Width 0 /Height 2 ${GRAY}`, gray(4, 2, 34));
image('pattern-colour-space', 'failing', '/Width 4 /Height 2 /ColorSpace /Pattern /BitsPerComponent 8', gray(4, 2, 35));

// filters
image('flate-rgb', 'filters', `/Width 4 /Height 3 ${RGB} /Filter /FlateDecode`, flate(rgbBytes(4, 3, 36)));
image('flate-predictor', 'filters', `/Width 4 /Height 3 ${RGB} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns 4 >>`, flate(Buffer.concat(Array.from({ length: 3 }, (_, r) => Buffer.concat([Buffer.from([2]), rgbBytes(4, 1, 40 + r)])))));
image('ascii-hex-gray', 'filters', `/Width 5 /Height 3 ${GRAY} /Filter /ASCIIHexDecode`, asciiHex(gray(5, 3, 37)));
image('ascii-hex-then-flate', 'filters', `/Width 5 /Height 3 ${GRAY} /Filter [/ASCIIHexDecode /FlateDecode]`, asciiHex(flate(gray(5, 3, 38))));
image('run-length-rgb', 'filters', `/Width 4 /Height 3 ${RGB} /Filter /RunLengthDecode`, runLength(rgbBytes(4, 3, 39)));

// masks
const stencil = (w, h, seed, dict = '') => stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ImageMask true /BitsPerComponent 1 ${dict}`, rowsOf1(w, h, seed));
page('imagemask', 'mask', DO, { 10: stencil(8, 4, 41) });
page('imagemask-padded-rows', 'mask', DO, { 10: stencil(10, 3, 42) });
page('imagemask-decode-inverted', 'mask', DO, { 10: stencil(10, 3, 42, '/Decode [1 0]') });
page('imagemask-interpolate', 'mask', DO, { 10: stencil(8, 2, 43, '/Interpolate true') });
page('imagemask-short-data', 'mask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 16 /Height 6 /ImageMask true /BitsPerComponent 1', rowsOf1(16, 2, 44)) });
page('imagemask-short-data-inverted', 'mask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 16 /Height 6 /ImageMask true /BitsPerComponent 1 /Decode [1 0]', rowsOf1(16, 2, 44)) });
for (const [label, byte, decode] of [['paint', 0x00, ''], ['clear', 0x80, ''], ['inverse-paint', 0x80, '/Decode [1 0]'], ['inverse-clear', 0x00, '/Decode [1 0]']]) {
  page(`imagemask-1x1-${label}`, 'mask', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1 ${decode}`, Buffer.from([byte])) });
}
page('imagemask-1x1-empty', 'mask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1', Buffer.alloc(0)) });
page('imagemask-flate', 'mask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 8 /Height 4 /ImageMask true /BitsPerComponent 1 /Filter /FlateDecode', flate(rowsOf1(8, 4, 45))) });
page('imagemask-abbreviated-keys', 'mask', DO, { 10: stream('/Type /XObject /Subtype /Image /W 8 /H 2 /IM true /BPC 1 /I true', rowsOf1(8, 2, 46)) });

const rgbWith = (extra, w = 4, h = 4, seed = 50) => stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ${RGB} ${extra}`, rgbBytes(w, h, seed));
page('stencil-same-size', 'mask', DO, { 10: rgbWith('/Mask 11 0 R'), 11: stencil(4, 4, 51) });
page('stencil-larger', 'mask', DO, { 10: rgbWith('/Mask 11 0 R'), 11: stencil(8, 8, 52) });
page('stencil-smaller', 'mask', DO, { 10: rgbWith('/Mask 11 0 R'), 11: stencil(2, 2, 53) });
page('stencil-decode', 'mask', DO, { 10: rgbWith('/Mask 11 0 R'), 11: stencil(4, 4, 51, '/Decode [1 0]') });
page('stencil-without-imagemask', 'mask', DO, { 10: rgbWith('/Mask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 1', rowsOf1(4, 4, 54)) });
page('stencil-no-size', 'mask', DO, { 10: rgbWith('/Mask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /ImageMask true /BitsPerComponent 1', rowsOf1(4, 4, 54)) });
page('colourkey-rgb', 'mask', DO, { 10: rgbWith('/Mask [0 120 0 255 0 255]') });
page('colourkey-gray', 'mask', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width 4 /Height 4 ${GRAY} /Mask [100 200]`, gray(4, 4, 55)) });
page('colourkey-indexed', 'mask', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width 6 /Height 2 /ColorSpace [/Indexed /DeviceRGB 7 ${PALETTE}] /BitsPerComponent 8 /Mask [1 3]`, lcg(12, 56, 7)) });
page('colourkey-decode', 'mask', DO, { 10: rgbWith('/Mask [0 120 0 255 0 255] /Decode [1 0 1 0 1 0]') });
page('colourkey-short-array', 'mask', DO, { 10: rgbWith('/Mask [0 120]') });
page('colourkey-4bit', 'mask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 4 /Mask [0 7 0 15 0 15]', lcg(5 * 2, 57)) });
const smask = (w, h, extra = '', bits = 8, seed = 60, colourSpace = '/DeviceGray') =>
  stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${colourSpace} /BitsPerComponent ${bits} ${extra}`, bits === 8 ? lcg(w * h, seed) : rowsOf1(w, h, seed));
page('softmask-same-size', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(4, 4) });
page('softmask-larger', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(8, 6, '', 8, 61) });
page('softmask-smaller', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(2, 3, '', 8, 62) });
page('softmask-wider-only', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(7, 4, '', 8, 63) });
page('softmask-1bit', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(4, 4, '', 1, 64) });
page('softmask-1bit-decode', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(4, 4, '/Decode [1 0]', 1, 64) });
page('softmask-decode', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(4, 4, '/Decode [1 0]') });
page('softmask-4bit', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 4', lcg(8, 65)) });
page('softmask-16bit', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 16', lcg(8, 66)) });
page('softmask-matte', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(4, 4, '/Matte [0.2 0.4 0.6]', 8, 67) });
page('softmask-matte-zero-alpha', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [0.2 0.4 0.6]', Buffer.from([0, 0, 255, 128, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110])) });
page('softmask-on-gray', 'smask', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width 4 /Height 4 ${GRAY} /SMask 11 0 R`, gray(4, 4, 68)), 11: smask(4, 4) });
page('softmask-on-gray1', 'smask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 8 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 1 /SMask 11 0 R', rowsOf1(8, 4, 69)), 11: smask(8, 4) });
page('softmask-on-indexed', 'smask', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width 6 /Height 2 /ColorSpace [/Indexed /DeviceRGB 7 ${PALETTE}] /BitsPerComponent 8 /SMask 11 0 R`, lcg(12, 70, 7)), 11: smask(6, 2) });
page('softmask-on-cmyk', 'smask', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /SMask 11 0 R', lcg(24, 71)), 11: smask(3, 2) });
page('softmask-on-decoded-image', 'smask', DO, { 10: rgbWith('/SMask 11 0 R /Decode [1 0 1 0 1 0]'), 11: smask(4, 4) });
page('softmask-not-gray', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: smask(4, 4, '', 8, 72, '/DeviceRGB') });
page('softmask-no-size', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /ColorSpace /DeviceGray /BitsPerComponent 8', lcg(16, 73)) });
page('softmask-and-mask', 'smask', DO, { 10: rgbWith('/SMask 11 0 R /Mask [0 120 0 255 0 255]'), 11: smask(4, 4) });
page('softmask-flate', 'smask', DO, { 10: rgbWith('/SMask 11 0 R'), 11: stream('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', flate(lcg(16, 74))) });

// DCT
const rawPixels = (w, h, channels, seed) => {
  // smooth gradients with a little noise, so lossy coding is not at its worst
  const noise = lcg(w * h * channels, seed, 15);
  const data = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1)
      for (let c = 0; c < channels; c += 1) data[(y * w + x) * channels + c] = Math.min(255, Math.floor(((x * 255) / w) * (c === 0 ? 1 : 0.5) + ((y * 255) / h) * (c === 1 ? 1 : 0.3) + noise[(y * w + x) * channels + c]));
  return data;
};
async function jpeg(w, h, channels, options = {}, seed = 80) {
  let pipeline = sharp(rawPixels(w, h, channels, seed), { raw: { width: w, height: h, channels } });
  if (options.cmyk) pipeline = pipeline.toColourspace('cmyk');
  return pipeline.jpeg({ quality: 90, ...options.encode }).toBuffer();
}
const DCT = (w, h, cs, extra = '') => `/Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode ${extra}`;
const dct = { tolerance: 2 };
image('dct-gray', 'dct', DCT(17, 13, '/DeviceGray'), await jpeg(17, 13, 1), dct);
image('dct-rgb-420', 'dct', DCT(17, 13, '/DeviceRGB'), await jpeg(17, 13, 3), dct);
image('dct-rgb-444', 'dct', DCT(17, 13, '/DeviceRGB'), await jpeg(17, 13, 3, { encode: { chromaSubsampling: '4:4:4' } }), dct);
image('dct-rgb-progressive', 'dct', DCT(17, 13, '/DeviceRGB'), await jpeg(17, 13, 3, { encode: { progressive: true, chromaSubsampling: '4:4:4' } }), dct);
image('dct-rgb-16x16', 'dct', DCT(16, 16, '/DeviceRGB'), await jpeg(16, 16, 3), dct);
image('dct-rgb-colour-transform-0', 'dct', DCT(17, 13, '/DeviceRGB', '/DecodeParms << /ColorTransform 0 >>'), await jpeg(17, 13, 3), dct);
image('dct-gray-in-rgb-space', 'dct', DCT(17, 13, '/DeviceRGB'), await jpeg(17, 13, 1), dct);
image('dct-cmyk', 'dct', DCT(17, 13, '/DeviceCMYK'), await jpeg(17, 13, 3, { cmyk: true }), dct);
image('dct-cmyk-decode-inverted', 'dct', DCT(17, 13, '/DeviceCMYK', '/Decode [1 0 1 0 1 0 1 0]'), await jpeg(17, 13, 3, { cmyk: true }), dct);
image('dct-gray-decode-inverted', 'dct', DCT(17, 13, '/DeviceGray', '/Decode [1 0]'), await jpeg(17, 13, 1), dct);
image('dct-rgb-decode-inverted', 'dct', DCT(17, 13, '/DeviceRGB', '/Decode [1 0 1 0 1 0]'), await jpeg(17, 13, 3), dct);
image('dct-scaled-down', 'dct', DCT(10, 8, '/DeviceRGB'), await jpeg(17, 13, 3), dct);
image('dct-scaled-up', 'dct', DCT(40, 30, '/DeviceRGB'), await jpeg(17, 13, 3), dct);
image('dct-flate-wrapped', 'dct', DCT(17, 13, '/DeviceRGB').replace('/DCTDecode', '[/FlateDecode /DCTDecode]'), flate(await jpeg(17, 13, 3)), dct);
image('dct-no-colour-space', 'failing', '/Width 17 /Height 13 /BitsPerComponent 8 /Filter /DCTDecode', await jpeg(17, 13, 3), dct);
image('dct-leading-garbage', 'dct', DCT(17, 13, '/DeviceRGB'), Buffer.concat([Buffer.from('garbage'), await jpeg(17, 13, 3)]), dct);
image('dct-truncated', 'dct', DCT(17, 13, '/DeviceRGB'), (await jpeg(17, 13, 3)).subarray(0, 300), dct);
image('dct-not-a-jpeg', 'failing', DCT(17, 13, '/DeviceRGB'), Buffer.from('not a jpeg at all'), dct);
image('dct-indexed', 'dct', `/Width 17 /Height 13 /ColorSpace [/Indexed /DeviceRGB 255 <${hex(lcg(768, 81))}>] /BitsPerComponent 8 /Filter /DCTDecode`, await jpeg(17, 13, 1), dct);
page('dct-smask', 'dct', DO, { 10: stream(`/Type /XObject /Subtype /Image ${DCT(17, 13, '/DeviceRGB', '/SMask 11 0 R')}`, await jpeg(17, 13, 3)), 11: stream(`/Type /XObject /Subtype /Image ${DCT(17, 13, '/DeviceGray')}`, await jpeg(17, 13, 1, {}, 82)) }, dct);
page('dct-colour-key', 'dct', DO, { 10: stream(`/Type /XObject /Subtype /Image ${DCT(17, 13, '/DeviceRGB', '/Mask [0 120 0 255 0 255]')}`, await jpeg(17, 13, 3)) }, dct);
page('dct-imagemask', 'dct', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 16 /Height 8 /ImageMask true /BitsPerComponent 1 /Filter /DCTDecode', await jpeg(16, 8, 1)) }, dct);

// CCITT and JBIG2 (the streams of the codec corpus)
function corpusCases() {
  const text = readFileSync(path.join(corpus('office-jbig2'), 'cases.txt'), 'utf8');
  return text
    .split(/\n\n+/)
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.trim().split('\n');
      const entry = {};
      for (const line of lines) {
        const space = line.indexOf(' ');
        entry[space < 0 ? line : line.slice(0, space)] = space < 0 ? '' : line.slice(space + 1);
      }
      return entry;
    });
}
const corpusAll = corpusCases();
const pick = (kind, pattern, count = 1) => corpusAll.filter((c) => c.kind === kind && pattern.test(c.case ?? c.kind) && Number(c.width) <= 120 && Number(c.height) <= 80 && c.ok !== undefined).slice(0, count);
const ccittParams = (c) => `/K ${c.k} /Columns ${c.columns} /Rows ${c.rows}${c.eol === '1' ? ' /EndOfLine true' : ''}${c.align === '1' ? ' /EncodedByteAlign true' : ''}${c.black === '1' ? ' /BlackIs1 true' : ''}`;
for (const c of corpusAll.filter((x) => x.kind === 'ccitt' && Number(x.width) <= 100 && Number(x.height) <= 60 && /ccitt-random|ccitt-cut-k|ccitt-damaged/.test(x.case ?? '')).filter((_, i) => i % 9 === 0).slice(0, 6)) {
  image(`ccitt-${c.case ?? 'case'}-${c.width}x${c.height}-k${c.k}`, 'ccitt', `/Width ${c.width} /Height ${c.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << ${ccittParams(c)} >>`, Buffer.from(c.data, 'hex'));
}
{
  const c = corpusAll.find((x) => x.kind === 'ccitt' && Number(x.width) >= 8 && Number(x.width) <= 64 && Number(x.height) <= 32 && x.k === '-1');
  if (c) {
    image('ccitt-decode-inverted', 'ccitt', `/Width ${c.width} /Height ${c.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /Decode [1 0] /DecodeParms << ${ccittParams(c)} >>`, Buffer.from(c.data, 'hex'));
    page('ccitt-imagemask', 'ccitt', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ImageMask true /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << ${ccittParams(c)} >>`, Buffer.from(c.data, 'hex')) });
    page('ccitt-smask', 'ccitt', DO, { 10: rgbWith(`/SMask 11 0 R`, Number(c.width), Number(c.height), 90), 11: stream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << ${ccittParams(c)} >>`, Buffer.from(c.data, 'hex')) });
  }
}
const jbig2Cases = [...pick('jbig2', /^generic-t0-\d/, 2), ...pick('jbig2', /^mmr/, 1), ...pick('jbig2', /^compose-op/, 1), ...pick('jbig2', /^header-refs/, 1), ...pick('jbig2', /^damaged-t0/, 1), ...pick('jbig2', /^size/, 1)];
for (const c of jbig2Cases) {
  const globals = c.globals ? { 11: stream('', Buffer.from(c.globals, 'hex')) } : {};
  const parms = c.globals ? '/DecodeParms << /JBIG2Globals 11 0 R >>' : '';
  image(`jbig2-${c.case}`, 'jbig2', `/Width ${c.width} /Height ${c.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode ${parms}`, Buffer.from(c.data, 'hex'), { objects: globals });
}
if (jbig2Cases[0]) {
  const c = jbig2Cases[0];
  page('jbig2-imagemask', 'jbig2', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ImageMask true /BitsPerComponent 1 /Filter /JBIG2Decode`, Buffer.from(c.data, 'hex')) });
  page('jbig2-decode-inverted', 'jbig2', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] /Filter /JBIG2Decode`, Buffer.from(c.data, 'hex')) });
  page('jbig2-indexed', 'jbig2', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace [/Indexed /DeviceRGB 1 <ff0000 0000ff>] /BitsPerComponent 1 /Filter /JBIG2Decode`, Buffer.from(c.data, 'hex')) });
  page('jbig2-no-colour-space', 'jbig2', DO, { 10: stream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /Filter /JBIG2Decode`, Buffer.from(c.data, 'hex')) });
}

// JPEG 2000 (the streams of the codec corpus)
const jpxFile = (name) => readFileSync(path.join(corpus('office-jpx'), name));
const jpx = (name, cs, extra = '', tolerance = 0) => {
  const bytes = jpxFile(name);
  image(`jpx-${name.replace(/\.(j2k|jp2)$/, '')}${cs ? `-${cs.replace(/[^A-Za-z]/g, '')}` : ''}${extra ? `-${extra.replace(/[^A-Za-z0-9]/g, '')}` : ''}`, 'jpx', `/Width 1 /Height 1 ${cs ? `/ColorSpace ${cs}` : ''} /BitsPerComponent 8 /Filter /JPXDecode ${extra}`, bytes, { tolerance });
};
jpx('gray-lossless.j2k', '/DeviceGray');
jpx('gray-lossless.j2k', '');
jpx('rgb-lossy-tiled.j2k', '/DeviceRGB', '', 1);
jpx('rgb-lossy-tiled.j2k', '', '', 1);
jpx('rgb-lossy-tiled.j2k', '/DeviceRGB', '/Decode [1 0 1 0 1 0]', 1);
jpx('jp2-alpha.jp2', '');
jpx('jp2-alpha.jp2', '', '/SMaskInData 1');
jpx('jp2-alpha.jp2', '', '/SMaskInData 2');
jpx('jp2-palette-xl.jp2', '');
jpx('jp2-palette-xl.jp2', '[/Indexed /DeviceRGB 255 <' + '00'.repeat(768) + '>]');
page('jpx-smask', 'jpx', DO, { 10: stream('/Type /XObject /Subtype /Image /Width 64 /Height 48 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode /SMask 11 0 R', jpxFile('gray-lossless.j2k')), 11: smask(64, 48, '', 8, 95) });

// inline images
const inline = (dict, bytes, tail = '') => Buffer.concat([Buffer.from(`q 10 0 0 10 0 0 cm\nBI ${dict} ID\n`, 'latin1'), Buffer.from(bytes), Buffer.from(`\nEI Q${tail}\n`, 'latin1')]).toString('latin1');
const safe = (n, seed) => lcg(n, seed, 0x3f);
page('inline-rgb-small', 'inline', inline('/W 4 /H 3 /BPC 8 /CS /RGB', safe(36, 100)));
page('inline-gray-small', 'inline', inline('/W 5 /H 3 /BPC 8 /CS /G', safe(15, 101)));
page('inline-gray1-small', 'inline', inline('/W 10 /H 3 /BPC 1 /CS /G', safe(6, 102)));
page('inline-gray1-decode', 'inline', inline('/W 10 /H 3 /BPC 1 /CS /G /D [1 0]', safe(6, 102)));
page('inline-cmyk-small', 'inline', inline('/W 3 /H 2 /BPC 8 /CS /CMYK', safe(24, 103)));
page('inline-ascii-hex', 'inline', inline('/W 4 /H 3 /BPC 8 /CS /RGB /F /AHx', Buffer.from(`${hex(lcg(36, 104))}>`, 'latin1')));
page('inline-ascii-hex-flate', 'inline', inline('/W 4 /H 3 /BPC 8 /CS /RGB /F [/AHx /Fl]', Buffer.from(`${hex(flate(lcg(36, 105)))}>`, 'latin1')));
page('inline-named-colour-space', 'inline', inline('/W 4 /H 2 /BPC 8 /CS /CS0', safe(8, 106)), { 20: '[/Indexed /DeviceRGB 1 <ff0000 0000ff>]' });
page('inline-indexed-array', 'inline', inline('/W 4 /H 2 /BPC 8 /CS [/I /RGB 1 <00ff00 ff00ff>]', safe(8, 107)));
page('inline-mask', 'inline', inline('/W 8 /H 3 /IM true /BPC 1', safe(3, 108)));
page('inline-mask-decode', 'inline', inline('/W 8 /H 3 /IM true /BPC 1 /D [1 0]', safe(3, 108)));
page('inline-mask-1x1', 'inline', inline('/W 1 /H 1 /IM true /BPC 1', Buffer.from([0x7f])));
page('inline-interpolate', 'inline', inline('/W 4 /H 3 /BPC 8 /CS /RGB /I true', safe(36, 109)));
page('inline-large-gray', 'inline', inline('/W 100 /H 120 /BPC 8 /CS /G', safe(12000, 110)), {}, { inline: true });
page('inline-large-rgb-decode', 'inline', inline('/W 100 /H 110 /BPC 8 /CS /RGB /D [1 0 1 0 1 0]', safe(33000, 111)), {}, { inline: true });
page('inline-large-named-colour-space', 'inline', inline('/W 100 /H 110 /BPC 8 /CS /CS0', safe(11000, 112)), { 20: '[/Indexed /DeviceRGB 1 <ff0000 0000ff>]' }, { inline: true });
page('inline-two-images', 'inline', `${inline('/W 2 /H 2 /BPC 8 /CS /G', safe(4, 113))}${inline('/W 2 /H 2 /BPC 8 /CS /RGB', safe(12, 114))}`);
page('inline-no-bpc', 'inline', inline('/W 2 /H 2 /CS /G', safe(4, 115)));
page('inline-dct-small', 'inline', inline('/W 17 /H 13 /BPC 8 /CS /RGB /F /DCT', await jpeg(17, 13, 3)), {}, dct);

// ---- run -----------------------------------------------------------------------------------------------------------

const out = {
  note: 'pdf.js 6.4.299 (legacy build, no worker, no OffscreenCanvas, no ImageDecoder, wasmUrl supplied) on generated PDFs: the images the page paints, in order. kind is pdf.js ImageKind (1 gray 1bpp, 2 rgb, 3 rgba); `failed` is an image pdf.js could not decode. tolerance is the largest difference allowed per byte. `inline` marks a large inline image, which pdf.js paints as an image XObject whose colour space is read from the resources.',
  pdfjs: pdfjs.version,
  cases: [],
  withoutWasm: [],
};
for (const spec of cases) {
  const images = await run(spec.pdf);
  out.cases.push({ name: spec.name, group: spec.group, tolerance: spec.tolerance, inline: spec.inline, pdf: spec.pdf.toString('hex'), images });
}
for (const name of ['ccitt-', 'jbig2-', 'jpx-']) {
  const spec = cases.find((c) => c.name.startsWith(name));
  if (spec) out.withoutWasm.push({ name: spec.name, images: await run(spec.pdf, { wasm: false }) });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-images');
mkdirSync(fixtures, { recursive: true });
const lines = [
  '{',
  `  "note": ${JSON.stringify(out.note)},`,
  `  "pdfjs": ${JSON.stringify(out.pdfjs)},`,
  `  "withoutWasm": ${JSON.stringify(out.withoutWasm)},`,
  `  "cases": [\n${out.cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
  '}',
  '',
];
const data = lines.join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-images', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
const failed = out.cases.filter((c) => c.images.some((i) => i.failed)).map((c) => c.name);
console.log(`golden.json ${data.length} bytes, ${out.cases.length} cases, failed images in: ${failed.join(', ')}`);
