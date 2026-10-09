// Helpers shared by the per-format snapshots: run fonts, related parts,
// chart parts and pagination facts.
import { partRelationshipPath, relationshipTarget, zipText } from './portable-opc.mjs';
import { blockText, xmlAttribute, xmlDecode } from './portable-xml.mjs';
import { detectChartType } from './portable-pptx-chart.mjs';

// Word keeps a heading's type in styles.xml, not on its runs: a document whose
// headings carry no direct formatting reads as sizeless unless the style chain
// is resolved. Each style answers with what it states, then with what it is
// based on, and finally with the document defaults.
export function docxRunFont(xml) {
  const sizes = [...String(xml).matchAll(/<w:sz\b[^>]*\bw:val="(\d+)"/g)]
    .map((match) => Number(match[1]) / 2)
    .filter((size) => size > 0);
  // Automatic colour is the effective default, black. Caps and tracking are left out when unstated, and stated as
  // false / 0 when the run switches them off, so an inheriting style can tell a reset from silence.
  const color = /<w:color\b[^>]*\bw:val="([0-9A-Fa-f]{6}|auto)"/.exec(String(xml))?.[1];
  const trackingValue = /<w:spacing\b[^>]*\bw:val="(-?\d+)"/.exec(String(xml))?.[1];
  const capsTags = [...String(xml).matchAll(/<w:(?:caps|smallCaps)\b([^>]*)>/g)];
  const caps = capsTags.some((tag) => !/\bw:val="(?:0|false)"/.test(tag[1]));
  return {
    size: sizes.length ? Math.max(...sizes) : 0,
    bold: /<w:b\b(?![^>]*\bw:val="(?:0|false)")/.test(String(xml)),
    name: xmlDecode(/<w:rFonts\b[^>]*\bw:ascii="([^"]*)"/.exec(String(xml))?.[1] || ''),
    ...(color ? { color: color === 'auto' ? '000000' : color.toUpperCase() } : {}),
    ...(capsTags.length ? { caps } : {}),
    ...(trackingValue !== undefined ? { letterSpacing: Number(trackingValue) / 20 } : {}),
  };
}

/** Paragraph spacing before/after in points, as the paragraph or style properties state it. */
export function docxParagraphSpacing(xml) {
  const spacing = /<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.exec(String(xml))?.[0] || String(xml);
  const read = (name) => {
    const value = new RegExp(`<w:spacing\\b[^>]*\\bw:${name}="(\\d+)"`).exec(spacing)?.[1];
    return value === undefined ? undefined : Number(value) / 20;
  };
  const before = read('before');
  const after = read('after');
  return {
    ...(before !== undefined ? { spacingBefore: before } : {}),
    ...(after !== undefined ? { spacingAfter: after } : {}),
  };
}

// The part a relationship id points at, used to walk worksheet → drawing → chart.
export async function relatedPartById(zip, part, id) {
  if (!id) return '';
  const relationshipPath = partRelationshipPath(part);
  const relationships = await zipText(zip, relationshipPath);
  if (!relationships) return '';
  for (const match of relationships.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    if (xmlAttribute(match[0], 'Id') !== id) continue;
    if (/\bTargetMode="External"/i.test(match[0])) return '';
    const target = xmlAttribute(match[0], 'Target');
    return target ? relationshipTarget(relationshipPath, target) : '';
  }
  return '';
}

/** What a chart part carries, in the shape a review reads: its plot kind, title,
 *  and the series with the ranges they pull from. */
export function chartPartSnapshot(xml) {
  const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((match, index) => {
    const body = match[1];
    // Each reference is read inside its own element: a name written as text (<c:tx><c:v>Value</c:v></c:tx>) has no
    // formula, and a search past </c:tx> reported the category range as the series name's.
    const element = (tag) => new RegExp(`<c:${tag}>([\\s\\S]*?)<\\/c:${tag}>`).exec(body)?.[1] || '';
    const reference = (tag) => xmlDecode(/<c:f>([\s\S]*?)<\/c:f>/.exec(element(tag))?.[1] || '');
    return {
      index: index + 1,
      name: xmlDecode(/<c:v>([\s\S]*?)<\/c:v>/.exec(element('tx'))?.[1] || ''),
      formula: reference('tx'),
      categoryFormula: reference('cat'),
      valueFormula: reference('val'),
      pointCount: Number(/<c:val>[\s\S]*?<c:ptCount\b[^>]*\bval="(\d+)"/.exec(body)?.[1] || 0),
    };
  });
  return {
    // A column and a bar are both barChart; only the direction (and the
    // grouping) tells them apart, so the reader uses the same names the writer
    // takes rather than the element name alone.
    chartType: /<c:\w+Chart\b/.test(xml) ? detectChartType(xml) : '',
    title: blockText(/<c:title>([\s\S]*?)<\/c:title>/.exec(xml)?.[1] || '', 'a:t'),
    seriesCount: series.length,
    // What tells one series from another on the page: the legend the chart draws,
    // or labels that carry the series name. Without either, two series are two
    // colours and the reader has nothing to read them by.
    legend: /<c:legend>/.test(xml),
    seriesNamesShown: /<c:showSerName val="1"\/>/.test(xml),
    series,
  };
}

// Offset of the next page, or null once the window reached the end.
export function nextPageOffset(offset, returned, total) {
  return offset + returned < total ? offset + returned : null;
}

// Pagination facts for a paged workbook read: the populated-cell window of the
// sheet just read, and the next sheet when this one is read out and the caller
// named none.
export function populatedCellPagination({ options, page, selectedSheets, sheets, sheetOffset }) {
  const offset = Math.max(0, Number(options.offset) || 0);
  const returned = page?.records.length || 0;
  const total = page?.total || 0;
  const nextOffset = page ? nextPageOffset(offset, returned, total) : null;
  const rangeSuffix = options.range ? `!${options.range}` : '';
  const pagination = {
    unit: 'populated-cell',
    scope: `${selectedSheets[0]?.name || ''}${rangeSuffix}`,
    offset,
    limit: Math.max(1, Number(options.limit) || 2_000),
    returned,
    total,
    nextOffset,
  };
  if (nextOffset === null && !options.sheet && sheetOffset + 1 < sheets.length) {
    pagination.nextSheetOffset = sheetOffset + 1;
  }
  return pagination;
}

export function statedRunFont(xml) {
  const direct = docxRunFont(xml);
  return direct.size || direct.bold || direct.name || direct.color || direct.caps !== undefined || direct.letterSpacing !== undefined
    ? { font: direct }
    : {};
}

export function softBreakFacts(xml) {
  const count = (xml.match(/<w:br\b(?![^>]*\bw:type=)/g) || []).length;
  return count ? { softBreaks: count } : {};
}
