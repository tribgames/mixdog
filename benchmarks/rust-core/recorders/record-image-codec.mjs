#!/usr/bin/env node
// The twin corpus of `mixdog-imaging` (WP nr-exthost-imaging-core): what sharp (libvips) answers to the four image
// calls the extension host serves, recorded from the real Node code. Inputs are built here with the tree's own sharp
// (generated gradients and noise photos, every EXIF orientation, CMYK, Display-P3, 16-bit, palette, interlaced,
// animated, lossless and lossy WebP, TIFF, truncated and corrupt files, AVIF and SVG bytes named .png, pixel counts
// over the limit, and sizes on both sides of every edge, patch, raw-size and token threshold of both profiles).
//
//   node benchmarks/rust-core/recorders/record-image-codec.mjs --tree <tree>     (tree = the Node product, e.g. C:\Project\mixdog)
//
// Writes native/core/fixtures/image-codec/: `corpus.json` (one case per call) and `inputs/<name>.bin` (the bytes of every
// input, named .bin so the secret scan leaves them alone). For every probe / jpeg / validate / resize call a case records
// the class (ok / invalid / environment / none), the mime type, the original and display dimensions, the output byte
// length, the branch of `resizeImageBuffer` (original bytes, plain rendition, JPEG q50, 400x400 JPEG q20) and sharp's
// own decode of the output pixels (sha256 and a 32x32 area-averaged RGBA thumbnail) with the error sentence.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
// The ESM build of sharp, the one the product's own `import('sharp')` loads (sharp ships separate ESM and CommonJS
// builds, each with its own prototype, and the branch instrumentation below patches the one the product calls).
const sharp = (await importFrom(tree, 'node_modules/sharp/dist/index.mjs')).default;
sharp.cache(false);
const { resizeImageBuffer } = await importFrom(tree, 'src/runtime/shared/read-image-resize.mjs');
const { isEnvironmentError } = await importFrom(tree, 'src/runtime/shared/environment-error.mjs');

const outDir = join(FIXTURES_ROOT, 'image-codec');
const sha = (data) => createHash('sha256').update(data).digest('hex');

// ---- the branch of resizeImageBuffer: the JPEG qualities its token gate asks sharp for ------------------------
const jpegCalls = [];
{
  const proto = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }));
  const original = proto.jpeg;
  proto.jpeg = function jpegLogged(options) {
    jpegCalls.push(options?.quality);
    return original.call(this, options);
  };
}

// ---- deterministic pixels ---------------------------------------------------------------------------------
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

/** RGB bytes of a smooth picture: gradients and a few low-frequency waves, optionally with seeded noise on top. */
function picture(width, height, { noise = 0, seed = 1 } = {}) {
  const random = mulberry32(seed);
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      const n = noise ? (random() - 0.5) * 2 * noise : 0;
      data[at] = clamp8((x / width) * 220 + 20 * Math.sin(y / 13) + n);
      data[at + 1] = clamp8((y / height) * 220 + 15 * Math.sin(x / 17) + n);
      data[at + 2] = clamp8(128 + 60 * Math.sin((x + y) / 37) + n);
    }
  }
  return data;
}

/** Uniform noise: incompressible, so a PNG of it is as many bytes as its pixels. */
function noiseRaw(width, height, seed, channels = 3) {
  const random = mulberry32(seed);
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(random() * 256);
  return data;
}

const fromRaw = (data, width, height, channels = 3) => sharp(data, { raw: { width, height, channels } });

/** RGBA bytes with a soft transparent corner. */
function pictureWithAlpha(width, height) {
  const rgb = picture(width, height, { seed: 3 });
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    const x = i % width;
    const y = Math.floor(i / width);
    data[i * 4 + 3] = clamp8(255 - Math.max(0, 255 - ((x + y) * 255) / (width + height) * 2));
  }
  return data;
}

