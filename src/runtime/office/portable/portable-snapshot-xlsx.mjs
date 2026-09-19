// Workbook snapshot: cells, notes, tables, visuals and page setup per sheet.
import { posix } from 'node:path';
import {
  booleanXmlAttribute,
  cellRecords,
  columnLabel,
  formulaReferences,
  sharedStrings,
  sheetFormulaTotals,
  workbookCalculation,
  workbookSheets,
} from './portable-cells.mjs';
import { partRelationshipPath, zipText } from './portable-opc.mjs';
import { paragraphTexts, xmlAttribute, xmlDecode } from './portable-xml.mjs';
import { expandSharedFormulas } from './portable-shared-formulas.mjs';
import { worksheetDrawings } from './portable-sheet-page.mjs';
import { resolveCellStyles } from './portable-sheet-styles.mjs';
import { hiddenSheetAreas, mergedRanges } from './portable-sheet-xml.mjs';
import { chartPartSnapshot, populatedCellPagination, relatedPartById } from './portable-snapshot-shared.mjs';

// Legacy cell notes (the comments part a worksheet relates to), in the shape
// Excel reports them: { path, cell, text, author }.
async function worksheetNotes(zip, sheet) {
  const rels = await zipText(zip, partRelationshipPath(sheet.path));
  const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/.exec(rels || '')?.[1];
  if (!target) return [];
  const part = target.startsWith('/')
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(sheet.path), target));
  const xml = await zipText(zip, part);
  if (!xml) return [];
  const authors = [...xml.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((match) => xmlDecode(match[1]));
  const notes = [];
  for (const match of xml.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)) {
    const cell = (/\bref="([^"]+)"/.exec(match[1])?.[1] || '').toUpperCase();
    if (!cell) continue;
    const authorId = Number(/\bauthorId="(\d+)"/.exec(match[1])?.[1] ?? -1);
    notes.push({
      path: `/sheet[${sheet.name}]/cell[${cell}]/note`,
      cell,
      text: paragraphTexts(match[2], 't').join(''),
      author: authors[authorId] || '',
    });
  }
  return notes;
}

// Excel tables (ListObjects) a worksheet relates to, in the shape Excel
// reports them: { path, index, name, range, style }.
async function worksheetTables(zip, sheet) {
  const rels = await zipText(zip, partRelationshipPath(sheet.path));
  const tables = [];
  for (const match of (rels || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attributes = match[1];
    if (!/\bType="[^"]*\/table"/.test(attributes)) continue;
    const target = /\bTarget="([^"]+)"/.exec(attributes)?.[1] || '';
    if (!target) continue;
    const part = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(posix.dirname(sheet.path), target));
    const xml = await zipText(zip, part);
    const open = /<table\b([^>]*)>/.exec(xml || '')?.[1] || '';
    const range = (/\bref="([^"]+)"/.exec(open)?.[1] || '').toUpperCase();
    if (!range) continue;
    tables.push({
      path: `/sheet[${sheet.name}]/table[${tables.length + 1}]`,
      index: tables.length + 1,
      name: xmlDecode(/\bdisplayName="([^"]*)"/.exec(open)?.[1] || /\bname="([^"]*)"/.exec(open)?.[1] || ''),
      range,
      style: xmlDecode(/<tableStyleInfo\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] || ''),
    });
  }
  return tables;
}

/** Charts and pictures a worksheet carries, each placed on the cell grid so a
 *  review can compare them with the print area the sheet actually declares. */
function drawingAnchor(drawing) {
  const round = (value) => Math.round(value * 100) / 100;
  return {
    from: `${columnLabel(drawing.startColumn)}${drawing.startRow}`,
    to: `${columnLabel(drawing.endColumn)}${drawing.endRow}`,
    startColumn: drawing.startColumn,
    startRow: drawing.startRow,
    endColumn: drawing.endColumn,
    endRow: drawing.endRow,
    ...(Number.isFinite(drawing.left)
      ? {
          left: round(drawing.left),
          top: round(drawing.top),
          width: round(drawing.width),
          height: round(drawing.height),
        }
      : {}),
  };
}

