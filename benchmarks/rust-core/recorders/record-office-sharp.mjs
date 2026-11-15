#!/usr/bin/env node
// The twin corpus of `mixdog-raster` (WP nr-office-raster-image): what sharp (libvips) answers to the image calls the
// office code makes, recorded from the product's own sharp. Inputs are built here with the tree's sharp (a noise photo,
// an odd-sized JPEG, a flat graphic, alpha pictures, grey, grey and alpha, palette, 16-bit, EXIF-rotated, density), so the
// corpus needs no binary file beside it.
//
//   node benchmarks/rust-core/recorders/record-office-sharp.mjs --tree <tree>     (tree = the Node product with node_modules)
//
// Writes native/core/fixtures/office-sharp/golden.json (+ MANIFEST.json): `inputs` (id -> format and base64 bytes) and
// `cases`. A case is `{ name, source, steps, output }`: `source` is `{ input }` (an input id), `{ create }` or `{ raw }`;
// every step is applied to the result of the one before it, which is materialised as raw pixels (sharp applies its own
// operations in a fixed order, not the order they are called in, so one operation per sharp call keeps both sides
// to the order written here); `output` is `raw` (width, height, channels and the pixels), `stats`, `metadata` or
// `png` (sharp's own PNG of the result, decoded again). The Rust twin replays the same steps and compares.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const sharp = (await importFrom(tree, 'node_modules/sharp/dist/index.mjs')).default;
sharp.cache(false);
const outDir = join(FIXTURES_ROOT, 'office-sharp');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Pixels from a function (x, y) -> array of `channels` bytes. */
function pixels(width, height, channels, f) {
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) f(x, y).forEach((v, c) => (data[(y * width + x) * channels + c] = clamp8(v)));
  return data;
}
const fromRaw = (data, width, height, channels, extra = {}) => sharp(data, { raw: { width, height, channels, ...extra } });

const random = mulberry32(20261115);
const photo = (width, height) =>
  pixels(width, height, 3, (x, y) => {
    const u = x / width;
    const v = y / height;
    const base = 120 + 80 * Math.sin(u * 7 + v * 3) * Math.cos(v * 5);
    return [base + 60 * u + (random() - 0.5) * 36, base * 0.8 + 90 * v + (random() - 0.5) * 36, 255 - base + (random() - 0.5) * 36];
  });

// ---- inputs ----------------------------------------------------------------------------------------------------
const inputs = new Map();
const addInput = (id, format, bytes) => inputs.set(id, { format, bytes });

