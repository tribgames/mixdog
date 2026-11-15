#!/usr/bin/env node
// The decoded samples of the JPEG 2000 corpus of `record-office-jpx.mjs` (WP nr-office-pdf-jpx-decode).
//
//   node benchmarks/rust-core/recorders/record-office-jpx-pixels.mjs [--pdfjs <pdfjs-dist dir>] [--in <office-jpx dir>]
//
// Reads every file of native/core/fixtures/office-jpx (or --in), decodes it through pdf.js 6.4.299's own `JpxImage`
// (OpenJPEG as compiled into wasm/openjpeg.wasm, loaded explicitly: the Node configuration the application runs in
// sets no `wasmUrl` and cannot load it) with the component count the corpus recorder used, and writes
// native/core/fixtures/office-jpx-pixels/: `pixels.json` (per case the 8-bit samples as lower-case hex) and
// `MANIFEST.json`. `crates/mixdog-pdf/tests/twin_jpx.rs` replays it: lossless streams must match every sample,
// lossy ones within one level.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : fallback);
const pdfjsDir = option('--pdfjs', join(ROOT, 'node_modules', 'pdfjs-dist'));
const IN = option('--in', join(ROOT, 'native', 'core', 'fixtures', 'office-jpx'));
const OUT = join(ROOT, 'native', 'core', 'fixtures', 'office-jpx-pixels');

const expected = JSON.parse(readFileSync(join(IN, 'expected.json'), 'utf8'));
const dec = await import(pathToFileURL(join(pdfjsDir, 'image_decoders', 'pdf.image_decoders.mjs')).href);
const { JpxImage } = dec;
const pkg = JSON.parse(readFileSync(join(pdfjsDir, 'package.json'), 'utf8'));
const wasmDir = join(pdfjsDir, 'wasm');
JpxImage.setOptions({
  useWasm: true,
  useWorkerFetch: false,
  wasmUrl: null,
  handler: { sendWithPromise: async (_name, { filename }) => new Uint8Array(readFileSync(join(wasmDir, filename))) },
});

const cases = {};
for (const [name, c] of Object.entries(expected.cases)) {
  const bytes = new Uint8Array(readFileSync(join(IN, c.file)));
  const numComponents = Math.min(c.comps.length, 4);
  try {
    const pixels = await JpxImage.instance.decode(bytes, { numComponents });
    cases[name] = { file: c.file, numComponents, pixels: Buffer.from(pixels).toString('hex') };
  } catch (e) {
    cases[name] = { file: c.file, numComponents, error: String((e && e.message) || e) };
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'pixels.json'), `${JSON.stringify({ generator: 'benchmarks/rust-core/recorders/record-office-jpx-pixels.mjs', pdfjs: pkg.version, cases })}\n`);
const manifest = {
  set: 'office-jpx-pixels',
  recorder: 'benchmarks/rust-core/recorders/record-office-jpx-pixels.mjs',
  command: 'node benchmarks/rust-core/recorders/record-office-jpx-pixels.mjs',
  pdfjsDist: pkg.version,
  nodeVersion: process.version,
  recorderSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
};
manifest.files = readdirSync(OUT).filter((f) => f !== 'MANIFEST.json').sort().map((f) => {
  const d = readFileSync(join(OUT, f));
  return { path: f, bytes: d.length, sha256: createHash('sha256').update(d).digest('hex') };
});
manifest.fileCount = manifest.files.length;
manifest.totalBytes = manifest.files.reduce((a, f) => a + f.bytes, 0);
writeFileSync(join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.files.length} files to ${OUT}`);
