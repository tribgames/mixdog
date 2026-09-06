// Backend-neutral formula audit over snapshot sheets. A sheet is
// { name, path?, cells: [...], tables?, notes?, freezePanes? }; the COM and
// portable snapshots both produce this shape, so one audit serves both
// backends and the qa/finalize review. Findings use the office issue shape
// ({ severity, code, path, message }); the caller adds its source.
//
// Two tiers: the workbook hygiene of xlsx-sheet-hygiene.mjs runs for every
// profile; the modelling discipline here (inline constants, unguarded
// division, a lone formula that breaks a row pattern, a reference past the
// data, hardcodes inside formula rows, unsourced inputs, failed checks,
// unmarked inputs) runs under auditProfile 'financial-model'.
import { columnNumber } from './portable-cells.mjs';
import {
  IssueList,
  MAX_ISSUES_PER_CODE,
  cellPath,
  falseValue,
  formulaBody,
  insideTableBody,
  isMarkedInputStyle,
  notedRefs,
  numericValue,
  position,
  sheetPath,
  tableAreas,
} from './xlsx-audit-support.mjs';
import { auditSheetHygiene, auditSheetLayout } from './xlsx-sheet-hygiene.mjs';

// Unit and calendar constants belong in a formula; a rate or a factor does not.
const UNIT_LITERALS = new Set([0, 1, 2, 7, 10, 12, 24, 52, 60, 100, 365, 1000, 10000, 100000, 1000000]);

// A formula expressed relative to its own cell (R1C1), so the same pattern
// copied across a row or down a column yields the same signature.
export function relativeFormulaSignature(formula, ref) {
  const origin = position({ ref });
  return formulaBody(formula)
    .replace(/\s+/g, '')
    .replace(
      /(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![A-Za-z0-9_(])/gi,
      (_all, absoluteColumn, label, absoluteRow, row) => {
        if (!origin) return '#REF';
        const column = columnNumber(label.toUpperCase());
        const rowNumber = Number(row);
        return `${absoluteRow ? `R${rowNumber}` : `R[${rowNumber - origin.row}]`}`
          + `${absoluteColumn ? `C${column}` : `C[${column - origin.column}]`}`;
      },
    )
    .toUpperCase();
}

// Numeric literals that scale or shift a value: `*1.05`, `/1.1`, `^2`, `(1+0.05)`.
// A function argument (`ROUND(x, 2)`) is not adjacent to an operator and is
// never reported; unit constants are exempt.
export function inlineConstants(formula) {
  const text = formulaBody(formula);
  const found = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.$])(\d+(?:\.\d+)?)(?![A-Za-z0-9_(])/g)) {
    const literal = Number(match[1]);
    if (UNIT_LITERALS.has(literal)) continue;
    const before = text.slice(0, match.index).replace(/\s+$/, '').at(-1) || '';
    const after = text.slice(match.index + match[1].length).replace(/^\s+/, '')[0] || '';
    const scaling = /[*/^]/.test(before) || /[*/^]/.test(after);
    const fractionalShift = match[1].includes('.') && (/[+-]/.test(before) || /[+-]/.test(after));
    if (scaling || fractionalShift) found.push(match[1]);
  }
  return found;
}

