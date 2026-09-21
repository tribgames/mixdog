// Recalculation for the portable backend. LibreOffice is the reference
// implementation and is asked first; the in-process engine answers only on a
// machine that has none, and only for the formulas it can read. A cell it
// cannot evaluate keeps whatever the file already held, and the result names it.
import { extname } from 'node:path';
import { cellRecords, columnNumber, parseCellRef, sharedStrings, workbookSheets } from './portable-cells.mjs';
import { expandSharedFormulas } from './portable-shared-formulas.mjs';
import { loadPackage, savePackage, zipText } from './portable-opc.mjs';
import { libreOfficeAvailable, recalculateLibreOfficeWorkbook } from './portable-soffice.mjs';
import { xmlDecode, xmlEncode } from './portable-xml.mjs';
import { UnsupportedFormula, evaluateFormula, isBlank, isFormulaError } from './xlsx-formula-engine.mjs';

const MAX_ENGINE_FORMULAS = 20_000;
// Each cell a formula waits on is another frame on the stack, and a column that
// points at the cell below it stacks one frame per row. Past a depth this deep
// the process would die of a stack overflow — which is machine-dependent, so
// the engine stops at a fixed depth and says so instead.
const MAX_CHAIN_DEPTH = 500;
// The same ceiling the LibreOffice summary reports under, so a caller reads one
// contract whichever backend answered.
const MAX_REPORTED_CELLS = 100;

// How Excel stores a computed result: the cell keeps its formula and carries the
// value beside it, typed the way the reader expects it back.
function cachedCell(value) {
  if (isFormulaError(value)) return { type: 'e', text: xmlEncode(value) };
  if (typeof value === 'boolean') return { type: 'b', text: value ? '1' : '0' };
  if (typeof value === 'number') return { type: '', text: String(value) };
  if (isBlank(value)) return { type: 'str', text: '' };
  return { type: 'str', text: xmlEncode(String(value)) };
}

function writeCachedValues(xml, values) {
  return xml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (whole, attributes, body) => {
    const ref = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
    if (!ref || !values.has(ref)) return whole;
    // Only the first cell of an array block holds the formula; the rest of the
    // block carries the value alone, which is how Excel writes them too.
    const formula = /<f(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/f>)/.exec(body || '')?.[0] || '';
    const { type, text } = cachedCell(values.get(ref));
    const kept = attributes.replace(/\st="[^"]*"/g, '').replace(/\s*\/$/, '');
    return `<c${kept}${type ? ` t="${type}"` : ''}>${formula}<v>${text}</v></c>`;
  });
}

// A name the workbook defines as one cell, one range or a plain constant is
// that value under another word, and a model reads better for it. Anything else
// a name can hold — a formula, a name that means something different on each
// sheet, a print area — is left undefined, so the formulas using it are refused
// rather than read wrongly. None of these can name another name, so a
// definition never chases its own tail.
const DEFINED_NAME_TARGET =
  /^(?:(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"[^"]*")$/;

function workbookDefinedNames(xml) {
  const names = new Map();
  for (const match of String(xml || '').matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const attributes = match[1] || '';
    if (/\blocalSheetId=/.test(attributes)) continue;
    const name = /\bname="([^"]+)"/.exec(attributes)?.[1];
    if (!name || name.startsWith('_xlnm.')) continue;
    const target = xmlDecode(match[2].trim());
    if (!DEFINED_NAME_TARGET.test(target)) continue;
    names.set(name.toUpperCase(), target);
  }
  return names;
}

// The workbook's cells by sheet, plus the per-sheet parts the engine writes
// back to, and the formula count that gates the engine.
async function loadWorkbookGrid(zip) {
  const strings = await sharedStrings(zip);
  const parts = [];
  const grid = new Map();
  let formulaCount = 0;
  for (const sheet of await workbookSheets(zip)) {
    const xml = await zipText(zip, sheet.path);
    const records = cellRecords(xml, strings);
    const sharedFailures = expandSharedFormulas(xml, records);
    grid.set(sheet.name.toLowerCase(), new Map(records.map((record) => [record.ref, record])));
    parts.push({ sheet, xml, records, sharedFailures });
    for (const record of records) if (record.formula) formulaCount += 1;
  }
  return { parts, grid, formulaCount };
}