// ---- the inputs --------------------------------------------------------------------------------------------
const inputs = new Map(); // name -> bytes
const addInput = (name, bytes) => {
  if (inputs.has(name)) throw new Error(`input ${name} twice`);
  inputs.set(name, Buffer.from(bytes));
  return name;
};

// Generated PNG inputs are filtered and compressed hard to keep the fixture small; only the noise PNGs of the raw-size
// threshold are big on purpose.
const smallPng = { adaptiveFiltering: true, compressionLevel: 9 };
const gradientPng = (w, h) => fromRaw(picture(w, h), w, h).png(smallPng).toBuffer();
const gradientJpeg = (w, h, quality = 90) => fromRaw(picture(w, h), w, h).jpeg({ quality }).toBuffer();
const gradientOf = async (w, h) => (w * h <= 1_000_000 ? gradientPng(w, h) : gradientJpeg(w, h));

const cases = [];
const caseNames = new Set();
function addCase(c) {
  if (caseNames.has(c.name)) throw new Error(`case ${c.name} twice`);
  caseNames.add(c.name);
  cases.push(c);
}

// Sizes on both sides of every edge and patch threshold, for both profiles, each a smooth picture.
const anthropicSizes = [
  [1, 1], [2, 3], [50, 50], [199, 199], [200, 200], [199, 500], [500, 199], [1, 1000], [1000, 1], [640, 480],
  [1567, 100], [1568, 100], [1569, 100], [100, 1569], [1568, 1568], [1456, 819], [1457, 819], [1456, 820], [1568, 882],
  [1920, 1080], [3000, 200],
];
const openaiSizes = [[2048, 100], [2049, 100], [1536, 1024], [1537, 1024], [1600, 1200], [2048, 2048], [100, 100], [64, 48]];

for (const [w, h] of anthropicSizes) {
  const name = addInput(`grad-${w}x${h}`, await gradientOf(w, h));
  addCase({ name: `anthropic ${w}x${h}`, op: 'resize', input: name, ext: w * h <= 1_000_000 ? 'png' : 'jpeg', profile: 'anthropic' });
}
for (const [w, h] of openaiSizes) {
  const name = inputs.has(`grad-${w}x${h}`) ? `grad-${w}x${h}` : addInput(`grad-${w}x${h}`, await gradientOf(w, h));
  addCase({ name: `openai ${w}x${h}`, op: 'resize', input: name, ext: w * h <= 1_000_000 ? 'png' : 'jpeg', profile: 'openai' });
}

