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
export async function protectedInputIssues(zip, sheets) {
  const styles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml || !/<sheetProtection\b/.test(xml)) continue;
    const entryCells = new Set();
    for (const match of xml.matchAll(/<dataValidation\b([^>]*)/g)) {
      const references = xmlDecode(xmlAttribute(match[1], 'sqref') || '')
        .split(/\s+/)
        .filter(Boolean);
      for (const reference of references) {
        const [start, end] = reference.split(':');
        const from = parseCellRef(start);
        const to = parseCellRef(end || start);
        if (!from || !to) continue;
        for (let row = from.row; row <= to.row && row - from.row < 512; row += 1) {
          for (
            let column = columnNumber(from.col);
            column <= columnNumber(to.col) && column - columnNumber(from.col) < 64;
            column += 1
          ) {
            entryCells.add(`${columnLabel(column)}${row}`);
          }
        }
      }
    }
    if (!entryCells.size) continue;
    const locked = [];
    for (const cell of iterateSheetCells(xml)) {
      if (!cell.ref || !entryCells.has(cell.ref)) continue;
      const styleIndex = Number(/\bs="(\d+)"/.exec(cell.attributes)?.[1] ?? 0);
      if (styles[styleIndex]?.locked === false) entryCells.delete(cell.ref);
    }
    for (const reference of entryCells) locked.push(reference);
    if (!locked.length) continue;
    locked.sort();
    issues.push({
      severity: 'warning',
      code: 'protected_input_locked',
      path: `/sheet[${sheet.name}]/cell[${locked[0]}]`,
      message:
        `Sheet protection is on and ${locked.length === 1 ? 'the entry cell' : `all ${locked.length} entry cells`} ` +
        `(${locked.slice(0, 4).join(', ')}${locked.length > 4 ? ', …' : ''}) stay locked, so nobody can type the value the validation asks for. ` +
        'Run set_style with properties { locked: false } on the entry range before protect_sheet.',
      source: 'sheet-protection',
    });
    if (issues.length >= 50) return issues;
  }
  return issues;
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
    const withheld = hiddenSheetAreas(xml);
    const widths = new Map();
    const section = worksheetSection(xml, 'cols');
    if (section) {
      for (const match of section[0].matchAll(/<col\b([^>]*)\/>/g)) {
        const min = Number(xmlAttribute(match[1], 'min')) || 0;
        const max = Number(xmlAttribute(match[1], 'max')) || min;
        const width = Number(xmlAttribute(match[1], 'width'));
        if (!Number.isFinite(width) || width <= 0) continue;
        for (let column = min; column >= 1 && column <= max && column - min < 2048; column += 1) {
          widths.set(column, width);
        }
      }
    }
    // One narrow column cuts every value in it; reporting each cell would fill
    // the issue list with one fault and hide the rest, so a column answers once
    // with the worst cell and how many it takes down.
    const narrowColumns = new Map();
    for (const cell of iterateSheetCells(xml)) {
      const attributes = cell.attributes;
      if (/\bt="(?:s|inlineStr|str|b)"/.test(attributes)) continue;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1];
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const reference = cell.ref;
      if (!reference) continue;
      const column = columnNumber(parseCellRef(reference).col);
      if (withheld.columns.has(column) || withheld.rows.has(parseCellRef(reference).row)) continue;
      const width = widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
      const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1]);
      const format = Number.isInteger(style) ? styles[style]?.numberFormat || '' : '';
      const needed = formattedNumberWidth(value, format);
      if (needed <= width + 0.5) continue;
      const found = narrowColumns.get(column);
      if (!found) narrowColumns.set(column, { reference, needed, width, count: 1 });
      else {
        found.count += 1;
        if (needed > found.needed) {
          found.needed = needed;
          found.reference = reference;
        }
      }
    }
    for (const [column, entry] of [...narrowColumns.entries()].sort((left, right) => left[0] - right[0])) {
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
    // Text spills into an empty neighbour, but is cut at the column edge as
    // soon as the next cell holds something — the reader sees half a label.
    const merged = mergedRanges(xml).map((reference) => {
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
        // The label runs until the first column to its right that holds
        // something: the empty columns before it lend their width, and a hidden
        // column lends none, because the sheet gives it no room on the page.
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
        if (
          merged.some(
            (area) =>
              area.startCol <= cell.column &&
              area.endCol > cell.column &&
              area.startRow <= rowNumber &&
              area.endRow >= rowNumber
          )
        )
          continue;
        const width = widths.get(cell.column) ?? DEFAULT_COLUMN_WIDTH;
        let available = width;
        for (let column = cell.column + 1; column < neighbour.column; column += 1) {
          if (withheld.columns.has(column)) continue;
          available += widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
        }
        const needed = displayWidth(text);
        if (needed <= available + 0.5) continue;
        const found = cutLabels.get(cell.column);
        if (!found) {
          cutLabels.set(cell.column, {
            reference: cell.ref,
            text,
            needed,
            width,
            neighbour: `${columnLabel(neighbour.column)}${rowNumber}`,
            count: 1,
          });
        } else {
          found.count += 1;
          if (needed > found.needed) {
            Object.assign(found, {
              reference: cell.ref,
              text,
              needed,
              neighbour: `${columnLabel(neighbour.column)}${rowNumber}`,
            });
          }
        }
      }
    }
    for (const [column, entry] of [...cutLabels.entries()].sort((left, right) => left[0] - right[0])) {
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
      for (const cell of cells) {
        if (cell.formula || !cell.numeric || !cell.reference) continue;
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
