#!/usr/bin/env node
// The twin corpus of the still renditions of `mixdog-imaging` (WP nr-exthost-imaging-still): what the Node product's
// own `ensureRendition` (renditions.mjs: EXIF rotate, fit inside the variant's edge without enlargement, lossy WebP at
// the variant's quality, through sharp) writes for an image, and what `resizeImageBuffer` writes for a WebP input.
//
//   node benchmarks/rust-core/recorders/record-image-still.mjs --tree <tree>     (tree = the Node product, e.g. C:\Project\mixdog)
//
// Writes native/core/fixtures/image-still/: `corpus.json` and `inputs/<name>.bin`. A still case records the class (ok, or
// none when the source does not decode), the extension, the output size, whether the output has an alpha channel and
// sharp's own decode of the output (a 32x32 area-averaged RGBA thumbnail) for both variants of every input; a resize
// case records the same for the WebP inputs the image.resize call re-encodes. Inputs are built here with the tree's own
// sharp: every EXIF orientation, alpha, animated GIF and WebP, huge and tiny images, CMYK, wide and tall, invalid bytes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const sharp = (await importFrom(tree, 'node_modules/sharp/dist/index.mjs')).default;
sharp.cache(false);
const { ensureRendition, renditionSpec } = await importFrom(tree, 'src/runtime/media/renditions.mjs');
const { resizeImageBuffer } = await importFrom(tree, 'src/runtime/shared/read-image-resize.mjs');

const outDir = join(FIXTURES_ROOT, 'image-still');
const THUMB = 32;
const VARIANTS = ['thumb', 'display'];

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

/** RGB bytes of a smooth, asymmetric picture (so a wrong rotation or mirror shows), optionally with seeded noise. */
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

const fromRaw = (data, width, height, channels = 3) => sharp(data, { raw: { width, height, channels } });
const smallPng = { adaptiveFiltering: true, compressionLevel: 9 };

const inputs = new Map();
const addInput = (name, bytes) => {
  if (inputs.has(name)) throw new Error(`input ${name} twice`);
  inputs.set(name, Buffer.from(bytes));
  return name;
};

// Sizes on both sides of both variants' edges (512 and 2048), tiny and degenerate ones, wide and tall.
for (const [w, h] of [[1, 1], [2, 3], [64, 48], [100, 100], [511, 300], [512, 512], [513, 512], [640, 480], [1000, 1000], [2048, 1000], [2049, 1000], [3000, 2000], [6000, 400], [400, 6000]]) {
  const big = w * h > 1_000_000;
  const bytes = big ? await fromRaw(picture(w, h), w, h).jpeg({ quality: 85 }).toBuffer() : await fromRaw(picture(w, h), w, h).png(smallPng).toBuffer();
  addInput(`size-${w}x${h}`, bytes);
}
addInput('size-photo-1200x900', await fromRaw(picture(1200, 900, { noise: 20, seed: 5 }), 1200, 900).jpeg({ quality: 88 }).toBuffer());
// Huge: 20 million pixels of flat colour, a few bytes of file.
addInput('huge-5000x4000', await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#3366aa' } }).jpeg({ quality: 80 }).toBuffer());

// Every EXIF orientation, on a small and a wide picture.
for (let orientation = 1; orientation <= 8; orientation += 1) {
  addInput(`exif${orientation}`, await fromRaw(picture(96, 64, { seed: orientation }), 96, 64).withMetadata({ orientation }).jpeg({ quality: 90 }).toBuffer());
  addInput(`exif${orientation}-wide`, await fromRaw(picture(2400, 400, { seed: orientation }), 2400, 400).withMetadata({ orientation }).jpeg({ quality: 85 }).toBuffer());
}

// Formats and colour models.
const frames = await Promise.all(
  ['#e11d48', '#16a34a', '#2563eb'].map((background) => sharp({ create: { width: 120, height: 80, channels: 3, background } }).png().toBuffer()),
);
const formats = {
  pngAlpha: await fromRaw(pictureWithAlpha(300, 200), 300, 200, 4).png(smallPng).toBuffer(),
  pngAlphaBig: await fromRaw(pictureWithAlpha(1600, 1200), 1600, 1200, 4).png(smallPng).toBuffer(),
  pngPalette: await fromRaw(pictureWithAlpha(300, 200), 300, 200, 4).png({ ...smallPng, palette: true, colours: 64 }).toBuffer(),
  pngGrey: await fromRaw(picture(300, 200), 300, 200).greyscale().png(smallPng).toBuffer(),
  png16: await fromRaw(picture(300, 200), 300, 200).toColourspace('rgb16').png(smallPng).toBuffer(),
  pngP3: await fromRaw(picture(300, 200), 300, 200).withIccProfile('p3').png(smallPng).toBuffer(),
  jpegP3: await fromRaw(picture(300, 200), 300, 200).withIccProfile('p3').jpeg({ quality: 90 }).toBuffer(),
  jpegCmyk: await fromRaw(picture(300, 200), 300, 200).toColourspace('cmyk').withIccProfile('cmyk').jpeg({ quality: 90 }).toBuffer(),
  jpegCmykNoProfile: await fromRaw(picture(300, 200), 300, 200).toColourspace('cmyk').jpeg({ quality: 90 }).toBuffer(),
  gif: await fromRaw(picture(300, 200), 300, 200).gif().toBuffer(),
  gifAnimated: await sharp(frames, { join: { animated: true } }).gif().toBuffer(),
  tiff: await fromRaw(picture(300, 200), 300, 200).tiff().toBuffer(),
  webpLossy: await fromRaw(picture(400, 300), 400, 300).webp({ quality: 80 }).toBuffer(),
  webpLossless: await fromRaw(picture(400, 300), 400, 300).webp({ lossless: true }).toBuffer(),
  webpAlpha: await fromRaw(pictureWithAlpha(400, 300), 400, 300, 4).webp({ quality: 80 }).toBuffer(),
  webpAnimated: await sharp(frames, { join: { animated: true } }).webp().toBuffer(),
  webpWide: await fromRaw(picture(2000, 500), 2000, 500).webp({ quality: 80 }).toBuffer(),
  webpTiny: await fromRaw(picture(100, 100), 100, 100).webp({ quality: 80 }).toBuffer(),
  webpAlphaWide: await fromRaw(pictureWithAlpha(2000, 500), 2000, 500, 4).webp({ quality: 80 }).toBuffer(),
  webpLosslessWide: await fromRaw(picture(2000, 500), 2000, 500).webp({ lossless: true }).toBuffer(),
};
for (const [key, bytes] of Object.entries(formats)) addInput(`fmt-${key}`, bytes);

// Not decodable.
const photo = await fromRaw(picture(160, 120, { noise: 12, seed: 8 }), 160, 120).png(smallPng).toBuffer();
addInput('bad-empty', Buffer.alloc(0));
addInput('bad-junk', Buffer.from('hello world this is not an image at all'));
addInput('bad-pngTruncated', photo.subarray(0, photo.length - 40));
addInput('bad-pngHeaderOnly', photo.subarray(0, 20));
// Bytes sharp renders (librsvg) and the Rust decoder answers as unsupported, by owner decision (AVIF, HEIF and SVG).
addInput('foreign-svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#336699"/></svg>'));