// Formats and what libvips does to each before it resizes.
const small = { w: 400, h: 300 };
const wide = { w: 2000, h: 500 };
const formats = {};
formats.jpeg = await gradientJpeg(small.w, small.h, 80);
formats.jpegPhoto = await fromRaw(picture(480, 360, { noise: 24, seed: 5 }), 480, 360).jpeg({ quality: 90 }).toBuffer();
formats.jpegWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).jpeg({ quality: 85 }).toBuffer();
formats.pngPhoto = await fromRaw(picture(480, 360, { noise: 8, seed: 6 }), 480, 360).png(smallPng).toBuffer();
formats.pngWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).png(smallPng).toBuffer();
formats.webpLossy = await fromRaw(picture(small.w, small.h), small.w, small.h).webp({ quality: 80 }).toBuffer();
formats.webpLossless = await fromRaw(picture(small.w, small.h), small.w, small.h).webp({ lossless: true }).toBuffer();
formats.webpWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).webp({ quality: 80 }).toBuffer();
formats.webpAlpha = await fromRaw(pictureWithAlpha(small.w, small.h), small.w, small.h, 4).webp({ quality: 80 }).toBuffer();
formats.gif = await fromRaw(picture(300, 200), 300, 200).gif().toBuffer();
formats.gifWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).gif().toBuffer();
formats.tiff = await fromRaw(picture(300, 200), 300, 200).tiff().toBuffer();
formats.tiffWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).tiff().toBuffer();
const frames = await Promise.all(
  ['#e11d48', '#16a34a', '#2563eb'].map((background) => sharp({ create: { width: 120, height: 80, channels: 3, background } }).png().toBuffer()),
);
formats.gifAnimated = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
formats.webpAnimated = await sharp(frames, { join: { animated: true } }).webp().toBuffer();
formats.pngAlpha = await fromRaw(pictureWithAlpha(300, 200), 300, 200, 4).png(smallPng).toBuffer();
formats.pngAlphaWide = await fromRaw(pictureWithAlpha(wide.w, wide.h), wide.w, wide.h, 4).png(smallPng).toBuffer();
formats.pngPalette = await fromRaw(pictureWithAlpha(300, 200), 300, 200, 4).png({ ...smallPng, palette: true, colours: 64 }).toBuffer();
formats.pngPaletteWide = await fromRaw(pictureWithAlpha(wide.w, wide.h), wide.w, wide.h, 4).png({ ...smallPng, palette: true, colours: 64 }).toBuffer();
formats.pngInterlaced = await fromRaw(picture(300, 200), 300, 200).png({ ...smallPng, progressive: true }).toBuffer();
formats.pngInterlacedWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).png({ ...smallPng, progressive: true }).toBuffer();
formats.pngGrey = await fromRaw(picture(300, 200), 300, 200).greyscale().png(smallPng).toBuffer();
formats.pngGreyWide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).greyscale().png(smallPng).toBuffer();
formats.png16 = await fromRaw(picture(300, 200), 300, 200).toColourspace('rgb16').png(smallPng).toBuffer();
formats.png16Wide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).toColourspace('rgb16').png(smallPng).toBuffer();
formats.pngP3 = await fromRaw(picture(300, 200), 300, 200).withIccProfile('p3').png(smallPng).toBuffer();
formats.pngP3Wide = await fromRaw(picture(wide.w, wide.h), wide.w, wide.h).withIccProfile('p3').png(smallPng).toBuffer();
formats.jpegP3 = await fromRaw(picture(300, 200), 300, 200).withIccProfile('p3').jpeg({ quality: 90 }).toBuffer();
formats.jpegCmyk = await fromRaw(picture(300, 200), 300, 200).toColourspace('cmyk').withIccProfile('cmyk').jpeg({ quality: 90 }).toBuffer();
formats.jpegCmykNoProfile = await fromRaw(picture(300, 200), 300, 200).toColourspace('cmyk').jpeg({ quality: 90 }).toBuffer();
for (let orientation = 1; orientation <= 8; orientation += 1) {
  formats[`jpegExif${orientation}`] = await fromRaw(picture(96, 64, { seed: orientation }), 96, 64).withMetadata({ orientation }).jpeg({ quality: 90 }).toBuffer();
  formats[`jpegExif${orientation}Wide`] = await fromRaw(picture(2400, 400, { seed: orientation }), 2400, 400).withMetadata({ orientation }).jpeg({ quality: 85 }).toBuffer();
}

const labels = (key) => (key.startsWith('jpeg') ? 'jpeg' : key.startsWith('png') ? 'png' : key.startsWith('webp') ? 'webp' : key.startsWith('gif') ? 'gif' : 'tiff');
for (const [key, bytes] of Object.entries(formats)) {
  const name = addInput(`fmt-${key}`, bytes);
  addCase({ name: `format ${key}`, op: 'resize', input: name, ext: labels(key), profile: 'anthropic' });
}
// The same pictures through the composer's other profile and the validate and probe calls.
for (const key of ['jpegWide', 'pngWide', 'gifWide', 'tiffWide', 'png16Wide', 'pngP3Wide']) {
  addCase({ name: `format ${key} openai`, op: 'resize', input: `fmt-${key}`, ext: labels(key), profile: 'openai' });
}
for (const key of ['jpeg', 'pngPhoto', 'webpLossy', 'webpLossless', 'gif', 'tiff', 'png16', 'pngPalette', 'jpegCmyk', 'gifAnimated', 'webpAnimated']) {
  addCase({ name: `probe ${key}`, op: 'probe', input: `fmt-${key}` });
  addCase({ name: `validate ${key}`, op: 'validate', input: `fmt-${key}`, format: labels(key) });
}

