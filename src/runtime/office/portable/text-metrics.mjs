import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const LINE_HEIGHT_RATIO = 1.2;
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

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
  '바탕': 'Batang',
  '돋움': 'Dotum',
  '굴림': 'Gulim',
});
const WEIGHT_SUFFIX = /\s+(semilight|light|semibold|medium|black|thin|extrabold)$/iu;
// Semilight faces register at weight 300 (Windows enumerates Malgun Gothic
// Semilight there); a non-standard 350 makes the canvas synthesize nonsense.
const SUFFIX_WEIGHT = Object.freeze({ thin: 100, light: 300, semilight: 300, medium: 500, semibold: 600, extrabold: 800, black: 900 });

function resolveFont(fontName) {
  let family = String(fontName || 'Calibri').replace(/"/g, '').trim();
  family = FONT_ALIASES[family] || family;
  let weight = 0;
  const suffix = WEIGHT_SUFFIX.exec(family);
  if (suffix && !installedFamilies().has(family.toLowerCase())) {
    weight = SUFFIX_WEIGHT[suffix[1].toLowerCase()] || 0;
    family = family.replace(WEIGHT_SUFFIX, '');
  }
  return { family, weight };
}

function fontSpec({ fontName = 'Calibri', fontSize = 18, bold = false, italic = false } = {}) {
  const size = Math.max(1, Number(fontSize) || 18);
  const { family, weight } = resolveFont(fontName);
  const weightSpec = bold ? '700 ' : weight ? `${weight} ` : '';
  return `${italic ? 'italic ' : ''}${weightSpec}${size}px "${family}"`;
}

let installedFonts = null;

function installedFamilies() {
  if (!installedFonts) {
    try {
      installedFonts = new Set((GlobalFonts.families || [])
        .map((entry) => String(entry?.family || '').toLowerCase())
        .filter(Boolean));
    } catch {
      installedFonts = new Set();
    }
  }
  return installedFonts;
}

export function fontAvailable(name) {
  const family = (FONT_ALIASES[String(name || '').trim()] || String(name || '')).trim().toLowerCase();
  if (!family) return true;
  installedFamilies();
  if (!installedFonts.size) return true;
  if (installedFonts.has(family)) return true;
  // Weight-suffixed families (Malgun Gothic Semilight, Segoe UI Semibold)
  // often enumerate only under their base family; measure with that base
  // instead of reporting the whole font missing.
  const base = family.replace(/\s+(?:semilight|light|semibold|medium|black|thin|extrabold)$/u, '');
  return base !== family && installedFonts.has(base);
}

export function measureTextWidth(text, font = {}) {
  const value = String(text ?? '');
  if (!value) return 0;
  const ctx = context();
  ctx.font = fontSpec(font);
  return ctx.measureText(value).width;
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
  return parts;
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
      continue;
    }
    current = candidate;
  }
  lines.push(current.trimEnd());
  return lines.length ? lines : [''];
}

// PowerPoint's single line spacing is the face's own line height (ascent +
// descent), not 1 em: Calibri and Arial sit near 1.2, Malgun Gothic at 1.33. A
// percentage line spacing multiplies that, so a Hangul paragraph at 150% runs
// 2.0 em per line. Measure with the face's ratio, floored at the Latin default.
const naturalRatios = new Map();
function naturalLineRatio(fontName) {
  const { family } = resolveFont(fontName);
  if (naturalRatios.has(family)) return naturalRatios.get(family);
  let ratio = LINE_HEIGHT_RATIO;
  try {
    const ctx = context();
    ctx.font = `100px "${family}"`;
    const metrics = ctx.measureText('가Ag');
    const measured = ((Number(metrics.fontBoundingBoxAscent) || 0) + (Number(metrics.fontBoundingBoxDescent) || 0)) / 100;
    if (measured > 0) ratio = Math.max(LINE_HEIGHT_RATIO, measured);
  } catch {
    ratio = LINE_HEIGHT_RATIO;
  }
  naturalRatios.set(family, ratio);
  return ratio;
}