// A memoized cell evaluator over the grid: literals answer directly,
// formulas evaluate through their dependencies, with circular references and
// over-deep chains refused as UnsupportedFormula.
function createCellEvaluator(grid, definedNames) {
  // How far a sheet's own cells reach, which is what bounds SUM(A:A).
  const extents = new Map();
  const sheetExtent = (sheetName) => {
    const key = sheetName.toLowerCase();
    if (extents.has(key)) return extents.get(key);
    const records = grid.get(key);
    if (!records) return null;
    let rows = 0;
    let columns = 0;
    for (const ref of records.keys()) {
      const position = parseCellRef(ref);
      if (!position) continue;
      rows = Math.max(rows, position.row);
      columns = Math.max(columns, columnNumber(position.col));
    }
    const extent = { rows, columns };
    extents.set(key, extent);
    return extent;
  };
  const computed = new Map();
  const active = new Set();
  const cellValue = (sheetName, ref) => {
    const key = `${sheetName.toLowerCase()}!${ref}`;
    if (computed.has(key)) return computed.get(key);
    const records = grid.get(sheetName.toLowerCase());
    if (!records) throw new UnsupportedFormula(`sheet "${sheetName}" is not in this workbook`);
    const record = records.get(ref);
    if (!record) return '';
    if (!record.formula) {
      const literal = record.value ?? '';
      computed.set(key, literal);
      return literal;
    }
    // A formula that reaches itself has no value to give; Excel reports the
    // same condition rather than settling on a number.
    if (active.has(key)) throw new UnsupportedFormula('a circular reference');
    // The cells being waited on are exactly the frames this evaluation holds.
    if (active.size >= MAX_CHAIN_DEPTH) {
      const tooDeep = new UnsupportedFormula(`a dependency chain deeper than ${MAX_CHAIN_DEPTH} cells`);
      // Depth is about the order this sheet is read in, not about the formula:
      // the same cell answers immediately once the ones it waits on are cached.
      tooDeep.deferrable = true;
      throw tooDeep;
    }
    active.add(key);
    try {
      const value = evaluateFormula(record.formula, {
        sheet: sheetName,
        value: cellValue,
        extent: sheetExtent,
        definedName: (name) => definedNames.get(name.toUpperCase()) || '',
      });
      computed.set(key, value);
      return value;
    } finally {
      active.delete(key);
    }
  };
  return cellValue;
}

// Evaluates one sheet's formulas into `values`, recording refusals and error
// results on the tally. A column that adds up the row above it resolves as
// the sheet is read. One written the other way round waits on a cell further
// down for every row, and reading top-down would refuse each of them in turn.
// So the first refusal for depth turns the rest of the sheet around: read
// from the bottom, every cell finds what it waits on already computed.
function evaluateSheetFormulas(part, cellValue, tally) {
  const values = new Map();
  const sheetName = part.sheet.name;
  for (const failure of part.sharedFailures) {
    tally.unevaluated.push({ at: `${sheetName}!${failure.ref}`, reason: failure.reason });
  }
  const attempt = (record) => {
    try {
      const value = cellValue(sheetName, record.ref);
      values.set(record.ref, value);
      tally.evaluated += 1;
      if (isFormulaError(value)) tally.errorCells.push({ value, at: `${sheetName}!${record.ref}` });
      return null;
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      return error;
    }
  };
  const refuse = (record, error) => tally.unevaluated.push({ at: `${sheetName}!${record.ref}`, reason: error.reason });
  const formulas = part.records.filter((record) => record.formula);
  let turned = null;
  for (const [index, record] of formulas.entries()) {
    const failure = attempt(record);
    if (!failure) continue;
    if (failure.deferrable) {
      turned = formulas.slice(index).reverse();
      break;
    }
    refuse(record, failure);
  }
  for (const record of turned || []) {
    const failure = attempt(record);
    if (failure) refuse(record, failure);
  }
  return values;
}