// A divisor that is a reference, a name, a function, or a bracketed expression
// can be zero; a literal cannot. Any IF-family wrapper counts as a guard.
export function unguardedDivision(formula) {
  const text = formulaBody(formula);
  if (/(?<![A-Za-z0-9_.])(?:IFERROR|IFNA|IF|IFS)\s*\(/i.test(text)) return false;
  return /\/\s*(?:\(|[A-Za-z_$'])/.test(text);
}

// Single same-sheet references in a formula: not a range end, not another
// sheet's cell. An open-ended SUM(B2:B100) is a habit; `=B31` on a 30-row
// sheet is the off-by-one that recalculates cleanly and reads wrong.
export function singleCellReferences(formula) {
  const text = formulaBody(formula);
  const found = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.!':$\]])\$?([A-Z]{1,3})\$?([1-9]\d*)(?![A-Za-z0-9_(:])/gi)) {
    found.push({ ref: `${match[1].toUpperCase()}${match[2]}`, column: columnNumber(match[1].toUpperCase()), row: Number(match[2]) });
  }
  return found;
}

function auditLine(list, sheet, cells, axis) {
  // cells: formula cells on one row (axis 'row') or one column (axis 'column'),
  // each { cell, index, signature }, sorted by index.
  if (cells.length < 4) return;
  const tally = new Map();
  for (const entry of cells) tally.set(entry.signature, (tally.get(entry.signature) || 0) + 1);
  let dominant = '';
  let dominantCount = 0;
  for (const [signature, count] of tally) {
    if (count > dominantCount) {
      dominant = signature;
      dominantCount = count;
    }
  }
  if (dominantCount < 3 || dominantCount / cells.length < 0.75) return;
  const positions = cells.filter((entry) => entry.signature === dominant).map((entry) => entry.index);
  const first = Math.min(...positions);
  const last = Math.max(...positions);
  for (const entry of cells) {
    if (entry.signature === dominant || entry.index <= first || entry.index >= last) continue;
    list.push(
      'warning',
      'formula_pattern_inconsistency',
      cellPath(sheet, entry.cell),
      `Formula breaks the pattern its neighbours share along the ${axis}; a lone edited cell mid-line is the commonest silent model error.`,
    );
  }
}

function auditModelDiscipline(list, sheet, cells) {
  const byRow = new Map();
  const byColumn = new Map();
  const formulaRows = new Map();
  const formulaColumnSet = new Set();
  const noted = notedRefs(sheet, cells);
  const bodies = tableAreas(sheet);
  const checksSheet = String(sheet.name || '').trim().toLowerCase() === 'checks';
  const extent = { row: 0, column: 0, firstRow: Number.POSITIVE_INFINITY };
  for (const cell of cells) {
    const at = position(cell);
    if (!at) continue;
    extent.row = Math.max(extent.row, at.row);
    extent.column = Math.max(extent.column, at.column);
    extent.firstRow = Math.min(extent.firstRow, at.row);
  }
  let formulaCount = 0;
  let hardcodes = 0;
  let markedHardcodes = 0;
  let styledCells = 0;
  for (const cell of cells) {
    const at = position(cell);
    if (!at) continue;
    if (cell.style && typeof cell.style === 'object') styledCells += 1;
    if (cell.formula) {
      const beyond = singleCellReferences(cell.formula)
        .filter((reference) => reference.row > extent.row || reference.column > extent.column)
        .map((reference) => reference.ref);
      if (beyond.length) {
        list.push('warning', 'formula_reads_beyond_data', cellPath(sheet, cell), `Formula reads ${[...new Set(beyond)].join(', ')}, past the last populated row or column of the sheet; a reference one row or column off recalculates cleanly and shows the wrong number.`);
      }
      formulaCount += 1;
      formulaColumnSet.add(at.column);
      const signature = relativeFormulaSignature(cell.formula, cell.ref);
      if (!byRow.has(at.row)) byRow.set(at.row, []);
      byRow.get(at.row).push({ cell, index: at.column, signature });
      if (!byColumn.has(at.column)) byColumn.set(at.column, []);
      byColumn.get(at.column).push({ cell, index: at.row, signature });
      if (!formulaRows.has(at.row)) formulaRows.set(at.row, []);
      formulaRows.get(at.row).push(at.column);
      const path = cellPath(sheet, cell);
      const constants = inlineConstants(cell.formula);
      if (constants.length) {
        list.push('warning', 'inline_constant_in_formula', path, `Formula embeds ${constants.join(', ')}; put each assumption in its own labelled cell and reference it (=B5*(1+$B$6), never =B5*1.05).`);
      }
      if (unguardedDivision(cell.formula)) {
        list.push('warning', 'unguarded_division', path, 'Formula divides by a cell that can be zero; wrap it in IFERROR or guard the denominator with IF.');
      }
      if (checksSheet && falseValue(cell)) {
        list.push('warning', 'failed_check', path, 'Tie-out on the Checks sheet evaluates to FALSE; the model does not add up until it reads TRUE.');
      }
    } else if (numericValue(cell) !== null) {
      hardcodes += 1;
      if (isMarkedInputStyle(cell.style)) markedHardcodes += 1;
    }
  }
  for (const cell of cells) {
    const value = numericValue(cell);
    if (cell.formula || value === null) continue;
    const at = position(cell);
    if (!at) continue;
    const path = cellPath(sheet, cell);
    // An input a formula reads — marked as one, or sharing a row or column
    // with formulas — says where its number came from; raw data does not,
    // and a year across the first populated row is a column heading.
    const feedsModel = formulaCount > 0 && (
      isMarkedInputStyle(cell.style) || formulaRows.has(at.row) || formulaColumnSet.has(at.column)
    );
    const headerYear = at.row === extent.firstRow && Number.isInteger(value) && value >= 1900 && value <= 2100;
    if (feedsModel && !headerYear && !noted.has(String(cell.ref).toUpperCase()) && !insideTableBody(bodies, at)) {
      list.push('warning', 'hardcode_missing_source', path, 'Hardcoded input has no note naming its source or the assumption behind it; add_provenance or add_note on the cell.');
    }
    const formulaColumns = formulaRows.get(at.row);
    if (!formulaColumns || formulaColumns.length < 2) continue;
    const first = Math.min(...formulaColumns);
    const last = Math.max(...formulaColumns);
    if (at.column > first && at.column < last) {
      list.push('warning', 'formula_inconsistency', path, 'A hardcoded value interrupts a row of formulas; the projection no longer recalculates through this cell.');
    } else if (at.column > last) {
      list.push('warning', 'rogue_hardcode', path, 'Numeric hardcode sits after the formulas of its row; a pasted result where a formula belongs.');
    }
  }
  for (const line of byRow.values()) auditLine(list, sheet, line.sort((a, b) => a.index - b.index), 'row');
  for (const line of byColumn.values()) auditLine(list, sheet, line.sort((a, b) => a.index - b.index), 'column');
  if (styledCells && formulaCount >= 3 && hardcodes >= 5 && markedHardcodes === 0) {
    list.push('info', 'input_cells_unmarked', sheetPath(sheet), `${hardcodes} hardcoded inputs are indistinguishable from formulas; mark inputs (blue font, or a fill for cells the reader edits) and add a legend.`);
  }
}

export function auditXlsxFormulas(sheets, { auditProfile = '', sheetNames = null } = {}) {
  const list = new IssueList();
  const names = Array.isArray(sheetNames) && sheetNames.length
    ? sheetNames
    : (sheets || []).map((sheet) => sheet?.name).filter(Boolean);
  for (const sheet of sheets || []) {
    const cells = Array.isArray(sheet?.cells) ? sheet.cells.filter((cell) => cell && cell.ref) : [];
    if (!cells.length) continue;
    auditSheetHygiene(list, sheet, cells, names);
    auditSheetLayout(list, sheet, cells);
    if (auditProfile === 'financial-model') auditModelDiscipline(list, sheet, cells);
  }
  if (list.omitted > 0) {
    list.issues.push({
      severity: 'info',
      code: 'audit_issues_truncated',
      path: '/',
      message: `${list.omitted} additional formula audit finding(s) were omitted after ${MAX_ISSUES_PER_CODE} per code.`,
    });
  }
  return list.issues;
}

// Folds the shared audit into a backend's own issues result (Excel's issues
// come from its host, which reports a subset of these codes); a finding the
// host already made is not repeated, and a sheet-scoped request stays scoped.
export function mergeXlsxFormulaAudit(result, document, { auditProfile = '', sheet = '' } = {}) {
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  const scope = sheet ? `/sheet[${String(sheet).toLowerCase()}]` : '';
  const findings = auditXlsxFormulas(sheets, { auditProfile, sheetNames: sheets.map((entry) => entry?.name) })
    .filter((finding) => !scope || finding.path === '/' || String(finding.path).toLowerCase().startsWith(scope));
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const seen = new Set(issues.map((entry) => `${entry?.code}|${entry?.path}`));
  const added = findings.filter((finding) => !seen.has(`${finding.code}|${finding.path}`));
  return {
    ...result,
    issues: [...issues, ...added],
    issueCount: issues.length + added.length,
    sharedAudit: { added: added.length, cellsRead: sheets.reduce((total, entry) => total + (entry?.cells?.length || 0), 0) },
  };
}