// lineSpacing: the PowerPoint multiple (1.0 = single); a paragraph's own
// `lineSpacing` (read from lnSpc) overrides it. `lineHeightRatio` is the legacy
// pitch-per-em override for callers that already resolved spacing themselves.
export function measureTextBlock(paragraphs = [], {
  width = 0,
  lineSpacing = 1,
  lineHeightRatio = 0,
} = {}) {
  let height = 0;
  let lines = 0;
  let widest = 0;
  for (const paragraph of paragraphs) {
    const font = {
      fontName: paragraph.fontName,
      fontSize: paragraph.fontSize,
      bold: paragraph.bold,
      italic: paragraph.italic,
    };
    const size = Math.max(1, Number(paragraph.fontSize) || 18);
    const wrapped = width > 0 ? wrapParagraph(paragraph.text, width, font) : [String(paragraph.text ?? '')];
    for (const line of wrapped) widest = Math.max(widest, measureTextWidth(line, font));
    lines += wrapped.length;
    const multiple = Number(paragraph.lineSpacing) > 0 ? Number(paragraph.lineSpacing) : Math.max(0.5, Number(lineSpacing) || 1);
    const pitch = lineHeightRatio > 0 ? lineHeightRatio : naturalLineRatio(paragraph.fontName) * multiple;
    height += wrapped.length * size * pitch;
    height += Math.max(0, Number(paragraph.spaceBefore) || 0);
    height += Math.max(0, Number(paragraph.spaceAfter) || 0);
  }
  return { height, lines, width: widest };
}