// Damaged and foreign bytes.
const damaged = {};
const smallPhoto = picture(160, 120, { noise: 12, seed: 8 });
const damagedSources = {
  png: await fromRaw(smallPhoto, 160, 120).png(smallPng).toBuffer(),
  jpeg: await fromRaw(smallPhoto, 160, 120).jpeg({ quality: 90 }).toBuffer(),
  webp: await fromRaw(smallPhoto, 160, 120).webp({ quality: 80 }).toBuffer(),
  gif: await fromRaw(smallPhoto, 160, 120).gif().toBuffer(),
  tiff: await fromRaw(smallPhoto, 160, 120).tiff().toBuffer(),
};
const cut = (bytes, drop) => bytes.subarray(0, bytes.length - drop);
damaged.pngTruncated = cut(damagedSources.png, 40);
damaged.pngHalf = damagedSources.png.subarray(0, Math.floor(damagedSources.png.length / 2));
damaged.pngHeaderOnly = damagedSources.png.subarray(0, 20);
damaged.pngCorruptData = (() => {
  const b = Buffer.from(damagedSources.png);
  for (let i = 200; i < b.length - 20; i += 7) b[i] ^= 0x55;
  return b;
})();
damaged.jpegTruncated = cut(damagedSources.jpeg, 60);
damaged.jpegHalf = damagedSources.jpeg.subarray(0, Math.floor(damagedSources.jpeg.length / 2));
damaged.jpegHeaderOnly = damagedSources.jpeg.subarray(0, 12);
damaged.jpegCorrupt = (() => {
  const b = Buffer.from(damagedSources.jpeg);
  for (let i = 300; i < b.length - 20; i += 3) b[i] ^= 0xa5;
  return b;
})();
damaged.webpTruncated = cut(damagedSources.webp, 10);
damaged.webpHeaderOnly = damagedSources.webp.subarray(0, 14);
damaged.gifTruncated = cut(damagedSources.gif, 10);
damaged.gifHeaderOnly = damagedSources.gif.subarray(0, 8);
damaged.tiffTruncated = cut(damagedSources.tiff, 40);
damaged.tiffHeaderOnly = damagedSources.tiff.subarray(0, 10);
damaged.junk = Buffer.from('hello world this is not an image at all');
damaged.empty = Buffer.alloc(0);
damaged.riffNotWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(8)]);
for (const [key, bytes] of Object.entries(damaged)) {
  addInput(`bad-${key}`, bytes);
  const ext = key.startsWith('jpeg') ? 'jpeg' : key.startsWith('webp') ? 'webp' : key.startsWith('gif') ? 'gif' : 'png';
  addCase({ name: `damaged ${key}`, op: 'resize', input: `bad-${key}`, ext, profile: 'anthropic' });
  addCase({ name: `damaged ${key} probe`, op: 'probe', input: `bad-${key}` });
  addCase({ name: `damaged ${key} validate`, op: 'validate', input: `bad-${key}`, format: ext });
}
addCase({ name: 'damaged jpeg truncated tool jpeg', op: 'jpeg', input: 'bad-jpegTruncated', jpeg: { width: 100, height: 100, allowEnlargement: false, quality: 85 } });
addCase({ name: 'damaged empty tool jpeg', op: 'jpeg', input: 'bad-empty', jpeg: { width: 100, height: 100, allowEnlargement: false, quality: 85 } });