function drawingImage(sheet, drawing, index, anchor) {
  return {
    path: `/sheet[${sheet.name}]/image[${index}]`,
    index,
    name: xmlDecode(/<xdr:cNvPr\b[^>]*\bname="([^"]*)"/.exec(drawing.body)?.[1] || ''),
    // What a reader who cannot see the picture is told about it.
    altText: xmlDecode(/<xdr:cNvPr\b[^>]*\bdescr="([^"]*)"/.exec(drawing.body)?.[1] || ''),
    anchor,
  };
}

async function worksheetVisuals(zip, sheet, xml) {
  const charts = [];
  const images = [];
  let drawings = [];
  try {
    drawings = await worksheetDrawings(zip, sheet, xml);
  } catch (error) {
    return { charts, images, drawingsUnreadable: error.message };
  }
  for (const drawing of drawings) {
    const anchor = drawingAnchor(drawing);
    const chartId = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(drawing.body)?.[1] || '';
    if (chartId) {
      const part = await relatedPartById(zip, drawing.part, chartId);
      charts.push({
        path: `/sheet[${sheet.name}]/chart[${charts.length + 1}]`,
        index: charts.length + 1,
        part,
        anchor,
        ...chartPartSnapshot(part ? (await zipText(zip, part)) || '' : ''),
      });
      continue;
    }
    if (/<xdr:pic\b/.test(drawing.body)) images.push(drawingImage(sheet, drawing, images.length + 1, anchor));
  }
  return { charts, images };
}

/** Print setup in the shape Excel reports it: fit-to-page counts hold only while
 *  the sheet is set to fit, and the print area comes from the workbook name. */
function worksheetPageSetup(xml, printArea) {
  const setup = /<pageSetup\b([^>]*?)\/?>/.exec(xml)?.[1] || '';
  const options = /<printOptions\b([^>]*?)\/?>/.exec(xml)?.[1] || '';
  const fitToPage = /<pageSetUpPr\b[^>]*\bfitToPage="1"/.test(xml);
  return {
    orientation: xmlAttribute(setup, 'orientation') || '',
    zoom: Number(xmlAttribute(setup, 'scale')) || 100,
    fitToPage,
    fitToPagesWide: fitToPage ? Number(xmlAttribute(setup, 'fitToWidth')) || 1 : 0,
    fitToPagesTall: fitToPage ? Number(xmlAttribute(setup, 'fitToHeight')) || 0 : 0,
    centerHorizontally: booleanXmlAttribute(options, 'horizontalCentered'),
    centerVertically: booleanXmlAttribute(options, 'verticalCentered'),
    // What every printed page of this sheet says, beside what the grid holds.
    header: xmlDecode(/<oddHeader>([\s\S]*?)<\/oddHeader>/.exec(xml)?.[1] || ''),
    footer: xmlDecode(/<oddFooter>([\s\S]*?)<\/oddFooter>/.exec(xml)?.[1] || ''),
    printArea,
  };
}

// _xlnm.Print_Area is a sheet-local defined name; Excel writes it absolute and
// comma-separated when the sheet prints several areas.
function sheetPrintArea(definedNames, sheetIndex) {
  const entry = definedNames.find((item) => item.name === '_xlnm.Print_Area' && item.localSheetId === sheetIndex);
  if (!entry) return '';
  return String(entry.refersTo || '')
    .split(',')
    .map((part) => part.split('!').pop().replace(/\$/g, '').trim())
    .filter(Boolean)
    .join(',');
}

// How many populated cells one whole-sheet read carries. It bounds the work a
// single call does; past it the reading says how far it got.
export const FULL_READ_CELL_LIMIT = 200_000;