function errorSummary(errorCells) {
  const byType = {};
  for (const entry of errorCells) {
    byType[entry.value] ||= { count: 0, cells: [] };
    const bucket = byType[entry.value];
    bucket.count += 1;
    if (bucket.cells.length < MAX_REPORTED_CELLS) bucket.cells.push(entry.at);
    else bucket.truncated = (bucket.truncated || 0) + 1;
  }
  return byType;
}

/** Evaluates the workbook's formulas in this process and writes the values it reached. */
export async function recalculateWithFormulaEngine(path) {
  const zip = await loadPackage(path);
  if (Object.keys(zip.files).some((entry) => /^xl\/externalLinks\//i.test(entry))) {
    return { recalculated: false, reason: 'The workbook reads another workbook, which this engine cannot open.' };
  }
  const { parts, grid, formulaCount } = await loadWorkbookGrid(zip);
  if (!formulaCount) return { recalculated: false, reason: 'The workbook has no formulas.' };
  if (formulaCount > MAX_ENGINE_FORMULAS) {
    return {
      recalculated: false,
      reason: `The workbook carries ${formulaCount} formulas, more than the ${MAX_ENGINE_FORMULAS} this engine evaluates; install LibreOffice to recalculate it.`,
    };
  }
  const definedNames = workbookDefinedNames(await zipText(zip, 'xl/workbook.xml'));
  const cellValue = createCellEvaluator(grid, definedNames);
  const tally = { unevaluated: [], errorCells: [], evaluated: 0 };
  for (const part of parts) {
    const values = evaluateSheetFormulas(part, cellValue, tally);
    if (values.size) zip.file(part.sheet.path, writeCachedValues(part.xml, values));
  }
  const { unevaluated, errorCells, evaluated } = tally;
  if (!evaluated) {
    return {
      recalculated: false,
      reason: `No formula in this workbook could be evaluated (${unevaluated[0]?.reason || 'unknown reason'}).`,
    };
  }
  await savePackage(zip, path);
  const byType = errorSummary(errorCells);
  // A clean status proves the formulas evaluate, not that they are right.
  let status = 'success';
  if (errorCells.length) status = 'errors_found';
  else if (unevaluated.length) status = 'partial';
  return {
    recalculated: true,
    backend: 'mixdog-formula',
    status,
    formulaCount,
    evaluated,
    totalErrors: errorCells.length,
    errorSummary: byType,
    ...(unevaluated.length
      ? {
          unevaluatedCount: unevaluated.length,
          unevaluated: unevaluated.slice(0, MAX_REPORTED_CELLS).map((entry) => `${entry.at}: ${entry.reason}`),
        }
      : {}),
  };
}

/**
 * Recalculates a portable workbook: LibreOffice when it is installed, the
 * in-process engine when it is not.
 */
export async function recalculatePortableWorkbook(path, options = {}) {
  const libreOffice = await recalculateLibreOfficeWorkbook(path, options);
  if (!libreOffice.needed || libreOffice.recalculated) return libreOffice;
  // LibreOffice answered and failed for its own reason; that answer stands.
  if (await libreOfficeAvailable()) return libreOffice;
  if (extname(path).toLowerCase() !== '.xlsx') return libreOffice;
  const engine = await recalculateWithFormulaEngine(path);
  if (!engine.recalculated) {
    return { ...libreOffice, reason: `${libreOffice.reason} ${engine.reason}`.trim() };
  }
  return {
    needed: true,
    available: true,
    missingCachedValues: libreOffice.missingCachedValues,
    ...engine,
  };
}
