import { join } from 'node:path';
import { normalizeColor } from './portable-sheet-styles.mjs';
import { columnLabel, columnNumber, parseCellRef } from './portable-cells.mjs';
import { containerBody, elementSpans, setXmlAttribute, xmlAttribute } from './portable-xml.mjs';

const WORKSHEET_SECTIONS = Object.freeze([
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
  'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter',
  'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr',
  'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions',
  'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing',
  'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst',
]);


export function safeWorkbookTableName(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9_]/g, '');
  const named = /^[A-Za-z_]/.test(cleaned) ? cleaned : `Table${cleaned}`;
  return named.slice(0, 255) || 'Table1';
}



export function worksheetSection(xml, name) {
  return new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`).exec(xml);
}



export function upsertWorksheetSection(xml, name, element) {
  const existing = worksheetSection(xml, name);
  const base = existing
    ? `${xml.slice(0, existing.index)}${xml.slice(existing.index + existing[0].length)}`
    : xml;
  if (!element) return base;
  const position = WORKSHEET_SECTIONS.indexOf(name);
  for (const candidate of WORKSHEET_SECTIONS.slice(position + 1)) {
    const found = worksheetSection(base, candidate);
    if (found) return `${base.slice(0, found.index)}${element}${base.slice(found.index)}`;
  }
  return base.replace(/<\/worksheet>\s*$/, `${element}</worksheet>`);
}



export function mergedRanges(xml) {
  const section = worksheetSection(xml, 'mergeCells');
  if (!section) return [];
  return [...section[0].matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/g)]
    .map((match) => match[1].toUpperCase());
}



export function writeMergedRanges(xml, ranges) {
  const unique = [...new Set(ranges)];
  const element = unique.length
    ? `<mergeCells count="${unique.length}">${unique.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
    : '';
  return upsertWorksheetSection(xml, 'mergeCells', element);
}



function renumberWorksheetRow(rowXml, index) {
  const open = /^<row\b([^>]*?)(\/>|>)/.exec(rowXml);
  if (!open) return rowXml;
  const attrs = setXmlAttribute(open[1], 'r', index);
  if (open[2] === '/>') return `<row${attrs}/>`;
  const body = containerBody(rowXml, 'row')
    .replace(/(<c\b[^>]*?\br=")([A-Z]+)\d+(")/g, (_match, lead, column, tail) => `${lead}${column}${index}${tail}`);
  return `<row${attrs}>${body}</row>`;
}



function replaceSheetData(xml, inner) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  return `${xml.slice(0, sheetData.index)}<sheetData>${inner}</sheetData>`
    + xml.slice(sheetData.index + sheetData[0].length);
}



export function shiftWorksheetRows(xml, from, count) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  const inner = containerBody(sheetData[0], 'sheetData');
  const kept = [];
  for (const span of elementSpans(inner, 'row')) {
    const index = Number(/\br="(\d+)"/.exec(span.attrs)?.[1] || 0);
    if (count < 0 && index >= from && index < from - count) continue;
    const next = index >= from ? index + count : index;
    if (next < 1) continue;
    kept.push(renumberWorksheetRow(span.xml, next));
  }
  return replaceSheetData(xml, kept.join(''));
}



export function shiftWorksheetColumns(xml, from, count) {
  const sheetData = /<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)/.exec(xml);
  if (!sheetData) throw new Error('Worksheet is missing sheetData');
  const inner = containerBody(sheetData[0], 'sheetData');
  const rows = elementSpans(inner, 'row').map((span) => {
    const open = /^<row\b([^>]*?)(\/>|>)/.exec(span.xml);
    if (!open || open[2] === '/>') return span.xml;
    const body = containerBody(span.xml, 'row');
    const kept = [];
    for (const cell of elementSpans(body, 'c')) {
      const reference = (/\br="([A-Za-z]+\d+)"/.exec(cell.attrs)?.[1] || '').toUpperCase();
      if (!reference) continue;
      const parsed = parseCellRef(reference);
      const column = columnNumber(parsed.col);
      if (count < 0 && column >= from && column < from - count) continue;
      const next = column >= from ? column + count : column;
      if (next < 1) continue;
      kept.push(cell.xml.replace(/(\br=")[A-Za-z]+(\d+")/, `$1${columnLabel(next)}$2`));
    }
    return `<row${open[1]}>${kept.join('')}</row>`;
  });
  return replaceSheetData(xml, rows.join(''));
}