addInput('photoPng', 'png', await fromRaw(photo(80, 56), 80, 56, 3).png().toBuffer());
addInput('photoJpeg', 'jpeg', await fromRaw(photo(79, 55), 79, 55, 3).jpeg({ quality: 90 }).toBuffer());
addInput(
  'graphic',
  'png',
  await fromRaw(
    pixels(64, 40, 4, (x, y) => {
      if (x >= 6 && x < 30 && y >= 5 && y < 20) return [30, 90, 200, 255];
      if (x >= 34 && x < 58 && y >= 12 && y < 36) return [220, 60 + x * 2, 40, 255];
      if (y >= 28 && y < 31 && x < 30) return [20, 20, 20, 255];
      return [255, 255, 255, 255];
    }),
    64,
    40,
    4
  )
    .png()
    .toBuffer()
);
addInput(
  'alpha',
  'png',
  await fromRaw(
    pixels(48, 32, 4, (x, y) => {
      const d = Math.hypot(x - 24, y - 16);
      return [255 - x * 4, 60 + y * 5, 40 + x * 3, d < 12 ? 255 : d < 18 ? 200 - (d - 12) * 30 : 0];
    }),
    48,
    32,
    4
  )
    .png()
    .toBuffer()
);
addInput('odd', 'png', await fromRaw(photo(31, 17), 31, 17, 3).png().toBuffer());
addInput('grey', 'png', await fromRaw(pixels(40, 30, 1, (x, y) => [x * 6 + y * 2]), 40, 30, 1).png().toBuffer());
addInput('greyAlpha', 'png', await fromRaw(pixels(24, 16, 2, (x, y) => [x * 10, y * 15]), 24, 16, 2).png().toBuffer());
addInput('palette', 'png', await fromRaw(pixels(32, 32, 3, (x, y) => [(x >> 3) * 80, (y >> 3) * 80, 128]), 32, 32, 3).png({ palette: true, colours: 16 }).toBuffer());
// A 16-bit RGB PNG written by hand (sharp keeps 16 bits only when it reads them): sharp's raw output of it is 8-bit
// (the high byte), its stats are on the 16-bit scale.
function png16(width, height, f) {
  const rows = Buffer.alloc(height * (1 + width * 6));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (let c = 0; c < 3; c += 1) rows.writeUInt16BE(f(x, y, c), y * (1 + width * 6) + 1 + (x * 3 + c) * 2);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
addInput('png16', 'png', png16(48, 32, (x, y, c) => (x * 1300 + y * 700 + c * 20011 + 37) & 0xffff));
addInput('greyTrue', 'png', await fromRaw(pixels(40, 30, 1, (x, y) => [x * 6 + y * 2]), 40, 30, 1).toColourspace('b-w').png().toBuffer());
addInput('greyAlphaTrue', 'png', await fromRaw(pixels(24, 16, 2, (x, y) => [x * 10, y * 15]), 24, 16, 2).toColourspace('b-w').png().toBuffer());
addInput('greyJpeg', 'jpeg', await fromRaw(pixels(33, 21, 1, (x, y) => [x * 7 + y * 3]), 33, 21, 1).toColourspace('b-w').jpeg({ quality: 90 }).toBuffer());
addInput('paletteAlpha', 'png', await fromRaw(pixels(16, 16, 4, (x, y) => [(x >> 2) * 70, (y >> 2) * 70, 90, x < 8 ? 255 : 0]), 16, 16, 4).png({ palette: true, colours: 16 }).toBuffer());
addInput('exif6', 'jpeg', await fromRaw(photo(64, 40), 64, 40, 3).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer());
addInput('density144', 'png', await fromRaw(photo(20, 20), 20, 20, 3).png().withMetadata({ density: 144 }).toBuffer());
addInput(
  'blob',
  'png',
  await fromRaw(
    pixels(96, 64, 3, (x, y) => {
      if (x >= 66 && x < 94 && y >= 20 && y < 48) return (x + y) % 2 === 0 ? [250, 30, 20] : [20, 40, 250];
      return [120, 120, 120];
    }),
    96,
    64,
    3
  )
    .png()
    .toBuffer()
);
addInput(
  'blobLeft',
  'png',
  await fromRaw(
    pixels(96, 64, 3, (x, y) => {
      if (x >= 2 && x < 30 && y >= 20 && y < 48) return (x + y) % 2 === 0 ? [250, 30, 20] : [20, 40, 250];
      return [120, 120, 120];
    }),
    96,
    64,
    3
  )
    .png()
    .toBuffer()
);
// The mask of a rounded picture: an opaque rounded rectangle on transparent (what the SVG mask of `addImage` rasterises to).
const mask = (w, h, r) =>
  pixels(w, h, 4, (x, y) => {
    const cx = Math.min(Math.max(x + 0.5, r), w - r);
    const cy = Math.min(Math.max(y + 0.5, r), h - r);
    return [0, 0, 0, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r ? 255 : 0];
  });
addInput('mask60x40', 'png', await fromRaw(mask(60, 40, 12), 60, 40, 4).png().toBuffer());
addInput('mask30x20', 'png', await fromRaw(mask(30, 20, 6), 30, 20, 4).png().toBuffer());
// A capture with a transparent canvas and a painted box (what `trim({ threshold: 0 })` of a measured element sees).
addInput(
  'capture',
  'png',
  await fromRaw(pixels(60, 40, 4, (x, y) => (x >= 11 && x < 44 && y >= 7 && y < 30 ? [20 + x, 90, 200 - y, 255] : [0, 0, 0, 0])), 60, 40, 4)
    .png()
    .toBuffer()
);
addInput('flat', 'png', await fromRaw(pixels(20, 12, 3, () => [90, 90, 90]), 20, 12, 3).png().toBuffer());

// ---- the cases ------------------------------------------------------------------------------------------------
const cases = [];
const add = (name, source, steps, output = 'raw') => cases.push({ name, source: typeof source === 'string' ? { input: source } : source, steps, output });
const resize = (width, height, options = {}) => ({ op: 'resize', width, height, ...options });

for (const input of inputs.keys()) add(`metadata ${input}`, input, [], 'metadata');

// Kernels, down and up.
for (const kernel of ['nearest', 'linear', 'cubic', 'mitchell', 'lanczos2', 'lanczos3']) {
  add(`fill down ${kernel} photoPng`, 'photoPng', [resize(40, 30, { fit: 'fill', kernel })]);
  add(`fill up ${kernel} photoPng`, 'photoPng', [resize(150, 100, { fit: 'fill', kernel })]);
  add(`fill down ${kernel} alpha`, 'alpha', [resize(24, 16, { fit: 'fill', kernel })]);
}
// Fits.
for (const input of ['photoPng', 'photoJpeg', 'graphic', 'alpha', 'odd', 'grey', 'greyAlpha', 'greyTrue', 'greyAlphaTrue', 'greyJpeg', 'png16', 'paletteAlpha']) {
  const [w, h] = { photoPng: [80, 56], photoJpeg: [79, 55], graphic: [64, 40], alpha: [48, 32], odd: [31, 17], grey: [40, 30], greyAlpha: [24, 16], greyTrue: [40, 30], greyAlphaTrue: [24, 16], greyJpeg: [33, 21], png16: [48, 32], paletteAlpha: [16, 16] }[input];
  add(`cover half ${input}`, input, [resize(Math.round(w / 2), Math.round(h / 2), { fit: 'cover' })]);
  add(`cover square ${input}`, input, [resize(20, 20, { fit: 'cover' })]);
  add(`cover tall up ${input}`, input, [resize(Math.round(w * 1.5), h * 2, { fit: 'cover' })]);
  add(`contain transparent ${input}`, input, [resize(60, 60, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })]);
  add(`contain red ${input}`, input, [resize(90, 50, { fit: 'contain', background: { r: 255, g: 0, b: 0, alpha: 1 } })]);
  add(`inside ${input}`, input, [resize(50, 50, { fit: 'inside' })]);
  add(`inside up ${input}`, input, [resize(200, 200, { fit: 'inside' })]);
  add(`outside ${input}`, input, [resize(30, 30, { fit: 'outside' })]);
  add(`fill ${input}`, input, [resize(33, 21, { fit: 'fill' })]);
}
add('width only photoPng', 'photoPng', [{ op: 'resize', width: 40 }]);
add('height only photoJpeg', 'photoJpeg', [{ op: 'resize', height: 28 }]);
add('width only odd', 'odd', [{ op: 'resize', width: 10 }]);
for (const position of ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'centre']) {
  add(`cover gravity ${position}`, 'photoPng', [resize(30, 30, { fit: 'cover', position })]);
  add(`cover odd gravity ${position}`, 'odd', [resize(10, 6, { fit: 'cover', position })]);
  add(`contain gravity ${position}`, 'photoPng', [resize(60, 60, { fit: 'contain', position, background: { r: 10, g: 20, b: 30, alpha: 1 } })]);
}
// Smart crops on a picture whose busy part is unambiguous (the crop windows are clamped to an edge on both sides).
for (const [input, w, h] of [['blob', 32, 64], ['blob', 64, 32], ['blobLeft', 32, 64]]) {
  add(`cover attention ${input} ${w}x${h}`, input, [resize(w, h, { fit: 'cover', position: 'attention' })]);
  add(`cover entropy ${input} ${w}x${h}`, input, [resize(w, h, { fit: 'cover', position: 'entropy' })]);
}

