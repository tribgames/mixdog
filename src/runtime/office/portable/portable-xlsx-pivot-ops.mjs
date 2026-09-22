// The add_pivot_table operation: which field names the portable writer can
// lay out, the source range read as a header row plus cached data rows, and
// the destination the pivot part is written to. The pivot part itself is
// written by portable-pivot.mjs.
import { workbookSheets } from './portable-cells.mjs';
import { summarizePivotFields, writePivotTable } from './portable-pivot.mjs';
import { areaReference, parseAreaRange } from './portable-sheet-xml.mjs';
import { sheetCellReader } from './portable-xlsx-cell-values.mjs';

// The row, column and value field names an add_pivot_table op names, within
// what the portable writer can lay out.
function pivotFieldNames(op) {
  const asList = (value) => {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  };
  const rowNames = asList(op.rows);
  const columnNames = asList(op.columns);
  const valueNames = asList(op.values);
  if (!valueNames.length) throw new Error('add_pivot_table requires at least one value field');
  if (rowNames.length > 1 || columnNames.length > 1) {
    throw new Error(
      'Portable add_pivot_table supports one row field and one column field; run the edit with Microsoft Excel for deeper nesting'
    );
  }
  if (valueNames.length > 1 && columnNames.length) {
    throw new Error('Portable add_pivot_table supports multiple value fields only without a column field');
  }
  return { rowNames, columnNames, valueNames };
}

// The source range as its header row plus data rows of cached values.
async function pivotSourceTable(zip, xml, area) {
  const cellValue = await sheetCellReader(zip, xml);
  const headers = [];
  for (let column = area.startCol; column <= area.endCol; column += 1) {
    headers.push(String(cellValue(column, area.startRow) ?? ''));
  }
  if (headers.some((entry) => !entry)) {
    throw new Error('add_pivot_table requires a field name in every column of the first source row');
  }
  const records = [];
  for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
    records.push(headers.map((_, index) => cellValue(area.startCol + index, row)));
  }
  if (!records.length) throw new Error('add_pivot_table source range has no data rows');
  return { headers, records };
}

/** One row field and one column field over a bounded source range. */
export async function addWorksheetPivotTable(zip, sheet, xml, op) {
  const area = parseAreaRange(op.source);
  if (!area.startRow || !area.startCol || area.endRow <= area.startRow) {
    throw new Error('add_pivot_table requires a bounded source range whose first row holds field names');
  }
  const { rowNames, columnNames, valueNames } = pivotFieldNames(op);
  const { headers, records } = await pivotSourceTable(zip, xml, area);
  const fieldIndex = (name) => {
    const index = headers.indexOf(name);
    if (index < 0) {
      throw new Error(`add_pivot_table field "${name}" is not in the source header row (${headers.join(', ')})`);
    }
    return index;
  };
  const destinationName = String(op.destinationSheet || sheet.name);
  const destination = (await workbookSheets(zip)).find((entry) => entry.name === destinationName);
  if (!destination) throw new Error(`add_pivot_table destination sheet "${destinationName}" was not found`);
  const pivotName = String(
    op.name ||
      `MixdogPivot${Object.keys(zip.files).filter((part) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(part)).length + 1}`
  );
  const written = await writePivotTable(zip, {
    fields: summarizePivotFields(headers, records),
    records,
    sourceSheet: sheet.name,
    sourceRef: areaReference(area),
    destinationSheetPath: destination.path,
    destination: String(op.destination || 'A1'),
    name: pivotName,
    rowField: rowNames.length ? fieldIndex(rowNames[0]) : -1,
    columnField: columnNames.length ? fieldIndex(columnNames[0]) : -1,
    valueFields: valueNames.map(fieldIndex),
  });
  return {
    op: op.op,
    changed: true,
    sheet: destinationName,
    name: pivotName,
    rows: records.length,
    fields: headers.length,
    part: written.tablePart,
  };
}
