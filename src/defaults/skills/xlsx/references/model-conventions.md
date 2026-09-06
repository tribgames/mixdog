# Model conventions

The conventions a reader of a financial or decision model expects, unless the user says otherwise or the existing file already does something else — in which case the file wins. The runtime reads these back under `auditProfile:'financial-model'` (SKILL.md §6); this file says what to build so the audit has nothing to report.

## 1. Color — what a cell's ink says about where its number comes from
| Cell | Font | Fill | `set_style` |
|---|---|---|---|
| hardcoded input, scenario lever | blue `0000FF` | — | `{ color:'0000FF' }` |
| formula | black (default) | — | nothing |
| link to another sheet | green `008000` | — | `{ color:'008000' }` |
| link to another file | red `FF0000` | — | `{ color:'FF0000' }` — and copy the value into an input (SKILL.md §5) |
| key assumption; a cell the user should fill in | as above | yellow `FFFF00` | `{ fillColor:'FFFF00' }` |

Put a three-line legend where the reader lands (the assumptions sheet, above the first input): "blue = input, black = formula, yellow = fill in". A color without a legend is decoration. → runtime `input_cells_unmarked` (info) when no input carries a color or fill

## 2. Numbers — stored one way, shown another
- Currency `$#,##0` (or the locale's), the unit named in the header (`Revenue ($mm)`, `매출 (억원)`), never repeated in every cell.
- Zeros render as `-`, negatives in parentheses: `$#,##0;($#,##0);-` — the same three-part form for percentages (`0.0%;(0.0%);-`).
- Percentages stored as fractions: `0.15` under `0.0%` renders 15.0%; `15` renders 1500.0%. → runtime `percentage_stored_as_whole`
- Valuation multiples `0.0x`; ratios `0.00`; counts `#,##0`.
- Years as text (`"2024"`) or formatted `0`; a thousands-separator format renders `2,024`. → runtime `year_with_thousands_separator`
- Dates as ISO strings in `set_cell`, formatted `yyyy-mm-dd` — a date typed as text sorts wrong and cannot be subtracted.

## 3. Structure — one assumption, one cell
- Every assumption in its own labelled cell (label to the left, unit in the label), referenced by the formulas that use it: `=B5*(1+$B$6)`, never `=B5*1.05`. → runtime `inline_constant_in_formula`
- One formula per row of a projection, copied across every period; a lone edited cell mid-row is the commonest silent error. A period computed differently gets its own labelled row. → runtime `formula_pattern_inconsistency`, `formula_inconsistency`
- Guard every denominator that can be zero: `=IFERROR(B5/C5,0)` or `=IF(C5=0,0,B5/C5)`; a `#DIV/0!` in one cell spreads through every total that reads it. → runtime `unguarded_division`
- Check the first two or three formulas against the cells they should read before copying them across; a reference one row off recalculates cleanly and shows the wrong number. → runtime `formula_reads_beyond_data` (a single reference past the populated extent)
- Inputs on their own sheet (or a clearly separated block at the top) and calculations below or beside them; a pasted result inside a calculation row is a finding, not a shortcut. → runtime `rogue_hardcode`
- Cross-sheet references use `define_name` for inputs the model reads in more than one place (`GrowthRate` instead of `Assumptions!$B$6` five times).
- Sheet names are short, without leading or trailing spaces; a name with a space is quoted in references (`'Input Sheet'!B2`). → runtime `unquoted_sheet_reference`

## 4. The Checks sheet — the model proves itself
A sheet named `Checks` with one tie-out per row: what is compared, the two sides, and a formula that evaluates `TRUE` (`=ROUND(Summary!B20-SUM(Detail!B2:B19),2)=0`), plus a top cell `=AND(B2:B9)` the reader looks at first. A model without one has no answer to "does it add up". → runtime `missing_checks_sheet`, `failed_check`

## 5. Sourcing — where every hardcode came from
- `add_provenance cell source` on every input with an external source; the note reads as a citation a reader can follow: document, period, page or table, URL.
- `add_note` on every assumption or estimate with who decided it and when ("user brief 2026-09-06: 5% growth"); a number the user gave is cited as theirs, never dressed up as research.
- Raw records live in an Excel table (`add_table`) on their own sheet, sourced once by the sheet's `source` or an `add_note` on its first cell; the audit reads table rows as data and asks for a note only on the assumptions outside them.
- A scenario table (base / upside / downside) lives with the inputs; the active case is selected through one cell the formulas read (`=INDEX(C6:E6,$B$2)`), never by overwriting the inputs. → runtime `hardcode_missing_source`

## 6. A workbook someone else fills in
- The legend of §1 sits where the reader lands, and names the cells to edit in words ("yellow cells: type your figures; everything else calculates").
- One example row of realistic values in the expected format, labelled as an example in its first cell, so the reader sees the units and the precision before typing. Never add such a row to a file you were asked to edit.
- `add_validation` on every constrained input (a list of allowed values, a numeric range) with an input message; a typo caught at entry never reaches a total.
- An input left blank on purpose keeps its fill, so a reader sees what is still missing.

## 7. Editing an existing model
1. `snapshot` the assumptions region first; `document.conventions` names the file's faces, formats, and input markers, and each cell's `style` and `note` show the detail. Adopt them even when they differ from §1.
2. Write only into the marked input cells; never overwrite a formula to "fix" its result — change the input it reads, or add a labelled override row.
3. Keep the file's number formats, fonts, and sheet order; add a sheet at the end rather than reshaping the existing ones.
4. Run `issues auditProfile:'financial-model'` before and after the edit: the findings you inherited are reported in the delivery, the ones you introduced are fixed.
