import { posix } from 'node:path';
import { cellRecords, columnLabel, columnNumber, parseCellRef, sharedStrings } from './portable-cells.mjs';
import { partRelationshipPath, zipText } from './portable-opc.mjs';
import { xmlAttribute, xmlEncode } from './portable-xml.mjs';
import {
  absoluteRange,
  areaReference,
  mergedRanges,
  parseAreaRange,
  quoteSheetName,
  upsertDefinedName,
  upsertWorksheetSection,
  worksheetSection,
} from './portable-sheet-xml.mjs';

// OOXML stores row heights in points and column widths in character units.
// Use the persisted dimensions, including hidden ranges, rather than a uniform grid.
export function worksheetGeometry(xml) {
  const format = /<sheetFormatPr\b([^>]*?)\/?>/.exec(xml)?.[1] || '';
  const defaultRow = Number(xmlAttribute(format, 'defaultRowHeight')) || 15;
  const defaultColumn = Number(xmlAttribute(format, 'defaultColWidth')) || 8.43;
  const columns = [...xml.matchAll(/<col\b([^>]*?)\/>/g)].map((match) => ({
    start: Number(xmlAttribute(match[1], 'min')),
    end: Number(xmlAttribute(match[1], 'max')),
    width: xmlAttribute(match[1], 'hidden') === '1' ? 0 : Number(xmlAttribute(match[1], 'width')) || defaultColumn,
  }));
  const rows = new Map(
    [...xml.matchAll(/<row\b([^>]*?)(?:\/>|>)/g)].map((match) => [
      Number(xmlAttribute(match[1], 'r')),
      xmlAttribute(match[1], 'hidden') === '1' ? 0 : Number(xmlAttribute(match[1], 'ht')) || defaultRow,
    ])
  );
  const columnPoints = (index) => {
    const width = columns.find((entry) => index >= entry.start && index <= entry.end)?.width ?? defaultColumn;
    return width === 0 ? 0 : Math.floor(width * 7 + 5) * 0.75;
  };
  const rowPoints = (index) => rows.get(index) ?? defaultRow;
  // Which cell a point falls in. A drawing that starts exactly on a boundary
  // sits in the cell that begins there (an image placed at D2 is in D2, not in
  // C1), while one that ends on a boundary still ends in the cell before it.
  const edgeCell = (points, size, limit, trailing) => {
    let edge = 0;
    for (let index = 1; index <= limit; index += 1) {
      edge += size(index);
      if (trailing ? edge >= points : edge > points) return index;
    }
    throw new Error('Worksheet drawing exceeds the Excel page grid');
  };
  return {
    columnPoints,
    rowPoints,
    columnAt: (points, { trailing = false } = {}) => edgeCell(points, columnPoints, 16_384, trailing),
    rowAt: (points, { trailing = false } = {}) => edgeCell(points, rowPoints, 1_048_576, trailing),
  };
}

/** Every chart and picture anchored to a worksheet, resolved onto the cell grid
 *  (1-based, inclusive). Excel writes three anchor kinds and our own writer uses
 *  the absolute one, so the print area and the snapshot read the same resolver
 *  rather than each parsing anchors again. `body` is the anchor's own markup,
 *  which the caller inspects to tell a chart frame from a picture. */
