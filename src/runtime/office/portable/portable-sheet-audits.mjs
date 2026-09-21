// What a workbook's own cells report about themselves: a column too narrow for
// what it holds, a protected form nobody can type into, ink no reader can see,
// and a hardcoded value inside a row of formulas. Each audit reads the sheet
// parts directly, so the package validation above it stays about package
// structure. A percentage stored as a whole number is the shared formula
// audit's finding, reported once there for both backends.
import { posix } from 'node:path';
import { contrastRatio } from './text-metrics.mjs';
import {
  columnLabel,
  columnNumber,
  iterateSheetCells,
  iterateSheetRows,
  parseCellRef,
  sharedStrings,
} from './portable-cells.mjs';
import { partRelationshipPath, zipText } from './portable-opc.mjs';
import {
  displayWidth,
  formattedNumberWidth,
  hiddenSheetAreas,
  mergedRanges,
  worksheetSection,
} from './portable-sheet-xml.mjs';
import { resolveCellStyles } from './portable-sheet-styles.mjs';
import { paragraphTexts, xmlAttribute, xmlDecode } from './portable-xml.mjs';

const DEFAULT_COLUMN_WIDTH = 8.43;

function cellText(cell, strings) {
  const type = /\bt="([^"]+)"/.exec(cell.attributes)?.[1] || '';
  if (type === 'inlineStr') return paragraphTexts(cell.body, 't').join('');
  const raw = xmlDecode(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cell.body)?.[1] || '');
  if (type === 's') return strings[Number(raw)] ?? '';
  return type === 'str' ? raw : '';
}

// A protected sheet locks every cell unless one is marked unlocked, so a form
// whose entry cells stay locked cannot be filled in at all — the dropdown is
// there, and Excel refuses the keystroke.
// Every cell of one A1 reference, capped at 512 rows by 64 columns.
function addReferenceCells(entryCells, reference) {
  const [start, end] = reference.split(':');
  const from = parseCellRef(start);
  const to = parseCellRef(end || start);
  if (!from || !to) return;
  const firstColumn = columnNumber(from.col);
  const lastColumn = columnNumber(to.col);
  for (let row = from.row; row <= to.row && row - from.row < 512; row += 1) {
    for (let column = firstColumn; column <= lastColumn && column - firstColumn < 64; column += 1) {
      entryCells.add(`${columnLabel(column)}${row}`);
    }
  }
}

// The cells the sheet's data validations ask the reader to fill in.
function validationEntryCells(xml) {
  const entryCells = new Set();
  for (const match of xml.matchAll(/<dataValidation\b([^>]*)/g)) {
    const references = xmlDecode(xmlAttribute(match[1], 'sqref') || '')
      .split(/\s+/)
      .filter(Boolean);
    for (const reference of references) addReferenceCells(entryCells, reference);
  }
  return entryCells;
}

// The entry cells whose style still locks them under sheet protection.
function lockedEntryCells(xml, styles, entryCells) {
  for (const cell of iterateSheetCells(xml)) {
    if (!cell.ref || !entryCells.has(cell.ref)) continue;
    const styleIndex = Number(/\bs="(\d+)"/.exec(cell.attributes)?.[1] ?? 0);
    if (styles[styleIndex]?.locked === false) entryCells.delete(cell.ref);
  }
  return [...entryCells].sort();
}

function protectedInputIssue(sheet, locked) {
  return {
    severity: 'warning',
    code: 'protected_input_locked',
    path: `/sheet[${sheet.name}]/cell[${locked[0]}]`,
    message:
      `Sheet protection is on and ${locked.length === 1 ? 'the entry cell' : `all ${locked.length} entry cells`} ` +
      `(${locked.slice(0, 4).join(', ')}${locked.length > 4 ? ', …' : ''}) stay locked, so nobody can type the value the validation asks for. ` +
      'Run set_style with properties { locked: false } on the entry range before protect_sheet.',
    source: 'sheet-protection',
  };
}

export async function protectedInputIssues(zip, sheets) {
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml || !/<sheetProtection\b/.test(xml)) continue;
    const entryCells = validationEntryCells(xml);
    if (!entryCells.size) continue;
    const locked = lockedEntryCells(xml, styles, entryCells);
    if (!locked.length) continue;
    issues.push(protectedInputIssue(sheet, locked));
    if (issues.length >= 50) return issues;
  }
  return issues;
}

