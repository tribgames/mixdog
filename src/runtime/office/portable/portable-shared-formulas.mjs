// Excel stores a filled-down column once: the first cell holds the formula and
// a shared id, every cell under it holds the id alone. Taken as written, those
// cells carry no formula at all — so a snapshot shows pasted numbers, the model
// audit reports hardcodes where the workbook holds a calculation, and a
// recalculation leaves the column empty without reporting anything missing.
// Every reader therefore goes through here first.
import { columnLabel, columnNumber, iterateSheetCells, parseCellRef } from './portable-cells.mjs';
import { xmlDecode } from './portable-xml.mjs';
import { UnsupportedFormula, translateSharedFormula } from './xlsx-formula-engine.mjs';

// A block wider than this is a range the file declares rather than a formula a
// reader will look at, and walking it cell by cell costs more than it tells.
const MAX_BLOCK_CELLS = 20_000;
const STORED_ONCE = /<f\b[^>]*\bt="(?:shared|array)"/;

/**
 * Gives each cell a stored-once formula covers the formula it holds: a shared
 * follower gets it seen from where the cell sits, a cell inside an array block
 * gets the block's own formula, which is what Excel shows there. Returns the
 * cells that could not be written, with the reason; records are patched in place.
 */
export function expandSharedFormulas(xml, records) {
  // Most sheets store every formula in its own cell, and walking them again to
  // learn that costs as much as reading them did.
  if (!STORED_ONCE.test(xml)) return [];
  const byRef = new Map(records.map((record) => [record.ref, record]));
  const masters = new Map();
  const followers = [];
  const arrays = [];
  const failures = [];
  for (const cell of iterateSheetCells(xml)) {
    const element = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(cell.body);
    const attributes = element?.[1] || '';
    if (!element) continue;
    const text = xmlDecode((element[2] || '').trim());
    // An array formula is written in the first cell of the block it fills and
    // nowhere else, though Excel shows the same formula in every cell of it.
    if (/\bt="array"/.test(attributes) && text) {
      const range = /\bref="([^"]+)"/.exec(attributes)?.[1];
      if (range?.includes(':')) arrays.push({ formula: text, range });
      continue;
    }
    if (!/\bt="shared"/.test(attributes)) continue;
    const id = /\bsi="([^"]+)"/.exec(attributes)?.[1];
    if (id === undefined) continue;
    if (text) masters.set(id, { formula: text, at: parseCellRef(cell.ref) });
    else followers.push({ ref: cell.ref, id });
  }
  for (const array of arrays) {
    const [start, end] = array.range.split(':').map((part) => parseCellRef(part.replaceAll('$', '')));
    if (!start || !end) continue;
    const firstRow = Math.min(start.row, end.row);
    const lastRow = Math.max(start.row, end.row);
    const firstColumn = Math.min(columnNumber(start.col), columnNumber(end.col));
    const lastColumn = Math.max(columnNumber(start.col), columnNumber(end.col));
    if ((lastRow - firstRow + 1) * (lastColumn - firstColumn + 1) > MAX_BLOCK_CELLS) continue;
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const record = byRef.get(`${columnLabel(column)}${row}`);
        if (record && !record.formula) record.formula = array.formula;
      }
    }
  }
  for (const follower of followers) {
    const master = masters.get(follower.id);
    const record = byRef.get(follower.ref);
    const at = parseCellRef(follower.ref);
    if (!master?.at || !record || record.formula || !at) continue;
    try {
      record.formula = translateSharedFormula(
        master.formula,
        at.row - master.at.row,
        columnNumber(at.col) - columnNumber(master.at.col)
      );
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      failures.push({ ref: follower.ref, reason: error.reason });
    }
  }
  return failures;
}