// Formats sharp reads and Rust answers as unsupported (owner decision 5): recorded as sharp answers, flagged.
const foreign = {
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#336699"/></svg>'),
  avif: await fromRaw(picture(64, 48), 64, 48).avif({ quality: 50 }).toBuffer(),
};
for (const [key, bytes] of Object.entries(foreign)) {
  addInput(`foreign-${key}`, bytes);
  addCase({ name: `foreign ${key} named png`, op: 'resize', input: `foreign-${key}`, ext: 'png', profile: 'anthropic', divergence: 'avif-svg' });
  addCase({ name: `foreign ${key} probe`, op: 'probe', input: `foreign-${key}`, divergence: 'avif-svg' });
  addCase({ name: `foreign ${key} validate`, op: 'validate', input: `foreign-${key}`, format: 'png', divergence: 'avif-svg' });
}

// Pixel counts over the limit (64 Mi pixels), as flat images (a few bytes of file).
const overPng = await sharp({ create: { width: 8200, height: 8200, channels: 3, background: '#ffffff' } }).png().toBuffer();
const overJpeg = await sharp({ create: { width: 8200, height: 8200, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
addInput('limit-png-8200x8200', overPng);
addInput('limit-jpeg-8200x8200', overJpeg);
for (const [name, ext] of [['limit-png-8200x8200', 'png'], ['limit-jpeg-8200x8200', 'jpeg']]) {
  addCase({ name: `${name} resize`, op: 'resize', input: name, ext, profile: 'anthropic' });
  addCase({ name: `${name} probe`, op: 'probe', input: name });
  addCase({ name: `${name} validate`, op: 'validate', input: name, format: ext });
}

// The raw-size threshold (3.75 MiB = 3,932,160 bytes): RGBA noise PNGs a few bytes below and above it. Four bytes a
// pixel keeps both inside the patch budget (about 1.2 M pixels), so only the byte size sends the larger one to a re-encode.
const rawTarget = (5 * 1024 * 1024 * 3) / 4;
const below = await fromRaw(noiseRaw(990, 985, 11, 4), 990, 985, 4).png().toBuffer();
const above = await fromRaw(noiseRaw(1000, 985, 12, 4), 1000, 985, 4).png().toBuffer();
if (!(below.length < rawTarget && above.length > rawTarget)) throw new Error(`the noise PNGs must straddle ${rawTarget}: ${below.length} and ${above.length}`);
for (const [name, bytes] of [['raw-below', below], ['raw-above', above]]) {
  addInput(`limit-${name}`, bytes);
  addCase({ name: `${name} (${bytes.length} bytes)`, op: 'resize', input: `limit-${name}`, ext: 'png', profile: 'anthropic' });
}

// ---- the calls, recorded ---------------------------------------------------------------------------------
const THUMB = 32;

/** The mean of every cell of a `THUMB` x `THUMB` grid over the RGBA pixels (the rule `tests/node_twin.rs` repeats). */
function thumbnail(rgba, width, height) {
  const out = Buffer.alloc(THUMB * THUMB * 4);
  for (let cy = 0; cy < THUMB; cy += 1) {
    const y0 = Math.floor((cy * height) / THUMB);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((cy + 1) * height) / THUMB)));
    for (let cx = 0; cx < THUMB; cx += 1) {
      const x0 = Math.floor((cx * width) / THUMB);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((cx + 1) * width) / THUMB)));
      const sums = [0, 0, 0, 0];
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * width + x) * 4;
          for (let c = 0; c < 4; c += 1) sums[c] += rgba[at + c];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 4; c += 1) out[(cy * THUMB + cx) * 4 + c] = Math.round(sums[c] / count);
    }
  }
  return out;
}

/** sharp's own decode of an output image: its size, the hash of its RGBA pixels and their thumbnail. */
async function pixelsOf(bytes) {
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== info.width * info.height * 4) throw new Error(`the pixels of an output are not 8-bit RGBA: ${JSON.stringify(info)}`);
  return { width: info.width, height: info.height, sha256: sha(data), thumbnail: thumbnail(data, info.width, info.height).toString('base64') };
}

const errorOf = (error) => ({
  class: isEnvironmentError(error) ? 'environment' : 'invalid',
  message: String(error?.message ?? ''),
  sentence: String(error?.message ?? '').split('\n')[0],
});

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return { error: errorOf(error) };
  }
}

