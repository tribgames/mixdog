# Recalculation, formula compatibility, and audit findings

Read when a recalculation result is not `success`, before writing a function newer than Excel 2007 or one that spills, and when interpreting `qa` / `issues` findings.

## 1. Recalculation — what the result means
- `render`, `qa`, and `finalize` recalculate every formula before reading the workbook: Excel in `background`/`attach`, LibreOffice in `portable`. On a machine without LibreOffice the portable backend evaluates the formulas in process instead (`recalculation.backend:'mixdog-formula'`): it caches every value it could compute and leaves the rest exactly as the file held them, naming them in `unevaluated` with the reason (a workbook link, a function it does not implement, a name defined as anything but one cell, range or constant, a circular reference, and what it refuses on purpose rather than answer wrongly: a wildcard criterion in `COUNTIF`/`SUMIF`, `ROW`/`COLUMN`/`OFFSET`/`INDIRECT`, `ISBLANK`, `TEXT` with a date format, and an array formula whose answer differs per cell) under `status:'partial'`. It never writes a number it cannot stand behind, so a cell listed there still reads back empty. The result's `recalculation` reports `status` (`success` | `partial` | `errors_found`), `formulaCount`, `totalErrors`, and `errorSummary` — each error type with up to 100 cell locations (`truncated` counts the rest; trust `totalErrors`, not the list length). `errors_found` blocks finalize; fix what it names and finalize again. A formula LibreOffice could not parse comes back lower-cased beside its `#NAME?`; `recalculation.unparsedFormulas` names those cells.
- `reason: recalculation_failed` means nothing was recalculated (a `.xlsm`/template in portable mode, an external link, or a workbook neither LibreOffice nor the in-process engine could evaluate): follow `nextAction`, usually Microsoft Office background mode. Until a recalculation, a formula cell has no cached value and reads back empty. → runtime `formula_cache_missing`
- An edit marks the workbook for a full calculation, and that mark travels in the file: a workbook read before the calculation runs reports `stale_calculation` instead of presenting cached numbers as current, and the recalculation drops the cached values so every formula is computed again rather than kept as it was found.

## 2. Formulas that survive verification
- Prefer Excel-2007-era functions — `SUMIFS`, `INDEX`/`MATCH`, `IFERROR`, `SUMPRODUCT` — which every engine evaluates.
- `TEXTJOIN`, `CONCAT`, `IFS`, `SWITCH`, `MAXIFS`, `MINIFS` need the `_xlfn.` prefix Excel stores and hides; the runtime adds it and the result shows `normalizedFormula`.
- `XLOOKUP`, `XMATCH`, `SORT`, `SORTBY`, `FILTER`, `UNIQUE`, `SEQUENCE`, `RANDARRAY` spill, and a file written without spill metadata keeps only the top-left value; `portable` refuses them. Use `INDEX`/`MATCH`; sort, filter, and de-duplicate before writing the cells.
- A sheet name with a space or punctuation is quoted in a reference (`='Assumptions Inputs'!$B$5`); the runtime quotes names the workbook holds (portable) and any multi-word name written before `!` and a reference (both backends), and reports what it could not. → runtime `unquoted_sheet_reference`

## 3. Audit findings
Fix the cell, or answer with the reason in the note.
| Tier | Code | Meaning |
|---|---|---|
| every profile | `formula_error`, `formula_cache_missing` | an error value; a formula never recalculated |
| every profile | `subtotal_double_counted` | a total whose range covers a subtotal of those same rows; every value under it counts twice |
| every profile | `number_format_inconsistent` | one table column where a row or two carry a format the rest of the column does not |
| every profile | `unquoted_sheet_reference`, `external_link_reference` | a reference that evaluates to `#VALUE!`; a link to a file that is not here, written in the formula or carried by a defined name it reads |
| every profile | `percentage_stored_as_whole`, `year_with_thousands_separator`, `number_stored_as_text` | `15` under `0.0%` renders 1500%; `2024` under `#,##0` renders 2,024; `"1,234"` as text never sums (a year as text is fine) |
| every profile | `missing_alt_text` | a picture with nothing for a reader who cannot see it; `add_image altText:<what it shows>` |
| every profile | `chart_includes_total_row`, `chart_stops_short_of_data` | a series that reaches into the total row; a series that stops a row or two above the data it reads — both render cleanly and draw the wrong picture |
| every profile (info) | `header_not_frozen`, `numeric_column_unformatted` | a long sheet whose header scrolls away; a table column of numbers left under General |
| every profile | `header_alignment_mismatch`, `total_row_unmarked` | a bold header set left over a column of figures set right; a total row set like the rows it sums |
| every profile | `drawing_outside_print_area` | a chart or picture past a declared print area (warning: the export cuts it); a sheet with no print area or fit at all (info) |
| every profile | `drawing_overlap`, `drawing_covers_cells` | a chart or picture over another one; one laid over filled cells, which the page no longer shows |
| `financial-model` | `missing_checks_sheet`, `failed_check` | no Checks sheet; a tie-out that evaluates FALSE |
| `financial-model` | `inline_constant_in_formula`, `unguarded_division` | a rate or factor typed into a formula; a divisor that can be zero |
| `financial-model` | `formula_pattern_inconsistency`, `formula_inconsistency`, `rogue_hardcode` | a lone formula that breaks its row or column pattern; a hardcode between formulas; a pasted result after them |
| `financial-model` | `formula_reads_beyond_data` | a single reference past the sheet's last populated row or column — the off-by-one that recalculates cleanly and reads wrong |
| `financial-model` | `hardcode_missing_source`, `input_cells_unmarked` (info) | an input a formula reads without a note (records inside an Excel table are sourced by the table or sheet note, not cell by cell); inputs indistinguishable from formulas |

A chart or picture that landed in the wrong place is moved where it stands rather than rebuilt: `set_drawing` moves or resizes it and `delete_drawing` removes one with the parts only it owned — together they answer `drawing_overlap`, `drawing_covers_cells`, and `drawing_outside_print_area`.
