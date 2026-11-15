// Record only against the original read-only Node product. Output stays beside this script.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const tree = process.argv[2] || 'C:/Project/mixdog';
const require = createRequire(`${tree}/package.json`);
const sharp = require('sharp');
const { resizeImageBuffer } = await import(pathToFileURL(`${tree}/src/runtime/shared/read-image-resize.mjs`));
const specimens = [
  ['solid', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#336699"/></svg>'],
  ['alpha', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#336699" fill-opacity="0.5"/></svg>'],
  ['physical', '<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="1in"><rect width="100%" height="100%" fill="red"/></svg>'],
  ['xml', '<?xml version="1.0"?><!-- fixture --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="blue"/></svg>'],
];
const rows = [];
for (const [name, svg] of specimens) {
  const bytes = Buffer.from(svg);
  const meta = await sharp(bytes).metadata();
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const resized = await resizeImageBuffer(bytes, 'png');
  rows.push({ name, svg, width: meta.width, height: meta.height, firstPixel: [...decoded.subarray(0,4)], mime: resized.mimeType, dimensions: resized.dimensions });
}
await writeFile(new URL('./svg-reference.json', import.meta.url), JSON.stringify(rows, null, 2) + '\n');
