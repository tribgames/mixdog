// Shared reading helpers for the XLSX audits: how a snapshot cell is located,
// read as a number or a boolean, recognised as a marked input or a table
// record, and how findings are collected under a per-code cap. Both backends
// produce the cell shape these read ({ ref, path?, value, formula?,
// cachedValue?, style?, note?, dataType? }).
import { columnNumber, parseCellRef } from './portable-cells.mjs';
import { parseAreaRange } from './portable-sheet-xml.mjs';

export const MAX_ISSUES_PER_CODE = 100;

// The General format under any Excel UI language (Korean G/표준, Japanese
// G/標準, German Standard): a number that carries no format at all.
export const GENERAL_FORMAT = /^(?:general|g\/표준|g\/標準|standard|standaard|général|generale|estándar|padrão|общий|常规|通用格式)?$/i;

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sheetPath(sheet) {
  return sheet.path || `/sheet[${sheet.name || ''}]`;
}

export function cellPath(sheet, cell) {
  return cell.path || `${sheetPath(sheet)}/cell[${cell.ref || ''}]`;
}

// String literals never carry references or operators; blank them so a
// quoted "Sheet Name!" or "1.05" cannot masquerade as one.
export function stripFormulaStrings(formula) {
  return String(formula || '').replace(/"(?:[^"]|"")*"/g, '""');
}

export function formulaBody(formula) {
  return stripFormulaStrings(formula).replace(/^=/, '');
}

export function numericValue(cell) {
  const value = cell.formula ? (cell.cachedValue ?? cell.value) : cell.value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) return Number(value);
  return null;
}

export function isNumericCell(cell) {
  return numericValue(cell) !== null;
}

export function falseValue(cell) {
  const value = cell.formula ? (cell.cachedValue ?? cell.value) : cell.value;
  return value === false || (typeof value === 'string' && value.trim().toUpperCase() === 'FALSE');
}

export function position(cell) {
  try {
    const parsed = parseCellRef(cell.ref);
    return { row: parsed.row, column: columnNumber(parsed.col) };
  } catch {
    return null;
  }
}

// Cells with a resolvable A1 reference, each paired with its coordinates.
export function locate(cells) {
  return cells.map((cell) => ({ cell, at: position(cell) })).filter((entry) => entry.at);
}

export function generalFormat(style) {
  return GENERAL_FORMAT.test(String(style?.numberFormat || '').trim());
}

// COM reports colors as BGR integers (black 0, no fill 16777215); the portable
// snapshot reports RRGGBB hex and omits the default. Both read as "marked"
// when the cell carries a non-default font color or a fill.
export function isMarkedInputStyle(style) {
  if (!style || typeof style !== 'object') return false;
  const color = style.color;
  const fill = style.fillColor;
  const coloredFont = typeof color === 'number'
    ? color !== 0
    : Boolean(color) && !/^(?:FF)?000000$/i.test(String(color));
  const filled = typeof fill === 'number'
    ? fill !== 16777215
    : Boolean(fill) && !/^(?:FF)?FFFFFF$/i.test(String(fill));
  return coloredFont || filled;
}

// The Excel tables a sheet lists (both readers: `tables` [{ range }]), as
// areas; the body rows are records the table sources, not assumptions.
export function tableAreas(sheet) {
  const areas = [];
  for (const table of sheet?.tables || []) {
    try {
      const area = parseAreaRange(String(table?.range || '').replace(/\$/g, ''));
      if (area.startRow && area.startCol) areas.push({ ...area, table });
    } catch {
      // A malformed range excludes nothing.
    }
  }
  return areas;
}

export function insideTableBody(areas, at) {
  return areas.some((area) => at.row > area.startRow && at.row <= area.endRow
    && at.column >= area.startCol && at.column <= area.endCol);
}

// Notes reach the audit two ways: a portable cell carries `note`, an Excel
// sheet lists `notes` [{ cell, text }]. Either documents the cell.
export function notedRefs(sheet, cells) {
  const refs = new Set();
  for (const cell of cells) if (cell.note) refs.add(String(cell.ref).toUpperCase());
  for (const note of sheet?.notes || []) if (note?.cell) refs.add(String(note.cell).replace(/\$/g, '').toUpperCase());
  return refs;
}

export class IssueList {
  constructor() {
    this.issues = [];
    this.counts = new Map();
    this.omitted = 0;
  }

  push(severity, code, path, message) {
    const count = this.counts.get(code) || 0;
    if (count >= MAX_ISSUES_PER_CODE) {
      this.omitted += 1;
      return;
    }
    this.counts.set(code, count + 1);
    this.issues.push({ severity, code, path, message });
  }
}
