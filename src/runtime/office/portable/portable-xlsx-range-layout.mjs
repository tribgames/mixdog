// Laying out a range of cells that already exists: sort_range reorders its
// rows, autofit_range measures the width each column prints. Both read the
// cell grid and write it back; neither adds a part to the package.
import {
  cellRecords,
  cellStyleIndexes,
  columnLabel,
  columnNumber,
  expandRange,
  parseCellRef,
  setCellStylesInSheet,
  setCellsInSheet,
  sharedStrings,
} from './portable-cells.mjs';
import { zipText } from './portable-opc.mjs';
import { resolveCellStyles } from './portable-sheet-styles.mjs';
import {
  displayWidth,
  formattedNumberWidth,
  hiddenSheetAreas,
  mergedRanges,
  parseAreaRange,
  writeColumnWidths,
} from './portable-sheet-xml.mjs';

// The sort key is named the way the caller already reads the sheet: a column
// letter, the header the column carries, or nothing when the first column of
// the range is the key.
function sortKeyColumn(op, area, headerValue) {
  const declared = String(op.by ?? op.column ?? op.byColumn ?? '').trim();
  if (!declared) return area.startCol;
  if (/^[A-Za-z]{1,3}$/.test(declared)) {
    const column = columnNumber(declared.toUpperCase());
    if (column < area.startCol || column > area.endCol) {
      throw new Error(`XLSX sort_range by "${declared}" is outside ${op.range}; name a column the range covers.`);
    }
    return column;
  }
  const headers = [];
  for (let col = area.startCol; col <= area.endCol; col += 1) {
    const value = headerValue(col);
    const text = value == null ? '' : String(value).trim();
    if (text) headers.push(`${columnLabel(col)} (${text})`);
    if (text && text === declared) return col;
  }
  throw new Error(
    `XLSX sort_range by "${declared}" matches no column in ${op.range}. Name a column letter or one of its headers: ${headers.join(', ') || '(the range has no header row)'}.`
  );
}

// Excel orders numbers before text and leaves blanks last in both directions;
// text is compared the way the reader's locale reads it, so 강릉 sorts before
// 광주 rather than by code point.
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareSortValues(left, right) {
  const blank = (value) => value == null || value === '';
  if (blank(left) && blank(right)) return 0;
  if (blank(left)) return 1;
  if (blank(right)) return -1;
  const leftNumber = typeof left === 'number' ? left : Number(left);
  const rightNumber = typeof right === 'number' ? right : Number(right);
  const leftNumeric = typeof left === 'number' || (String(left).trim() !== '' && Number.isFinite(leftNumber));
  const rightNumeric = typeof right === 'number' || (String(right).trim() !== '' && Number.isFinite(rightNumber));
  if (leftNumeric && rightNumeric) return leftNumber - rightNumber;
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return SORT_COLLATOR.compare(String(left), String(right));
}

// The sorts Excel itself refuses, and the ones that would silently corrupt
// the sheet: formulas inside the moved rows, hidden rows among them, and
// merged cells crossing them.
function refuseUnsortableRange(xml, area, firstRow, records, refAt) {
  // A sort moves whole rows. A formula inside them would keep pointing at
  // the row number it was written for, so the sorted sheet would compute
  // someone else's numbers: sort the values, then write the formulas.
  const formulas = [];
  for (let row = firstRow; row <= area.endRow; row += 1) {
    for (let col = area.startCol; col <= area.endCol; col += 1) {
      if (records.get(refAt(row, col))?.formula) formulas.push(refAt(row, col));
    }
  }
  if (formulas.length) {
    const named = formulas.slice(0, 3).join(', ') + (formulas.length > 3 ? ` and ${formulas.length - 3} more` : '');
    const holds =
      formulas.length === 1 ? 'holds a formula whose references would' : 'hold formulas whose references would';
    throw new Error(
      `XLSX sort_range moves rows, and ${named} ${holds} follow the move. Sort a range of values, then write the formulas over the sorted rows.`
    );
  }
  // A filtered sheet hides rows, not records: the flag stays on the row
  // number while the values move under it, so a sort would leave a
  // different record hidden than the one the reader filtered away.
  const withheld = [...hiddenSheetAreas(xml).rows].filter((row) => row >= firstRow && row <= area.endRow);
  if (withheld.length) {
    throw new Error(
      `XLSX sort_range would move values under hidden row${withheld.length > 1 ? 's' : ''} ${withheld.slice(0, 5).join(', ')}, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them.`
    );
  }
  // Excel refuses the same case: a merged cell cannot travel with one row.
  const merges = mergedRanges(xml).filter((range) => {
    const merge = expandRange(range);
    return (
      merge.endRow >= firstRow &&
      merge.startRow <= area.endRow &&
      merge.endCol >= area.startCol &&
      merge.startCol <= area.endCol
    );
  });
  if (merges.length) {
    throw new Error(
      `XLSX sort_range cannot move rows through the merged cell${merges.length > 1 ? 's' : ''} ${merges.slice(0, 5).join(', ')}; Excel refuses the same sort. Unmerge them first with unmerge_cells.`
    );
  }
}

// The cell refs of the sortable body, row by row.
function rangeRows(area, firstRow, refAt) {
  return Array.from({ length: area.endRow - firstRow + 1 }, (_unused, offset) => firstRow + offset).map((row) =>
    Array.from({ length: area.endCol - area.startCol + 1 }, (_empty, index) => refAt(row, area.startCol + index))
  );
}