function workbookDefinedNames(workbookXml) {
  const definedNames = [];
  for (const match of workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const attributes = match[1];
    definedNames.push({
      path: `/defined-name[${definedNames.length + 1}]`,
      index: definedNames.length + 1,
      name: xmlDecode(/\bname="([^"]+)"/.exec(attributes)?.[1] || ''),
      localSheetId: Number(/\blocalSheetId="(\d+)"/.exec(attributes)?.[1] ?? -1),
      hidden: booleanXmlAttribute(attributes, 'hidden'),
      refersTo: xmlDecode(match[2]),
    });
  }
  return definedNames;
}

// A snapshot read for a person is trimmed to a readable page. A reader that
// audits, diffs, or searches the workbook asks for the whole sheet instead
// (full): with the display cap in force every such check silently stops at
// the same boundary and still answers as if it had read the sheet.
function xlsxCellLimit(options) {
  if (Number.isFinite(Number(options.cellLimit))) return Math.max(1, Number(options.cellLimit));
  return options.full === true ? FULL_READ_CELL_LIMIT : 2_000;
}

// A paged read walks the workbook one sheet at a time; without a named sheet
// it starts where the cursor left off, so every sheet is reachable.
function selectXlsxSheets(sheets, options, paged, sheetOffset) {
  if (!paged) return sheets;
  const sheet = options.sheet
    ? sheets.find((entry) => entry.name.toLowerCase() === String(options.sheet).toLowerCase())
    : sheets[sheetOffset];
  const selected = [sheet].filter(Boolean);
  if (options.sheet && !selected.length) throw new Error(`XLSX sheet not found: ${options.sheet}`);
  return selected;
}

// The same shape Excel reports: which rows and columns stay put.
function worksheetFreezePanes(xml) {
  const pane = /<pane\b([^>]*)\/?>/.exec(xml)?.[1] || '';
  return {
    frozen: /\bstate="frozen(?:Split)?"/.test(pane),
    splitRow: Number(/\bySplit="(\d+)"/.exec(pane)?.[1] || 0),
    splitColumn: Number(/\bxSplit="(\d+)"/.exec(pane)?.[1] || 0),
  };
}

// Protection decides whether a locked cell is actually read-only, so the
// sheet reports it beside the cells that carry the flag.
function worksheetProtection(xml) {
  const guard = /<sheetProtection\b([^>]*?)\/?>/.exec(xml)?.[1] || '';
  return {
    protected: Boolean(/<sheetProtection\b/.test(xml)),
    ...(guard
      ? {
          password: /\b(?:password|hashValue)="[^"]+"/.test(guard),
          allowFormattingCells: /\bformatCells="0"/.test(guard),
          allowSorting: /\bsort="0"/.test(guard),
          allowFiltering: /\bautoFilter="0"/.test(guard),
        }
      : {}),
  };
}

function worksheetValidations(xml, sheetName) {
  const validations = [];
  for (const match of xml.matchAll(/<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
    const attributes = match[1];
    const body = match[2] || '';
    validations.push({
      path: `/sheet[${sheetName}]/validation[${validations.length + 1}]`,
      index: validations.length + 1,
      ranges: xmlDecode(/\bsqref="([^"]+)"/.exec(attributes)?.[1] || '')
        .split(/\s+/)
        .filter(Boolean),
      type: /\btype="([^"]+)"/.exec(attributes)?.[1] || '',
      operator: /\boperator="([^"]+)"/.exec(attributes)?.[1] || '',
      allowBlank: booleanXmlAttribute(attributes, 'allowBlank'),
      showInputMessage: booleanXmlAttribute(attributes, 'showInputMessage'),
      showErrorMessage: booleanXmlAttribute(attributes, 'showErrorMessage'),
      formula1: xmlDecode(/<formula1(?:\s[^>]*)?>([\s\S]*?)<\/formula1>/.exec(body)?.[1] || ''),
      formula2: xmlDecode(/<formula2(?:\s[^>]*)?>([\s\S]*?)<\/formula2>/.exec(body)?.[1] || ''),
    });
  }
  return validations;
}

