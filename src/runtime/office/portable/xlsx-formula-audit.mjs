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
  hasVisibleStyle,
  insideTableBody,
  isMarkedInputStyle,
  locate,
  notedRefs,
  numericValue,
  position,
  sheetPath,
  tableAreas,
} from './xlsx-audit-support.mjs';
import { auditSheetHygiene, auditSheetLayout, externalDefinedNames } from './xlsx-sheet-hygiene.mjs';

// Cells that sit side by side in the same row are one input line to the reader.
function contiguousRuns(entries) {
  const byRow = new Map();
  for (const entry of entries) {
    if (!byRow.has(entry.row)) byRow.set(entry.row, []);
    byRow.get(entry.row).push(entry);
  }
  const runs = [];
  for (const row of [...byRow.keys()].sort((left, right) => left - right)) {
    let current = [];
    for (const entry of byRow.get(row).sort((left, right) => left.column - right.column)) {
      if (current.length && entry.column !== current[current.length - 1].column + 1) {
        runs.push(current);
        current = [];
      }
      current.push(entry);
    }
    if (current.length) runs.push(current);
  }
  return runs;
}

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
        return (
          `${absoluteRow ? `R${rowNumber}` : `R[${rowNumber - origin.row}]`}` +
          `${absoluteColumn ? `C${column}` : `C[${column - origin.column}]`}`
        );
      }
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
    found.push({
      ref: `${match[1].toUpperCase()}${match[2]}`,
      column: columnNumber(match[1].toUpperCase()),
      row: Number(match[2]),
    });
  }
  return found;
}

// The areas a purely additive formula reads — `SUM(B2:B9)`, `B2+B3`, or the two
// together — and nothing else: a product, a ratio, a name, another sheet, or any
// other function disqualifies the formula, so only a plain total is read as one.
function additiveAreas(formula) {
  const body = formulaBody(formula).replace(/\s+/g, '');
  if (!body) return null;
  const areas = [];
  for (const term of body.split('+')) {
    const summed = /^SUM\(([^()]+)\)$/i.exec(term);
    for (const piece of summed ? summed[1].split(',') : [term]) {
      const span = /^\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(piece);
      const one = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(piece);
      if (span) {
        const columns = [columnNumber(span[1].toUpperCase()), columnNumber(span[3].toUpperCase())];
        const rows = [Number(span[2]), Number(span[4])];
        areas.push({
          startColumn: Math.min(...columns),
          endColumn: Math.max(...columns),
          startRow: Math.min(...rows),
          endRow: Math.max(...rows),
        });
      } else if (one) {
        const column = columnNumber(one[1].toUpperCase());
        const row = Number(one[2]);
        areas.push({ startColumn: column, endColumn: column, startRow: row, endRow: row });
      } else return null;
    }
  }
  return areas.length ? areas : null;
}

const insideArea = (area, at) =>
  at.column >= area.startColumn && at.column <= area.endColumn && at.row >= area.startRow && at.row <= area.endRow;

const coversArea = (outer, inner) =>
  inner.startColumn >= outer.startColumn &&
  inner.endColumn <= outer.endColumn &&
  inner.startRow >= outer.startRow &&
  inner.endRow <= outer.endRow;

const multiCell = (area) => area.startRow !== area.endRow || area.startColumn !== area.endColumn;