// Declared column widths by column number; undeclared columns use the default.
function declaredColumnWidths(xml) {
  const widths = new Map();
  const section = worksheetSection(xml, 'cols');
  if (!section) return widths;
  for (const match of section[0].matchAll(/<col\b([^>]*)\/>/g)) {
    const min = Number(xmlAttribute(match[1], 'min')) || 0;
    const max = Number(xmlAttribute(match[1], 'max')) || min;
    const width = Number(xmlAttribute(match[1], 'width'));
    if (!Number.isFinite(width) || width <= 0) continue;
    for (let column = min; column >= 1 && column <= max && column - min < 2048; column += 1) {
      widths.set(column, width);
    }
  }
  return widths;
}

// Records one cut cell on its column's entry: the column answers once with
// the worst cell and how many it takes down.
function noteCutCell(byColumn, column, entry) {
  const found = byColumn.get(column);
  if (!found) {
    byColumn.set(column, { ...entry, count: 1 });
    return;
  }
  found.count += 1;
  if (entry.needed > found.needed) Object.assign(found, entry);
}

function sortedByColumn(byColumn) {
  return [...byColumn.entries()].sort((left, right) => left[0] - right[0]);
}

// Numbers a column is too narrow to show: one narrow column cuts every value
// in it; reporting each cell would fill the issue list with one fault and
// hide the rest.
function narrowNumberColumns(xml, { widths, withheld, styles }) {
  const narrowColumns = new Map();
  for (const cell of iterateSheetCells(xml)) {
    const attributes = cell.attributes;
    if (/\bt="(?:s|inlineStr|str|b)"/.test(attributes)) continue;
    const raw = /<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1];
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const reference = cell.ref;
    if (!reference) continue;
    const position = parseCellRef(reference);
    const column = columnNumber(position.col);
    if (withheld.columns.has(column) || withheld.rows.has(position.row)) continue;
    const width = widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
    const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1]);
    const format = Number.isInteger(style) ? styles[style]?.numberFormat || '' : '';
    const needed = formattedNumberWidth(value, format);
    if (needed <= width + 0.5) continue;
    noteCutCell(narrowColumns, column, { reference, needed, width });
  }
  return sortedByColumn(narrowColumns);
}

function mergedAreas(xml) {
  return mergedRanges(xml).map((reference) => {
    const [start, end] = String(reference).split(':');
    const from = parseCellRef(start);
    const to = parseCellRef(end || start);
    return {
      startCol: columnNumber(from.col),
      endCol: columnNumber(to.col),
      startRow: from.row,
      endRow: to.row,
    };
  });
}

// Labels cut at the column edge: text spills into an empty neighbour, but is
// cut as soon as the next cell holds something — the reader sees half a
// label. The label runs until the first column to its right that holds
// something: the empty columns before it lend their width, and a hidden
// column lends none, because the sheet gives it no room on the page.
// Whether a merge that continues past this column covers the cell.
function insideMergedArea(merged, column, row) {
  return merged.some(
    (area) => area.startCol <= column && area.endCol > column && area.startRow <= row && area.endRow >= row
  );
}

// The width a label may run across: its own column and the empty shown
// columns up to its next filled neighbour.
function labelRoom(column, neighbourColumn, { widths, withheld }) {
  let available = widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
  for (let next = column + 1; next < neighbourColumn; next += 1) {
    if (withheld.columns.has(next)) continue;
    available += widths.get(next) ?? DEFAULT_COLUMN_WIDTH;
  }
  return available;
}

