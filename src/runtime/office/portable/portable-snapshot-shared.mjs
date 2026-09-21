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
  return {
    size: sizes.length ? Math.max(...sizes) : 0,
    bold: /<w:b\b(?![^>]*\bw:val="(?:0|false)")/.test(String(xml)),
    name: xmlDecode(/<w:rFonts\b[^>]*\bw:ascii="([^"]*)"/.exec(String(xml))?.[1] || ''),
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
    const reference = (tag) =>
      xmlDecode(new RegExp(`<c:${tag}>[\\s\\S]*?<c:f>([\\s\\S]*?)<\\/c:f>`).exec(body)?.[1] || '');
    return {
      index: index + 1,
      name: xmlDecode(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(body)?.[1] || ''),
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
  return direct.size || direct.bold || direct.name ? { font: direct } : {};
}

export function softBreakFacts(xml) {
  const count = (xml.match(/<w:br\b(?![^>]*\bw:type=)/g) || []).length;
  return count ? { softBreaks: count } : {};
}