export function appendWorksheetSection(xml, name, element) {
  const existing = [...xml.matchAll(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g'))];
  if (!existing.length) return upsertWorksheetSection(xml, name, element);
  const last = existing.at(-1);
  const position = last.index + last[0].length;
  return `${xml.slice(0, position)}${element}${xml.slice(position)}`;
}



export function appendDifferentialFormat(stylesXml, { color = '', fillColor = '' }) {
  const font = normalizeColor(color);
  const fill = normalizeColor(fillColor);
  const dxf = '<dxf>'
    + (font ? `<font><color rgb="${font}"/></font>` : '')
    + (fill ? `<fill><patternFill><bgColor rgb="${fill}"/></patternFill></fill>` : '')
    + '</dxf>';
  const section = /<dxfs\b[^>]*?(?:\/>|>[\s\S]*?<\/dxfs>)/.exec(stylesXml);
  const items = section && !section[0].endsWith('/>')
    ? [...section[0].matchAll(/<dxf>[\s\S]*?<\/dxf>/g)].map((match) => match[0])
    : [];
  const found = items.indexOf(dxf);
  if (found >= 0) return { xml: stylesXml, id: found };
  items.push(dxf);
  const element = `<dxfs count="${items.length}">${items.join('')}</dxfs>`;
  if (section) return { xml: stylesXml.replace(section[0], element), id: items.length - 1 };
  const styles = /<cellStyles\b[^>]*?(?:\/>|>[\s\S]*?<\/cellStyles>)/.exec(stylesXml);
  if (styles) {
    const position = styles.index + styles[0].length;
    return { xml: `${stylesXml.slice(0, position)}${element}${stylesXml.slice(position)}`, id: items.length - 1 };
  }
  return { xml: stylesXml.replace('</styleSheet>', `${element}</styleSheet>`), id: items.length - 1 };
}



export function mergedCellAnchor(xml, reference) {
  const parsed = parseCellRef(reference);
  const column = columnNumber(parsed.col);
  for (const entry of mergedRanges(xml)) {
    const area = parseAreaRange(entry);
    if (
      area.startCol <= column && column <= area.endCol
      && area.startRow <= parsed.row && parsed.row <= area.endRow
    ) {
      return area.startCol === column && area.startRow === parsed.row;
    }
  }
  return true;
}



export function sheetViewParts(view) {
  const open = /^<sheetView\b([^>]*?)(\/>|>)/.exec(view);
  if (!open) throw new Error('Worksheet view is malformed');
  return {
    attrs: open[1],
    body: open[2] === '/>' ? '' : view.slice(open[0].length, view.lastIndexOf('</sheetView>')),
  };
}



export function composeSheetView(attrs, body) {
  return body ? `<sheetView${attrs}>${body}</sheetView>` : `<sheetView${attrs}/>`;
}



export function updateSheetView(xml, mutate) {
  const section = worksheetSection(xml, 'sheetViews');
  const current = section
    ? /<sheetView\b[^>]*?(?:\/>|>[\s\S]*?<\/sheetView>)/.exec(section[0])?.[0] || ''
    : '';
  const next = mutate(current || '<sheetView workbookViewId="0"/>');
  return upsertWorksheetSection(xml, 'sheetViews', `<sheetViews>${next}</sheetViews>`);
}



export function freezePaneXml(row, column) {
  const ySplit = Math.max(0, (Number(row) || 0) - 1);
  const xSplit = Math.max(0, (Number(column) || 0) - 1);
  if (!ySplit && !xSplit) return '';
  const topLeft = `${columnLabel(xSplit + 1)}${ySplit + 1}`;
  const activePane = ySplit && xSplit ? 'bottomRight' : ySplit ? 'bottomLeft' : 'topRight';
  return `<pane${xSplit ? ` xSplit="${xSplit}"` : ''}${ySplit ? ` ySplit="${ySplit}"` : ''}`
    + ` topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>`;
}



export function parseAreaRange(range) {
  const text = String(range || '').trim().toUpperCase();
  const columns = /^([A-Z]+):([A-Z]+)$/.exec(text);
  if (columns) {
    return { startCol: columnNumber(columns[1]), endCol: columnNumber(columns[2]), startRow: 0, endRow: 0 };
  }
  const rows = /^(\d+):(\d+)$/.exec(text);
  if (rows) return { startCol: 0, endCol: 0, startRow: Number(rows[1]), endRow: Number(rows[2]) };
  const area = /^([A-Z]+\d+):([A-Z]+\d+)$/.exec(text);
  if (area) {
    const start = parseCellRef(area[1]);
    const end = parseCellRef(area[2]);
    return {
      startCol: Math.min(columnNumber(start.col), columnNumber(end.col)),
      endCol: Math.max(columnNumber(start.col), columnNumber(end.col)),
      startRow: Math.min(start.row, end.row),
      endRow: Math.max(start.row, end.row),
    };
  }
  if (/^[A-Z]+\d+$/.test(text)) {
    const single = parseCellRef(text);
    const column = columnNumber(single.col);
    return { startCol: column, endCol: column, startRow: single.row, endRow: single.row };
  }
  throw new Error(`Unsupported range: ${range}`);
}



export function displayWidth(text) {
  let width = 0;
  for (const character of String(text ?? '')) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character)
      ? 2
      : 1;
  }
  return width;
}