function cutLabelColumns(xml, { widths, withheld, styles, strings }) {
  const merged = mergedAreas(xml);
  const cutLabels = new Map();
  for (const row of iterateSheetRows(xml)) {
    const cells = [...iterateSheetCells(row.body)]
      .filter((cell) => cell.ref)
      .map((cell) => ({ ...cell, column: columnNumber(parseCellRef(cell.ref).col) }))
      .sort((left, right) => left.column - right.column);
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      if (withheld.columns.has(cell.column)) continue;
      const text = cellText(cell, strings).trim();
      if (!text) continue;
      const neighbour = cells
        .slice(index + 1)
        .find(
          (candidate) => cellText(candidate, strings).trim() || /<v(?:\s[^>]*)?>[\s\S]*?<\/v>/.test(candidate.body)
        );
      if (!neighbour) continue;
      const styleIndex = Number(/\bs="(\d+)"/.exec(cell.attributes)?.[1] ?? 0);
      if (styles[styleIndex]?.wrapText === true) continue;
      const rowNumber = parseCellRef(cell.ref).row;
      if (withheld.rows.has(rowNumber)) continue;
      if (insideMergedArea(merged, cell.column, rowNumber)) continue;
      const width = widths.get(cell.column) ?? DEFAULT_COLUMN_WIDTH;
      const available = labelRoom(cell.column, neighbour.column, { widths, withheld });
      const needed = displayWidth(text);
      if (needed <= available + 0.5) continue;
      const neighbourRef = `${columnLabel(neighbour.column)}${rowNumber}`;
      const found = cutLabels.get(cell.column);
      if (!found) {
        cutLabels.set(cell.column, { reference: cell.ref, text, needed, width, neighbour: neighbourRef, count: 1 });
      } else {
        found.count += 1;
        if (needed > found.needed) Object.assign(found, { reference: cell.ref, text, needed, neighbour: neighbourRef });
      }
    }
  }
  return sortedByColumn(cutLabels);
}

export async function columnFitIssues(zip, sheets) {
  const strings = await sharedStrings(zip);
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const issues = [];
  for (const sheet of sheets) {
    // Fit is about what a reader sees. A hidden sheet, row, or column shows
    // nothing, so measuring it reports a defect nobody can look at — and the
    // fix round then widens a column the workbook deliberately withholds.
    if (sheet.visibility && sheet.visibility !== 'visible') continue;
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    const measure = { widths: declaredColumnWidths(xml), withheld: hiddenSheetAreas(xml), styles, strings };
    for (const [column, entry] of narrowNumberColumns(xml, measure)) {
      issues.push({
        severity: 'warning',
        code: 'column_too_narrow',
        path: `/sheet[${sheet.name}]/cell[${entry.reference}]`,
        message:
          `Number needs about ${entry.needed} characters but column ${columnLabel(column)} is ${entry.width.toFixed(1)} wide; Excel shows ###.` +
          `${entry.count > 1 ? ` ${entry.count} cells in this column are cut.` : ''} Run autofit_range.`,
        source: 'number-format',
      });
      if (issues.length >= 50) return issues;
    }
    for (const [column, entry] of cutLabelColumns(xml, measure)) {
      const shown = entry.text.length > 24 ? `${entry.text.slice(0, 24)}…` : entry.text;
      issues.push({
        severity: 'warning',
        code: 'label_truncated',
        path: `/sheet[${sheet.name}]/cell[${entry.reference}]`,
        message:
          `"${shown}" needs about ${entry.needed} characters but column ${columnLabel(column)} is ${entry.width.toFixed(1)} wide and ${entry.neighbour} has content, so the label is cut.` +
          `${entry.count > 1 ? ` ${entry.count} labels in this column are cut.` : ''} Run autofit_range or widen the column.`,
        source: 'column-fit',
      });
      if (issues.length >= 50) return issues;
    }
  }
  return issues;
}

// A pasted result where a formula belongs stops recalculating, and the row goes
// on looking right. Only a constant the row's formulas have already started is
// read that way: the first period of a projection is the input every later
// period grows from, and calling that an interruption reports the ordinary
// shape of a plan as a defect.
export async function formulaConsistencyIssues(zip, sheets) {
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    for (const row of iterateSheetRows(xml)) {
      const cells = [...iterateSheetCells(row.body)].map((cell) => ({
        reference: cell.ref,
        formula: /<f[\s>]/.test(cell.body),
        numeric:
          !/\bt="(?:s|inlineStr|str|b)"/.test(cell.attributes) &&
          Number.isFinite(Number(/<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1])),
      }));
      if (cells.filter((cell) => cell.formula).length < 3) continue;
      let started = false;
      for (const cell of cells) {
        if (cell.formula) {
          started = true;
          continue;
        }
        if (!started || !cell.numeric || !cell.reference) continue;
        issues.push({
          severity: 'warning',
          code: 'formula_inconsistency',
          path: `/sheet[${sheet.name}]/cell[${cell.reference}]`,
          message:
            'A hardcoded value interrupts a row of formulas; a lone edited cell mid-row is a common silent error.',
          source: 'formula-audit',
        });
        if (issues.length >= 50) return issues;
      }
    }
  }
  return issues;
}