// ---- recording --------------------------------------------------------------------------------------------
/** The mean of every cell of a `THUMB` x `THUMB` grid over the RGBA pixels (the rule `tests/still_twin.rs` repeats). */
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

/** sharp's own decode of an output: its size, whether it carries alpha, and the thumbnail of its RGBA pixels. */
async function pixelsOf(bytes) {
  const meta = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== info.width * info.height * 4) throw new Error(`the pixels of an output are not 8-bit RGBA: ${JSON.stringify(info)}`);
  return { width: info.width, height: info.height, hasAlpha: Boolean(meta.hasAlpha), thumbnail: thumbnail(data, info.width, info.height).toString('base64') };
}

// Renditions are written to a scratch directory inside this checkout and removed afterwards.
const scratch = mkdtempSync(join(REPO_ROOT, 'still-record-'));
let serial = 0;
const cases = [];
try {
  for (const [name, bytes] of inputs) {
    const sourcePath = join(scratch, `${name}.src`);
    writeFileSync(sourcePath, bytes);
    for (const variant of VARIANTS) {
      serial += 1;
      const spec = renditionSpec(variant);
      const got = await ensureRendition({ id: `case${serial}`, kind: 'image', sourcePath, variant, cacheDir: join(scratch, 'cache') });
      const base = { name: `${name} ${variant}`, op: 'still', input: name, variant, maxEdge: spec.maxEdge, quality: spec.quality, inputBytes: bytes.length, ...(name.startsWith('foreign-') ? { divergence: 'avif-svg' } : {}) };
      if (!got) {
        cases.push({ ...base, expect: { class: 'none' } });
        continue;
      }
      const output = readFileSync(got.path);
      cases.push({ ...base, expect: { class: 'ok', extension: got.path.slice(got.path.lastIndexOf('.')), mime: got.mime, byteLength: output.length, pixels: await pixelsOf(output) } });
    }
  }
  // image.resize of WebP inputs: sharp re-encodes them as lossy WebP at its default quality 80.
  for (const name of ['fmt-webpLossy', 'fmt-webpLossless', 'fmt-webpAlpha', 'fmt-webpAnimated', 'fmt-webpWide', 'fmt-webpTiny', 'fmt-webpAlphaWide', 'fmt-webpLosslessWide']) {
    serial += 1;
    const bytes = inputs.get(name);
    const answered = await resizeImageBuffer(bytes, `webp.${serial}`, { profile: 'anthropic' });
    const output = Buffer.from(answered.data, 'base64');
    const { originalWidth, originalHeight, displayWidth, displayHeight } = answered.dimensions;
    cases.push({
      name: `resize ${name}`,
      op: 'resize',
      input: name,
      ext: 'webp',
      profile: 'anthropic',
      inputBytes: bytes.length,
      expect: { class: 'ok', mime: answered.mimeType, originalWidth, originalHeight, displayWidth, displayHeight, byteLength: output.length, original: answered.data === bytes.toString('base64'), pixels: await pixelsOf(output) },
    });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (cases.length < 80) throw new Error(`the corpus has only ${cases.length} cases`);

const stage = stageSet(outDir);
mkdirSync(join(stage, 'inputs'), { recursive: true });
for (const [name, bytes] of inputs) writeFileSync(join(stage, 'inputs', `${name}.bin`), bytes);
writeJson(join(stage, 'corpus.json'), { sharp: sharp.versions, thumbnail: THUMB, cases });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'image-still',
  recorder: 'benchmarks/rust-core/recorders/record-image-still.mjs',
  command: 'node benchmarks/rust-core/recorders/record-image-still.mjs --tree <tree>',
  identityTree: tree,
});
const classes = {};
for (const c of cases) classes[c.expect.class] = (classes[c.expect.class] ?? 0) + 1;
console.log(`recorded ${cases.length} cases over ${inputs.size} inputs`, classes);
process.exit(0);