function channelLuminance(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const raw = String(hex || '').replace(/^#/, '').slice(-6);
  if (!/^[0-9A-Fa-f]{6}$/.test(raw)) return null;
  const red = channelLuminance(Number.parseInt(raw.slice(0, 2), 16));
  const green = channelLuminance(Number.parseInt(raw.slice(2, 4), 16));
  const blue = channelLuminance(Number.parseInt(raw.slice(4, 6), 16));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
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
  const text = paragraphs.map((paragraph) => String(paragraph.text ?? '').trim()).filter(Boolean).join('\n');
  return text.length > 0 && text.length <= LABEL_MAX_CHARS && !text.includes('\n');
}

export function reviewShapeSpacing(boxes = [], { minimumGap = 21.6 } = {}) {
  const issues = [];
  const slides = new Map();
  for (const box of boxes) {
    if (!slides.has(box.slide)) slides.set(box.slide, []);
    slides.get(box.slide).push(box);
  }
  for (const [slide, shapes] of slides) {
    for (let first = 0; first < shapes.length; first += 1) {
      for (let second = first + 1; second < shapes.length; second += 1) {
        const left = shapes[first];
        const right = shapes[second];
        const horizontal = Math.max(
          left.left - (right.left + right.width),
          right.left - (left.left + left.width),
        );
        const vertical = Math.max(
          left.top - (right.top + right.height),
          right.top - (left.top + left.height),
        );
        const apart = [horizontal >= 0, vertical >= 0];
        if (apart[0] === apart[1]) continue;
        const gap = apart[0] ? horizontal : vertical;
        if (gap >= minimumGap) continue;
        if (isLabelBox(left) || isLabelBox(right)) continue;
        if (!apart[0]) {
          const aligned = Math.min(left.left + left.width, right.left + right.width)
            - Math.max(left.left, right.left);
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

export function reviewTextBoxFit(boxes = [], {
  slideWidth = 0,
  slideHeight = 0,
  tolerance = 1.04,
  isFontAvailable = fontAvailable,
} = {}) {
  const issues = [];
  for (const box of boxes) {
    const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
    if (!paragraphs.some((paragraph) => String(paragraph.text ?? '').trim())) continue;
    if (box.autofit === true) continue;
    const insetLeft = Number(box.insetLeft) || 0;
    const insetRight = Number(box.insetRight) || 0;
    const insetTop = Number(box.insetTop) || 0;
    const insetBottom = Number(box.insetBottom) || 0;
    const usableWidth = Math.max(1, (Number(box.width) || 0) - insetLeft - insetRight);
    const usableHeight = Math.max(1, (Number(box.height) || 0) - insetTop - insetBottom);
    const measured = measureTextBlock(paragraphs, {
      width: box.wrap === false ? 0 : usableWidth,
    });
    const unavailableFonts = [...new Set(paragraphs
      .map((paragraph) => String(paragraph.fontName || '').trim())
      .filter((name) => name && !isFontAvailable(name)))];
    for (const font of unavailableFonts) {
      issues.push({
        code: 'font_unavailable',
        path: `/slide[${box.slide}]/shape[${box.shape}]`,
        message: `Font "${font}" is not installed, so PowerPoint may substitute it and change the layout.`,
        font,
      });
    }
    const substituted = unavailableFonts.length > 0;
    const allowance = substituted ? tolerance * 1.12 : tolerance;
    if (measured.height > usableHeight * allowance) {
      issues.push({
        code: 'text_overflow',
        path: `/slide[${box.slide}]/shape[${box.shape}]`,
        message: `Text needs about ${Math.round(measured.height)}pt but the shape allows ${Math.round(usableHeight)}pt.`
          + (substituted ? ' The font is not installed here, so the measurement is approximate.' : ''),
        overflow: Math.round(measured.height - usableHeight),
        lines: measured.lines,
        ...(substituted ? { approximate: true } : {}),
      });
    }
    if (box.wrap === false && measured.width > usableWidth * tolerance) {
      issues.push({
        code: 'text_clipped',
        path: `/slide[${box.slide}]/shape[${box.shape}]`,
        message: `Unwrapped text is about ${Math.round(measured.width)}pt wide inside a ${Math.round(usableWidth)}pt shape.`,
      });
    }
    if (box.wrap !== false && measured.width > usableWidth * 1.02 && measured.lines > 1) {
      issues.push({
        code: 'text_box_too_narrow',
        path: `/slide[${box.slide}]/shape[${box.shape}]`,
        message: `A word needs about ${Math.round(measured.width)}pt but the shape offers ${Math.round(usableWidth)}pt, so the text breaks mid-word.`,
      });
    }
    const right = (Number(box.left) || 0) + (Number(box.width) || 0);
    const bottom = (Number(box.top) || 0) + (Number(box.height) || 0);
    if (slideWidth > 0 && slideHeight > 0 && (
      Number(box.left) < -1 || Number(box.top) < -1
      || right > slideWidth + 1 || bottom > slideHeight + 1
    )) {
      issues.push({
        code: 'shape_out_of_bounds',
        path: `/slide[${box.slide}]/shape[${box.shape}]`,
        message: 'Shape extends past the slide edge.',
      });
    }
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
    const text = paragraphs.map((paragraph) => String(paragraph.text || '')).join('').trim();
    if (!text) continue;
    const entry = perSlide.get(box.slide) || { count: 0, sizes: [], chars: 0 };
    entry.count += 1;
    entry.sizes.push(Math.max(0, ...paragraphs.map((paragraph) => Number(paragraph.fontSize) || 0)));
    entry.chars += text.length;
    perSlide.set(box.slide, entry);
  }
  const result = new Set();
  for (const [slide, entry] of perSlide) {
    if (entry.count > 5) continue;
    const largest = Math.max(...entry.sizes);
    if (largest >= 42 || entry.sizes.filter((size) => size >= 34).length >= 2 || (largest >= 24 && entry.chars <= 280)) result.add(slide);
  }
  return result;
}

export function reviewVerticalBalance(bounds = [], { slideWidth = 0, slideHeight = 0, boxes = [] } = {}) {
  if (!(slideHeight > 0) || !(slideWidth > 0)) return [];
  const issues = [];
  const slides = new Map();
  const statements = statementSlides(boxes);
  for (const box of bounds) {
    if (!slides.has(box.slide)) slides.set(box.slide, []);
    slides.get(box.slide).push(box);
  }
  for (const [slide, shapes] of slides) {
    if (statements.has(slide)) continue;
    const content = shapes.filter((shape) => (
      Math.max(0, shape.width) * Math.max(0, shape.height) < slideWidth * slideHeight * 0.8
    ));
    if (!content.length) continue;
    const top = Math.min(...content.map((shape) => shape.top));
    const bottom = Math.max(...content.map((shape) => shape.top + shape.height));
    const topEmpty = Math.max(0, top);
    const bottomEmpty = Math.max(0, slideHeight - bottom);
    const heavyBottom = bottomEmpty > slideHeight * 0.3 && bottomEmpty - topEmpty > slideHeight * 0.24;
    const heavyTop = topEmpty > slideHeight * 0.3 && topEmpty - bottomEmpty > slideHeight * 0.24;
    if (!heavyBottom && !heavyTop) continue;
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
  const slides = new Map();
  for (const box of boxes) {
    if (!slides.has(box.slide)) slides.set(box.slide, []);
    slides.get(box.slide).push(box);
  }
  for (const [slide, shapes] of slides) {
    for (const box of shapes) {
      const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
      const text = paragraphs.map((paragraph) => String(paragraph.text ?? '')).join(' ').trim();
      const size = Math.max(...paragraphs.map((paragraph) => Number(paragraph.fontSize) || 0), 0);
      if (size < 28 || !text || text.length > 16 || !/\d/.test(text)) continue;
      const letters = (text.match(/\p{L}/gu) || []).length;
      if (letters > text.replace(/\s/g, '').length * 0.5) continue;
      const bottom = box.top + box.height;
      const nearest = shapes
        .filter((candidate) => candidate !== box)
        .filter((candidate) => Math.max(
          ...(Array.isArray(candidate.paragraphs) ? candidate.paragraphs : [])
            .map((paragraph) => Number(paragraph.fontSize) || 0),
          0,
        ) <= 20)
        .filter((candidate) => candidate.top >= bottom - 2)
        .filter((candidate) => {
          const overlap = Math.min(box.left + box.width, candidate.left + candidate.width)
            - Math.max(box.left, candidate.left);
          return overlap >= Math.min(box.width, candidate.width) * 0.4;
        })
        .sort((first, second) => first.top - second.top)[0];
      if (!nearest) continue;
      const gap = nearest.top - bottom;
      if (gap <= maximumGap) continue;
      issues.push({
        code: 'stat_label_detached',
        path: `/slide[${slide}]/shape[${box.shape}]`,
        message: `The stat "${text}" sits ${Math.round(gap)}pt above its nearest label; keep a value and its label within ${maximumGap}pt so they read as one unit.`,
        gap: Math.round(gap),
      });
    }
  }
  return issues;
}

export function shrinkFontSizeToFit(paragraphs = [], {
  width = 0,
  height = 0,
  minimumFontSize = 8,
} = {}) {
  const sizes = paragraphs.map((paragraph) => Math.max(1, Number(paragraph.fontSize) || 18));
  const largest = Math.max(...sizes, 1);
  const floor = Math.max(1, Number(minimumFontSize) || 8);
  for (let scale = 100; scale >= 1; scale -= 2) {
    const factor = scale / 100;
    if (largest * factor < floor) break;
    const scaled = paragraphs.map((paragraph, index) => ({
      ...paragraph,
      fontSize: Math.max(floor, sizes[index] * factor),
    }));
    const measured = measureTextBlock(scaled, { width });
    if (measured.height <= height) {
      return { scale: factor, sizes: scaled.map((paragraph) => paragraph.fontSize) };
    }
  }
  return { scale: 0, sizes: [] };
}
