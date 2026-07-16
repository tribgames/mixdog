import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const size = 256;
const rgba = Buffer.alloc(size * size * 4);

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    const rounded = (
      (x >= 24 && x < 232 && y >= 8 && y < 248)
      && !((x < 44 || x >= 212) && (y < 28 || y >= 228))
    );
    const left = x >= 54 && x < 86 && y >= 57 && y < 199;
    const right = x >= 170 && x < 202 && y >= 57 && y < 199;
    const down = x >= 86 && x < 170 && y >= 143 && y < 175;
    const notch = x >= 112 && x < 144 && y >= 111 && y < 143;
    const mark = left || right || down || notch;
    const color = mark ? [255, 255, 255, 255] : rounded ? [91, 76, 255, 255] : [0, 0, 0, 0];
    rgba.set(color, offset);
  }
}

let crcTable;
function crc32(buffer) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ICO image dimensions encode 256 as zero; modern Windows accepts embedded PNG.
const icoHeader = Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0]);
const icoEntry = Buffer.alloc(8);
icoEntry.writeUInt32LE(png.length, 0);
icoEntry.writeUInt32LE(22, 4);
const buildDir = fileURLToPath(new URL('../build/', import.meta.url));
await mkdir(buildDir, { recursive: true });
await Promise.all([
  writeFile(`${buildDir}/mixdog.png`, png),
  writeFile(`${buildDir}/mixdog.ico`, Buffer.concat([icoHeader, icoEntry, png])),
]);
console.log(`BRAND_ICONS=Mixdog; PNG_BYTES=${png.length}; ICO_BYTES=${png.length + 22}`);
