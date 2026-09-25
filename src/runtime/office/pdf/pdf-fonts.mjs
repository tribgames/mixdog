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
  const missing = [];
  const seen = new Set();
  for (const char of String(text || '')) {
    if (char.codePointAt(0) <= 32 || seen.has(char)) continue;
    if (hasGlyph(font, char) || standIn(font, char) !== null) continue;
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

// Typographic characters a face often lacks, each with the glyphs that set it
// the way a typesetter would: the writing guide asks for the minus sign on a
// negative figure (−6p), and Malgun Gothic and the standard PDF fonts have
// none, so a Korean report carrying one refused to write at all.
const TYPOGRAPHIC_STAND_INS = Object.freeze({
  '\u2212': ['\u2013', '-'],
  '\u2010': ['-'],
  '\u2011': ['-'],
  '\u2007': [' '],
  '\u2009': [' '],
  '\u200A': [' '],
  '\u202F': [' '],
});

function hasGlyph(font, char) {
  const face = font?.embedder?.font;
  if (typeof face?.hasGlyphForCodePoint === 'function') return face.hasGlyphForCodePoint(char.codePointAt(0));
  try {
    font.encodeText(char);
    return true;
  } catch {
    return false;
  }
}

function standIn(font, char) {
  return (TYPOGRAPHIC_STAND_INS[char] || []).find((candidate) => hasGlyph(font, candidate)) ?? null;
}

/**
 * The font with its typographic stand-ins applied wherever it encodes or measures text, so every page, stamp,
 * and field drawn with it sets a minus sign it lacks as an en dash instead of a missing glyph. A face that
 * carries every one of those characters is returned unchanged.
 */
function withStandIns(font) {
  const substitutes = new Map();
  for (const char of Object.keys(TYPOGRAPHIC_STAND_INS)) {
    if (hasGlyph(font, char)) continue;
    const replacement = standIn(font, char);
    if (replacement !== null) substitutes.set(char, replacement);
  }
  if (!substitutes.size) return font;
  const pattern = new RegExp(`[${[...substitutes.keys()].join('')}]`, 'gu');
  const set = (text) => String(text ?? '').replace(pattern, (char) => substitutes.get(char));
  return Object.create(font, {
    encodeText: { value: (text) => font.encodeText(set(text)) },
    widthOfTextAtSize: { value: (text, size) => font.widthOfTextAtSize(set(text), size) },
  });
}

/** True when every character of text has a glyph in the font, or a typographic stand-in it has (standard fonts throw on encode; embedded faces map misses to .notdef, so ask the face). */
export function fontCovers(font, text) {
  if (!text) return true;
  const seen = new Set();
  for (const char of String(text)) {
    if (char.codePointAt(0) <= 32 || seen.has(char)) continue;
    seen.add(char);
    if (!hasGlyph(font, char) && standIn(font, char) === null) return false;
  }
  return true;
}

// The bold face that ships beside a regular one: malgun.ttf / malgunbd.ttf, segoeui.ttf / segoeuib.ttf,
// NanumGothic.ttf / NanumGothicBold.ttf, DejaVuSans.ttf / DejaVuSans-Bold.ttf, a -Regular file and its -Bold.
function boldCompanions(path) {
  const file = String(path || '');
  if (!/\.(ttf|otf)$/i.test(file)) return [];
  return [
    ...new Set(
      [
        file.replace(/-Regular(\.\w+)$/i, '-Bold$1'),
        file.replace(/Regular(\.\w+)$/i, 'Bold$1'),
        file.replace(/(\.\w+)$/, 'bd$1'),
        file.replace(/(\.\w+)$/, 'b$1'),
        file.replace(/(\.\w+)$/, '-Bold$1'),
        file.replace(/(\.\w+)$/, 'Bold$1'),
      ].filter((candidate) => candidate !== file)
    ),
  ];
}

/**
 * The bold face for headings, table headers, labels, and figures: Helvetica-Bold beside Helvetica, else the
 * installed bold companion of the embedded face when it covers the same text. Without one the regular face
 * stands in, so a document without a bold file still writes — only without the weight.
 */
export async function embedBoldFont(document, { font, fontPath = '', text = '' } = {}) {
  if (!fontPath) return withStandIns(await document.embedFont(StandardFonts.HelveticaBold));
  for (const candidate of boldCompanions(fontPath)) {
    try {
      await access(candidate);
      const bold = await document.embedFont(await readFile(candidate), { subset: true });
      if (fontCovers(bold, text)) return withStandIns(bold);
    } catch {}
  }
  return font;
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
    if (fontCovers(builtin, text)) return { font: withStandIns(builtin), fontPath: '', embedded: false };
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
    if (fontCovers(font, text)) return { font: withStandIns(font), fontPath: candidate, embedded: true };
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
