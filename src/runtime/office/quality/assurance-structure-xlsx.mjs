// Workbook structure review: sheet layout, formulas, charts and print areas.
import { auditXlsxFormulas } from '../portable/xlsx-formula-audit.mjs';
import { columnNumber as columnIndex } from '../portable/portable-cells.mjs';
import { issue } from './assurance-issue.mjs';

function cellRow(ref) {
  return Number(/([1-9]\d*)$/.exec(String(ref || '').replaceAll('$', ''))?.[1] || 0);
}

function formulaRanges(formula) {
  const ranges = [];
  for (const match of String(formula || '').matchAll(/\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)/gi)) {
    ranges.push({
      startColumn: columnIndex(match[1]),
      start: Number(match[2]),
      endColumn: columnIndex(match[3]),
      end: Number(match[4]),
    });
  }
  return ranges;
}

// How far a series may stop above the data before the gap reads as a deliberate
// window rather than as the row someone forgot to include.
const CHART_SHORT_ROWS = 2;

function cellColumn(ref) {
  return columnIndex(/^\$?([A-Z]{1,3})/i.exec(String(ref || ''))?.[1] || '');
}

// A number the sheet holds, whatever notation it wears; a note or a label under
// the table is text and is not data the chart left out.
function numericCell(cell) {
  const raw = String(cell?.value ?? '').trim();
  if (!raw) return false;
  return Number.isFinite(Number(raw.replaceAll(',', '').replace(/%$/, '')));
}

// A print area is one or more A1 ranges; Excel prints each as its own page set.
function printAreas(reference) {
  return String(reference || '')
    .split(',')
    .map((part) => {
      const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(part.trim());
      if (!match) return null;
      return {
        startColumn: columnIndex(match[1]),
        startRow: Number(match[2]),
        endColumn: columnIndex(match[3] || match[1]),
        endRow: Number(match[4] || match[2]),
      };
    })
    .filter(Boolean);
}

function sheetAt(sheet) {
  return sheet.path || `/sheet[${sheet.name || ''}]`;
}

// The face a sheet's plain cells wear: the workbook's default where the reading states it, else the commonest.
function baseFace(cells, defaults) {
  if (defaults?.fontName || defaults?.fontSize) return { fontName: defaults.fontName, fontSize: defaults.fontSize };
  const counts = new Map();
  for (const cell of cells) {
    const face = `${cell.style?.fontName ?? ''}\u0000${cell.style?.fontSize ?? ''}`;
    counts.set(face, (counts.get(face) || 0) + 1);
  }
  const [face = '\u0000'] = [...counts].sort((left, right) => right[1] - left[1])[0] || [];
  const [fontName, fontSize] = face.split('\u0000');
  return { fontName, fontSize: fontSize === '' ? undefined : Number(fontSize) };
}

// A cell is styled by what it states beyond that face. The Office reader reports the workbook font (맑은 고딕 11)
// on every cell, which counted a sheet of plain data as styled and kept this check from ever firing there.
function styledCell(style, base) {
  return Object.entries(style || {}).some(([key, value]) => {
    if (key === 'fontName') return Boolean(value) && value !== base.fontName;
    if (key === 'fontSize') return value != null && Number(value) !== Number(base.fontSize);
    if (key === 'color') return !/^(?:#?000000|auto)?$/i.test(String(value ?? ''));
    return value != null && value !== '' && value !== false;
  });
}

function reviewXlsxHierarchy(sheet, cells, issues, defaults) {
  if (cells.length < 8) return;
  const base = baseFace(cells, defaults);
  const styled = cells.filter((cell) => styledCell(cell.style, base));
  if (styled.length) return;
  issues.push(
    issue(
      'worksheet_hierarchy_missing',
      sheetAt(sheet),
      'Data sheet has no styled title, header, table, or visual hierarchy.'
    )
  );
}

function xlsxTotalRows(cells) {
  return new Set(
    cells
      .filter((cell) =>
        /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(cell.value || '').trim())
      )
      .map((cell) => cellRow(cell.ref))
      .filter(Boolean)
  );
}

function reviewXlsxFormulaErrors(sheet, cells, issues) {
  for (const cell of cells) {
    if (!/^#(?:DIV\/0|VALUE|REF|NAME|N\/A|NUM|NULL|SPILL|CALC|FIELD)\??!?$/i.test(String(cell.value || '').trim())) {
      continue;
    }
    issues.push(
      issue(
        'formula_error',
        cell.path || `${sheetAt(sheet)}/cell[${cell.ref || ''}]`,
        `Formula evaluates to ${cell.value}.`,
        'format-review',
        'error'
      )
    );
  }
}

// The last data row the chart's columns hold past the rows it reads; 0 when
// the series reach the data or the columns hold nothing more.
function chartLastMissedRow(cells, ranges, lastRead, totalRows) {
  if (!ranges.length) return 0;
  const first = Math.min(...ranges.map((range) => range.startColumn));
  const last = Math.max(...ranges.map((range) => range.endColumn));
  const missed = cells
    .filter((cell) => {
      const row = cellRow(cell.ref);
      const column = cellColumn(cell.ref);
      return row > lastRead && !totalRows.has(row) && column >= first && column <= last && numericCell(cell);
    })
    .map((cell) => cellRow(cell.ref));
  return missed.length ? Math.max(...missed) : 0;
}