// The ranges Excel tables own: inside one, the table style paints the header
// and banding, so a cell there carries a fill this scan cannot read from the
// cell itself.
async function tableRanges(zip, sheet, xml) {
  const parts = worksheetSection(xml, 'tableParts');
  if (!parts) return [];
  const relations = await zipText(zip, partRelationshipPath(sheet.path));
  if (!relations) return [];
  const targets = new Map();
  for (const match of relations.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attributes = match[1];
    if (!String(xmlAttribute(attributes, 'Type') || '').endsWith('/table')) continue;
    const id = xmlAttribute(attributes, 'Id');
    const target = xmlAttribute(attributes, 'Target');
    if (id && target) {
      targets.set(
        id,
        target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(sheet.path), target))
      );
    }
  }
  const ranges = [];
  for (const match of parts[0].matchAll(/<tablePart\b[^>]*\br:id="([^"]+)"/g)) {
    const part = targets.get(match[1]);
    if (!part) continue;
    const reference = /<table\b[^>]*\bref="([^"]+)"/.exec((await zipText(zip, part)) || '')?.[1] || '';
    const [start, end] = reference.split(':');
    if (!start) continue;
    const from = parseCellRef(start);
    const to = parseCellRef(end || start);
    ranges.push({
      startCol: columnNumber(from.col),
      endCol: columnNumber(to.col),
      startRow: from.row,
      endRow: to.row,
    });
  }
  return ranges;
}

// Ink a reader cannot see: a header that keeps the body's dark colour on its
// dark fill, or text so pale it disappears into the sheet. The readable
// minimum is the one the deck review applies — 4.5:1, or 3:1 for large or
// bold type.
export async function cellInkIssues(zip, sheets) {
  const strings = await sharedStrings(zip);
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const issues = [];
  for (const sheet of sheets) {
    // Unreadable ink is what a reader sees; a withheld sheet, row, or column
    // shows nobody anything.
    if (sheet.visibility && sheet.visibility !== 'visible') continue;
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    const withheld = hiddenSheetAreas(xml);
    const tables = await tableRanges(zip, sheet, xml);
    for (const cell of iterateSheetCells(xml)) {
      const styleIndex = Number(/\bs="(\d+)"/.exec(cell.attributes)?.[1] ?? 0);
      const style = styleIndex > 0 ? styles[styleIndex] : null;
      if (!style?.color || !cell.ref) continue;
      const hasContent = Boolean(cellText(cell, strings).trim()) || /<v(?:\s[^>]*)?>[\s\S]*?<\/v>/.test(cell.body);
      if (!hasContent) continue;
      const position = parseCellRef(cell.ref);
      const column = columnNumber(position.col);
      if (withheld.columns.has(column) || withheld.rows.has(position.row)) continue;
      const inTable = tables.some(
        (range) =>
          column >= range.startCol &&
          column <= range.endCol &&
          position.row >= range.startRow &&
          position.row <= range.endRow
      );
      if (!style.fillColor && inTable) continue;
      const size = Number(style.fontSize) || 11;
      const minimum = size >= 18 || (size >= 14 && style.bold === true) ? 3 : 4.5;
      const ratio = contrastRatio(style.color, style.fillColor || 'FFFFFF');
      if (ratio == null || ratio >= minimum) continue;
      issues.push({
        severity: 'warning',
        code: 'low_contrast',
        path: `/sheet[${sheet.name}]/cell[${cell.ref}]`,
        message:
          `Cell text contrast is ${ratio.toFixed(2)}:1 against ${style.fillColor ? `its fill ${style.fillColor}` : 'the sheet'};` +
          ` ${minimum}:1 is the readable minimum at ${Math.round(size)}pt.`,
        source: 'text-metrics',
      });
      if (issues.length >= 20) return issues;
    }
  }
  return issues;
}
