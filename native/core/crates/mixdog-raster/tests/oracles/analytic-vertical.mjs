// Reproduce the strict pixel oracle against the original, read-only Node checkout.
// Usage: node tests/oracles/analytic-vertical.mjs C:/Project/mixdog
// Writes JSON to stdout only. JS automatic font loading is disabled; the native
// canvas font manager may enumerate OS fonts. This path-only probe uses no text.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

if (!process.argv[2]) throw new Error('Pass the original read-only Node checkout.');
process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
const reference = resolve(process.argv[2]);
const require = createRequire(resolve(reference, 'package.json'));
const { createCanvas, Path2D } = require('@napi-rs/canvas');
const version = require('@napi-rs/canvas/package.json').version;
if (version !== '1.0.11') throw new Error(`Expected @napi-rs/canvas 1.0.11; found ${version}`);
const bindingPackage = '@napi-rs/canvas-win32-x64-msvc';
const binding = require.resolve(bindingPackage);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const geometry = [[10.1, 5], [10.1, 25], [30, 25], [30, 5], [20, 4.5]];
const samples = [];
for (const background of ['transparent', 'white']) {
  const canvas = createCanvas(40, 40);
  const context = canvas.getContext('2d');
  if (background === 'white') {
    context.fillStyle = 'white';
    context.fillRect(0, 0, 40, 40);
  }
  const path = new Path2D();
  path.moveTo(...geometry[0]);
  for (const point of geometry.slice(1)) path.lineTo(...point);
  path.closePath();
  context.fillStyle = 'black';
  context.fill(path);
  samples.push({ background, rgba: Array.from(context.getImageData(10, 15, 1, 1).data) });
}
console.log(JSON.stringify({
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  canvasVersion: version,
  skiaPin: '95ee33d7ec7791ab9c071675710a14fe6408ae4f',
  skiaPinSource: 'https://api.github.com/repos/Brooooooklyn/canvas/contents/skia?ref=v1.0.11',
  bindingPackage,
  bindingSha256: sha256(readFileSync(binding)),
  scriptSha256: sha256(readFileSync(new URL(import.meta.url))),
  javascriptAutomaticFontLoadingDisabled: true,
  nativeSystemFontManagerMayReadOsFonts: true,
  canvasSize: [40, 40], geometry, pixel: [10, 15], fill: 'black', samples,
}, null, 2));