function reviewXlsxChartRanges(sheet, cells, totalRows, issues) {
  for (const chart of sheet.charts || []) {
    const chartPath = chart.path || `${sheetAt(sheet)}/chart`;
    const formulas = (chart.series || [])
      .flatMap((series) => [series.formula, series.categoryFormula, series.valueFormula])
      .filter(Boolean);
    const included = [...totalRows].find((row) =>
      formulas.some((formula) => formulaRanges(formula).some((range) => row >= range.start && row <= range.end))
    );
    if (included) {
      issues.push(
        issue(
          'chart_includes_total_row',
          chartPath,
          `Chart source includes total or subtotal row ${included}; separate summary rows from comparison series.`
        )
      );
    }
    // The opposite error renders just as cleanly: a series that stops one row
    // above the data draws a picture the sheet does not support. A chart
    // showing a deliberate window stops far short, and a total row is left
    // out on purpose, so only the last row or two count.
    const ranges = formulas.flatMap((formula) => formulaRanges(formula));
    const lastRead = ranges.length ? Math.max(...ranges.map((range) => range.end)) : 0;
    const lastData = chartLastMissedRow(cells, ranges, lastRead, totalRows);
    if (lastRead && lastData && lastData - lastRead <= CHART_SHORT_ROWS) {
      issues.push(
        issue(
          'chart_stops_short_of_data',
          chartPath,
          `Chart source stops at row ${lastRead} while the columns it reads hold data through row ${lastData}; widen the series range.`
        )
      );
    }
  }
}

function reviewXlsxPrintFit(sheet, pageSetup, issues) {
  const rows = Number(sheet.rows) || 0;
  const columns = Number(sheet.columns) || 0;
  if (!(rows >= 40 || columns >= 12) || Number(pageSetup.fitToPagesWide) === 1 || !(Number(pageSetup.zoom) > 100)) {
    return;
  }
  issues.push(
    issue(
      'worksheet_print_fit_missing',
      sheetAt(sheet),
      'Large worksheet has no one-page-wide print fit and uses an enlarged print zoom.'
    )
  );
}

function sheetDrawings(sheet) {
  return [
    ...(sheet.charts || []).map((entry) => ({ kind: 'Chart', entry })),
    ...(sheet.images || []).map((entry) => ({ kind: 'Picture', entry })),
  ].filter((item) => Number(item.entry?.anchor?.endColumn) > 0);
}

// A chart or picture the print area leaves out is cut in half by the page
// break, and a sheet with no print area at all paginates around it.
function reviewXlsxPrintArea(sheet, pageSetup, drawings, issues) {
  const areas = printAreas(pageSetup.printArea);
  for (const { kind, entry } of drawings.slice(0, 3)) {
    const anchor = entry.anchor;
    const inside = areas.some(
      (area) =>
        Number(anchor.startColumn) >= area.startColumn &&
        Number(anchor.startRow) >= area.startRow &&
        Number(anchor.endColumn) <= area.endColumn &&
        Number(anchor.endRow) <= area.endRow
    );
    if (inside) continue;
    // A sheet fitted to one page wide exports whole with or without a print
    // area; a declared print area that leaves the drawing out cuts it.
    if (!areas.length && Number(pageSetup.fitToPagesWide) === 1) continue;
    issues.push(
      issue(
        'drawing_outside_print_area',
        entry.path || sheetAt(sheet),
        areas.length
          ? `${kind} spans ${anchor.from}:${anchor.to}, past the print area ${pageSetup.printArea}; a print or PDF export cuts it.`
          : `${kind} spans ${anchor.from}:${anchor.to} and the sheet declares no print area or one-page-wide fit, so an export may paginate through it.`,
        'format-review',
        areas.length ? 'warning' : 'info'
      )
    );
  }
}

// Two drawings on one cell block hide each other: a second chart anchored
// inside the first one's rows prints as one chart drawn over another.
function reviewXlsxDrawingOverlap(sheet, drawings, issues) {
  for (let first = 0; first < drawings.length; first += 1) {
    for (let second = first + 1; second < drawings.length; second += 1) {
      const left = drawings[first].entry.anchor;
      const right = drawings[second].entry.anchor;
      const columns =
        Math.min(Number(left.endColumn), Number(right.endColumn)) -
        Math.max(Number(left.startColumn), Number(right.startColumn));
      const rows =
        Math.min(Number(left.endRow), Number(right.endRow)) - Math.max(Number(left.startRow), Number(right.startRow));
      if (columns < 1 || rows < 1) continue;
      issues.push(
        issue(
          'drawing_overlap',
          drawings[second].entry.path || sheetAt(sheet),
          `${drawings[second].kind} spans ${right.from}:${right.to}, over the ${drawings[first].kind.toLowerCase()} at ${left.from}:${left.to}; place it below or beside it.`,
          'format-review',
          'warning'
        )
      );
    }
  }
}

export function reviewXlsxStructure(document, auditProfile = '') {
  const issues = [];
  const sheets = Array.isArray(document?.sheets) ? document.sheets : [];
  for (const sheet of sheets) {
    const cells = Array.isArray(sheet.cells) ? sheet.cells : [];
    const pageSetup = sheet.pageSetup || {};
    const drawings = sheetDrawings(sheet);
    reviewXlsxHierarchy(sheet, cells, issues, document?.defaultStyle);
    reviewXlsxFormulaErrors(sheet, cells, issues);
    reviewXlsxChartRanges(sheet, cells, xlsxTotalRows(cells), issues);
    reviewXlsxPrintFit(sheet, pageSetup, issues);
    reviewXlsxPrintArea(sheet, pageSetup, drawings, issues);
    reviewXlsxDrawingOverlap(sheet, drawings, issues);
  }
  for (const finding of auditXlsxFormulas(sheets, { auditProfile, definedNames: document?.definedNames })) {
    issues.push(issue(finding.code, finding.path, finding.message, 'format-review', finding.severity));
  }
  return issues;
}
