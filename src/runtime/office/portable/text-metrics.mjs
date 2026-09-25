import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { warmupInstalledOfficeFonts } from './font-provisioner.mjs';
import { bySlide, rectangleGap, reviewDeclaredRelations } from './pptx-relations.mjs';

// PowerPoint's single line spacing is 1.2 em for every face — probe 2026-09-04
// read BoundHeight / lines / size = 1.200 for Noto Sans KR, Noto Serif KR,
// Malgun Gothic, Noto Sans, Arial, and Calibri at 18 and 36 pt. The canvas's
// font bounding box (1.33 for Malgun, 1.44 for Noto Serif KR) is the face's own
// metric, not the pitch PowerPoint lays out, so it is not used. A percentage
// line spacing multiplies the 1.2.
const LINE_HEIGHT_RATIO = 1.2;
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
// Families that carry their own Hangul / CJK glyphs. Any other face (Arial, Calibri, Noto Sans) hands
// CJK runs to PowerPoint's East Asian theme font, so those runs are measured in that fallback rather
// than in the canvas's own (half-width) substitute. Probe 2026-09-04: Arial 18 pt wrapped the same
// Korean sentence to 3 lines in PowerPoint and 2 lines in the canvas before this.
const CJK_FAMILY =
  /noto (sans|serif) (kr|sc|tc|jp|cjk)|malgun|batang|gulim|dotum|yahei|jhenghei|yu gothic|meiryo|ms (gothic|mincho)|simsun|simhei|pingfang|hiragino|apple sd|nanum/i;
