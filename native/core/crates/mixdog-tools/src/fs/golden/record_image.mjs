#!/usr/bin/env node
// Parity goldens for `read` on an image. The real Node `read` runs over a workspace holding an
// image built here (a flat-colour PNG in stored zlib blocks, so any port can rebuild the same
// bytes from the recipe); each case stores the recipe, the args and the result's content blocks.
// An image block is kept as its mime type, base64 length and sha256: the bytes are `sharp`'s.
//
//   node record_image.mjs --tree <Node product tree with node_modules>
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const tree = resolve(argv[argv.indexOf('--tree') + 1]);
const work = mkdtempSync(join(tmpdir(), 'mixdog-image-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { executeBuiltinTool } = await importFrom('src/runtime/agent/orchestrator/tools/builtin.mjs');
const sharp = createRequire(join(tree, 'package.json'))('sharp');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};
const adler32 = (buf) => {
  let a = 1;
  let b = 0;
  for (const x of buf) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};
// zlib stream of stored blocks of at most 65535 bytes, header 78 01.
const stored = (raw) => {
  const parts = [Buffer.from([0x78, 0x01])];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const part = raw.subarray(at, at + 65535);
    const last = at + 65535 >= raw.length;
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt16LE(part.length, 1);
    head.writeUInt16LE(~part.length & 0xffff, 3);
    parts.push(head, part);
    if (last) break;
  }
  parts.push(u32(adler32(raw)));
  return Buffer.concat(parts);
};
const flatPng = ({ width, height, rgb }) => {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', stored(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const cases = [
  { name: 'image-over-cap', file: 'big.png', png: { width: 2000, height: 1000, rgb: [200, 30, 90] } },
  { name: 'image-over-cap-tall', file: 'tall.png', png: { width: 700, height: 2200, rgb: [10, 120, 240] } },
  { name: 'image-under-cap', file: 'small.png', png: { width: 300, height: 200, rgb: [20, 200, 20] } },
  { name: 'image-tiny-upscaled', file: 'tiny.png', png: { width: 40, height: 30, rgb: [90, 90, 90] } },
  {
    name: 'batch-image-and-text',
    file: 'big.png',
    png: { width: 2000, height: 1000, rgb: [200, 30, 90] },
    input: { path: ['big.png', 'note.txt'] },
    extra: { 'note.txt': 'hello\nworld\n' },
  },
  { name: 'image-empty', file: 'empty.png', bytes: '' },
  { name: 'image-corrupt', file: 'bad.png', bytes: 'not a png at all' },
];

const recorded = [];
for (const [index, c] of cases.entries()) {
  const ws = join(work, `ws${index}`);
  mkdirSync(ws, { recursive: true });
  const bytes = c.png ? flatPng(c.png) : Buffer.from(c.bytes, 'utf8');
  writeFileSync(join(ws, c.file), bytes);
  for (const [rel, text] of Object.entries(c.extra ?? {})) writeFileSync(join(ws, rel), text);
  const raw = await executeBuiltinTool('read', c.input ?? { path: c.file }, ws);
  const blocks = [];
  for (const block of raw.content ?? []) {
    if (block.type !== 'image') {
      blocks.push({ type: block.type, text: block.text });
      continue;
    }
    const meta = await sharp(Buffer.from(block.data, 'base64')).metadata();
    blocks.push({
      type: 'image',
      mimeType: block.mimeType,
      base64Length: block.data.length,
      base64Sha256: createHash('sha256').update(block.data).digest('hex'),
      width: meta.width,
      height: meta.height,
    });
  }
  recorded.push({
    name: c.name,
    file: c.file,
    ...(c.png ? { png: c.png, sourceBytes: bytes.length, sourceSha256: createHash('sha256').update(bytes).digest('hex') } : { bytes: c.bytes }),
    input: c.input ?? { path: c.file },
    ...(c.extra ? { extra: c.extra } : {}),
    isError: raw.isError === true,
    content: blocks,
  });
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'image_cases.json');
writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${recorded.length} cases -> ${out}`);