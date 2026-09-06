import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { rgb } from 'pdf-lib';

export const SAVE_OPTIONS = Object.freeze({ useObjectStreams: true, addDefaultPage: false });

export const PAGE_SIZES = Object.freeze({
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
});

export function round2(value) {
  return Number(Number(value).toFixed(2));
}

export function color(value = '') {
  const hex = String(value || '000000').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid PDF color: ${value}`);
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  );
}

export function pageSize(properties = {}) {
  let size;
  if (Array.isArray(properties.pageSize) && properties.pageSize.length === 2) {
    size = properties.pageSize.map(Number);
  } else {
    const named = String(properties.pageSize || 'a4').toLowerCase();
    if (!PAGE_SIZES[named]) {
      throw new Error(`Unknown PDF page size: ${properties.pageSize}; use ${Object.keys(PAGE_SIZES).join(', ')} or [width, height] in points`);
    }
    size = [...PAGE_SIZES[named]];
  }
  if (!size.every((value) => Number.isFinite(value) && value > 0)) throw new Error('PDF pageSize must be two positive numbers in points');
  const landscape = String(properties.orientation || '').toLowerCase() === 'landscape';
  return landscape && size[0] < size[1] ? [size[1], size[0]] : size;
}

export async function embedImage(document, imagePath) {
  const data = await readFile(imagePath);
  const extension = extname(imagePath).toLowerCase();
  const png = extension === '.png' || (data[0] === 0x89 && data[1] === 0x50);
  const jpeg = ['.jpg', '.jpeg'].includes(extension) || (data[0] === 0xff && data[1] === 0xd8);
  if (png) return await document.embedPng(data);
  if (jpeg) return await document.embedJpg(data);
  throw new Error(`PDF images must be PNG or JPEG: ${imagePath}`);
}

function breakWord(word, font, size, width) {
  const pieces = [];
  let piece = '';
  for (const char of Array.from(word)) {
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