function worksheetConditionalFormats(xml, sheetName) {
  const conditionalFormats = [];
  for (const match of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
    const ranges = xmlDecode(/\bsqref="([^"]+)"/.exec(match[1])?.[1] || '')
      .split(/\s+/)
      .filter(Boolean);
    for (const rule of match[2].matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)) {
      const attributes = rule[1];
      const body = rule[2] || '';
      conditionalFormats.push({
        path: `/sheet[${sheetName}]/conditional-format[${conditionalFormats.length + 1}]`,
        index: conditionalFormats.length + 1,
        ranges,
        type: xmlDecode(/\btype="([^"]+)"/.exec(attributes)?.[1] || ''),
        operator: xmlDecode(/\boperator="([^"]+)"/.exec(attributes)?.[1] || ''),
        priority: Number(/\bpriority="(\d+)"/.exec(attributes)?.[1] || 0),
        formulas: [...body.matchAll(/<formula(?:\s[^>]*)?>([\s\S]*?)<\/formula>/g)].map((entry) => xmlDecode(entry[1])),
      });
    }
  }
  return conditionalFormats;
}

function formulaLineage(cells, sheetName) {
  return cells
    .filter((cell) => cell.formula)
    .map((cell) => ({
      path: `/sheet[${sheetName}]/cell[${cell.ref}]/lineage`,
      from: `/sheet[${sheetName}]/cell[${cell.ref}]`,
      formula: cell.formula,
      precedents: formulaReferences(cell.formula, sheetName),
    }));
}

function applyCellNotes(cells, notes) {
  if (!notes.length) return;
  const byRef = new Map(notes.map((note) => [note.cell, note.text]));
  for (const cell of cells) {
    const text = byRef.get(cell.ref);
    if (text) cell.note = text;
  }
}

// One sheet of the snapshot, with the cell records it was read from (a
// paged read reports the page's totals from them).
// The cells a sheet entry reports: the page's records, or the first
// `cellLimit` of an unpaged read.
function worksheetCellPage(sheet, cells, cellResult, { paged, cellLimit }) {
  const shown = paged ? cells : cells.slice(0, cellLimit);
  return {
    cellCount: paged ? cellResult.total : cells.length,
    cells: shown.map((cell) => ({ path: `/sheet[${sheet.name}]/cell[${cell.ref}]`, ...cell })),
    truncated: paged ? cellResult.total > cells.length : cells.length > cellLimit,
  };
}

function worksheetVisualEntries(visuals) {
  return {
    chartCount: visuals.charts.length,
    charts: visuals.charts,
    imageCount: visuals.images.length,
    images: visuals.images,
    ...(visuals.drawingsUnreadable ? { drawingsUnreadable: visuals.drawingsUnreadable } : {}),
  };
}

async function snapshotWorksheet(zip, sheet, { strings, styles, definedNames, sheets, options, paged, cellLimit }) {
  const xml = await zipText(zip, sheet.path);
  const cellResult = cellRecords(xml, strings, paged ? { ...options, styles } : { styles });
  const cells = paged ? cellResult.records : cellResult;
  expandSharedFormulas(xml, cells);
  const notes = await worksheetNotes(zip, sheet);
  const tables = await worksheetTables(zip, sheet);
  const visuals = await worksheetVisuals(zip, sheet, xml);
  const pageSetup = worksheetPageSetup(
    xml,
    sheetPrintArea(
      definedNames,
      sheets.findIndex((entry) => entry.name === sheet.name)
    )
  );
  applyCellNotes(cells, notes);
  const validations = worksheetValidations(xml, sheet.name);
  const conditionalFormats = worksheetConditionalFormats(xml, sheet.name);
  const lineage = formulaLineage(cells, sheet.name);
  const hidden = hiddenSheetAreas(xml);
  const entry = {
    path: `/sheet[${sheet.name}]`,
    name: sheet.name,
    visibility: sheet.visibility || 'visible',
    // Rows and columns the sheet withholds: a filtered view or a working
    // column still holds values, and an edit written into one lands where the
    // user never looks.
    hiddenRows: [...hidden.rows],
    hiddenColumns: [...hidden.columns].map((column) => columnLabel(column)),
    ...worksheetCellPage(sheet, cells, cellResult, { paged, cellLimit }),
    noteCount: notes.length,
    notes,
    tableCount: tables.length,
    tables,
    mergedRanges: mergedRanges(xml),
    freezePanes: worksheetFreezePanes(xml),
    protection: worksheetProtection(xml),
    pageSetup,
    ...worksheetVisualEntries(visuals),
    validationCount: validations.length,
    validations,
    conditionalFormatCount: conditionalFormats.length,
    conditionalFormats,
    lineageCount: lineage.length,
    formulaLineage: lineage,
  };
  return { entry, cellResult, cells };
}