function writeSortedRows(xml, sorted, area, firstRow, refAt) {
  const placed = sorted.flatMap((cells, offset) =>
    cells.map((cell, index) => ({ ref: refAt(firstRow + offset, area.startCol + index), ...cell }))
  );
  const withValues = setCellsInSheet(
    xml,
    placed.map(({ ref, value }) => ({ ref, value }))
  );
  return setCellStylesInSheet(
    withValues,
    placed.map(({ ref, style }) => ({ ref, style }))
  );
}

/** Sorts the values of a range, refusing the cases Excel itself refuses. */
export async function sortWorksheetRange(zip, sheet, xml, op) {
  const area = expandRange(op.range);
  const records = new Map(cellRecords(xml, await sharedStrings(zip)).map((cell) => [cell.ref, cell]));
  const header = op.hasHeader !== false;
  const firstRow = area.startRow + (header ? 1 : 0);
  const refAt = (row, col) => `${columnLabel(col)}${row}`;
  refuseUnsortableRange(xml, area, firstRow, records, refAt);
  const column = sortKeyColumn(op, area, (col) => records.get(refAt(area.startRow, col))?.value);
  const descending = String(op.order || 'asc')
    .trim()
    .toLowerCase()
    .startsWith('desc');
  const rows = rangeRows(area, firstRow, refAt);
  const styles = cellStyleIndexes(xml, rows.flat());
  const body = rows.map((refs) =>
    refs.map((ref) => ({ value: records.get(ref)?.value ?? null, style: styles.get(ref) || 0 }))
  );
  const keyIndex = column - area.startCol;
  const sorted = [...body].sort(
    (left, right) => compareSortValues(left[keyIndex]?.value, right[keyIndex]?.value) * (descending ? -1 : 1)
  );
  zip.file(sheet.path, writeSortedRows(xml, sorted, area, firstRow, refAt));
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    range: op.range,
    by: columnLabel(column),
    order: descending ? 'desc' : 'asc',
    rows: sorted.length,
  };
}

// The widest printed text of each column in the area, skipping the cells a
// horizontal merge spans. A width counts characters of the workbook's default
// size (`baseSize`), so a cell set larger takes proportionally more of it.
function measuredColumnWidths(records, area, spans, baseSize) {
  const measured = new Map();
  for (const record of records) {
    const parsed = parseCellRef(record.ref);
    const column = columnNumber(parsed.col);
    if (area.startCol && (column < area.startCol || column > area.endCol)) continue;
    if (area.startRow && (parsed.row < area.startRow || parsed.row > area.endRow)) continue;
    if (
      spans.some(
        (span) =>
          span.startCol !== span.endCol &&
          span.startCol <= column &&
          column <= span.endCol &&
          span.startRow <= parsed.row &&
          parsed.row <= span.endRow
      )
    )
      continue;
    const value = record.formula ? record.cachedValue : record.value;
    const text = String(value ?? '');
    const numeric = record.dataType !== 'text' && text.trim() !== '' && Number.isFinite(Number(text));
    // An indent level holds about one character of the column before the text starts.
    const scale = (Number(record.style?.fontSize) || baseSize) / baseSize;
    const needed =
      (numeric ? formattedNumberWidth(Number(text), record.style?.numberFormat || '') : displayWidth(text)) * scale +
      (Number(record.style?.indent) || 0);
    measured.set(column, Math.max(measured.get(column) || 0, needed));
  }
  return measured;
}

/** Widths measured from what each cell prints, with the floor a composed sheet asks for. */
export async function autofitWorksheetRange(zip, sheet, xml, op) {
  const area = parseAreaRange(op.range);
  // A row fit names rows (1:12) and asks for their height. Measuring columns
  // there rewrote every column width from its text, which silently undid the
  // widths a composed layout had just asked for.
  if (op.rows === true && !area.startCol) {
    return { op: op.op, changed: true, sheet: sheet.name, rows: true, columns: 0 };
  }
  // Widths follow what the cell prints: a number carries its format's
  // separators, decimals, and units, not the digits it stores.
  const cellStyles = resolveCellStyles(await zipText(zip, 'xl/styles.xml'));
  const records = cellRecords(xml, await sharedStrings(zip), { styles: cellStyles });
  const spans = mergedRanges(xml).map((entry) => parseAreaRange(entry));
  const measured = measuredColumnWidths(records, area, spans, Number(cellStyles[0]?.fontSize) || 11);
  // Fit-to-page never enlarges a sheet, so a layout whose columns hold only
  // their text prints as a small block in the corner of the page. minWidth is
  // the floor a composed sheet asks for: the columns still grow to their
  // content, and every column in the range - including the empty ones a
  // merged band spans - reaches that floor so the block keeps its width.
  const floor = Number(op.minWidth) > 0 ? Math.min(80, Number(op.minWidth)) : 8;
  if (Number(op.minWidth) > 0 && area.startCol && area.endCol - area.startCol < 64) {
    for (let column = area.startCol; column <= area.endCol; column += 1) {
      if (!measured.has(column)) measured.set(column, 0);
    }
  }
  const widths = new Map(
    [...measured.entries()].map(([column, width]) => [
      column,
      Math.min(80, Math.max(floor, Math.round((width + 2) * 10) / 10)),
    ])
  );
  zip.file(sheet.path, writeColumnWidths(xml, widths));
  return { op: op.op, changed: true, sheet: sheet.name, columns: widths.size };
}
