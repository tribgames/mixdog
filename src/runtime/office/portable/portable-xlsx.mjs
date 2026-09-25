import { forceWorkbookRecalculation, workbookSheets } from './portable-cells.mjs';
import { zipText } from './portable-opc.mjs';
import { applyWorksheetPageSetup } from './portable-sheet-page.mjs';
import {
  addWorksheet,
  addWorksheetChart,
  addWorksheetImage,
  addWorksheetPivotTable,
  addWorksheetValidation,
  applyConditionalFormat,
  autofitWorksheetRange,
  deleteWorksheet,
  deleteWorksheetDrawing,
  renameWorksheet,
  setWorksheetDrawing,
  setWorksheetHeaderFooter,
  sortWorksheetRange,
} from './portable-xlsx-operations.mjs';
import {
  addWorksheetNote,
  addWorksheetTable,
  appendWorksheetRow,
  clearWorksheetCell,
  copyWorksheet,
  defineWorkbookName,
  deleteWorksheetNote,
  freezeWorksheetPanes,
  mergeWorksheetCells,
  protectWorksheet,
  replaceWorkbookText,
  setRowHeightOrColumnWidth,
  setRowOrColumnVisibility,
  setWorksheetAutofilter,
  setWorksheetCell,
  setWorksheetHyperlink,
  setWorksheetRange,
  setWorksheetStyle,
  setWorksheetView,
  setWorksheetVisibility,
  shiftWorksheetRowsOrColumns,
} from './portable-xlsx-sheet-edits.mjs';

// Every operation the portable backend applies to an existing worksheet. An
// edit receives (zip, sheet, xml, op, sheets) and returns the result row; the
// few that reach beyond the addressed sheet adapt their arguments here.
const SHEET_EDITS = {
  set_range: setWorksheetRange,
  sort_range: sortWorksheetRange,
  append_row: appendWorksheetRow,
  clear_cell: clearWorksheetCell,
  replace_text: (zip, _sheet, _xml, op, sheets) => replaceWorkbookText(zip, sheets, op),
  set_style: setWorksheetStyle,
  merge_cells: mergeWorksheetCells,
  unmerge_cells: mergeWorksheetCells,
  freeze_panes: freezeWorksheetPanes,
  set_sheet_view: setWorksheetView,
  autofit_range: autofitWorksheetRange,
  insert_rows: shiftWorksheetRowsOrColumns,
  delete_rows: shiftWorksheetRowsOrColumns,
  insert_columns: shiftWorksheetRowsOrColumns,
  delete_columns: shiftWorksheetRowsOrColumns,
  set_autofilter: setWorksheetAutofilter,
  set_sheet_visibility: setWorksheetVisibility,
  // What a printed sheet says on every page — the confidentiality mark, the
  // document number. Word and PowerPoint could carry one and a workbook could
  // not, so a printed pack lost its marking at the spreadsheet.
  set_header_footer: setWorksheetHeaderFooter,
  set_row_visibility: setRowOrColumnVisibility,
  set_column_visibility: setRowOrColumnVisibility,
  set_row_height: setRowHeightOrColumnWidth,
  set_column_width: setRowHeightOrColumnWidth,
  define_name: (zip, _sheet, _xml, op) => defineWorkbookName(zip, op),
  delete_name: (zip, _sheet, _xml, op) => defineWorkbookName(zip, op),
  add_note: addWorksheetNote,
  add_provenance: addWorksheetNote,
  delete_note: deleteWorksheetNote,
  add_image: addWorksheetImage,
  set_hyperlink: setWorksheetHyperlink,
  protect_sheet: protectWorksheet,
  unprotect_sheet: protectWorksheet,
  add_conditional_format: applyConditionalFormat,
  delete_conditional_formats: applyConditionalFormat,
  add_validation: addWorksheetValidation,
  add_table: addWorksheetTable,
  add_pivot_table: addWorksheetPivotTable,
  add_chart: addWorksheetChart,
  // A chart or picture the audit reports as overlapping or off the print area
  // had no answer but a rebuilt workbook.
  set_drawing: setWorksheetDrawing,
  delete_drawing: deleteWorksheetDrawing,
  set_page_setup: (zip, sheet, xml, op, sheets) => applyWorksheetPageSetup(zip, sheets, sheet, xml, op),
};

// Every operation that can change what a formula would answer. Marking the
// workbook only when a formula was written left an edited input with every
// dependent cell's old cached value in place: the file reopened with the
// numbers from before the edit, and an error a guard had swallowed stayed
// swallowed. The mark is what tells a later read the values are stale.
const VALUE_OPERATIONS = new Set([
  'set_cell',
  'set_formula',
  'set_range',
  'append_row',
  'clear_cell',
  'replace_text',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'sort_range',
  'add_sheet',
  'delete_sheet',
  'rename_sheet',
  'copy_sheet',
  'define_name',
  'delete_name',
]);

function selectWorksheet(sheets, op) {
  const selected = op.sheet
    ? sheets.find((entry) => entry.name.toLowerCase() === String(op.sheet).toLowerCase())
    : sheets[0];
  if (!selected) throw new Error(`Worksheet not found: ${op.sheet || '(first sheet)'}`);
  return selected;
}

export async function applyXlsx(zip, operations) {
  let sheets = await workbookSheets(zip);
  const results = [];
  let recalculationRequired = false;
  for (const op of operations) {
    if (VALUE_OPERATIONS.has(op.op)) recalculationRequired = true;
    if (op.op === 'add_sheet') {
      const created = await addWorksheet(zip, op.name);
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, sheet: created.name });
      continue;
    }
    const sheet = selectWorksheet(sheets, op);
    if (op.op === 'rename_sheet' || op.op === 'delete_sheet') {
      const changed =
        op.op === 'rename_sheet'
          ? await renameWorksheet(zip, sheet, op.name)
          : await deleteWorksheet(zip, sheets, sheet);
      sheets = await workbookSheets(zip);
      results.push({ op: op.op, changed: true, ...changed });
      continue;
    }
    const xml = await zipText(zip, sheet.path);
    if (op.op === 'set_cell' || op.op === 'set_formula') {
      const { result, recalculate } = await setWorksheetCell(zip, sheet, xml, op, sheets);
      if (recalculate) recalculationRequired = true;
      results.push(result);
      continue;
    }
    if (op.op === 'copy_sheet') {
      results.push(await copyWorksheet(zip, sheet, xml, op, sheets));
      sheets = await workbookSheets(zip);
      continue;
    }
    const edit = SHEET_EDITS[op.op];
    if (!edit) throw new Error(`Portable XLSX backend does not support operation: ${op.op}`);
    results.push(await edit(zip, sheet, xml, op, sheets));
  }
  if (recalculationRequired) {
    const workbookPath = 'xl/workbook.xml';
    zip.file(workbookPath, forceWorkbookRecalculation(await zipText(zip, workbookPath)));
  }
  return results;
}