// Geometry.
add('extract photo', 'photoPng', [{ op: 'extract', left: 10, top: 5, width: 30, height: 20 }]);
add('extract alpha', 'alpha', [{ op: 'extract', left: 4, top: 3, width: 11, height: 9 }]);
add('extend transparent alpha', 'alpha', [{ op: 'extend', top: 3, bottom: 5, left: 7, right: 2, background: { r: 0, g: 0, b: 0, alpha: 0 } }]);
add('extend colour photo', 'photoPng', [{ op: 'extend', top: 2, bottom: 2, left: 4, right: 4, background: { r: 255, g: 128, b: 0, alpha: 1 } }]);
add('rotate exif 6', 'exif6', [{ op: 'rotate' }]);
add('rotate exif 6 then cover', 'exif6', [{ op: 'rotate' }, resize(30, 30, { fit: 'cover' })]);

// Bands.
add('flatten white alpha', 'alpha', [{ op: 'flatten', background: '#ffffff' }]);
add('flatten red greyAlpha', 'greyAlpha', [{ op: 'flatten', background: { r: 255, g: 0, b: 0 } }]);
add('flatten opaque photo', 'photoPng', [{ op: 'flatten', background: '#ffffff' }]);
add('removeAlpha alpha', 'alpha', [{ op: 'removeAlpha' }]);
add('removeAlpha photo', 'photoPng', [{ op: 'removeAlpha' }]);
add('ensureAlpha photo', 'photoPng', [{ op: 'ensureAlpha' }]);
add('ensureAlpha grey', 'grey', [{ op: 'ensureAlpha' }]);
for (const input of ['photoPng', 'alpha', 'grey', 'graphic', 'greyTrue', 'greyAlphaTrue', 'greyJpeg']) add(`greyscale ${input}`, input, [{ op: 'greyscale' }]);
add('linear contrast', 'photoPng', [{ op: 'linear', a: 1.5, b: -64 }]);
add('linear alpha', 'alpha', [{ op: 'linear', a: 0.8, b: 20 }]);
add('modulate saturation', 'photoPng', [{ op: 'modulate', saturation: 0.5 }]);
add('modulate none', 'photoPng', [{ op: 'modulate', saturation: 0 }]);
add('modulate brightness hue', 'photoPng', [{ op: 'modulate', brightness: 1.2, hue: 30, saturation: 1.3 }]);

