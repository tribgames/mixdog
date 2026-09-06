import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts } from 'pdf-lib';

// The standard PDF fonts only cover WinAnsi (Latin-1 plus a few symbols).
// Anything else — Hangul, CJK, Cyrillic, Greek — needs a TrueType/OpenType
// face embedded in the file. These are the faces a machine is likely to have;
// the first that exists wins, and an explicit fontPath always comes first.
const SYSTEM_UNICODE_FONTS = Object.freeze([
  process.platform === 'win32' ? 'C:\\Windows\\Fonts\\malgun.ttf' : '',
  process.platform === 'win32' ? 'C:\\Windows\\Fonts\\arialuni.ttf' : '',
  process.platform === 'win32' ? 'C:\\Windows\\Fonts\\segoeui.ttf' : '',
  process.platform === 'darwin' ? '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' : '',
  process.platform === 'darwin' ? '/Library/Fonts/Arial Unicode.ttf' : '',
  process.platform === 'darwin' ? '/System/Library/Fonts/AppleSDGothicNeo.ttc' : '',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
]);

export const PDF_FONT_HINT = 'pass fontPath pointing to a Unicode TrueType/OpenType font (Windows: C:\\Windows\\Fonts\\malgun.ttf) or set MIXDOG_OCR_FONT';

/** Readable Unicode fonts in preference order: the explicit path, the MIXDOG_OCR_FONT override, then the platform list. */
export async function unicodeFontCandidates(explicit = '') {
  const found = [];
  for (const candidate of [explicit ? resolve(String(explicit)) : '', process.env.MIXDOG_OCR_FONT, ...SYSTEM_UNICODE_FONTS].filter(Boolean)) {
    try {
      await access(candidate);
      found.push(candidate);
    } catch {}
  }
  return found;
}

export async function unicodeFontPath(explicit = '') {
  return (await unicodeFontCandidates(explicit))[0] || '';
}

/** True when every character of text has a glyph in the font (standard fonts throw on encode; embedded faces map misses to .notdef, so ask the face). */
export function fontCovers(font, text) {
  if (!text) return true;
  const face = font?.embedder?.font;
  if (typeof face?.hasGlyphForCodePoint === 'function') {
    for (const char of String(text)) {
      const codePoint = char.codePointAt(0);
      if (codePoint > 32 && !face.hasGlyphForCodePoint(codePoint)) return false;
    }
    return true;
  }
  try {
    font.encodeText(String(text));
    return true;
  } catch {
    return false;
  }
}

/**
 * Embed the font a document needs for `text`: an explicit fontPath always wins;
 * otherwise Helvetica when it can encode the text, else the first installed
 * Unicode face that covers it. Throws a hint instead of pdf-lib's WinAnsi
 * error when no face does.
 */
export async function embedDocumentFont(document, {
  fontPath = '',
  text = '',
  standard = StandardFonts.Helvetica,
} = {}) {
  if (!fontPath) {
    const builtin = await document.embedFont(standard);
    if (fontCovers(builtin, text)) return { font: builtin, fontPath: '', embedded: false };
  }
  const candidates = await unicodeFontCandidates(fontPath);
  if (fontPath && !candidates.length) throw new Error(`PDF font file was not found: ${fontPath}`);
  document.registerFontkit(fontkit);
  for (const candidate of fontPath ? candidates.slice(0, 1) : candidates) {
    let font;
    try {
      font = await document.embedFont(await readFile(candidate), { subset: true });
    } catch (error) {
      // Collections (.ttc) and damaged files cannot be embedded; an explicit choice reports it, the fallback moves on.
      if (fontPath) throw new Error(`PDF font ${candidate} could not be embedded: ${error?.message || error}`);
      continue;
    }
    if (fontCovers(font, text)) return { font, fontPath: candidate, embedded: true };
    if (fontPath) throw new Error(`Font ${candidate} has no glyphs for part of the text; ${PDF_FONT_HINT}`);
  }
  throw new Error(`Text contains characters the standard PDF fonts cannot encode and no installed Unicode font covers it; ${PDF_FONT_HINT}`);
}
