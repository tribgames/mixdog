import { measureTextBlock, measureTextWidth } from './text-metrics.mjs';

export function measuredTextHeight(text, {
  width = 0,
  fontName = 'Calibri',
  fontSize = 14,
  bold = false,
  italic = false,
} = {}) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  const paragraphs = value.split('\n').map((line) => ({
    text: line,
    fontName,
    fontSize,
    bold,
    italic,
  }));
  return measureTextBlock(paragraphs, { width }).height;
}

export function packedTextStack({ top, height, width }, entries = [], {
  gap = 8,
  align = 'center',
} = {}) {
  const measured = entries
    .map((entry) => {
      const font = {
        fontName: entry.fontName,
        fontSize: entry.fontSize,
        bold: entry.bold,
        italic: entry.italic,
      };
      return {
        ...entry,
        height: Math.ceil(entry.height ?? measuredTextHeight(entry.text, {
        width: entry.width ?? width,
        ...font,
        })),
        measuredWidth: measureTextWidth(String(entry.text ?? '').replace(/\n/g, ' '), font),
      };
    })
    .filter((entry) => entry.height > 0);
  const total = measured.reduce(
    (sum, entry, index) => sum + entry.height + (index ? (entry.gapBefore ?? gap) : 0),
    0,
  );
  let cursor = top + (align === 'top' ? 0 : Math.max(0, (height - total) / 2));
  const placed = measured.map((entry, index) => {
    if (index) cursor += entry.gapBefore ?? gap;
    const positioned = { ...entry, top: cursor };
    cursor += entry.height;
    return positioned;
  });
  const widthOverflow = measured.some((entry) => Number(entry.widthScale) > 0
    && entry.measuredWidth * Number(entry.widthScale) > (entry.width ?? width) + 0.5);
  return { entries: placed, total, overflow: total > height + 0.5 || widthOverflow };
}