// Trim.
add('trim threshold 0 graphic', 'graphic', [{ op: 'trim', threshold: 0 }]);
add('trim threshold 0 capture', 'capture', [{ op: 'trim', threshold: 0 }]);
add('trim threshold 0 flat', 'flat', [{ op: 'trim', threshold: 0 }]);
add('trim threshold 10 photo', 'photoPng', [{ op: 'trim', threshold: 10 }]);

// Composite.
add('composite dest-in rounded mask', 'photoPng', [resize(60, 40, { fit: 'cover' }), { op: 'composite', input: 'mask60x40', blend: 'dest-in' }]);
add('composite dest-in smaller mask', 'photoPng', [resize(60, 40, { fit: 'cover' }), { op: 'composite', input: 'mask30x20', blend: 'dest-in' }]);
add('composite dest-in on alpha', 'alpha', [resize(60, 40, { fit: 'cover' }), { op: 'composite', input: 'mask60x40', blend: 'dest-in' }]);
add('composite over at', 'photoPng', [{ op: 'composite', input: 'alpha', blend: 'over', left: 10, top: 8 }]);
add('composite over centre', 'photoPng', [{ op: 'composite', input: 'alpha', blend: 'over' }]);
add('composite over negative offset', 'photoPng', [{ op: 'composite', input: 'alpha', blend: 'over', left: -10, top: -5 }]);
add('composite multiply at', 'photoPng', [{ op: 'composite', input: 'graphic', blend: 'multiply', left: 5, top: 5 }]);
add('composite over on alpha base', 'graphic', [{ op: 'ensureAlpha' }, { op: 'composite', input: 'alpha', blend: 'over', left: 3, top: 3 }]);
add(
  'side by side comparison canvas',
  { create: { width: 90, height: 30, channels: 3, background: { r: 128, g: 128, b: 128 } } },
  [{ op: 'composite', input: 'photoPng', blend: 'over', left: 0, top: 0, resizeTo: [40, 30] }, { op: 'composite', input: 'graphic', blend: 'over', left: 50, top: 0, resizeTo: [40, 30] }]
);

