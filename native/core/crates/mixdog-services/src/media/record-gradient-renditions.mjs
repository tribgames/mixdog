// Records what sharp (the product's Node `encodeStill` of src/runtime/media/renditions.mjs) makes of the 64x48 gradient for
// both variants, as base64 of the WebP bytes, for the constants of renditions.rs's real-worker test.
// Run: node record-gradient-renditions.mjs <path of sharp> <path of gradient.jpg> <thumb maxEdge> <thumb quality> <display maxEdge> <display quality>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const [sharpPath, jpg, tEdge, tQ, dEdge, dQ] = process.argv.slice(2);
const sharp = createRequire(import.meta.url)(sharpPath);
const input = readFileSync(jpg);
for (const [name, edge, quality] of [['thumb', tEdge, tQ], ['display', dEdge, dQ]]) {
  const buffer = await sharp(input).rotate().resize(+edge, +edge, { fit: 'inside', withoutEnlargement: true }).webp({ quality: +quality }).toBuffer();
  console.log(name, buffer.length, buffer.toString('base64'));
}