/** `decodedImageMeta` of read-image-resize.mjs, as `image.probe` calls it. */
async function probe(bytes) {
  const meta = await sharp(bytes).metadata();
  await sharp(bytes, { sequentialRead: true, limitInputPixels: 64 * 1024 * 1024 }).raw().toBuffer();
  return { width: meta.width || 0, height: meta.height || 0 };
}

const branchOf = (calls, outputBase64, inputBase64) => {
  if (calls.includes(20)) return 'token-fallback';
  if (calls.includes(50)) return 'token-jpeg';
  return outputBase64 === inputBase64 ? 'original' : 'rendition';
};

// Node's resize cache is keyed by the extension among other things; a counter in it keeps every recording from being
// answered from an earlier one (which would make no sharp call, and so show no branch).
let uncached = 0;

async function recordResize(bytes, ext, options) {
  jpegCalls.length = 0;
  uncached += 1;
  const outcome = await attempt(() => resizeImageBuffer(bytes, `${ext}.${uncached}`, options));
  if (outcome?.error) return { class: outcome.error.class, error: outcome.error };
  if (outcome === null) return { class: 'none' };
  const output = Buffer.from(outcome.data, 'base64');
  const { originalWidth, originalHeight, displayWidth, displayHeight } = outcome.dimensions;
  return {
    class: 'ok',
    mime: outcome.mimeType,
    originalWidth,
    originalHeight,
    displayWidth,
    displayHeight,
    byteLength: output.length,
    branch: branchOf(jpegCalls, outcome.data, bytes.toString('base64')),
    pixels: await pixelsOf(output),
  };
}

async function record(c) {
  const bytes = inputs.get(c.input);
  const base = { name: c.name, op: c.op, input: c.input, inputBytes: bytes.length, ...(c.divergence ? { divergence: c.divergence } : {}) };
  if (c.op === 'resize') {
    const options = { profile: c.profile, ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }) };
    return { ...base, ext: c.ext, profile: c.profile, ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }), ...(c.boundary ? { boundary: c.boundary } : {}), expect: await recordResize(bytes, c.ext, options) };
  }
  if (c.op === 'probe') {
    const answered = await attempt(() => probe(bytes));
    return { ...base, expect: answered.error ? { class: answered.error.class, error: answered.error } : { class: 'ok', ...answered } };
  }
  if (c.op === 'validate') {
    jpegCalls.length = 0;
    uncached += 1;
    const answered = await attempt(() => resizeImageBuffer(bytes, `${c.format}.${uncached}`, { profile: 'anthropic' }));
    const expect = answered?.error ? { class: answered.error.class, error: answered.error } : answered === null ? { class: 'environment' } : { class: 'ok' };
    return { ...base, format: c.format, expect };
  }
  // jpeg: `encodeToolImageJpeg` of read-image-resize.mjs, as `image.jpeg` calls it.
  const { width, height, allowEnlargement, quality } = c.jpeg;
  const answered = await attempt(() =>
    sharp(bytes).resize(width, height, { fit: 'inside', withoutEnlargement: !allowEnlargement }).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer({ resolveWithObject: true }),
  );
  if (answered.error) return { ...base, jpeg: c.jpeg, expect: { class: answered.error.class, error: answered.error } };
  return {
    ...base,
    jpeg: c.jpeg,
    expect: { class: 'ok', width: answered.info.width, height: answered.info.height, byteLength: answered.data.length, pixels: await pixelsOf(answered.data) },
  };
}