// The office flows, step for step.
add('addImage cover then mask', 'photoJpeg', [{ op: 'rotate' }, resize(60, 40, { fit: 'fill' }), { op: 'extract', left: 0, top: 0, width: 50, height: 40 }, { op: 'composite', input: 'mask30x20', blend: 'dest-in' }]);
add('aesthetics ink grey', 'alpha', [{ op: 'flatten', background: '#ffffff' }, resize(40, 24, { fit: 'fill' }), { op: 'greyscale' }]);
add('aesthetics sample rgb', 'graphic', [{ op: 'flatten', background: '#ffffff' }, resize(32, 20, { fit: 'fill' }), { op: 'removeAlpha' }]);
add('runner canvas pixels', 'photoJpeg', [resize(40, 28, { fit: 'fill' }), { op: 'removeAlpha' }]);
add('treat resize longest', 'photoPng', [{ op: 'rotate' }, { op: 'resize', width: 50 }, { op: 'linear', a: 1.2, b: -25.6 }, { op: 'modulate', saturation: 0.6 }, { op: 'removeAlpha' }]);
add('cutout raw roundtrip', { raw: { width: 4, height: 3, channels: 4, data: Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 37) & 255)).toString('base64') } }, [], 'png');
for (const channels of [1, 2, 3, 4]) {
  add(`raw ${channels} channels to png`, { raw: { width: 5, height: 4, channels, data: Buffer.from(Array.from({ length: 20 * channels }, (_, i) => (i * 53 + 11) & 255)).toString('base64') } }, [], 'png');
}
for (const input of ['photoPng', 'alpha', 'graphic', 'greyTrue', 'greyAlphaTrue', 'palette']) add(`png of ${input} resized`, input, [resize(20, 12, { fit: 'fill' })], 'png');

// Stats.
for (const input of ['photoPng', 'alpha', 'graphic', 'grey', 'greyAlpha', 'greyTrue', 'greyAlphaTrue', 'greyJpeg', 'palette', 'paletteAlpha', 'capture', 'odd']) add(`stats ${input}`, input, [], 'stats');
add('stats ensureAlpha photo', 'photoPng', [{ op: 'ensureAlpha' }], 'stats');
add('stats after resize alpha', 'alpha', [resize(20, 12, { fit: 'fill' })], 'stats');

