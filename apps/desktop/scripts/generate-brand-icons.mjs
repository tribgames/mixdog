import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const supersample = 4;
// Brand icon: near-black tile with a subtle vertical gradient and a white
// rounded-cap M (chosen design r6-9).
const inkTop = [27, 26, 23];
const inkBottom = [42, 41, 37];

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

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedSquare(x, y, size) {
  const radius = size * 0.22;
  const inset = size / 2 - radius;
  const dx = Math.max(Math.abs(x - size / 2) - inset, 0);
  const dy = Math.max(Math.abs(y - size / 2) - inset, 0);
  return dx * dx + dy * dy <= radius * radius;
}

function insideStroke(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  // Capsule: clamp the projection so every stroke ends in a round cap.
  const projection = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));

  const closestX = ax + projection * dx;
  const closestY = ay + projection * dy;
  const distanceX = x - closestX;
  const distanceY = y - closestY;
  return distanceX * distanceX + distanceY * distanceY <= (width / 2) ** 2;
}

function insideMonogram(x, y, size) {
  const scale = size / 256;
  const width = 33.28 * scale;
  const left = 76.8 * scale;
  const right = 179.2 * scale;
  const top = 81.92 * scale;
  const bottom = 174.08 * scale;
  const center = 128 * scale;
  const point = 153.6 * scale;

  return (
    insideStroke(x, y, left, top, left, bottom, width)
    || insideStroke(x, y, right, top, right, bottom, width)
    || insideStroke(x, y, left + width / 2, top, center, point, width)
    || insideStroke(x, y, center, point, right - width / 2, top, width)
  );
}

function renderIcon(size) {
  const highSize = size * supersample;
  const highPixels = new Uint8Array(highSize * highSize * 4);

  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      const iconX = (x + 0.5) / supersample;
      const iconY = (y + 0.5) / supersample;
      const offset = (y * highSize + x) * 4;

      if (insideMonogram(iconX, iconY, size)) {
        highPixels.set([255, 255, 255, 255], offset);
      } else if (insideRoundedSquare(iconX, iconY, size)) {
        const t = iconY / size;
        highPixels.set([
          Math.round(inkTop[0] + (inkBottom[0] - inkTop[0]) * t),
          Math.round(inkTop[1] + (inkBottom[1] - inkTop[1]) * t),
          Math.round(inkTop[2] + (inkBottom[2] - inkTop[2]) * t),
          255,
        ], offset);
      }
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  const samples = supersample * supersample;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sampleY = 0; sampleY < supersample; sampleY += 1) {
        for (let sampleX = 0; sampleX < supersample; sampleX += 1) {
          const highOffset = (((y * supersample + sampleY) * highSize) + x * supersample + sampleX) * 4;
          red += highPixels[highOffset];
          green += highPixels[highOffset + 1];
          blue += highPixels[highOffset + 2];
          alpha += highPixels[highOffset + 3];
        }
      }
      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(red / samples);
      rgba[offset + 1] = Math.round(green / samples);
      rgba[offset + 2] = Math.round(blue / samples);
      rgba[offset + 3] = Math.round(alpha / samples);
    }
  }

  return rgba;
}

const pngEntries = iconSizes.map((size) => ({ size, png: encodePng(size, renderIcon(size)) }));
const icoHeaderSize = 6 + pngEntries.length * 16;
const ico = Buffer.alloc(icoHeaderSize);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(pngEntries.length, 4);

let offset = icoHeaderSize;
for (const [index, entry] of pngEntries.entries()) {
  const entryOffset = 6 + index * 16;
  ico[entryOffset] = entry.size === 256 ? 0 : entry.size;
  ico[entryOffset + 1] = entry.size === 256 ? 0 : entry.size;
  ico.writeUInt16LE(1, entryOffset + 4);
  ico.writeUInt16LE(32, entryOffset + 6);
  ico.writeUInt32LE(entry.png.length, entryOffset + 8);
  ico.writeUInt32LE(offset, entryOffset + 12);
  offset += entry.png.length;
}

const buildDir = fileURLToPath(new URL('../build/', import.meta.url));
await mkdir(buildDir, { recursive: true });
await writeFile(`${buildDir}/mixdog.ico`, Buffer.concat([ico, ...pngEntries.map(({ png }) => png)]));
await writeFile(`${buildDir}/mixdog-icon-preview.png`, pngEntries.at(-1).png);
console.log(`BRAND_ICONS=Mixdog; ICO_BYTES=${offset}`);
