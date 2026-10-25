/**
 * Measured KaTeX metrics for text-mode characters KaTeX has none for.
 *
 * KaTeX lets CJK, Cyrillic, Indic, … text appear in `\text{}` (its
 * `supportedCodepoint` scripts) but ships no metrics for those glyphs, so
 * `getCharacterMetrics` lends them the metrics of 'M' (height 0.683, depth 0).
 * A Hangul syllable really rises ~0.875 em and drops ~0.141 em, so a fraction
 * places its numerator/denominator as if the glyphs were shorter and the ink
 * crosses the bar. Before KaTeX lays a formula out, this gives each such
 * character the metrics of the glyph the browser will actually paint, measured
 * once with a 2D canvas, through KaTeX's public `__setFontMetrics` extension
 * point.
 */
import katex from 'katex';
import { getCharacterMetrics } from 'katex/src/fontMetrics.ts';
import builtInFontMetrics from 'katex/src/fontMetricsData.js';
import { supportedCodepoint } from 'katex/src/unicodeScripts.ts';

type MetricsTuple = [depth: number, height: number, italic: number, skew: number, width: number];

// `__setFontMetrics` / `__parse` are KaTeX's extension points; its typings omit them.
const katexInternals = katex as unknown as {
  __setFontMetrics(font: string, metrics: Record<number, MetricsTuple>): void;
  __parse(expression: string, settings: object): unknown;
};

/** Ink extents of one glyph, in em of the font it was measured in. */
export interface GlyphInk {
  ascent: number;
  descent: number;
  advance: number;
}

export interface GlyphFace {
  style: 'normal' | 'italic';
  weight: 'normal' | 'bold';
  /** CSS font-family values the face can paint in; the first is the primary. */
  families: string[];
}

export type GlyphMeasurer = (face: GlyphFace, character: string) => GlyphInk;

// katex.css: `.katex { font: normal 1.21em KaTeX_Main, math, Times New Roman,
// serif }` is what text without a family class paints in (`\text`, `\textbf`,
// `\textit`). `.textrm` and `.mathbf` replace the whole family with
// `KaTeX_Main` alone, `.textsf` with `KaTeX_SansSerif`, `.texttt` with
// `KaTeX_Typewriter`. None of these fonts has the glyphs, so the browser falls
// through to a system font, and the two Main stacks fall through differently
// (measured on Windows, Hangul at 400 px: long stack 0.875 / 0.141 em, short
// stack 0.844 / 0.109 em). KaTeX keys metrics by font name and `\text` and
// `\textrm` share `Main-Regular`, so a Main face takes the larger ink of both
// stacks: whichever one paints, the ink stays inside the registered box.
const KATEX_STACK = 'KaTeX_Main, math, "Times New Roman", serif';
const MAIN_FAMILIES = [KATEX_STACK, 'KaTeX_Main'];

/** KaTeX font names text-mode characters resolve to
 *  (`retrieveTextFontName` in KaTeX's buildCommon.ts), with the CSS they paint in. */
const TEXT_FONT_FACES: Record<string, GlyphFace> = {
  'Main-Regular': { style: 'normal', weight: 'normal', families: MAIN_FAMILIES },
  'Main-Bold': { style: 'normal', weight: 'bold', families: MAIN_FAMILIES },
  'Main-Italic': { style: 'italic', weight: 'normal', families: MAIN_FAMILIES },
  'Main-BoldItalic': { style: 'italic', weight: 'bold', families: MAIN_FAMILIES },
  'SansSerif-Regular': { style: 'normal', weight: 'normal', families: ['KaTeX_SansSerif'] },
  'SansSerif-Bold': { style: 'normal', weight: 'bold', families: ['KaTeX_SansSerif'] },
  'SansSerif-Italic': { style: 'italic', weight: 'normal', families: ['KaTeX_SansSerif'] },
  'Typewriter-Regular': { style: 'normal', weight: 'normal', families: ['KaTeX_Typewriter'] },
};

// Canvas ink bounds (actualBoundingBox*) come back rounded to whole pixels, so
// the em error is 1/size. Measured for all Hangul syllables, long stack, max
// ascent / descent in em: 25 px 0.880 / 0.160, 50 px 0.880 / 0.140, 100 px
// 0.880 / 0.140, 200 px 0.875 / 0.140, 400 px 0.875 / 0.1406; the advance
// (0.966) is the same at every size. Values scale linearly, so measure big and
// divide by the size.
const MEASURE_SIZE_PX = 400;