export async function worksheetDrawings(zip, sheet, xml) {
  const relations = await zipText(zip, partRelationshipPath(sheet.path));
  const geometry = worksheetGeometry(xml);
  const drawings = [];
  for (const match of (relations || '').matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const attrs = match[1];
    if (
      !String(xmlAttribute(attrs, 'Type') || '').endsWith('/drawing') ||
      xmlAttribute(attrs, 'TargetMode') === 'External'
    )
      continue;
    const target = xmlAttribute(attrs, 'Target');
    const part = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(posix.dirname(sheet.path), target));
    const drawing = await zipText(zip, part);
    for (const anchor of (drawing || '').matchAll(
      /<xdr:(absoluteAnchor|oneCellAnchor|twoCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g
    )) {
      const kind = anchor[1];
      const body = anchor[2];
      const marker = (tag) => {
        const value = new RegExp(`<xdr:${tag}>([\\s\\S]*?)<\\/xdr:${tag}>`).exec(body)?.[1] || '';
        const number = (name) => Number(new RegExp(`<xdr:${name}>(\\d+)<\\/xdr:${name}>`).exec(value)?.[1]) || 0;
        return { column: number('col'), row: number('row'), x: number('colOff') / 12700, y: number('rowOff') / 12700 };
      };
      const start = kind === 'absoluteAnchor' ? null : marker('from');
      if (start && (start.column >= 16_384 || start.row >= 1_048_576)) {
        throw new Error('Worksheet drawing anchor exceeds the Excel grid');
      }
      if (kind === 'twoCellAnchor') {
        const end = marker('to');
        if (end.column >= 16_384 || end.row >= 1_048_576)
          throw new Error('Worksheet drawing anchor exceeds the Excel grid');
        drawings.push({
          part,
          kind,
          body,
          startColumn: start.column + 1,
          startRow: start.row + 1,
          endColumn: end.column + (end.x > 0 ? 1 : 0),
          endRow: end.row + (end.y > 0 ? 1 : 0),
        });
        continue;
      }
      const extent = /<xdr:ext\b([^>]*?)\/>/.exec(body)?.[1] || '';
      let x = 0;
      let y = 0;
      if (kind === 'absoluteAnchor') {
        const position = /<xdr:pos\b([^>]*?)\/>/.exec(body)?.[1] || '';
        x = Number(xmlAttribute(position, 'x')) / 12700 || 0;
        y = Number(xmlAttribute(position, 'y')) / 12700 || 0;
      } else {
        x = start.x;
        y = start.y;
        for (let index = 1; index <= start.column; index += 1) x += geometry.columnPoints(index);
        for (let index = 1; index <= start.row; index += 1) y += geometry.rowPoints(index);
      }
      const width = (Number(xmlAttribute(extent, 'cx')) || 0) / 12700;
      const height = (Number(xmlAttribute(extent, 'cy')) || 0) / 12700;
      drawings.push({
        part,
        kind,
        body,
        startColumn: geometry.columnAt(x),
        startRow: geometry.rowAt(y),
        endColumn: geometry.columnAt(x + width, { trailing: true }),
        endRow: geometry.rowAt(y + height, { trailing: true }),
        left: x,
        top: y,
        width,
        height,
      });
    }
  }
  return drawings;
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
  for (const drawing of await worksheetDrawings(zip, sheet, xml)) {
    lastColumn = Math.max(lastColumn, drawing.endColumn);
    lastRow = Math.max(lastRow, drawing.endRow);
  }
  return `A1:${columnLabel(lastColumn)}${lastRow}`;
}

// The sheet's own sheetPr with fitToPage turned on: whatever else it declares
// travels with it, and the fit flag it may already carry is replaced rather
// than written twice.
function sheetPrWithFitToPage(xml) {
  const sheetPr = worksheetSection(xml, 'sheetPr');
  const attrs = sheetPr ? /^<sheetPr\b([^>]*?)(?:\/>|>)/.exec(sheetPr[0])?.[1] || '' : '';
  const body =
    sheetPr && !sheetPr[0].endsWith('/>')
      ? sheetPr[0].slice(sheetPr[0].indexOf('>') + 1, sheetPr[0].lastIndexOf('</sheetPr>'))
      : '';
  return `<sheetPr${attrs}>${body.replace(/<pageSetUpPr\b[^>]*?\/>/, '')}<pageSetUpPr fitToPage="1"/></sheetPr>`;
}

// A chart or picture beside a table is wider than a portrait page, and a sheet
// with no page setup exports by column blocks — the page break runs through the
// chart. A sheet that declares nothing takes one page wide and keeps paging down
// (a fit only scales down, so a small sheet prints as before); a declared fit,
// print scale, or print area is the author's and stays.
export function fitDrawingSheetOnePageWide(xml) {
  if (/<pageSetUpPr\b[^>]*\bfitToPage="1"/.test(xml)) return { xml, applied: false };
  const setup = worksheetSection(xml, 'pageSetup');
  if (setup && /\bscale="/.test(setup[0])) return { xml, applied: false };
  let next = upsertWorksheetSection(xml, 'sheetPr', sheetPrWithFitToPage(xml));
  // pageSetup is attributes and no children, and the section also matches the
  // paired <pageSetup …></pageSetup> a sheet may carry: the fit is written
  // onto the opening tag's attributes, never appended after a closing one.
  const attributes = (setup ? /^<pageSetup\b([^>]*?)\/?>/.exec(setup[0])?.[1] || '' : '').replace(
    /\s+fitTo(?:Width|Height)="[^"]*"/g,
    ''
  );
  next = upsertWorksheetSection(next, 'pageSetup', `<pageSetup${attributes} fitToWidth="1" fitToHeight="0"/>`);
  return { xml: next, applied: true };
}