// ---- Node side: one sharp call per step -------------------------------------------------------------------------
async function startState(source) {
  if (source.input) return { encoded: inputs.get(source.input).bytes };
  if (source.create) return { image: sharp({ create: source.create }) };
  const { width, height, channels, data } = source.raw;
  return { image: fromRaw(Buffer.from(data, 'base64'), width, height, channels) };
}
const sharpOf = (state) => (state.encoded ? sharp(state.encoded) : state.image);
async function materialise(image) {
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { raw: data, info, image: fromRaw(data, info.width, info.height, info.channels) };
}
async function applyStep(state, step) {
  let image = sharpOf(state);
  let extra = {};
  switch (step.op) {
    case 'rotate': image = image.rotate(); break;
    case 'resize': {
      const { op, width, height, ...options } = step;
      image = image.resize(width, height, options);
      break;
    }
    case 'extract': image = image.extract({ left: step.left, top: step.top, width: step.width, height: step.height }); break;
    case 'extend': image = image.extend({ top: step.top, bottom: step.bottom, left: step.left, right: step.right, background: step.background }); break;
    case 'flatten': image = image.flatten({ background: step.background }); break;
    case 'removeAlpha': image = image.removeAlpha(); break;
    case 'ensureAlpha': image = image.ensureAlpha(); break;
    case 'greyscale': image = image.greyscale(); break;
    case 'linear': image = image.linear(step.a, step.b); break;
    case 'modulate': {
      const { op, ...options } = step;
      image = image.modulate(options);
      break;
    }
    case 'trim': image = image.trim({ threshold: step.threshold }); break;
    case 'composite': {
      let input = inputs.get(step.input).bytes;
      if (step.resizeTo) input = await sharp(input).resize(step.resizeTo[0], step.resizeTo[1], { fit: 'fill' }).png().toBuffer();
      const overlay = { input, blend: step.blend };
      if (step.left !== undefined) overlay.left = step.left;
      if (step.top !== undefined) overlay.top = step.top;
      image = image.composite([overlay]);
      break;
    }
    default: throw new Error(`unknown step ${step.op}`);
  }
  const done = await materialise(image);
  if (step.op === 'trim') extra = { trimOffsetLeft: done.info.trimOffsetLeft ?? 0, trimOffsetTop: done.info.trimOffsetTop ?? 0 };
  return { state: { image: done.image, raw: done.raw, info: done.info }, extra };
}

const b64 = (buffer) => Buffer.from(buffer).toString('base64');
async function record(c) {
  let state = await startState(c.source);
  let extra = {};
  for (const step of c.steps) {
    const result = await applyStep(state, step);
    state = result.state;
    extra = { ...extra, ...result.extra };
  }
  const expect = { ...extra };
  if (c.output === 'metadata') {
    const m = await sharpOf(state).metadata();
    Object.assign(expect, { format: m.format, width: m.width, height: m.height, channels: m.channels, hasAlpha: m.hasAlpha, density: m.density ?? null, orientation: m.orientation ?? null, depth: m.depth });
  } else if (c.output === 'stats') {
    const s = await sharpOf(state).stats();
    expect.channels = s.channels.map((ch) => ({ min: ch.min, max: ch.max, sum: ch.sum, squaresSum: ch.squaresSum, mean: ch.mean, stdev: ch.stdev, minX: ch.minX, minY: ch.minY, maxX: ch.maxX, maxY: ch.maxY }));
  } else {
    const done = state.raw ? state : await materialise(sharpOf(state));
    if (c.output === 'png') {
      // sharp's own PNG of the pixels, decoded again: the band layout and the pixels a PNG round trip keeps.
      const png = await sharpOf(done).png().toBuffer();
      const again = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      Object.assign(expect, { width: again.info.width, height: again.info.height, channels: again.info.channels, data: b64(again.data) });
    } else {
      Object.assign(expect, { width: done.info.width, height: done.info.height, channels: done.info.channels, data: b64(done.raw) });
    }
  }
  return { name: c.name, source: c.source, steps: c.steps, output: c.output, expect };
}

const recorded = [];
for (const c of cases) recorded.push(await record(c));

const inputsOut = {};
for (const [id, { format, bytes }] of inputs) inputsOut[id] = { format, data: b64(bytes) };

const stage = stageSet(outDir);
mkdirSync(stage, { recursive: true });
writeJson(join(stage, 'golden.json'), { sharp: sharp.versions.sharp, vips: sharp.versions.vips, inputs: inputsOut, cases: recorded });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'office-sharp',
  recorder: 'benchmarks/rust-core/recorders/record-office-sharp.mjs',
  command: 'node benchmarks/rust-core/recorders/record-office-sharp.mjs --tree <tree>',
  identityTree: tree,
});
const counts = {};
for (const c of recorded) counts[c.output] = (counts[c.output] ?? 0) + 1;
console.log(`recorded ${recorded.length} cases over ${inputs.size} inputs`, counts);
process.exit(0);
