// Workbook hygiene every profile checks — an unquoted sheet name, a link to
// another workbook, a percentage stored as a whole number, a year under a
// thousands separator, a figure stored as text — and the reading ergonomics
// reported as information: a long sheet whose header scrolls away, a table
// column of numbers left under the General format.
import { columnLabel } from './portable-cells.mjs';
import {
  cellPath,
  escapeRegExp,
  formulaBody,
  generalFormat,
  insideArea,
  locate,
  mergedAreas,
  numericValue,
  position,
  sheetPath,
  tableAreas,
} from './xlsx-audit-support.mjs';

const LONG_SHEET_ROWS = 20;
const NUMERIC_COLUMN_MIN = 3;
// One column of a table holds one quantity, and its format is what the reader
// compares the rows by: where nearly every row agrees, the odd one out is a
// cell that missed the format, not a decision about that row.
const FORMAT_MAJORITY = 0.75;
// Excel quotes a sheet name in a reference only when it is not a plain
// identifier: a letter or underscore first, then letters, digits, underscores
// and periods. Letters include Hangul and every other script, so `모델!B8`
// evaluates unquoted and reporting it leaves a warning nobody can resolve.
const SHEET_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

function externalLinkReference(formula) {
  return /\[\d+\]|\[[^\]]*\.xls[xmb]?\]/i.test(formulaBody(formula));
}

/** The defined names that refer to another workbook: `=Rate*B2` reads that
 *  file as surely as `=[1]Rates!$A$1*B2` does. */
export function externalDefinedNames(definedNames = []) {
  return (definedNames || [])
    .filter((entry) => entry?.name && externalLinkReference(String(entry.refersTo || '')))
    .map((entry) => String(entry.name));
}

// The first external name a formula reads, as a whole name (not the tail of a
// longer one, a sheet prefix, or a function call).
function externalNameRead(formula, externalNames) {
  if (!externalNames.length) return '';
  const text = formulaBody(formula);
  return (
    externalNames.find((name) =>
      new RegExp(`(?:^|[^\\p{L}\\p{N}_.!'\\]])${escapeRegExp(name)}(?![\\p{L}\\p{N}_.(!])`, 'iu').test(text)
    ) || ''
  );
}

function unquotedSheetReferences(formula, sheetNames = []) {
  const text = formulaBody(formula);
  return (sheetNames || [])
    .map((name) => String(name || ''))
    .filter((name) => name && !SHEET_IDENTIFIER.test(name))
    .filter((name) => new RegExp(`(?:^|[^'A-Za-z0-9_.\\]])${escapeRegExp(name)}!`).test(text));
}

