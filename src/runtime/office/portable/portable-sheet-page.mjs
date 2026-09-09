import { posix } from 'node:path';
import { cellRecords, columnLabel, columnNumber, parseCellRef, sharedStrings } from './portable-cells.mjs';
import { partRelationshipPath, zipText } from './portable-opc.mjs';
import { xmlAttribute, xmlEncode } from './portable-xml.mjs';
import { absoluteRange, mergedRanges, parseAreaRange, quoteSheetName, upsertDefinedName, upsertWorksheetSection, worksheetSection } from './portable-sheet-xml.mjs';

// OOXML stores row heights in points and column widths in character units.
// Use the persisted dimensions, including hidden ranges, rather than a uniform grid.
export function worksheetGeometry(xml) {
  const format = /<sheetFormatPr\b([^>]*?)\/?>/.exec(xml)?.[1] || '';
  const defaultRow = Number(xmlAttribute(format, 'defaultRowHeight')) || 15;
  const defaultColumn = Number(xmlAttribute(format, 'defaultColWidth')) || 8.43;
  const columns = [...xml.matchAll(/<col\b([^>]*?)\/>/g)].map((match) => ({
    start: Number(xmlAttribute(match[1], 'min')),
    end: Number(xmlAttribute(match[1], 'max')),
    width: xmlAttribute(match[1], 'hidden') === '1' ? 0
      : Number(xmlAttribute(match[1], 'width')) || defaultColumn,
  }));
  const rows = new Map([...xml.matchAll(/<row\b([^>]*?)(?:\/>|>)/g)].map((match) => [
    Number(xmlAttribute(match[1], 'r')),
    xmlAttribute(match[1], 'hidden') === '1' ? 0
      : Number(xmlAttribute(match[1], 'ht')) || defaultRow,
  ]));
  const columnPoints = (index) => {
    const width = columns.find((entry) => index >= entry.start && index <= entry.end)?.width ?? defaultColumn;
    return width === 0 ? 0 : Math.floor(width * 7 + 5) * 0.75;
  };
  const rowPoints = (index) => rows.get(index) ?? defaultRow;
  const edgeCell = (points, size, limit) => {
    let edge = 0;
    for (let index = 1; index <= limit; index += 1) {
      edge += size(index);
      if (edge >= points) return index;
    }
    throw new Error('Worksheet drawing exceeds the Excel page grid');
  };
  return {
    columnPoints,
    rowPoints,
    columnAt: (points) => edgeCell(points, columnPoints, 16_384),
    rowAt: (points) => edgeCell(points, rowPoints, 1_048_576),
  };
}

export async function contentPrintArea(zip, sheet, xml) {
  let lastColumn = 1;
  let lastRow = 1;
  for (const cell of cellRecords(xml, await sharedStrings(zip))) {
    if (!cell.formula && (cell.value == null || cell.value === '')) continue;
    const parsed = parseCellRef(cell.ref);
    lastColumn = Math.max(lastColumn, columnNumber(parsed.col));
    lastRow = Math.max(lastRow, parsed.row);
  }
  for (const reference of mergedRanges(xml)) {
    const area = parseAreaRange(reference);
    lastColumn = Math.max(lastColumn, area.endCol);
    lastRow = Math.max(lastRow, area.endRow);
  }
  const relations = await zipText(zip, partRelationshipPath(sheet.path));
  const geometry = worksheetGeometry(xml);
  for (const match of relations.matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const attrs = match[1];
    if (!String(xmlAttribute(attrs, 'Type') || '').endsWith('/drawing') || xmlAttribute(attrs, 'TargetMode') === 'External') continue;
    const target = xmlAttribute(attrs, 'Target');
    const part = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(sheet.path), target));
    const drawing = await zipText(zip, part);
    for (const anchor of drawing.matchAll(/<xdr:(absoluteAnchor|oneCellAnchor|twoCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g)) {
      const body = anchor[2];
      const marker = (tag) => {
        const value = new RegExp(`<xdr:${tag}>([\\s\\S]*?)<\\/xdr:${tag}>`).exec(body)?.[1] || '';
        const number = (name) => Number(new RegExp(`<xdr:${name}>(\\d+)<\\/xdr:${name}>`).exec(value)?.[1]) || 0;
        return { column: number('col'), row: number('row'), x: number('colOff') / 12700, y: number('rowOff') / 12700 };
      };
      if (anchor[1] === 'twoCellAnchor') {
        const end = marker('to');
        if (end.column >= 16_384 || end.row >= 1_048_576) throw new Error('Worksheet drawing anchor exceeds the Excel grid');
        lastColumn = Math.max(lastColumn, end.column + (end.x > 0 ? 1 : 0));
        lastRow = Math.max(lastRow, end.row + (end.y > 0 ? 1 : 0));
        continue;
      }
      const extent = /<xdr:ext\b([^>]*?)\/>/.exec(body)?.[1] || '';
      let x = 0;
      let y = 0;
      if (anchor[1] === 'absoluteAnchor') {
        const position = /<xdr:pos\b([^>]*?)\/>/.exec(body)?.[1] || '';
        x = Number(xmlAttribute(position, 'x')) / 12700 || 0;
        y = Number(xmlAttribute(position, 'y')) / 12700 || 0;
      } else {
        const start = marker('from');
        if (start.column >= 16_384 || start.row >= 1_048_576) throw new Error('Worksheet drawing anchor exceeds the Excel grid');
        x = start.x;
        y = start.y;
        for (let index = 1; index <= start.column; index += 1) x += geometry.columnPoints(index);
        for (let index = 1; index <= start.row; index += 1) y += geometry.rowPoints(index);
      }
      lastColumn = Math.max(lastColumn, geometry.columnAt(x + (Number(xmlAttribute(extent, 'cx')) || 0) / 12700));
      lastRow = Math.max(lastRow, geometry.rowAt(y + (Number(xmlAttribute(extent, 'cy')) || 0) / 12700));
    }
  }
  return `A1:${columnLabel(lastColumn)}${lastRow}`;
}

