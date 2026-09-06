// Workbook hygiene every profile checks — an unquoted sheet name, a link to
// another workbook, a percentage stored as a whole number, a year under a
// thousands separator, a figure stored as text — and the reading ergonomics
// reported as information: a long sheet whose header scrolls away, a table
// column of numbers left under the General format.
import { columnLabel } from './portable-cells.mjs';
import { cellPath, escapeRegExp, formulaBody, generalFormat, locate, numericValue, sheetPath, tableAreas } from './xlsx-audit-support.mjs';

const LONG_SHEET_ROWS = 20;
const NUMERIC_COLUMN_MIN = 3;
const SHEET_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function externalLinkReference(formula) {
  return /\[\d+\]|\[[^\]]*\.xls[xmb]?\]/i.test(formulaBody(formula));
}

export function unquotedSheetReferences(formula, sheetNames = []) {
  const text = formulaBody(formula);
  return (sheetNames || [])
    .map((name) => String(name || ''))
    .filter((name) => name && !SHEET_IDENTIFIER.test(name))
    .filter((name) => new RegExp(`(?:^|[^'A-Za-z0-9_.\\]])${escapeRegExp(name)}!`).test(text));
}

function formatCode(style) {
  return String(style?.numberFormat || '').replace(/"[^"]*"/g, '').replace(/\\./g, '');
}

function percentFormat(style) {
  return formatCode(style).includes('%');
}

function thousandsFormat(style) {
  return /#,#|0,0/.test(formatCode(style));
}

// Text that reads as a number: a thousands-grouped or plain figure, with or
// without a percent sign. A four-digit year is text on purpose.
function numericText(cell) {
  if (cell.dataType !== 'text' || typeof cell.value !== 'string') return false;
  const text = cell.value.trim();
  if (!/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*%?$/.test(text)) return false;
  return !/^(?:19|20)\d{2}$/.test(text);
}

function yearLike(values) {
  return values.every((value) => Number.isInteger(value) && value >= 1900 && value <= 2100);
}

export function auditSheetHygiene(list, sheet, cells, sheetNames) {
  for (const cell of cells) {
    const path = cellPath(sheet, cell);
    if (numericText(cell)) {
      list.push('warning', 'number_stored_as_text', path, `"${cell.value.trim()}" is text, so it neither sums nor sorts as a number; store the number and give the column a format.`);
      continue;
    }
    if (cell.formula) {
      for (const name of unquotedSheetReferences(cell.formula, sheetNames)) {
        list.push('warning', 'unquoted_sheet_reference', path, `Formula references sheet "${name}" without quotes; Excel evaluates it as #VALUE! or #NAME?. Write '${name}'!.`);
      }
      if (externalLinkReference(cell.formula)) {
        list.push('warning', 'external_link_reference', path, 'Formula links to another workbook; only its cached value is available here, and recalculation would replace the link with #NAME?. Copy the value into a sourced input cell instead.');
      }
      continue;
    }
    const value = numericValue(cell);
    if (value === null) continue;
    if (percentFormat(cell.style) && Math.abs(value) >= 10) {
      list.push('warning', 'percentage_stored_as_whole', path, `Cell shows ${value}% × 100: a percentage is stored as a fraction (0.15 renders 15.0%), so ${value} renders ${value * 100}%.`);
    }
    if (thousandsFormat(cell.style) && Number.isInteger(value) && value >= 1900 && value <= 2100) {
      list.push('warning', 'year_with_thousands_separator', path, `Year ${value} renders as ${value.toLocaleString('en-US')} under a thousands-separator format; store years as text or format them 0.`);
    }
  }
}

export function auditSheetLayout(list, sheet, cells) {
  const located = locate(cells);
  if (!located.length) return;
  const freeze = sheet.freezePanes;
  if (freeze && typeof freeze === 'object' && freeze.frozen === false) {
    const lastRow = Math.max(...located.map((entry) => entry.at.row));
    const headerRow = Math.min(...located.map((entry) => entry.at.row));
    const headers = located.filter((entry) => entry.at.row === headerRow && entry.cell.dataType === 'text');
    if (lastRow - headerRow >= LONG_SHEET_ROWS && headers.length >= 2) {
      list.push('info', 'header_not_frozen', sheetPath(sheet), `${lastRow - headerRow} rows scroll under an unfrozen header row; freeze_panes row:${headerRow + 1} keeps the headers in view.`);
    }
  }
  tableAreas(sheet).forEach((area, index) => {
    for (let column = area.startCol; column <= area.endCol; column += 1) {
      const body = located.filter((entry) => entry.at.column === column
        && entry.at.row > area.startRow && entry.at.row <= area.endRow);
      const numbers = body.filter((entry) => entry.cell.dataType !== 'text' && numericValue(entry.cell) !== null);
      if (numbers.length < NUMERIC_COLUMN_MIN || numbers.length < body.length) continue;
      if (!numbers.every((entry) => generalFormat(entry.cell.style))) continue;
      if (yearLike(numbers.map((entry) => numericValue(entry.cell)))) continue;
      list.push('info', 'numeric_column_unformatted', area.table.path || `${sheetPath(sheet)}/table[${index + 1}]`, `Column ${columnLabel(column)} of ${area.table.name || 'the table'} holds numbers under the General format; an explicit format (#,##0, 0.0%, yyyy-mm-dd) aligns the figures and names their unit.`);
    }
  });
}