// A total that counts a subtotal again: the outer range covers a cell that is
// itself the sum of cells inside that same range, so every value under the
// subtotal lands in the answer twice. The sheet recalculates cleanly and the
// number is wrong by construction, which is why this reads under every profile.
function auditDoubleCounting(list, sheet, cells) {
  const located = locate(cells.filter((cell) => cell.formula));
  const subtotals = new Map();
  for (const entry of located) {
    const terms = additiveAreas(entry.cell.formula);
    if (!terms?.some(multiCell)) continue;
    if (!subtotals.has(entry.at.column)) subtotals.set(entry.at.column, []);
    subtotals.get(entry.at.column).push({ ...entry, terms });
  }
  if (!subtotals.size) return;
  for (const { cell, at } of located) {
    const outer = additiveAreas(cell.formula);
    if (!outer) continue;
    const counted = outer
      .filter(multiCell)
      .flatMap((area) =>
        Array.from({ length: area.endColumn - area.startColumn + 1 }, (_, step) =>
          (subtotals.get(area.startColumn + step) || []).filter(
            (candidate) =>
              candidate.at.row !== at.row &&
              insideArea(area, candidate.at) &&
              candidate.terms.every((term) => coversArea(area, term) && !insideArea(term, candidate.at))
          )
        ).flat()
      );
    if (!counted.length) continue;
    list.push(
      'warning',
      'subtotal_double_counted',
      cellPath(sheet, cell),
      `The total covers ${counted[0].cell.ref}, which is itself the sum of cells inside that same range; every value under that subtotal lands in this total twice. Sum the detail rows only, or leave the subtotal out of the range.`
    );
  }
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
      `Formula breaks the pattern its neighbours share along the ${axis}; a lone edited cell mid-line is the commonest silent model error.`
    );
  }
}

// The last populated row/column and the first populated row of the sheet.
function populatedExtent(cells) {
  const extent = { row: 0, column: 0, firstRow: Number.POSITIVE_INFINITY };
  for (const cell of cells) {
    const at = position(cell);
    if (!at) continue;
    extent.row = Math.max(extent.row, at.row);
    extent.column = Math.max(extent.column, at.column);
    extent.firstRow = Math.min(extent.firstRow, at.row);
  }
  return extent;
}