function formatCode(style) {
  return String(style?.numberFormat || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '');
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

function formatKey(style) {
  return generalFormat(style) ? 'General' : String(style?.numberFormat || '').trim();
}

function yearLike(values) {
  return values.every((value) => Number.isInteger(value) && value >= 1900 && value <= 2100);
}

// A quantity that happens to land between 1900 and 2100 is not a year, and a
// column of figures under #,##0 will hold one sooner or later (2,096 건). The
// column tells them apart: the numbers beside it under the same format. Every
// one of them in the year range is a year column; one outside it is a
// quantity column that happens to pass through those four digits.
function numbersByColumnFormat(cells) {
  const byColumnFormat = new Map();
  for (const cell of cells) {
    if (cell.formula) continue;
    const value = numericValue(cell);
    const at = position(cell);
    if (value === null || !at) continue;
    const key = `${at.column}|${formatKey(cell.style)}`;
    if (!byColumnFormat.has(key)) byColumnFormat.set(key, []);
    byColumnFormat.get(key).push(value);
  }
  return byColumnFormat;
}

function auditFormulaHygiene(list, cell, path, sheetNames, externalNames) {
  for (const name of unquotedSheetReferences(cell.formula, sheetNames)) {
    list.push(
      'warning',
      'unquoted_sheet_reference',
      path,
      `Formula references sheet "${name}" without quotes; Excel evaluates it as #VALUE! or #NAME?. Write '${name}'!.`
    );
  }
  if (externalLinkReference(cell.formula)) {
    list.push(
      'warning',
      'external_link_reference',
      path,
      'Formula links to another workbook; only its cached value is available here, and recalculation would replace the link with #NAME?. Copy the value into a sourced input cell instead.'
    );
    return;
  }
  const name = externalNameRead(cell.formula, externalNames);
  if (name) {
    list.push(
      'warning',
      'external_link_reference',
      path,
      `Formula reads ${name}, a defined name that links to another workbook; only its cached value is available here, and recalculation would replace the link with #NAME?. Copy the value into a sourced input cell and point the name or the formula at it.`
    );
  }
}

export function auditSheetHygiene(list, sheet, cells, sheetNames, externalNames = []) {
  const display = mergedAreas(sheet);
  const byColumnFormat = numbersByColumnFormat(cells);
  for (const cell of cells) {
    const path = cellPath(sheet, cell);
    // A figure typed as text in a merged banner or metric tile is the label it
    // was written as; only a grid cell has a column to sum or sort.
    if (numericText(cell) && !(display.length && insideArea(display, position(cell) || { row: 0, column: 0 }))) {
      list.push(
        'warning',
        'number_stored_as_text',
        path,
        `"${cell.value.trim()}" is text, so it neither sums nor sorts as a number; store the number and give the column a format.`
      );
      continue;
    }
    if (cell.formula) {
      auditFormulaHygiene(list, cell, path, sheetNames, externalNames);
      continue;
    }
    const value = numericValue(cell);
    if (value === null) continue;
    if (percentFormat(cell.style) && Math.abs(value) >= 10) {
      list.push(
        'warning',
        'percentage_stored_as_whole',
        path,
        `Cell shows ${value}% × 100: a percentage is stored as a fraction (0.15 renders 15.0%), so ${value} renders ${value * 100}%.`
      );
    }
    if (
      thousandsFormat(cell.style) &&
      Number.isInteger(value) &&
      value >= 1900 &&
      value <= 2100 &&
      yearLike(byColumnFormat.get(`${position(cell)?.column}|${formatKey(cell.style)}`) || [value])
    ) {
      list.push(
        'warning',
        'year_with_thousands_separator',
        path,
        `Year ${value} renders as ${value.toLocaleString('en-US')} under a thousands-separator format; store years as text or format them 0.`
      );
    }
  }
}

// Each all-numeric body column of a table: the ones whose format drifts
// from the column's majority, and the ones left under General.
function tableColumnFormats(located, area) {
  const unformatted = [];
  const drifted = [];
  for (let column = area.startCol; column <= area.endCol; column += 1) {
    const body = located.filter(
      (entry) => entry.at.column === column && entry.at.row > area.startRow && entry.at.row <= area.endRow
    );
    const numbers = body.filter((entry) => entry.cell.dataType !== 'text' && numericValue(entry.cell) !== null);
    if (numbers.length < NUMERIC_COLUMN_MIN || numbers.length < body.length) continue;
    const tally = new Map();
    for (const entry of numbers) {
      const key = formatKey(entry.cell.style);
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    if (tally.size > 1) {
      const [dominant, count] = [...tally].sort((left, right) => right[1] - left[1])[0];
      if (count / numbers.length >= FORMAT_MAJORITY) {
        drifted.push({
          column: columnLabel(column),
          dominant,
          refs: numbers
            .filter((entry) => formatKey(entry.cell.style) !== dominant)
            .map((entry) => String(entry.cell.ref).toUpperCase()),
        });
      }
    }
    if (!numbers.every((entry) => generalFormat(entry.cell.style))) continue;
    if (yearLike(numbers.map((entry) => numericValue(entry.cell)))) continue;
    unformatted.push(columnLabel(column));
  }
  return { unformatted, drifted };
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
      list.push(
        'info',
        'header_not_frozen',
        sheetPath(sheet),
        `${lastRow - headerRow} rows scroll under an unfrozen header row; freeze_panes row:${headerRow + 1} keeps the headers in view.`
      );
    }
  }
  tableAreas(sheet).forEach((area, index) => {
    const { unformatted, drifted } = tableColumnFormats(located, area);
    const tablePath = area.table.path || `${sheetPath(sheet)}/table[${index + 1}]`;
    for (const drift of drifted) {
      list.push(
        'warning',
        'number_format_inconsistent',
        tablePath,
        `Column ${drift.column} of ${area.table.name || 'the table'} carries ${drift.refs.slice(0, 3).join(', ')} under a format its other rows do not use (${drift.dominant}); one column shows one quantity one way, or the same figure reads two ways down the page.`
      );
    }
    // One table, one finding: repeating it per column produced entries a
    // reader cannot tell apart, since they all carry the table's own path.
    if (!unformatted.length) return;
    list.push(
      'info',
      'numeric_column_unformatted',
      area.table.path || `${sheetPath(sheet)}/table[${index + 1}]`,
      `Column${unformatted.length > 1 ? 's' : ''} ${unformatted.join(', ')} of ${area.table.name || 'the table'}` +
        ` hold numbers under the General format; an explicit format (#,##0, 0.0%, yyyy-mm-dd) aligns the figures and names their unit.`
    );
  });
}
