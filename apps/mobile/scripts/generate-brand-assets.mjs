// Renders the Mixdog brand mark (same algorithm as
// apps/desktop/scripts/generate-brand-icons.mjs: ink gradient tile + white
// rounded-cap M) into the source images @capacitor/assets consumes:
//   assets/icon-only.png        1024  full-bleed tile (legacy launchers)
//   assets/icon-foreground.png  1024  transparent + safe-zone M (adaptive)
//   assets/icon-background.png  1024  gradient tile (adaptive underlay)
//   assets/splash.png(-dark)    2732  flat ink + centered rounded tile
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const supersample = 4;
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

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
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

// mode: 'tile' rounded tile+M, 'square' full-bleed tile+M, 'mark' M only
// (transparent), 'plate' gradient only. virtualSize recenters the geometry
// inside canvasSize (adaptive safe zone, splash mark sizing).
function render(canvasSize, mode, virtualSize = canvasSize) {
  const offsetXY = (canvasSize - virtualSize) / 2;
  const rgba = Buffer.alloc(canvasSize * canvasSize * 4);
  const samples = supersample * supersample;
  for (let y = 0; y < canvasSize; y += 1) {
    for (let x = 0; x < canvasSize; x += 1) {
      let red = 0; let green = 0; let blue = 0; let alpha = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const px = x + (sx + 0.5) / supersample - offsetXY;
          const py = y + (sy + 0.5) / supersample - offsetXY;
          const inMark = mode !== 'plate' && insideMonogram(px, py, virtualSize);
          const inPlate = mode === 'square' || mode === 'plate'
            || (mode === 'tile' && insideRoundedSquare(px, py, virtualSize));
          if (inMark) {
            red += 255; green += 255; blue += 255; alpha += 255;
          } else if (inPlate) {
            const t = Math.min(1, Math.max(0, py / virtualSize));
            red += inkTop[0] + (inkBottom[0] - inkTop[0]) * t;
            green += inkTop[1] + (inkBottom[1] - inkTop[1]) * t;
            blue += inkTop[2] + (inkBottom[2] - inkTop[2]) * t;
            alpha += 255;
          }
        }
      }
      const offset = (y * canvasSize + x) * 4;
      rgba[offset] = Math.round(red / samples);
      rgba[offset + 1] = Math.round(green / samples);
      rgba[offset + 2] = Math.round(blue / samples);
      rgba[offset + 3] = Math.round(alpha / samples);
    }
  }
  return rgba;
}

function composite(base, baseSize, overlay, overlaySize) {
  const start = Math.round((baseSize - overlaySize) / 2);
  for (let y = 0; y < overlaySize; y += 1) {
    for (let x = 0; x < overlaySize; x += 1) {
      const from = (y * overlaySize + x) * 4;
      const alpha = overlay[from + 3] / 255;
      if (alpha === 0) continue;
      const to = ((start + y) * baseSize + start + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        base[to + channel] = Math.round(overlay[from + channel] * alpha + base[to + channel] * (1 - alpha));
      }
      base[to + 3] = 255;
    }
  }
}

const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url));
await mkdir(assetsDir, { recursive: true });

await writeFile(`${assetsDir}icon-only.png`, encodePng(1024, 1024, render(1024, 'square')));
// Adaptive foreground: the M spans ~35% of the canvas, inside the 66% safe zone.
await writeFile(`${assetsDir}icon-foreground.png`, encodePng(1024, 1024, render(1024, 'mark', 896)));
await writeFile(`${assetsDir}icon-background.png`, encodePng(1024, 1024, render(1024, 'plate', 1024)));

// Splash: flat deep-ink field with the rounded tile centered.
const splashSize = 2732;
const splash = Buffer.alloc(splashSize * splashSize * 4);
for (let i = 0; i < splashSize * splashSize; i += 1) {
  splash.set([26, 25, 23, 255], i * 4);
}
const tile = render(512, 'tile');
composite(splash, splashSize, tile, 512);
const splashPng = encodePng(splashSize, splashSize, splash);
await writeFile(`${assetsDir}splash.png`, splashPng);
await writeFile(`${assetsDir}splash-dark.png`, splashPng);
console.log('BRAND_ASSETS=icon-only, icon-foreground, icon-background, splash, splash-dark');