export async function applyWorksheetPageSetup(zip, sheets, sheet, xml, op) {
  const orientation = String(op.orientation || '').toLowerCase();
  if (orientation && !['portrait', 'landscape'].includes(orientation)) {
    throw new Error('set_page_setup orientation must be portrait or landscape');
  }
  const fitWide = Number(op.fitToPagesWide) || 0;
  const fitTall = op.fitToPagesTall == null ? null : Number(op.fitToPagesTall) || 0;
  if (fitWide || fitTall != null) {
    const existing = worksheetSection(xml, 'sheetPr');
    const attrs = existing ? /^<sheetPr\b([^>]*?)(?:\/>|>)/.exec(existing[0])?.[1] || '' : '';
    const body = existing && !existing[0].endsWith('/>')
      ? existing[0].slice(existing[0].indexOf('>') + 1, existing[0].lastIndexOf('</sheetPr>')) : '';
    xml = upsertWorksheetSection(xml, 'sheetPr', `<sheetPr${attrs}>${body.replace(/<pageSetUpPr\b[^>]*?\/>/, '')}<pageSetUpPr fitToPage="1"/></sheetPr>`);
  }
  const centered = `${op.centerHorizontally === true ? ' horizontalCentered="1"' : ''}${op.centerVertically === true ? ' verticalCentered="1"' : ''}`;
  xml = upsertWorksheetSection(xml, 'printOptions', centered ? `<printOptions${centered}/>` : '');
  const margin = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
  xml = upsertWorksheetSection(xml, 'pageMargins', `<pageMargins left="${margin(op.leftMargin, 0.7)}" right="${margin(op.rightMargin, 0.7)}" top="${margin(op.topMargin, 0.75)}" bottom="${margin(op.bottomMargin, 0.75)}" header="0.3" footer="0.3"/>`);
  xml = upsertWorksheetSection(xml, 'pageSetup', `<pageSetup paperSize="9"${orientation ? ` orientation="${orientation}"` : ''}${fitWide ? ` fitToWidth="${fitWide}"` : ''}${fitTall == null ? '' : ` fitToHeight="${fitTall}"`}/>`);
  const printArea = op.fitToContent === true ? await contentPrintArea(zip, sheet, xml) : op.printArea;
  if (printArea) {
    const area = parseAreaRange(printArea);
    const reference = `${quoteSheetName(sheet.name)}!${absoluteRange(`${columnLabel(area.startCol)}${area.startRow}:${columnLabel(area.endCol)}${area.endRow}`)}`;
    const localSheetId = sheets.findIndex((entry) => entry.name === sheet.name);
    const workbook = await zipText(zip, 'xl/workbook.xml');
    zip.file('xl/workbook.xml', upsertDefinedName(workbook,
      `<definedName name="_xlnm.Print_Area" localSheetId="${localSheetId}">${xmlEncode(reference)}</definedName>`,
      (item) => xmlAttribute(item, 'name') === '_xlnm.Print_Area' && Number(xmlAttribute(item, 'localSheetId')) === localSheetId));
  }
  zip.file(sheet.path, xml);
  return { op: op.op, changed: true, sheet: sheet.name, ...(printArea ? { printArea } : {}) };
}