export async function applyWorksheetPageSetup(zip, sheets, sheet, xml, op) {
  const orientation = String(op.orientation || '').toLowerCase();
  if (orientation && !['portrait', 'landscape'].includes(orientation)) {
    throw new Error('set_page_setup orientation must be portrait or landscape');
  }
  const fitWide = Number(op.fitToPagesWide) || 0;
  const fitTall = op.fitToPagesTall == null ? null : Number(op.fitToPagesTall) || 0;
  // A call that sets only the print area or margins keeps the fit the sheet
  // already declares: with fitToPage on and the counts dropped, Excel would
  // read the default 1 × 1 and shrink a long sheet onto one page.
  const carriedFit =
    fitWide || fitTall != null
      ? ''
      : (worksheetSection(xml, 'pageSetup')?.[0].match(/\s+fitTo(?:Width|Height)="[^"]*"/g) || []).join('');
  if (fitWide || fitTall != null) {
    xml = upsertWorksheetSection(xml, 'sheetPr', sheetPrWithFitToPage(xml));
  }
  const centered = `${op.centerHorizontally === true ? ' horizontalCentered="1"' : ''}${op.centerVertically === true ? ' verticalCentered="1"' : ''}`;
  xml = upsertWorksheetSection(xml, 'printOptions', centered ? `<printOptions${centered}/>` : '');
  const margin = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
  xml = upsertWorksheetSection(
    xml,
    'pageMargins',
    `<pageMargins left="${margin(op.leftMargin, 0.7)}" right="${margin(op.rightMargin, 0.7)}" top="${margin(op.topMargin, 0.75)}" bottom="${margin(op.bottomMargin, 0.75)}" header="0.3" footer="0.3"/>`
  );
  xml = upsertWorksheetSection(
    xml,
    'pageSetup',
    `<pageSetup paperSize="9"${orientation ? ` orientation="${orientation}"` : ''}${fitWide ? ` fitToWidth="${fitWide}"` : ''}${fitTall == null ? '' : ` fitToHeight="${fitTall}"`}${carriedFit}/>`
  );
  const printArea = op.fitToContent === true ? await contentPrintArea(zip, sheet, xml) : op.printArea;
  if (printArea) {
    const reference = `${quoteSheetName(sheet.name)}!${absoluteRange(areaReference(parseAreaRange(printArea)))}`;
    const localSheetId = sheets.findIndex((entry) => entry.name === sheet.name);
    const workbook = await zipText(zip, 'xl/workbook.xml');
    zip.file(
      'xl/workbook.xml',
      upsertDefinedName(
        workbook,
        `<definedName name="_xlnm.Print_Area" localSheetId="${localSheetId}">${xmlEncode(reference)}</definedName>`,
        (item) =>
          xmlAttribute(item, 'name') === '_xlnm.Print_Area' &&
          Number(xmlAttribute(item, 'localSheetId')) === localSheetId
      )
    );
  }
  // The header rows every printed page repeats (Print_Titles): a data sheet longer than a page named its columns on
  // the first page only, and the frozen header the screen shows does not print.
  const titles = printTitleRowSpan(op.printTitleRows);
  if (titles) {
    const reference = `${quoteSheetName(sheet.name)}!$${titles.first}:$${titles.last}`;
    const localSheetId = sheets.findIndex((entry) => entry.name === sheet.name);
    zip.file(
      'xl/workbook.xml',
      upsertDefinedName(
        await zipText(zip, 'xl/workbook.xml'),
        `<definedName name="_xlnm.Print_Titles" localSheetId="${localSheetId}">${xmlEncode(reference)}</definedName>`,
        (item) =>
          xmlAttribute(item, 'name') === '_xlnm.Print_Titles' &&
          Number(xmlAttribute(item, 'localSheetId')) === localSheetId
      )
    );
  }
  zip.file(sheet.path, xml);
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    ...(printArea ? { printArea } : {}),
    ...(titles ? { printTitleRows: `${titles.first}:${titles.last}` } : {}),
  };
}

// printTitleRows: a row or a span of rows, "1", "4:5", or "$1:$1".
function printTitleRowSpan(value) {
  if (value == null || String(value).trim() === '') return null;
  const [first, last = first] = String(value).replace(/\$/g, '').split(':').map((part) => Number(part.trim()));
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    throw new Error(`set_page_setup printTitleRows is a row or a span of rows such as "1" or "4:5", not "${value}"`);
  }
  return { first, last };
}