function pushTo(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

// One formula cell's own findings: reads past the data, embedded
// assumptions, unguarded division, and a failed tie-out on the Checks sheet.
function auditFormulaCell(list, sheet, cell, { extent, checksSheet }) {
  const beyond = singleCellReferences(cell.formula)
    .filter((reference) => reference.row > extent.row || reference.column > extent.column)
    .map((reference) => reference.ref);
  const path = cellPath(sheet, cell);
  if (beyond.length) {
    list.push(
      'warning',
      'formula_reads_beyond_data',
      path,
      `Formula reads ${[...new Set(beyond)].join(', ')}, past the last populated row or column of the sheet; a reference one row or column off recalculates cleanly and shows the wrong number.`
    );
  }
  const constants = inlineConstants(cell.formula);
  if (constants.length) {
    list.push(
      'warning',
      'inline_constant_in_formula',
      path,
      `Formula embeds ${constants.join(', ')}; put each assumption in its own labelled cell and reference it (=B5*(1+$B$6), never =B5*1.05).`
    );
  }
  if (unguardedDivision(cell.formula)) {
    list.push(
      'warning',
      'unguarded_division',
      path,
      'Formula divides by a cell that can be zero; wrap it in IFERROR or guard the denominator with IF.'
    );
  }
  if (checksSheet && falseValue(cell)) {
    list.push(
      'warning',
      'failed_check',
      path,
      'Tie-out on the Checks sheet evaluates to FALSE; the model does not add up until it reads TRUE.'
    );
  }
}

// A hardcode that breaks a formula pattern. Down a column: a schedule whose
// periods run down the page keeps its formulas in one column, and a pasted
// result between them stops recalculating exactly as it does across a row.
// Only a constant the formulas bracket is read this way — a number under the
// last formula is as likely to be the next block of the sheet as a pasted
// total. The column must be a pattern before a cell can break it: the formula
// above and the formula below the constant compute the same thing, one row
// apart, which is a schedule. A column of assumptions — a ratio here, a
// cross-sheet reference there — holds formulas and inputs side by side by
// design.
function auditHardcodeInterruption(list, path, at, { byColumn, formulaRows }) {
  const columnEntries = (byColumn.get(at.column) || []).slice().sort((a, b) => a.index - b.index);
  const above = [...columnEntries].reverse().find((entry) => entry.index < at.row);
  const below = columnEntries.find((entry) => entry.index > at.row);
  if (above && below && above.signature && above.signature === below.signature) {
    list.push(
      'warning',
      'formula_inconsistency',
      path,
      'A hardcoded value interrupts a column of formulas; the schedule no longer recalculates through this cell.'
    );
  }
  const formulaColumns = formulaRows.get(at.row);
  if (!formulaColumns || formulaColumns.length < 2) return;
  const first = Math.min(...formulaColumns);
  const last = Math.max(...formulaColumns);
  if (at.column > first && at.column < last) {
    list.push(
      'warning',
      'formula_inconsistency',
      path,
      'A hardcoded value interrupts a row of formulas; the projection no longer recalculates through this cell.'
    );
  } else if (at.column > last) {
    list.push(
      'warning',
      'rogue_hardcode',
      path,
      'Numeric hardcode sits after the formulas of its row; a pasted result where a formula belongs.'
    );
  }
}

// One input row missing its source is one decision the reader cannot check,
// not four: reported per cell it fills the answer and pushes other findings
// out of the list.
function reportUnsourcedRuns(list, unsourced) {
  for (const run of contiguousRuns(unsourced)) {
    const span = run.length > 1 ? `${run[0].ref}:${run[run.length - 1].ref}` : run[0].ref;
    list.push(
      'warning',
      'hardcode_missing_source',
      run[0].path,
      run.length > 1
        ? `${run.length} hardcoded inputs (${span}) have no note naming their source or the assumption behind them; add_provenance or add_note on the row.`
        : 'Hardcoded input has no note naming its source or the assumption behind it; add_provenance or add_note on the cell.'
    );
  }
}

// Audits every formula cell and groups them by row and column, counting
// the hardcoded numbers beside them.
function collectFormulaLines(list, sheet, cells, { extent, checksSheet }) {
  const lines = {
    byRow: new Map(),
    byColumn: new Map(),
    formulaRows: new Map(),
    formulaColumns: new Set(),
    formulaCount: 0,
    hardcodes: 0,
    markedHardcodes: 0,
    styledCells: 0,
  };
  for (const cell of cells) {
    const at = position(cell);
    if (!at) continue;
    if (hasVisibleStyle(cell.style)) lines.styledCells += 1;
    if (cell.formula) {
      auditFormulaCell(list, sheet, cell, { extent, checksSheet });
      lines.formulaCount += 1;
      lines.formulaColumns.add(at.column);
      const signature = relativeFormulaSignature(cell.formula, cell.ref);
      pushTo(lines.byRow, at.row, { cell, index: at.column, signature });
      pushTo(lines.byColumn, at.column, { cell, index: at.row, signature });
      pushTo(lines.formulaRows, at.row, at.column);
    } else if (numericValue(cell) !== null) {
      lines.hardcodes += 1;
      if (isMarkedInputStyle(cell.style)) lines.markedHardcodes += 1;
    }
  }
  return lines;
}

// An input a formula reads — marked as one, or sharing a row or column
// with formulas — says where its number came from; raw data does not,
// and a year across the first populated row is a column heading.
function auditHardcodes(list, sheet, cells, lines, extent) {
  const noted = notedRefs(sheet, cells);
  const bodies = tableAreas(sheet);
  const unsourced = [];
  for (const cell of cells) {
    const value = numericValue(cell);
    if (cell.formula || value === null) continue;
    const at = position(cell);
    if (!at) continue;
    const path = cellPath(sheet, cell);
    const feedsModel =
      lines.formulaCount > 0 &&
      (isMarkedInputStyle(cell.style) || lines.formulaRows.has(at.row) || lines.formulaColumns.has(at.column));
    const headerYear = at.row === extent.firstRow && Number.isInteger(value) && value >= 1900 && value <= 2100;
    if (feedsModel && !headerYear && !noted.has(String(cell.ref).toUpperCase()) && !insideTableBody(bodies, at)) {
      unsourced.push({ row: at.row, column: at.column, ref: String(cell.ref).toUpperCase(), path });
    }
    auditHardcodeInterruption(list, path, at, { byColumn: lines.byColumn, formulaRows: lines.formulaRows });
  }
  reportUnsourcedRuns(list, unsourced);
}

// The tie-out sheet is named in the reader's language. Matching the English
// convention alone left a Korean workbook's checks unread, so the profile's
// central test never ran and the model passed as if it had none.
export function isChecksSheetName(name) {
  const label = String(name || '')
    .trim()
    .toLowerCase();
  return ['checks', 'check', '검증', '점검'].includes(label);
}

function auditModelDiscipline(list, sheet, cells) {
  const checksSheet = isChecksSheetName(sheet.name);
  const extent = populatedExtent(cells);
  const lines = collectFormulaLines(list, sheet, cells, { extent, checksSheet });
  auditHardcodes(list, sheet, cells, lines, extent);
  const ordered = (line) => line.sort((a, b) => a.index - b.index);
  for (const line of lines.byRow.values()) auditLine(list, sheet, ordered(line), 'row');
  for (const line of lines.byColumn.values()) auditLine(list, sheet, ordered(line), 'column');
  if (lines.styledCells && lines.formulaCount >= 3 && lines.hardcodes >= 5 && lines.markedHardcodes === 0) {
    list.push(
      'info',
      'input_cells_unmarked',
      sheetPath(sheet),
      `${lines.hardcodes} hardcoded inputs are indistinguishable from formulas; mark inputs (blue font, or a fill for cells the reader edits) and add a legend.`
    );
  }
}

export function auditXlsxFormulas(sheets, { auditProfile = '', sheetNames = null, definedNames = [] } = {}) {
  const list = new IssueList();
  const names =
    Array.isArray(sheetNames) && sheetNames.length
      ? sheetNames
      : (sheets || []).map((sheet) => sheet?.name).filter(Boolean);
  const externalNames = externalDefinedNames(definedNames);
  for (const sheet of sheets || []) {
    const cells = Array.isArray(sheet?.cells) ? sheet.cells.filter((cell) => cell?.ref) : [];
    if (!cells.length) continue;
    auditSheetHygiene(list, sheet, cells, names, externalNames);
    auditSheetLayout(list, sheet, cells);
    auditDoubleCounting(list, sheet, cells);
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
// The model-discipline verdicts the shared audit owns outright. Excel's host
// makes cruder versions of these (every numeric cell on a data sheet with no
// comment was "unsourced", one per cell), so its findings for them are replaced
// by the shared audit's, and both backends report the same workbook the same way.
const SHARED_MODEL_VERDICTS = new Set(['hardcode_missing_source', 'rogue_hardcode', 'formula_inconsistency']);

export function mergeXlsxFormulaAudit(result, document, { auditProfile = '', sheet = '' } = {}) {
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  const scope = sheet ? `/sheet[${String(sheet).toLowerCase()}]` : '';
  const findings = auditXlsxFormulas(sheets, {
    auditProfile,
    sheetNames: sheets.map((entry) => entry?.name),
    definedNames: document?.definedNames,
  }).filter(
    (finding) => !scope || finding.path === '/' || String(finding.path).toLowerCase().startsWith(scope)
  );
  // Only a sheet whose cells came back was read: Excel's full snapshot carries
  // no cells for a sheet past 500 cells, and the host's own verdicts for such
  // a sheet stay — the shared audit saw nothing there to replace them with.
  const readSheets = new Set(
    sheets
      .filter((entry) => Array.isArray(entry?.cells) && entry.cells.length > 0)
      .map((entry) => `/sheet[${String(entry?.name || '').toLowerCase()}]`)
  );
  const issues = (Array.isArray(result?.issues) ? result.issues : []).filter((entry) => {
    if (!SHARED_MODEL_VERDICTS.has(entry?.code)) return true;
    const owner = /^\/sheet\[[^\]]*\]/.exec(String(entry?.path || '').toLowerCase())?.[0];
    return !(owner && readSheets.has(owner));
  });
  const seen = new Set(issues.map((entry) => `${entry?.code}|${entry?.path}`));
  const added = findings.filter((finding) => !seen.has(`${finding.code}|${finding.path}`));
  return {
    ...result,
    issues: [...issues, ...added],
    issueCount: issues.length + added.length,
    sharedAudit: {
      added: added.length,
      cellsRead: sheets.reduce((total, entry) => total + (entry?.cells?.length || 0), 0),
    },
  };
}