// Line-break prohibitions (kinsoku): a closing mark never starts a line, an opening mark never ends one.
const NO_LINE_START = /^[,.、。，．:;!?%)\]}」』〉》】〕’”…·]$/;
const NO_LINE_END = /^[([{「『〈《【〔‘“]$/;

let measureContext = null;

function context() {
  if (!measureContext) measureContext = createCanvas(8, 8).getContext('2d');
  return measureContext;
}

// Office stores the localized or weight-suffixed name (맑은 고딕, Malgun Gothic
// Semilight, Calibri Light); the canvas only resolves the registered family, and
// an unresolved name silently measures in a fallback face at roughly half the
// Hangul width. Map to the registered family plus a numeric weight instead.
const FONT_ALIASES = Object.freeze({
  '맑은 고딕': 'Malgun Gothic',
  바탕: 'Batang',
  돋움: 'Dotum',
  굴림: 'Gulim',
  본고딕: 'Noto Sans KR',
  본명조: 'Noto Serif KR',
  微软雅黑: 'Microsoft YaHei',
  微軟正黑體: 'Microsoft JhengHei',
  游ゴシック: 'Yu Gothic',
  メイリオ: 'Meiryo',
});
const WEIGHT_SUFFIX = /\s+(semilight|light|semibold|medium|black|thin|extrabold)$/iu;
// Semilight faces register at weight 300 (Windows enumerates Malgun Gothic
// Semilight there); a non-standard 350 makes the canvas synthesize nonsense.
const SUFFIX_WEIGHT = Object.freeze({
  thin: 100,
  light: 300,
  semilight: 300,
  medium: 500,
  semibold: 600,
  extrabold: 800,
  black: 900,
});

function resolveFont(fontName) {
  let family = String(fontName || 'Calibri')
    .replace(/"/g, '')
    .trim();
  family = FONT_ALIASES[family] || family;
  let weight = 0;
  const suffix = WEIGHT_SUFFIX.exec(family);
  if (suffix && !installedFamilies().has(family.toLowerCase())) {
    weight = SUFFIX_WEIGHT[suffix[1].toLowerCase()] || 0;
    family = family.replace(WEIGHT_SUFFIX, '');
  }
  return { family: installedEquivalent(family.toLowerCase()) || family, weight };
}

function fontSpec({ fontName = 'Calibri', fontSize = 18, bold = false, italic = false } = {}) {
  const size = Math.max(1, Number(fontSize) || 18);
  const { family, weight } = resolveFont(fontName);
  let weightSpec = '';
  if (bold) weightSpec = '700 ';
  else if (weight) weightSpec = `${weight} `;
  return `${italic ? 'italic ' : ''}${weightSpec}${size}px "${family}"`;
}

let installedFonts = null;
// Lower-cased family → the name the canvas registered, so a substitute is requested as enumerated.
let installedFamilyNames = null;

function installedFamilies() {
  if (!installedFonts) {
    try {
      warmupInstalledOfficeFonts();
      installedFamilyNames = new Map(
        (GlobalFonts.families || [])
          .map((entry) => String(entry?.family || '').trim())
          .filter(Boolean)
          .map((family) => [family.toLowerCase(), family])
      );
    } catch {
      installedFamilyNames = new Map();
    }
    installedFonts = new Set(installedFamilyNames.keys());
  }
  return installedFonts;
}

// Open faces with the same advance widths as the proprietary family they stand in for
// (fontconfig substitutes them the same way): a machine without Arial still measures the
// deck as PowerPoint lays it out where Arial is installed.
const METRIC_EQUIVALENTS = Object.freeze({
  arial: ['liberation sans', 'arimo'],
  helvetica: ['liberation sans', 'arimo'],
  'times new roman': ['liberation serif', 'tinos'],
  'courier new': ['liberation mono', 'cousine'],
  calibri: ['carlito'],
  cambria: ['caladea'],
  georgia: ['gelasio'],
});

/** Registered name of an installed metric-compatible substitute for a family that is not installed, else ''. */
function installedEquivalent(family) {
  const installed = installedFamilies();
  if (!installed.size || installed.has(family)) return '';
  const match = (METRIC_EQUIVALENTS[family] || []).find((candidate) => installed.has(candidate));
  return match ? installedFamilyNames.get(match) : '';
}

function fontAvailable(name) {
  const family = (FONT_ALIASES[String(name || '').trim()] || String(name || '')).trim().toLowerCase();
  if (!family) return true;
  installedFamilies();
  if (!installedFonts.size) return true;
  if (installedFonts.has(family) || installedEquivalent(family)) return true;
  // Weight-suffixed families (Malgun Gothic Semilight, Segoe UI Semibold)
  // often enumerate only under their base family; measure with that base
  // instead of reporting the whole font missing.
  const base = family.replace(WEIGHT_SUFFIX, '');
  return base !== family && (installedFonts.has(base) || Boolean(installedEquivalent(base)));
}

// PowerPoint's East Asian fallback for a Latin face: Malgun Gothic where Windows provides it, else
// the provisioned Noto Sans KR. Resolved once, from the families the canvas actually registered.
let cjkFallback = null;
function cjkFallbackFamily() {
  if (cjkFallback) return cjkFallback;
  const families = installedFamilies();
  cjkFallback = 'Malgun Gothic';
  if (!families.has('malgun gothic') && families.has('noto sans kr')) cjkFallback = 'Noto Sans KR';
  return cjkFallback;
}

// Measured against PowerPoint's own BoundWidth (probe 2026-09-04, 45 conditions: 3 faces × 13/18/36 pt
// × Hangul / mixed / Latin / punctuation / digits): the canvas reads each face narrower than PowerPoint
// lays it out, and by a different amount for CJK glyphs than for the face's Latin and digits — Noto Sans
// KR's Latin runs 6-7 % narrow while its Hangul runs 1 %; Noto Serif KR's Hangul is exact; Malgun
// Gothic is 3-4 % narrow throughout. One factor per face wrapped a pure-Hangul line a character early
// and a digit-heavy line a character late, so the factor is per script class. Arial and Calibri measure
// within 0.5 % and carry none.
const WIDTH_CALIBRATION = Object.freeze({
  'noto sans kr': { cjk: 1.027, latin: 1.082 },
  'noto serif kr': { cjk: 1.028, latin: 1.042 },
  'malgun gothic': { cjk: 1.039, latin: 1.032 },
});

// Maximal runs of one script class, in order: the calibration below reads a
// face's CJK glyphs apart from its Latin ones, and a Latin face hands only its
// CJK runs to the fallback family.
function scriptRuns(text) {
  const runs = [];
  for (const character of text) {
    const cjk = CJK.test(character);
    const last = runs.at(-1);
    if (last && last.cjk === cjk) last.text += character;
    else runs.push({ text: character, cjk });
  }
  return runs;
}

function rawWidth(text, font) {
  const ctx = context();
  ctx.font = fontSpec(font);
  const calibration = WIDTH_CALIBRATION[String(resolveFont(font.fontName).family).toLowerCase()];
  if (!calibration) return ctx.measureText(text).width;
  return scriptRuns(text).reduce(
    (width, run) => width + ctx.measureText(run.text).width * (run.cjk ? calibration.cjk : calibration.latin),
    0
  );
}

export function measureTextWidth(text, font = {}) {
  const value = String(text ?? '');
  if (!value) return 0;
  const { family } = resolveFont(font.fontName);
  if (!CJK.test(value) || CJK_FAMILY.test(family)) return rawWidth(value, font);
  // Mixed script in a Latin face: CJK runs go to the fallback family, the rest stays in the face.
  return scriptRuns(value).reduce(
    (width, run) => width + rawWidth(run.text, run.cjk ? { ...font, fontName: cjkFallbackFamily() } : font),
    0
  );
}

function segments(text) {
  const parts = [];
  let buffer = '';
  for (const character of String(text ?? '')) {
    if (character === ' ') {
      if (buffer) parts.push(buffer);
      parts.push(' ');
      buffer = '';
      continue;
    }
    if (CJK.test(character)) {
      if (buffer) parts.push(buffer);
      parts.push(character);
      buffer = '';
      continue;
    }
    buffer += character;
  }
  if (buffer) parts.push(buffer);
  return kinsoku(parts);
}

// Bind a closing mark to the segment before it and an opening mark to the segment after it, so a
// break never leaves "." or "," at the head of a line, the way PowerPoint wraps Korean.
function kinsoku(parts) {
  const bound = [];
  for (const part of parts) {
    const last = bound[bound.length - 1];
    if (last !== undefined && last !== ' ' && (NO_LINE_START.test(part) || NO_LINE_END.test(last))) {
      bound[bound.length - 1] = last + part;
      continue;
    }
    bound.push(part);
  }
  return bound;
}

// The longest prefix of a run that still fits the measure, never empty: a run
// with no break opportunity has to give up characters or the line never ends.
function headThatFits(text, limit, font) {
  const characters = [...text];
  let head = characters[0] ?? '';
  for (let count = 2; count <= characters.length; count += 1) {
    const candidate = characters.slice(0, count).join('');
    if (measureTextWidth(candidate, font) > limit) break;
    head = candidate;
  }
  return head;
}

export function wrapParagraph(text, width, font = {}) {
  const value = String(text ?? '');
  if (!value) return [''];
  const limit = Math.max(1, Number(width) || 1);
  const lines = [];
  let current = '';
  for (const part of segments(value)) {
    const candidate = `${current}${part}`;
    if (current && measureTextWidth(candidate.trimEnd(), font) > limit) {
      lines.push(current.trimEnd());
      current = part === ' ' ? '' : part;
    } else {
      current = candidate;
    }
    // A run with no break opportunity — a figure like 47,210, a long URL, a
    // compound Latin word — still does not fit: PowerPoint breaks it between
    // characters rather than letting it hang out of the box, so a measurement
    // that keeps it on one line reports a height the render never uses and the
    // overflow stays invisible.
    while (current && measureTextWidth(current, font) > limit) {
      const head = headThatFits(current, limit, font);
      if (head.length >= current.length) break;
      lines.push(head);
      current = current.slice(head.length);
    }
  }
  lines.push(current.trimEnd());
  return lines.length ? lines : [''];
}

// lineSpacing: the PowerPoint multiple (1.0 = single); a paragraph's own
// `lineSpacing` (read from lnSpc) overrides it. `lineHeightRatio` is the legacy
// pitch-per-em override for callers that already resolved spacing themselves.
export function measureTextBlock(paragraphs = [], { width = 0, lineSpacing = 1, lineHeightRatio = 0 } = {}) {
  let height = 0;
  let lines = 0;
  let widest = 0;
  // The widest run that cannot be broken at a space or a syllable: once the
  // wrap breaks such a run between characters, the laid-out width no longer
  // shows that the measure is narrower than the text it has to carry.
  let longestRun = 0;
  for (const paragraph of paragraphs) {
    const font = {
      fontName: paragraph.fontName,
      fontSize: paragraph.fontSize,
      bold: paragraph.bold,
      italic: paragraph.italic,
    };
    const size = Math.max(1, Number(paragraph.fontSize) || 18);
    const multipleEarly =
      Number(paragraph.lineSpacing) > 0 ? Number(paragraph.lineSpacing) : Math.max(0.5, Number(lineSpacing) || 1);
    // Runs of different sizes ("+4.3" at 47 pt, "%p" at 19 pt) are measured each at its own size: read at the first
    // run's size, a figure with its small unit was reported as breaking mid-word and overflowing its box. When the
    // whole paragraph fits one line that way, it is one line.
    const runs = Array.isArray(paragraph.runs) && new Set(paragraph.runs.map((run) => run.fontSize)).size > 1 ? paragraph.runs : null;
    if (runs) {
      const total = runs.reduce((sum, run) => sum + measureTextWidth(run.text, { ...font, fontSize: run.fontSize }), 0);
      if (!(width > 0) || total <= width) {
        widest = Math.max(widest, total);
        longestRun = Math.max(longestRun, total);
        lines += 1;
        height += size * (lineHeightRatio > 0 ? lineHeightRatio : LINE_HEIGHT_RATIO * multipleEarly);
        height += Math.max(0, Number(paragraph.spaceBefore) || 0) + Math.max(0, Number(paragraph.spaceAfter) || 0);
        continue;
      }
    }
    const wrapped = width > 0 ? wrapParagraph(paragraph.text, width, font) : [String(paragraph.text ?? '')];
    for (const line of wrapped) widest = Math.max(widest, measureTextWidth(line, font));
    for (const part of segments(paragraph.text)) {
      if (part !== ' ') longestRun = Math.max(longestRun, measureTextWidth(part, font));
    }
    lines += wrapped.length;
    const multiple =
      Number(paragraph.lineSpacing) > 0 ? Number(paragraph.lineSpacing) : Math.max(0.5, Number(lineSpacing) || 1);
    const pitch = lineHeightRatio > 0 ? lineHeightRatio : LINE_HEIGHT_RATIO * multiple;
    height += wrapped.length * size * pitch;
    height += Math.max(0, Number(paragraph.spaceBefore) || 0);
    height += Math.max(0, Number(paragraph.spaceAfter) || 0);
  }
  return { height, lines, width: widest, longestRun };
}

function channelLuminance(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const raw = String(hex || '')
    .replace(/^#/, '')
    .slice(-6);
  if (!/^[0-9A-Fa-f]{6}$/.test(raw)) return null;
  const red = channelLuminance(Number.parseInt(raw.slice(0, 2), 16));
  const green = channelLuminance(Number.parseInt(raw.slice(2, 4), 16));
  const blue = channelLuminance(Number.parseInt(raw.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (first == null || second == null) return null;
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

// A short label (a chevron stage, a node name, a step number) sits by design
// next to its neighbour in the run or its own note; the block gap applies
// between blocks of copy, not inside a labelled construct.
const LABEL_MAX_CHARS = 16;

function isLabelBox(box) {
  const paragraphs = Array.isArray(box?.paragraphs) ? box.paragraphs : [];
  const text = paragraphs
    .map((paragraph) => String(paragraph.text ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return text.length > 0 && text.length <= LABEL_MAX_CHARS && !text.includes('\n');
}

export function reviewShapeSpacing(boxes = [], { minimumGap = 21.6 } = {}) {
  const issues = [];
  for (const [slide, shapes] of bySlide(boxes)) {
    for (let first = 0; first < shapes.length; first += 1) {
      for (let second = first + 1; second < shapes.length; second += 1) {
        const left = shapes[first];
        const right = shapes[second];
        const horizontal = Math.max(left.left - (right.left + right.width), right.left - (left.left + left.width));
        const vertical = Math.max(left.top - (right.top + right.height), right.top - (left.top + left.height));
        // Boxes clear of each other on exactly one axis are neighbours in a
        // row or a column; clear on both is a diagonal, clear on neither is an
        // overlap, and neither is a gap this rule measures.
        const apartHorizontally = horizontal >= 0;
        const apartVertically = vertical >= 0;
        if (apartHorizontally === apartVertically) continue;
        const gap = apartHorizontally ? horizontal : vertical;
        if (gap >= minimumGap) continue;
        if (isLabelBox(left) || isLabelBox(right)) continue;
        if (!apartHorizontally) {
          const aligned = Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left);
          if (aligned >= Math.min(left.width, right.width) * 0.6) continue;
        }
        issues.push({
          code: 'shapes_too_close',
          path: `/slide[${slide}]/shape[${right.shape}]`,
          message: `Shapes ${left.shape} and ${right.shape} sit ${gap.toFixed(1)}pt apart; keep at least ${minimumGap}pt between blocks.`,
          gap: Number(gap.toFixed(1)),
        });
      }
    }
  }
  return issues;
}

export function reviewTextContrast(boxes = []) {
  const issues = [];
  for (const box of boxes) {
    const background = box.background;
    if (!background) continue;
    const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
    let worst = null;
    for (const paragraph of paragraphs) {
      if (!String(paragraph.text ?? '').trim()) continue;
      const ratio = contrastRatio(paragraph.color || '000000', background);
      if (ratio == null) continue;
      const size = Math.max(1, Number(paragraph.fontSize) || 18);
      const large = size >= 18 || (size >= 14 && paragraph.bold === true);
      const minimum = large ? 3 : 4.5;
      if (ratio >= minimum) continue;
      if (!worst || ratio < worst.ratio) worst = { ratio, minimum, size };
    }
    if (!worst) continue;
    issues.push({
      code: 'low_contrast',
      path: `/slide[${box.slide}]/shape[${box.shape}]`,
      message: `Text contrast is ${worst.ratio.toFixed(2)}:1 against its background; ${worst.minimum}:1 is the readable minimum at ${Math.round(worst.size)}pt.`,
      ratio: Number(worst.ratio.toFixed(2)),
      minimum: worst.minimum,
    });
  }
  return issues;
}

// Hangul and CJK are written without letter gaps: tracking pulls the syllables
// of one word apart, so the reader sees characters instead of words. Latin small
// caps are the opposite — a kicker is set with tracking on purpose — which is why
// the script of the run decides, not the value alone.
const CJK_TEXT = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/;
const CJK_TRACKING_RATIO = 0.05;

export function reviewCjkTracking(boxes = []) {
  const issues = [];
  for (const box of boxes) {
    const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
    let worst = null;
    for (const paragraph of paragraphs) {
      const text = String(paragraph.text ?? '');
      if (!CJK_TEXT.test(text)) continue;
      const tracking = Number(paragraph.charSpacing) || 0;
      if (tracking <= 0) continue;
      const size = Math.max(1, Number(paragraph.fontSize) || 18);
      const ratio = tracking / size;
      if (ratio <= CJK_TRACKING_RATIO) continue;
      if (!worst || ratio > worst.ratio) worst = { ratio, tracking, size };
    }
    if (!worst) continue;
    issues.push({
      code: 'cjk_letter_spacing',
      path: `/slide[${box.slide}]/shape[${box.shape}]`,
      message: `Hangul or CJK text carries ${worst.tracking.toFixed(1)}pt of tracking at ${Math.round(worst.size)}pt (${Math.round(worst.ratio * 100)}% of the size); the syllables of a word read as separate characters.`,
      tracking: Number(worst.tracking.toFixed(1)),
    });
  }
  return issues;
}

// The largest type size a block of paragraphs sets, 0 when none states one.
function largestFontSize(paragraphs) {
  return Math.max(0, ...paragraphs.map((paragraph) => Number(paragraph.fontSize) || 0));
}

// Two readings of the same fault: a box narrower than its longest word
// breaks mid-word, and a box only a little wider still leaves a ragged
// column of one or two words a line. Both are answered by widening the
// measure, so they share one code and report once.
function narrowBoxIssue(box, paragraphs, measured, usableWidth, path) {
  if (box.wrap === false) return null;
  const bodySize = largestFontSize(paragraphs);
  const longestRun = Number(measured.longestRun) || measured.width;
  if (longestRun > usableWidth * 1.02) {
    return {
      code: 'text_box_too_narrow',
      path,
      message: `A word needs about ${Math.round(longestRun)}pt but the shape offers ${Math.round(usableWidth)}pt, so the text breaks mid-word.`,
    };
  }
  if (measured.lines >= 3 && bodySize > 0 && usableWidth < bodySize * 7) {
    return {
      code: 'text_box_too_narrow',
      path,
      message: `The box offers ${Math.round(usableWidth)}pt of measure for ${Math.round(bodySize)}pt text, so its ${measured.lines} lines carry one or two words each.`,
    };
  }
  return null;
}

function outOfBoundsIssue(box, slideWidth, slideHeight, path) {
  if (!(slideWidth > 0 && slideHeight > 0)) return null;
  const right = (Number(box.left) || 0) + (Number(box.width) || 0);
  const bottom = (Number(box.top) || 0) + (Number(box.height) || 0);
  if (Number(box.left) < -1 || Number(box.top) < -1 || right > slideWidth + 1 || bottom > slideHeight + 1) {
    return { code: 'shape_out_of_bounds', path, message: 'Shape extends past the slide edge.' };
  }
  return null;
}

function usableTextArea(box) {
  const inset = (name) => Number(box[name]) || 0;
  return {
    usableWidth: Math.max(1, (Number(box.width) || 0) - inset('insetLeft') - inset('insetRight')),
    usableHeight: Math.max(1, (Number(box.height) || 0) - inset('insetTop') - inset('insetBottom')),
  };
}

function unavailableFonts(paragraphs, isFontAvailable) {
  return [
    ...new Set(
      paragraphs
        .map((paragraph) => String(paragraph.fontName || '').trim())
        .filter((name) => name && !isFontAvailable(name))
    ),
  ];
}

function overflowIssue(measured, usableHeight, { tolerance, substituted, path }) {
  const allowance = substituted ? tolerance * 1.12 : tolerance;
  if (!(measured.height > usableHeight * allowance)) return null;
  return {
    code: 'text_overflow',
    path,
    message:
      `Text needs about ${Math.round(measured.height)}pt but the shape allows ${Math.round(usableHeight)}pt.` +
      (substituted ? ' The font is not installed here, so the measurement is approximate.' : ''),
    overflow: Math.round(measured.height - usableHeight),
    lines: measured.lines,
    ...(substituted ? { approximate: true } : {}),
  };
}

function textBoxFitIssues(box, { slideWidth, slideHeight, tolerance, isFontAvailable }) {
  const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
  const path = `/slide[${box.slide}]/shape[${box.shape}]`;
  const { usableWidth, usableHeight } = usableTextArea(box);
  const measured = measureTextBlock(paragraphs, { width: box.wrap === false ? 0 : usableWidth });
  const fonts = unavailableFonts(paragraphs, isFontAvailable);
  const clipped =
    box.wrap === false && measured.width > usableWidth * tolerance
      ? {
          code: 'text_clipped',
          path,
          message: `Unwrapped text is about ${Math.round(measured.width)}pt wide inside a ${Math.round(usableWidth)}pt shape.`,
        }
      : null;
  return [
    ...fonts.map((font) => ({
      code: 'font_unavailable',
      path,
      message: `Font "${font}" is not installed, so PowerPoint may substitute it and change the layout.`,
      font,
    })),
    overflowIssue(measured, usableHeight, { tolerance, substituted: fonts.length > 0, path }),
    clipped,
    narrowBoxIssue(box, paragraphs, measured, usableWidth, path),
    outOfBoundsIssue(box, slideWidth, slideHeight, path),
  ].filter(Boolean);
}

export function reviewTextBoxFit(
  boxes = [],
  { slideWidth = 0, slideHeight = 0, tolerance = 1.04, isFontAvailable = fontAvailable } = {}
) {
  const issues = [];
  for (const box of boxes) {
    const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
    if (!paragraphs.some((paragraph) => String(paragraph.text ?? '').trim())) continue;
    if (box.autofit === true) continue;
    issues.push(...textBoxFitIssues(box, { slideWidth, slideHeight, tolerance, isFontAvailable }));
  }
  return issues;
}

// A statement slide (one thesis, quote, or number and air) is balanced by its
// air, not by filling the canvas; the same criterion design-review uses for
// authored decks, read here from the text boxes.
function statementSlides(boxes = []) {
  const perSlide = new Map();
  for (const box of boxes) {
    const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
    const text = paragraphs
      .map((paragraph) => String(paragraph.text || ''))
      .join('')
      .trim();
    if (!text) continue;
    const entry = perSlide.get(box.slide) || { count: 0, sizes: [], chars: 0 };
    entry.count += 1;
    entry.sizes.push(largestFontSize(paragraphs));
    entry.chars += text.length;
    perSlide.set(box.slide, entry);
  }
  const result = new Set();
  for (const [slide, entry] of perSlide) {
    if (entry.count > 5) continue;
    const largest = Math.max(...entry.sizes);
    if (largest >= 42 || entry.sizes.filter((size) => size >= 34).length >= 2 || (largest >= 24 && entry.chars <= 280))
      result.add(slide);
  }
  return result;
}

// A band this deep with content above and below it reads as an unfinished
// page, not as air: the eye crosses it looking for the missing region.
const HOLLOW_BAND = 108; // 1.5in at 72pt per inch

// A table, chart, picture or group is the page's carrier, and the few text
// boxes around it are its labels rather than its body. Such a page reads as a
// statement to the text-only heuristic above — few boxes, little text, a large
// title — so without this the exemption hides exactly the pages whose body
// stops halfway down the canvas. A full-bleed background is already filtered
// out of the content, so a statement over a picture stays exempt.
const CARRIER_KINDS = new Set(['p:graphicFrame', 'p:pic', 'p:grpSp']);
// A device the kit drew — the deck's motif, the cover's orb, an icon — is decoration placed as a picture, not the
// object a page is balanced around. Counting it as a carrier took the exemption away from exactly the pages the
// recipes ask for: a claim at poster scale with its device and half the canvas deliberately empty.
// The same signature the composition receipt reads: the writer names a drawn vector `mixdog-svg:<svg>` and a drawn
// raster `mixdog-device:<kind>`, and the normalizer renames the vector "Icon" once its SVG is attached.
const DEVICE_NAME = /^(?:mixdog-svg:|mixdog-device:|Icon$)/;

function carriesObject(content = []) {
  return content.some((shape) => CARRIER_KINDS.has(shape.kind) && !DEVICE_NAME.test(String(shape.name || '')));
}

// The deepest empty band between the slide's content, measured on merged
// intervals so overlapping shapes (a value over its field) never open a gap.
function hollowBand(content = []) {
  const intervals = content
    .map((shape) => [shape.top, shape.top + Math.max(0, shape.height)])
    .sort((left, right) => left[0] - right[0]);
  let reach = intervals.length ? intervals[0][1] : 0;
  let depth = 0;
  let top = 0;
  for (const [start, end] of intervals.slice(1)) {
    if (start - reach > depth) {
      depth = start - reach;
      top = reach;
    }
    reach = Math.max(reach, end);
  }
  return { depth, top };
}

export function reviewVerticalBalance(bounds = [], { slideWidth = 0, slideHeight = 0, boxes = [] } = {}) {
  if (!(slideHeight > 0) || !(slideWidth > 0)) return [];
  const issues = [];
  const statements = statementSlides(boxes);
  for (const [slide, shapes] of bySlide(bounds)) {
    const content = shapes.filter(
      (shape) => Math.max(0, shape.width) * Math.max(0, shape.height) < slideWidth * slideHeight * 0.8
    );
    if (!content.length) continue;
    if (statements.has(slide) && !carriesObject(content)) continue;
    const top = Math.min(...content.map((shape) => shape.top));
    const bottom = Math.max(...content.map((shape) => shape.top + shape.height));
    const topEmpty = Math.max(0, top);
    const bottomEmpty = Math.max(0, slideHeight - bottom);
    const heavyBottom = bottomEmpty > slideHeight * 0.3 && bottomEmpty - topEmpty > slideHeight * 0.24;
    const heavyTop = topEmpty > slideHeight * 0.3 && topEmpty - bottomEmpty > slideHeight * 0.24;
    if (!heavyBottom && !heavyTop) {
      // The footer line and the page number sit at the bottom of every slide,
      // so a page whose body stops halfway still measures a full canvas from
      // its margins alone; the hollow band between them is the real reading.
      const hollow = hollowBand(content);
      if (hollow.depth > HOLLOW_BAND) {
        issues.push({
          code: 'vertical_imbalance',
          path: `/slide[${slide}]`,
          message: `An empty band ${Math.round(hollow.depth)}pt deep (${(hollow.depth / 72).toFixed(2)}in) runs from ${Math.round(hollow.top)}pt to ${Math.round(hollow.top + hollow.depth)}pt with content above and below it; extend a region into the band or move the lower block up.`,
          hollowBand: Math.round(hollow.depth),
          hollowTop: Math.round(hollow.top),
        });
      }
      continue;
    }
    issues.push({
      code: 'vertical_imbalance',
      path: `/slide[${slide}]`,
      message: heavyBottom
        ? `Content ends ${Math.round(bottomEmpty)}pt above the slide bottom while starting ${Math.round(topEmpty)}pt from the top; rebalance the layout or extend content regions downward.`
        : `Content starts ${Math.round(topEmpty)}pt from the slide top while ending ${Math.round(bottomEmpty)}pt above the bottom; rebalance the layout upward.`,
      emptyTop: Math.round(topEmpty),
      emptyBottom: Math.round(bottomEmpty),
    });
  }
  return issues;
}

export function reviewStatLabelProximity(boxes = [], { maximumGap = 36 } = {}) {
  const issues = [];
  for (const [slide, shapes] of bySlide(boxes)) {
    issues.push(...reviewDeclaredRelations(shapes, maximumGap));
    for (const box of shapes) {
      if (box.relation?.role === 'value') continue;
      const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
      const text = paragraphs
        .map((paragraph) => String(paragraph.text ?? ''))
        .join(' ')
        .trim();
      const size = largestFontSize(paragraphs);
      if (size < 28 || !text || text.length > 16 || !/\d/.test(text)) continue;
      const letters = (text.match(/\p{L}/gu) || []).length;
      if (letters > text.replace(/\s/g, '').length * 0.5) continue;
      const nearest = shapes
        .filter((candidate) => candidate !== box)
        .filter((candidate) => largestFontSize(Array.isArray(candidate.paragraphs) ? candidate.paragraphs : []) <= 20)
        .filter((candidate) => candidate.paragraphs?.some((paragraph) => String(paragraph.text || '').trim()))
        .sort((first, second) => rectangleGap(box, first) - rectangleGap(box, second))[0];
      if (!nearest) continue;
      const gap = rectangleGap(box, nearest);
      if (gap <= maximumGap) continue;
      issues.push({
        code: 'stat_label_detached',
        severity: 'info',
        confidence: 'inferred',
        path: `/slide[${slide}]/shape[${box.shape}]`,
        message: `The stat "${text}" is ${Math.round(gap)}pt from the nearest small text. Its label is unknown; inspect the relationship before moving either element.`,
        gap: Math.round(gap),
      });
    }
  }
  return issues;
}

// The sizes a shrinking box may land on. A percentage search lands on 14.88 pt
// beside 24 pt copy, which reads as a mistake on the page; the repair keeps the
// text on a type ladder, the same rule the authoring kit follows.
const TYPE_LADDER = Object.freeze([
  96, 80, 72, 66, 60, 54, 48, 44, 40, 36, 32, 28, 26, 24, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8,
]);

export function shrinkFontSizeToFit(
  paragraphs = [],
  { width = 0, height = 0, minimumFontSize = 8, steps = null } = {}
) {
  const sizes = paragraphs.map((paragraph) => Math.max(1, Number(paragraph.fontSize) || 18));
  const largest = Math.max(...sizes, 1);
  const floor = Math.max(1, Number(minimumFontSize) || 8);
  // The caller's floor is the last resort under the ladder: a box that fits
  // nothing larger still has to be answered, and refusing the repair would
  // leave the overflow it was called to fix.
  const ladder = [...new Set([largest, ...(Array.isArray(steps) && steps.length ? steps : TYPE_LADDER), floor])]
    .map(Number)
    .filter((size) => Number.isFinite(size) && size <= largest && size >= floor)
    .sort((left, right) => right - left);
  for (const candidate of ladder) {
    const factor = candidate / largest;
    const scaled = paragraphs.map((paragraph, index) => ({
      ...paragraph,
      // A box of mixed sizes keeps its proportions; a half point is the finest
      // step PowerPoint stores, so the secondary runs stay on real sizes too.
      fontSize: Math.max(floor, Math.round(sizes[index] * factor * 2) / 2),
    }));
    const measured = measureTextBlock(scaled, { width });
    if (measured.height <= height) {
      return { scale: factor, sizes: scaled.map((paragraph) => paragraph.fontSize) };
    }
  }
  return { scale: 0, sizes: [] };
}
