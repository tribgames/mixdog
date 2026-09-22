// What a cell of the sheet SHOWS, by column and row. A pivot source and a
// chart's series both read the sheet this way, so the rule lives once.
import { cellRecords, columnLabel, sharedStrings } from './portable-cells.mjs';

// What a cell of the sheet shows, by column and row: a formula's last computed
// result, or a literal's own value. A pivot source and a chart's series both
// read the sheet this way.
export async function sheetCellReader(zip, xml) {
  const grid = new Map(cellRecords(xml, await sharedStrings(zip)).map((record) => [record.ref, record]));
  return (column, row) => {
    const record = grid.get(`${columnLabel(column)}${row}`);
    if (!record) return null;
    return record.formula ? record.cachedValue : record.value;
  };
}