function createCanvasMeasurer(): GlyphMeasurer | null {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : typeof document !== 'undefined'
        ? document.createElement('canvas')
        : null;
  const context = canvas?.getContext('2d') ?? null;
  if (!context) return null;
  return (face, character) => {
    let ascent = -Infinity;
    let descent = -Infinity;
    let advance = 0;
    face.families.forEach((family, index) => {
      context.font = `${face.style} ${face.weight} ${MEASURE_SIZE_PX}px ${family}`;
      const metrics = context.measureText(character);
      ascent = Math.max(ascent, metrics.actualBoundingBoxAscent / MEASURE_SIZE_PX);
      descent = Math.max(descent, metrics.actualBoundingBoxDescent / MEASURE_SIZE_PX);
      if (index === 0) advance = metrics.width / MEASURE_SIZE_PX;
    });
    return { ascent, descent, advance };
  };
}

let measurer: GlyphMeasurer | null | undefined;
/** Code units already examined (measured, or found to need nothing). */
const examined = new Set<number>();
/** Per font, the one merged map (built-in data + measured glyphs) handed to
 *  KaTeX; new glyphs are added to it in place. */
const registeredMaps = new Map<string, Record<number, MetricsTuple>>();

function activeMeasurer(): GlyphMeasurer | null {
  if (measurer === undefined) measurer = createCanvasMeasurer();
  return measurer;
}

function registeredMap(font: string): Record<number, MetricsTuple> {
  let map = registeredMaps.get(font);
  if (!map) {
    // KaTeX's setter replaces a font's whole map, so merge over the built-in one.
    map = { ...builtInFontMetrics[font] };
    registeredMaps.set(font, map);
    katexInternals.__setFontMetrics(font, map);
  }
  return map;
}

/** Replaces the measurer (undefined restores the canvas one) and drops every
 *  measured value, handing KaTeX back its built-in data. */
export function setGlyphMeasurer(next: GlyphMeasurer | null | undefined): void {
  measurer = next;
  examined.clear();
  for (const font of registeredMaps.keys()) {
    katexInternals.__setFontMetrics(font, builtInFontMetrics[font]);
  }
  registeredMaps.clear();
}

/** Every `text` string of KaTeX's parse tree: macros, `\char` and the like are
 *  already expanded there, unlike in the source. */
function collectParsedText(node: unknown, seen: Set<object>, out: string[]): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectParsedText(item, seen, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    // `loc` links back to the lexer and the whole source.
    if (key === 'loc') continue;
    if (key === 'text' && typeof value === 'string') out.push(value);
    else collectParsedText(value, seen, out);
  }
}

function parsedText(expression: string): string {
  let tree: unknown;
  try {
    // Display mode is the superset of what parses (`\tag`); strict only
    // reports, so silence it rather than warn twice with rehype-katex.
    tree = katexInternals.__parse(expression, { displayMode: true, strict: 'ignore', throwOnError: true });
  } catch {
    // rehype-katex reports the parse error and renders KaTeX's error markup.
    return '';
  }
  const out: string[] = [];
  collectParsedText(tree, new Set(), out);
  return out.join('');
}

/**
 * Registers measured metrics for every character of the formula `expression`
 * that KaTeX supports in text mode but has no metrics for. Only characters not
 * seen before are measured.
 */
export function ensureKatexTextMetrics(expression: string): void {
  const text = parsedText(expression);
  let pending: Map<string, string[]> | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (examined.has(code) || !supportedCodepoint(code)) continue;
    examined.add(code);
    const character = text[index];
    for (const font of Object.keys(TEXT_FONT_FACES)) {
      if (getCharacterMetrics(character, font, 'math')) continue;
      pending ??= new Map();
      const characters = pending.get(font);
      if (characters) characters.push(character);
      else pending.set(font, [character]);
    }
  }
  if (!pending) return;
  const measure = activeMeasurer();
  if (!measure) return;
  for (const [font, characters] of pending) {
    const map = registeredMap(font);
    for (const character of characters) {
      const ink = measure(TEXT_FONT_FACES[font], character);
      map[character.charCodeAt(0)] = [ink.descent, ink.ascent, 0, 0, ink.advance];
    }
  }
}