// Token-gate cases need the cost of what the gate sees: ask for the plain rendition (a budget no image reaches),
// then set the budget 20 percent either side of its tokens, and on both sides of the JPEG q50 rendition's.
const estTokens = (bytes) => Math.ceil(Math.ceil(bytes / 3) * 4 * 0.125);
const gateInputs = [
  ['fmt-pngPhoto', 'png'],
  ['fmt-jpegPhoto', 'jpeg'],
  ['fmt-jpegWide', 'jpeg'],
  ['fmt-pngAlpha', 'png'],
  ['fmt-pngWide', 'png'],
];
for (const [input, ext] of gateInputs) {
  const bytes = inputs.get(input);
  const plain = await resizeImageBuffer(bytes, `${ext}.pre`, { profile: 'anthropic', maxTokens: 1e12 });
  const plainTokens = estTokens(Buffer.from(plain.data, 'base64').length);
  addCase({ name: `gate ${input} budget above plain`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: Math.ceil(plainTokens * 1.25) });
  addCase({ name: `gate ${input} budget below plain`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: Math.floor(plainTokens * 0.8) });
  const gated = await resizeImageBuffer(bytes, `${ext}.pre`, { profile: 'anthropic', maxTokens: Math.floor(plainTokens * 0.8) });
  const jpegTokens = estTokens(Buffer.from(gated.data, 'base64').length);
  addCase({ name: `gate ${input} budget above q50 jpeg`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: Math.ceil(jpegTokens * 1.25) });
  addCase({ name: `gate ${input} budget below q50 jpeg`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: Math.max(1, Math.floor(jpegTokens * 0.8)) });
  addCase({ name: `gate ${input} budget of one token`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: 1 });
  // An image that fits is answered as its own bytes, so its cost is exact: the budget may sit on the very token.
  if (plain.data === bytes.toString('base64')) {
    addCase({ name: `gate ${input} budget on the token`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: plainTokens, boundary: 'exact' });
    addCase({ name: `gate ${input} budget one token under`, op: 'resize', input, ext, profile: 'anthropic', maxTokens: plainTokens - 1, boundary: 'exact' });
  }
}

// The image.jpeg call (tool-result compaction): the box, white-flattened, at one quality.
const toolSources = ['fmt-pngPhoto', 'fmt-jpegPhoto', 'fmt-webpLossy', 'fmt-pngAlpha', 'fmt-pngGrey', 'fmt-png16', 'fmt-pngPalette', 'fmt-gif', 'fmt-jpegCmyk'];
for (const input of toolSources) {
  const [w, h] = input === 'fmt-pngPhoto' || input === 'fmt-jpegPhoto' ? [480, 360] : input === 'fmt-webpLossy' ? [400, 300] : [300, 200];
  for (const jpeg of [
    { width: Math.round(w / 2), height: Math.round(h / 2), allowEnlargement: false, quality: 85 },
    { width: w, height: h, allowEnlargement: false, quality: 70 },
    { width: w * 2, height: h * 2, allowEnlargement: true, quality: 50 },
    { width: w * 2, height: h * 2, allowEnlargement: false, quality: 85 },
  ]) {
    addCase({ name: `tool jpeg ${input} ${jpeg.width}x${jpeg.height} enlarge ${jpeg.allowEnlargement} q${jpeg.quality}`, op: 'jpeg', input, jpeg });
  }
}

const recorded = [];
for (const c of cases) recorded.push(await record(c));
if (recorded.length < 80) throw new Error(`the corpus has only ${recorded.length} cases`);

const stage = stageSet(outDir);
mkdirSync(join(stage, 'inputs'), { recursive: true });
for (const [name, bytes] of inputs) writeFileSync(join(stage, 'inputs', `${name}.bin`), bytes);
writeJson(join(stage, 'corpus.json'), { sharp: sharp.versions, thumbnail: THUMB, rawTarget, cases: recorded });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'image-codec',
  recorder: 'benchmarks/rust-core/recorders/record-image-codec.mjs',
  command: 'node benchmarks/rust-core/recorders/record-image-codec.mjs --tree <tree>',
  identityTree: tree,
});
const classes = {};
for (const c of recorded) classes[c.expect.class] = (classes[c.expect.class] ?? 0) + 1;
console.log(`recorded ${recorded.length} cases over ${inputs.size} inputs`, classes);
process.exit(0);
