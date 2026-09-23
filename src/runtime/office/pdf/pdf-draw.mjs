import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { rgb } from 'pdf-lib';
import sharp from 'sharp';
import { pageSizePoints } from '../shared/page-sizes.mjs';

export const SAVE_OPTIONS = Object.freeze({ useObjectStreams: true, addDefaultPage: false });


export function round2(value) {
  return Number(Number(value).toFixed(2));
}

export function color(value = '') {
  const hex = String(value || '000000').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid PDF color: ${value}`);
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255
  );
}

export function pageSize(properties = {}) {
  const size = pageSizePoints(properties.pageSize || 'a4', 'PDF page size');
  const landscape = String(properties.orientation || '').toLowerCase() === 'landscape';
  return landscape && size[0] < size[1] ? [size[1], size[0]] : size;
}

// A logo handed to Word, Excel or PowerPoint as an .svg lands in all three; the
// PDF page draws rasters only, so the same file is rasterized here instead of
// being refused. It is rendered well above its declared size, and the placement
// still uses the vector's own size so a default-placed logo keeps its scale.
const SVG_RASTER_SCALE = 4;
const SVG_RASTER_MAX_PX = 4000;

function looksLikeSvg(data, extension) {
  if (extension === '.svg') return true;
  return /<svg[\s>]/i.test(data.subarray(0, 512).toString('utf8'));
}

async function rasterizeSvg(data, imagePath) {
  let natural;
  try {
    natural = await sharp(data).metadata();
  } catch (error) {
    throw new Error(`PDF could not read the SVG ${imagePath}: ${error.message}`);
  }
  const width = Number(natural?.width) || 0;
  const height = Number(natural?.height) || 0;
  if (!width || !height)
    throw new Error(`PDF needs the SVG to declare its size (width/height or viewBox): ${imagePath}`);
  const scale = Math.max(1, Math.min(SVG_RASTER_SCALE, SVG_RASTER_MAX_PX / width, SVG_RASTER_MAX_PX / height));
  const png = await sharp(data, { density: Math.round(72 * scale) })
    .png()
    .toBuffer();
  return { png, width, height };
}

// Returns the embedded image with the size the page should place it at: for a
// raster that is its pixel size, for a vector its declared size in points.
export async function embedImage(document, imagePath) {
  const data = await readFile(imagePath);
  const extension = extname(imagePath).toLowerCase();
  const png = extension === '.png' || (data[0] === 0x89 && data[1] === 0x50);
  const jpeg = ['.jpg', '.jpeg'].includes(extension) || (data[0] === 0xff && data[1] === 0xd8);
  if (png) {
    const image = await document.embedPng(data);
    return { image, width: image.width, height: image.height };
  }
  if (jpeg) {
    const image = await document.embedJpg(data);
    return { image, width: image.width, height: image.height };
  }
  if (looksLikeSvg(data, extension)) {
    const raster = await rasterizeSvg(data, imagePath);
    return { image: await document.embedPng(raster.png), width: raster.width, height: raster.height };
  }
  throw new Error(`PDF images must be PNG, JPEG, or SVG: ${imagePath}`);
}

function breakWord(word, font, size, width) {
  const pieces = [];
  let piece = '';
  for (const char of word) {
    if (piece && font.widthOfTextAtSize(piece + char, size) > width) {
      pieces.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

// Line breaks are honoured, words wrap at spaces, and a run wider than the
// line (CJK prose, URLs) breaks by character instead of leaving the page.
export function wrapText(text, font, size, width) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of raw.split(/[ \t]+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      const pieces = font.widthOfTextAtSize(word, size) <= width ? [word] : breakWord(word, font, size, width);
      line = pieces.pop() || '';
      lines.push(...pieces);
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}