// A paged snapshot returns one sheet, but the calculation state it reports
// belongs to the workbook: a caller must not read needsRecalculation:false
// merely because the single sheet it received happens to be settled.
async function workbookFormulaTotals(zip, sheets) {
  const totals = { formulaCount: 0, formulaCacheMissing: 0 };
  for (const sheet of sheets) {
    const sheetTotals = sheetFormulaTotals(await zipText(zip, sheet.path));
    totals.formulaCount += sheetTotals.formulaCount;
    totals.formulaCacheMissing += sheetTotals.formulaCacheMissing;
  }
  return totals;
}

// The selected sheets' entries with the workbook's formula totals: an unpaged
// read counts the cells it returned, a paged one counts the whole workbook.
async function snapshotSelectedSheets(zip, selectedSheets, context) {
  const output = [];
  const totals = { formulaCount: 0, formulaCacheMissing: 0 };
  let page = null;
  for (const sheet of selectedSheets) {
    const { entry, cellResult, cells } = await snapshotWorksheet(zip, sheet, context);
    if (context.paged) page = cellResult;
    else {
      totals.formulaCount += cells.filter((cell) => cell.formula).length;
      totals.formulaCacheMissing += cells.filter((cell) => cell.formula && cell.cacheState === 'missing').length;
    }
    output.push(entry);
  }
  if (context.paged) {
    const workbook = await workbookFormulaTotals(zip, context.sheets);
    totals.formulaCount += workbook.formulaCount;
    totals.formulaCacheMissing += workbook.formulaCacheMissing;
  }
  return { output, page, ...totals };
}

export async function snapshotXlsx(zip, options = {}) {
  const sheets = await workbookSheets(zip);
  const strings = await sharedStrings(zip);
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const workbookXml = await zipText(zip, 'xl/workbook.xml');
  const calculation = workbookCalculation(workbookXml);
  const definedNames = workbookDefinedNames(workbookXml);
  const paged = options.paged === true;
  const cellLimit = xlsxCellLimit(options);
  const sheetOffset = Math.max(0, Math.min(sheets.length - 1, Number(options.sheetOffset) || 0));
  const selectedSheets = selectXlsxSheets(sheets, options, paged, sheetOffset);
  const { output, page, formulaCount, formulaCacheMissing } = await snapshotSelectedSheets(zip, selectedSheets, {
    strings,
    styles,
    definedNames,
    sheets,
    options,
    paged,
    cellLimit,
  });
  const cellPagination = paged ? populatedCellPagination({ options, page, selectedSheets, sheets, sheetOffset }) : null;
  return {
    format: 'xlsx',
    sheetCount: sheets.length,
    // Which sheets the workbook holds, whichever one this page carries: a
    // paged read otherwise hides every sheet but the one it returned.
    ...(paged ? { sheetNames: sheets.map((sheet) => sheet.name) } : {}),
    sheets: output,
    // The workbook default (cellXfs 0): what every unstyled cell renders with.
    defaultStyle: styles[0] || null,
    formulaCount,
    formulaCacheMissing,
    needsRecalculation: formulaCacheMissing > 0,
    calculation,
    definedNameCount: definedNames.length,
    definedNames,
    ...(paged ? { pagination: cellPagination } : {}),
  };
}
