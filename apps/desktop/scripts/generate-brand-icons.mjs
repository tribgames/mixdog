import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const supersample = 4;
// 23-B OS mark: near-black tile, three titanium arcs, and a silver star core.
const tile = [7, 8, 11];
const titanium = [
  [[255, 255, 255], [203, 213, 225], [255, 255, 255]],
  [[241, 245, 249], [148, 163, 184], [241, 245, 249]],
  [[226, 232, 240], [100, 116, 139], [226, 232, 240]],
];

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
  const radius = size * (60 / 256);
  const inset = size / 2 - radius;
  const dx = Math.max(Math.abs(x - size / 2) - inset, 0);
  const dy = Math.max(Math.abs(y - size / 2) - inset, 0);
  return dx * dx + dy * dy <= radius * radius;
}

function insideRoundedSquareInset(x, y, size, inset) {
  const radius = Math.max(0, size * (60 / 256) - inset);
  const half = size / 2 - inset;
  const straight = Math.max(0, half - radius);
  const dx = Math.max(Math.abs(x - size / 2) - straight, 0);
  const dy = Math.max(Math.abs(y - size / 2) - straight, 0);
  return dx * dx + dy * dy <= radius * radius;
}

function rotatePoint(x, y, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    128 + (x - 128) * cosine + (y - 128) * sine,
    128 - (x - 128) * sine + (y - 128) * cosine,
  ];
}

function arcSample(x, y, size, rotation) {
  const scale = size / 256;
  const [localX, localY] = rotatePoint(x / scale, y / scale, -rotation);
  const dx = localX - 128;
  const dy = localY - 128;
  const angle = Math.atan2(dy, dx);
  const start = -100 * Math.PI / 180;
  const end = -20 * Math.PI / 180;
  const radius = 68;
  const halfWidth = 14;
  const startX = 128 + radius * Math.cos(start);
  const startY = 128 + radius * Math.sin(start);
  const endX = 128 + radius * Math.cos(end);
  const endY = 128 + radius * Math.sin(end);
  const onCurve = angle >= start && angle <= end && Math.abs(Math.hypot(dx, dy) - radius) <= halfWidth;
  const onStartCap = Math.hypot(localX - startX, localY - startY) <= halfWidth;
  const onEndCap = Math.hypot(localX - endX, localY - endY) <= halfWidth;
  if (!onCurve && !onStartCap && !onEndCap) return null;
  return Math.max(0, Math.min(1, (localX + localY - 177) / 91));
}

function gradientColor(colors, position) {
  const segment = position <= 0.5 ? position * 2 : (position - 0.5) * 2;
  const from = position <= 0.5 ? colors[0] : colors[1];
  const to = position <= 0.5 ? colors[1] : colors[2];
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * segment));
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function renderIcon(size) {
  const highSize = size * supersample;
  const highPixels = new Uint8Array(highSize * highSize * 4);

  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      const iconX = (x + 0.5) / supersample;
      const iconY = (y + 0.5) / supersample;
      const offset = (y * highSize + x) * 4;

      if (insideRoundedSquare(iconX, iconY, size)) {
        const scale = size / 256;
        const pointX = iconX / scale;
        const pointY = iconY / scale;
        let color = insideRoundedSquareInset(iconX, iconY, size, 2.5 * scale)
          ? tile
          : [148, 163, 184];
        for (let arc = 0; arc < 3; arc += 1) {
          const sample = arcSample(iconX, iconY, size, arc * 120 * Math.PI / 180);
          if (sample !== null) color = gradientColor(titanium[arc], sample);
        }
        const star = [[128, 112], [133, 123], [144, 128], [133, 133],
          [128, 144], [123, 133], [112, 128], [123, 123]];
        if (insidePolygon(pointX, pointY, star)) color = [241, 245, 249];
        if (Math.hypot(pointX - 128, pointY - 128) <= 3.5) color = tile;
        if (Math.hypot(pointX - 128, pointY - 128) <= 1.5) color = [255, 255, 255];
        highPixels.set([...color, 255], offset);
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
await writeFile(`${buildDir}/mixdog.png`, pngEntries.at(-1).png);
console.log(`BRAND_ICONS=Mixdog; ICO_BYTES=${offset}`);
