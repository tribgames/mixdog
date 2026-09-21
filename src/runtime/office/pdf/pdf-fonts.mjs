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

const PDF_FONT_HINT =
  'pass fontPath pointing to a Unicode TrueType/OpenType font (Windows: C:\\Windows\\Fonts\\malgun.ttf) or set MIXDOG_OCR_FONT';

/** Readable Unicode fonts in preference order: the explicit path, the MIXDOG_OCR_FONT override, then the platform list. */
async function unicodeFontCandidates(explicit = '') {
  const found = [];
  for (const candidate of [
    explicit ? resolve(String(explicit)) : '',
    process.env.MIXDOG_OCR_FONT,
    ...SYSTEM_UNICODE_FONTS,
  ].filter(Boolean)) {
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

/** The characters of `text` the font has no glyph for, in first-seen order. */
function uncoveredCharacters(font, text, limit = 6) {
  const face = font?.embedder?.font;
  const missing = [];
  const seen = new Set();
  for (const char of String(text || '')) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 32 || seen.has(char)) continue;
    const covered =
      typeof face?.hasGlyphForCodePoint === 'function'
        ? face.hasGlyphForCodePoint(codePoint)
        : (() => {
            try {
              font.encodeText(char);
              return true;
            } catch {
              return false;
            }
          })();
    if (covered) continue;
    seen.add(char);
    missing.push(char);
    if (missing.length >= limit) break;
  }
  return missing;
}

/** `😀 (U+1F600)` for each character, for an error that names what blocks the file. */
function describeUncovered(characters = []) {
  return characters
    .map((char) => `${char} (U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
    .join(', ');
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
export async function embedDocumentFont(
  document,
  { fontPath = '', text = '', standard = StandardFonts.Helvetica } = {}
) {
  if (!fontPath) {
    const builtin = await document.embedFont(standard);
    if (fontCovers(builtin, text)) return { font: builtin, fontPath: '', embedded: false };
  }
  const candidates = await unicodeFontCandidates(fontPath);
  if (fontPath && !candidates.length) throw new Error(`PDF font file was not found: ${fontPath}`);
  document.registerFontkit(fontkit);
  // The first face that embedded is what the missing characters are reported
  // against: it is the coverage the machine actually has.
  let widest = null;
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
    if (fontPath) {
      const missing = describeUncovered(uncoveredCharacters(font, text));
      throw new Error(`Font ${candidate} has no glyph for ${missing || 'part of the text'}; ${PDF_FONT_HINT}`);
    }
    widest = widest ?? font;
  }
  // Naming the characters is the difference between a fixable answer and a
  // font hunt: an emoji or a rare ideograph no installed face carries is removed
  // or replaced in the text, while a missing script really does want another font.
  const missing = widest ? describeUncovered(uncoveredCharacters(widest, text)) : '';
  throw new Error(
    `PDF text carries ${missing ? `${missing} — ` : 'characters '}no installed font covers` +
      `${missing ? '' : ' and the standard PDF fonts cannot encode'}.` +
      ` Replace or remove ${missing ? 'those characters' : 'them'}, or ${PDF_FONT_HINT}.`
  );
}
