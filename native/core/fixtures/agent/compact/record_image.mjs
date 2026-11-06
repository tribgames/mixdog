// Records Node's tool-result image compaction (session/tool-batch/finalize.mjs `compactResultImages`,
// shared/read-image-resize.mjs): the display box of an image, the note that supersedes an earlier size
// annotation, and what happens to small, undecodable and unsupported images.
//
//   node native/core/fixtures/agent/compact/record_image.mjs [--tree <node checkout with node_modules>]
//
// `golden/image.json`: `targets` (Node's `targetDimensions` for an original size), `notes`
// (`supersedingImageMetadataText`) and `results` (per inline image: Node's verdict, with `decodes` the
// decoder's own answer for its bytes, which the Rust test's codec repeats).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, refreshSetManifest, resolveTree } from '../../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const scratch = mkdtempSync(join(tmpdir(), 'mixdog-image-golden-'));
process.env.MIXDOG_DATA_DIR = scratch;
const agentDir = resolve(here, '..');
mkdirSync(join(here, 'golden'), { recursive: true });
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);
const sharp = createRequire(join(nodeRoot, 'package.json'))('sharp');

// `targetDimensions` is module-private: expose it from a copy of the module (it imports only node:crypto).
const resizePath = join(nodeRoot, 'src/runtime/shared/read-image-resize.mjs');
writeFileSync(join(scratch, 'read-image-resize.mjs'), `${readFileSync(resizePath, 'utf8')}\nexport { targetDimensions };\n`);
const resize = await import(pathToFileURL(join(scratch, 'read-image-resize.mjs')).href);
const { compactResultImages } = await load('src/runtime/agent/orchestrator/session/tool-batch/finalize.mjs');

const sizes = [
  [1, 1], [8, 8], [100, 100], [199, 5000], [200, 200], [3000, 100], [1, 5000], [5000, 1], [10, 4000], [1568, 882], [1568, 1568],
  [1920, 1080], [1800, 1200], [4000, 3000], [8000, 8000], [3840, 2160], [1000, 50], [50, 1000], [2000, 150], [1600, 199],
];
const targets = sizes.map(([width, height]) => {
  const { width: w, height: h, allowEnlargement } = resize.targetDimensions(width, height, 'anthropic');
  return { width, height, target: [w, h], allowEnlargement };
});

const pairs = [[1800, 1200, 1568, 1045], [1700, 800, 800, 376], [1700, 1000, 800, 470], [4000, 3000, 1456, 1092], [100, 100, 200, 200], [1, 5000, 1, 1568], [2125, 1000, 1000, 470]];
const notes = pairs.map(([ow, oh, dw, dh]) => ({
  original: [ow, oh],
  display: [dw, dh],
  text: resize.supersedingImageMetadataText({ originalWidth: ow, originalHeight: oh, displayWidth: dw, displayHeight: dh }),
}));

const png = async (width, height) =>
  (await sharp({ create: { width, height, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');
const jpeg = async (width, height) =>
  (await sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg().toBuffer()).toString('base64');
const webp = async (width, height) =>
  (await sharp({ create: { width, height, channels: 3, background: '#336699' } }).webp().toBuffer()).toString('base64');
const garbage = Buffer.from('definitely not an image').toString('base64');
const good = await png(8, 8);

const decodes = async (data) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    await sharp(buffer).metadata();
    await sharp(buffer, { sequentialRead: true, limitInputPixels: 64 * 1024 * 1024 }).raw().toBuffer();
    return true;
  } catch {
    return false;
  }
};

const images = [
  ['small png', good, 'image/png'],
  ['small jpeg', await jpeg(30, 20), 'image/jpeg'],
  ['small webp', await webp(30, 20), 'image/webp'],
  ['large dimensions, small bytes', await png(3000, 2000), 'image/png'],
  ['garbage png', garbage, 'image/png'],
  ['garbage jpeg', garbage, 'image/jpeg'],
  ['garbage gif', garbage, 'image/gif'],
  ['garbage webp', garbage, 'image/webp'],
  ['svg', good, 'image/svg+xml'],
  ['jpg alias is no image type', good, 'image/jpg'],
  ['upper case mime', good, 'IMAGE/PNG'],
  ['mime with parameters', good, 'image/png; charset=binary'],
  ['mime with parameters, garbage', garbage, 'Image/PNG ; charset=binary'],
  ['padded mime', good, '  image/png  '],
  ['no mime', good, ''],
  ['no mime, garbage', garbage, ''],
  ['empty data', '', 'image/png'],
  ['empty data, unsupported', '', 'image/tiff'],
  ['text mime', good, 'text/plain'],
  ['pdf mime', good, 'application/pdf'],
  ['gif valid bytes', good, 'image/gif'],
].map(([name, data, mimeType]) => [name, data, mimeType]);

const results = [];
for (const [name, data, mimeType] of images) {
  const input = { content: [{ type: 'image', data, ...(mimeType === '' ? {} : { mimeType }) }] };
  const out = await compactResultImages(input);
  const part = out.content[0];
  let outcome;
  if (out === input) outcome = { keep: true };
  else if (part.type === 'text') outcome = { omitted: part.text };
  else throw new Error(`${name}: a small image was re-encoded`);
  results.push({ name, data, mime: mimeType, decodes: await decodes(data), ...outcome });
}

// One real re-encode, kept small: a 190x380 noise PNG just over the 256 KiB base64 gate whose short edge
// is lifted to the 200px floor, so it carries the enlargement, the JPEG bytes and the superseding note.
// `jpeg` is what sharp wrote (base64) at the quality the loop settled on.
const noise = Buffer.alloc(190 * 380 * 3);
let seed = 7;
for (let i = 0; i < noise.length; i += 1) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  noise[i] = seed >>> 24;
}
const noisy = (await sharp(noise, { raw: { width: 190, height: 380, channels: 3 } }).png().toBuffer()).toString('base64');
if (noisy.length <= 256 * 1024) throw new Error('the re-encode image is under the gate');
const { compactToolResultImage } = await load('src/runtime/shared/read-image-resize.mjs');
const compacted = await compactToolResultImage(noisy, 'image/png');
const out = await compactResultImages({ content: [{ type: 'image', data: noisy, mimeType: 'image/png' }] });
if (out.content.length !== 2 || out.content[0].type !== 'text' || out.content[1].data !== compacted.data) throw new Error('unexpected re-encode shape');
const reencode = {
  data: noisy,
  mime: 'image/png',
  original: [compacted.dimensions.originalWidth, compacted.dimensions.originalHeight],
  display: [compacted.dimensions.displayWidth, compacted.dimensions.displayHeight],
  outMime: compacted.mimeType,
  jpeg: compacted.data,
  note: out.content[0].text,
};

writeFileSync(join(here, 'golden', 'image.json'), `${JSON.stringify({ targets, notes, results, reencode }, null, 2)}\n`);
refreshSetManifest(agentDir, nodeRoot);
