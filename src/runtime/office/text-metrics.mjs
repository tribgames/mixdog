import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const LINE_HEIGHT_RATIO = 1.2;
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

let measureContext = null;

function context() {
  if (!measureContext) measureContext = createCanvas(8, 8).getContext('2d');
  return measureContext;
}

function fontSpec({ fontName = 'Calibri', fontSize = 18, bold = false, italic = false } = {}) {
  const size = Math.max(1, Number(fontSize) || 18);
  const family = String(fontName || 'Calibri').replace(/"/g, '');
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${size}px "${family}"`;
}

let installedFonts = null;

export function fontAvailable(name) {
  const family = String(name || '').trim().toLowerCase();
  if (!family) return true;
  if (!installedFonts) {
    try {
      installedFonts = new Set((GlobalFonts.families || [])
        .map((entry) => String(entry?.family || '').toLowerCase())
        .filter(Boolean));
    } catch {
      installedFonts = new Set();
    }
  }
  if (!installedFonts.size) return true;
  return installedFonts.has(family);
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

export function measureTextBlock(paragraphs = [], {
  width = 0,
  lineHeightRatio = LINE_HEIGHT_RATIO,
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
    height += wrapped.length * size * lineHeightRatio;
    height += Math.max(0, Number(paragraph.spaceBefore) || 0);
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
    const substituted = paragraphs.some((paragraph) => !fontAvailable(paragraph.fontName));
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
