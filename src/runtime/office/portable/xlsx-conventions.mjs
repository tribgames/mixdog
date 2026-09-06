// What an existing workbook already does — its faces, its number formats by
// column, and the color or fill that marks an input — read from the styled
// cells of a snapshot so an edit can match the file instead of the guideline.
// Both backends feed the same cell shape ({ ref, value, formula?, style? }).
import { columnNumber } from './portable-cells.mjs';
import { isMarkedInputStyle, isNumericCell } from './xlsx-audit-support.mjs';

const TOP_FONTS = 5;
const TOP_FORMATS = 8;
const TOP_MARKERS = 3;
const SAMPLE_INPUTS = 5;

function tally(map, key, extra) {
  if (!key) return;
  const entry = map.get(key) || { count: 0, columns: new Set() };
  entry.count += 1;
  if (extra) entry.columns.add(extra);
  map.set(key, entry);
}

function ranked(map, limit, label) {
  return [...map.entries()]
    .sort((left, right) => right[1].count - left[1].count || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([key, entry]) => ({
      [label]: key,
      cells: entry.count,
      ...(entry.columns.size ? { columns: [...entry.columns].sort((a, b) => columnNumber(a) - columnNumber(b)) } : {}),
    }));
}

export function summarizeXlsxConventions(document) {
  const fonts = new Map();
  const formats = new Map();
  const inputColors = new Map();
  const inputFills = new Map();
  const markedInputs = [];
  let styled = 0;
  let formulas = 0;
  let hardcodes = 0;
  for (const sheet of document?.sheets || []) {
    for (const cell of sheet?.cells || []) {
      if (!cell?.ref) continue;
      const style = cell.style && typeof cell.style === 'object' ? cell.style : null;
      const column = /^[A-Z]+/i.exec(cell.ref)?.[0]?.toUpperCase() || '';
      if (cell.formula) formulas += 1;
      if (style) {
        styled += 1;
        tally(fonts, style.fontName);
        tally(formats, style.numberFormat, column);
      }
      if (!cell.formula && isNumericCell(cell)) {
        hardcodes += 1;
        if (isMarkedInputStyle(style)) {
          markedInputs.push(`${sheet.name}!${cell.ref}`);
          tally(inputColors, style.color);
          tally(inputFills, style.fillColor);
        }
      }
    }
  }
  const defaultFont = document?.defaultStyle?.fontName ? String(document.defaultStyle.fontName) : '';
  if (!styled && !defaultFont) return null;
  return {
    ...(defaultFont ? { defaultFont } : {}),
    fonts: ranked(fonts, TOP_FONTS, 'name'),
    numberFormats: ranked(formats, TOP_FORMATS, 'format'),
    inputMarkers: {
      fontColors: ranked(inputColors, TOP_MARKERS, 'color'),
      fills: ranked(inputFills, TOP_MARKERS, 'color'),
    },
    cells: { styled, formulas, hardcodes, markedInputs: markedInputs.length },
    sampleInputs: markedInputs.slice(0, SAMPLE_INPUTS),
  };
}