export function writeColumnWidths(xml, widths) {
  if (!widths.size) return xml;
  const entries = new Map();
  const existing = worksheetSection(xml, 'cols');
  if (existing) {
    for (const match of existing[0].matchAll(/<col\b([^>]*?)\/>/g)) {
      const min = Number(xmlAttribute(match[1], 'min')) || 0;
      const max = Number(xmlAttribute(match[1], 'max')) || min;
      for (let column = min; column >= 1 && column <= max && column - min < 2048; column += 1) {
        entries.set(column, match[1]);
      }
    }
  }
  for (const [column, width] of widths) {
    entries.set(column, ` min="${column}" max="${column}" width="${width}" customWidth="1"`);
  }
  const body = [...entries.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([column, attrs]) => `<col${setXmlAttribute(setXmlAttribute(attrs, 'min', column), 'max', column)}/>`)
    .join('');
  return upsertWorksheetSection(xml, 'cols', `<cols>${body}</cols>`);
}



export function quoteSheetName(name) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}



export function absoluteRange(range) {
  return String(range)
    .split(':')
    .map((part) => part.replace(/^([A-Za-z]+)(\d+)$/, '$$$1$$$2'))
    .join(':');
}



export function upsertDefinedName(xml, entry, matches) {
  const section = /<definedNames\b[^>]*?(?:\/>|>[\s\S]*?<\/definedNames>)/.exec(xml);
  const items = section
    ? [...section[0].matchAll(/<definedName\b[^>]*?(?:\/>|>[\s\S]*?<\/definedName>)/g)].map((match) => match[0])
    : [];
  const kept = items.filter((item) => !matches(item));
  if (entry) kept.push(entry);
  const element = kept.length ? `<definedNames>${kept.join('')}</definedNames>` : '';
  if (section) {
    return `${xml.slice(0, section.index)}${element}${xml.slice(section.index + section[0].length)}`;
  }
  if (!element) return xml;
  const calculation = /<calcPr\b[^>]*?(?:\/>|>[\s\S]*?<\/calcPr>)/.exec(xml);
  if (calculation) return `${xml.slice(0, calculation.index)}${element}${xml.slice(calculation.index)}`;
  return xml.replace(/<\/workbook>\s*$/, `${element}</workbook>`);
}
