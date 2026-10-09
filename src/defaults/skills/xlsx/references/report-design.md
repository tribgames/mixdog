# Report surfaces and working grids

Use this guide for an Excel report, dashboard, or visual redesign. A CSV export
or a small input correction does not need a presentation workflow.

**Route.** Design a new report surface in HTML/CSS for the reader and data, then use `office action:'author'` (`references/html.md`). Raw-data and calculation sheets use native operations; one workbook may mix both. The archetypes and cell recipes below are optional examples, not required layouts or styling. Palette role names (`<ink>`, `<line>`, `<accent>`, and others) stand for colours the author chooses; native operations take six-digit hex without `#`.

## Example sheet structures
Use, combine, or ignore these examples according to the workbook's purpose. Do not add sheets, metrics, cards, or charts merely to fill an archetype.
| Archetype | Sheets | Surface | Route |
|---|---|---|---|
| KPI report | `Report` (title, 2-4 metric figures, one or two charts, a table, a sourced note), `Data`, optional `Calc`/`Checks` | designed: reading order, a dominant metric, chart beside table; concept `formal-report`, `data-dashboard`, or `editorial-magazine` | `Report` in HTML; `Data`/`Calc` native or `data-table` |
| Tracker (status, tasks, pipeline) | one working sheet: an Excel table with a status column, filters, a few summary figures above | functional: frozen header, dropdown (`add_validation`) status, two-hue conditional format, a summary strip; concept `data-dashboard` or `quiet-minimal` | native (the table is the sheet); a summary strip may be HTML |
| Financial model | `Inputs`, `Calc`, `Summary`, `Checks` | conventions, not decoration: input/formula/link colours, tie-outs (`model-conventions.md`); the `Summary` may be a designed report | native; `Summary` optionally HTML |
| Data log / dump | one `Data` sheet | none: header row, formats, frozen header, autofilter; no title block, no charts unless asked; concept `quiet-minimal` at most | native only |
| Form / intake | `Form` (legend, example row, entry cells), `Lists` (choices) | a printable entry sheet: labelled cells, validation, unlocked fill cells, protection (`model-conventions.md` §6); concept `form-intake` | native; the form's frame may be HTML |

## Choose what the reader opens

Before placing cells, name the audience, period, units, and the question the
first sheet answers. Separate three jobs when the workbook needs them:

- Report: a concise finding, the important measures, native evidence, and its
  qualification on the same surface.
- Data or inputs: a filterable rectangular table with clear editable cells.
- Calculations and Checks: traceable formulas and explicit reconciliations.

The first sheet is not a decorated copy of every calculation. Link its figures
to the model. Keep input colors on working sheets; report emphasis follows
meaning rather than formula origin. State the legend where inputs are edited.

## Design before filling the grid

For an uncertain direction or an expensive redesign, a representative-content
trial can help. Compare arrangements at the same reading size and vary the
hierarchy or chart placement, not just colors. Use a trial when it resolves a
real choice; neither two variants nor a specimen is mandatory.

Use a deliberate report width, coherent column proportions, and intentional
row heights. Place a dominant metric or visual first, with subordinate labels
and supporting details. Large numerals alone are not a dashboard. Do not fill
unused page area with decoration or stretch a short validation table to a page.

Native ranges, styles and charts are the route for data, calculation, and model sheets, and for editing; a new designed surface is HTML (above).
`compose_sheet` is an optional preset; its `metrics` accept `formula`, `label`,
`detail`, and `numberFormat`. The preset decides where its table lands, so a
metric reads the table by name, not by cell: give `tableName` and write
`=SUM(Hubs[처리량 (건)])`. Use it only when its arrangement fits the design.
Keep record tables unmerged; merged report labels live outside them. Set page
setup after all intended charts and panels exist.

## Sheet anatomy — the recipes

One workbook, up to three kinds of sheet, and the same anatomy on both backends. Distances are Excel column
characters; colors are the concept's roles as hex without `#`. Take the anatomy the archetype above calls for: a data log has
none of the report parts, a tracker has a summary strip and no chart, and a title block, a metric strip, a banded or
bordered table, and a fill header are each a choice of the concept, not required parts.

- **Sheets by job**: `Report` (or `Summary`) first — the finding, the important measures, one or two native
  charts, the print area; `Data` / `Inputs` — one rectangular table per sheet, header in row 1, `freeze_panes
  row:2` (row names the first row that scrolls, so row 1 stays in view), `add_table` for records, `set_autofilter`; `Calc` — formulas that read the inputs, one formula per row
  copied across; `Checks` — the tie-outs (`model-conventions.md` §4). The report links to the model
  (`=Calc!B12`), never repeats a number by hand; a workbook with one table needs one sheet.
- **Title block on a report**: A1 eyebrow (`fontSize:9, bold:true, color:<accent>`), A2 title (`fontSize:16,
  bold:true, color:<ink>`), A3 subtitle or period (`fontSize:10, color:<muted>`), one empty row, then the table or the
  metric strip. Merge the title cells across the report width only; never merge inside a data table. A row
  holding 16 pt or larger type, or a merged band that wraps, takes `set_row_height` (about 1.3 × the size per
  line); a gutter or a label column takes `set_column_width`.
- **Metric strip** (two to four figures the report is about, above the table): one row of values — formulas that
  read the model (`=Calc!C10`), `fontSize:20, bold:true, color:<accent>` for the one the title names and `color:<ink>`
  for the rest, `numberFormat` with the unit (`#,##0"건"`, `0"분"`) — over one row of labels (`fontSize:9,
  color:<muted>`), each figure in its own column pair (`merge_cells` across two columns, never inside the data
  table), `set_row_height` about 1.4 × 20 pt on the value row, and one empty row before the table. The strip is the
  report's first reading; a blank half page under a small table is the strip's place.
- **Header row** (one treatment per concept: a `<tint>` fill with a `<line>` rule, a rule alone, an `<ink>` fill with `<paper>` type, or plain bold): `set_style range:<header> properties:{ bold:true, fillColor:<tint>, borders:{ bottom:{ style:'thin',
  color:<line> } }, verticalAlignment:'center' }`; figure columns `horizontalAlignment:'right'` (their header
  too — a date or a month is a figure Excel sets right, so its header goes right as well); the unit in the header
  (`처리량 (건)`), never in every cell. → runtime `header_alignment_mismatch` A label column right after a figure column
  takes `indent:1` (header and body): the figures end on their column's right edge, and without it "38" and
  "김서연" beside it read as one cell.
- **Total row**: `bold:true, borders:{ top:{ style:'medium', color:<accent> } }`, formulas (`=SUM`), never typed; a row
  that averages is labelled what it is (`평균`), never `합계`. → runtime `total_row_unmarked`
- **Excel tables** (`add_table`) take a style in the report's palette: `style:'TableStyleLight1'` (grey banding, no
  colour) under a report of any accent, a `TableStyleMedium` only when its hue is the report's own; left unnamed the
  table opens in Excel's blue and clashes with a green or coral report.
- **Checks**: one row per tie-out — what is compared, the difference (`=Report!C10-SUM(Ops[처리량 (건)])`), and the
  verdict as words, `=IF(ABS(B2)<0.5,"✓ 통과","✗ 확인")`, marked by `add_conditional_format` in the two state hues
  (a pale green fill with dark green type for good, a pale red fill with dark red type for bad — fixed state hues, not
  the accent); a bare TRUE/FALSE says
  nothing to the reader who opens the sheet.
- **Body rows**: no borders; `numberFormat` per column (`#,##0`, `0.0%`, `yyyy-mm-dd`, years `0`); banding
  (`fillColor:<tint>` on every other row) only on a table over ~15 rows; `autofit_range` on the whole
  table after the values are in, `minWidth` for a label column.
- **Input cells** (a financial model, or a sheet someone fills in): the finance colour conventions of
  `model-conventions.md` §1 (they belong to financial models and fill-in sheets only; a report surface follows its
  concept) and the three-line legend where the reader lands; `add_validation` on constrained inputs.
- **Charts**: `add_chart` with `seriesColors:[<accent>, <muted>, <line>]` (one accent, neutrals after it; a second
  hue only as the concept's `accent2` with its own job),
  `title` naming the unit, `showValues:true` for six or fewer points with `gridlines:false, valueAxis:false` (the
  labels carry the numbers), `highlight` on the bar the title is about (one series: the rest take `mutedColor`),
  `fontName` the sheet's face, `showLegend` only with two or more series, `zeroBaseline:true` for bars; placed at
  `cell` beside or under the table, as wide as the table (`toColumn`).
  `range` is the header row plus the rows under it, categories in its first column; a series that is not
  next to its categories joins by comma the way Excel reads it (`range:'A7:A12,D7:D12'`), same rows in
  every area. `width`/`height` are points: a 420 × 260 chart at `F5` reaches about column N and row 22,
  so the print area has to reach past it.
- **Conditional format**: at most two hues with a meaning the header or a legend states — good (pale green fill, dark
  green type), bad (pale red fill, dark red type) — `formula` relative to the
  range's first cell (`B2<0.9`); a `colorScale` only on a heat-map the reader compares across, never on a
  total column.
- **Print**: `set_page_setup printArea:<report range> fitToPagesWide:1 orientation:'landscape'` after the last
  chart exists; a one-page report adds `fitToPagesTall:1` — fitted by width alone, a report a few rows taller than
  the sheet printed its chart's axis on a second page; a data sheet prints as it lies, with `printTitleRows:'1'` (its
  header row) so every printed page names its columns — the frozen header the screen shows does not print.
  Margins are inches.

## Control visual noise

Use the recipient's available fonts consistently in cells and charts. Reserve
high contrast for the finding and the important values. Keep supporting tables
quiet: restrained banding, few boundaries, and aligned numbers with enough room
for their formatted values. Do not highlight a category merely because it is
last in the data.

Put each explanation once. An action says what to do; a caveat says what the
numbers exclude; an input legend says what can be changed. These are different
jobs, not text to repeat in every available box.

## Keep evidence native and legible

Choose the chart by the question: ordered bars for category comparison, a line
for a time series, and a part-to-whole chart only when the whole matters.
Preserve meaningful periods; do not invent equal time buckets just to reduce
the number of operations. Name units in the title or axis.

Use direct labels when they simplify reading. A legend must distinguish its
categories. Verify per-category colors on pie charts, not just series colors.
Inspect long category names, label/line collisions, number scale, and font
substitution in the final renderer. Prefer fewer useful labels over tiny text.

## Accept the saved result

After data and formulas are complete:

1. Recalculate and check the relevant tie-outs. Format and size numeric columns
   against cached results, not empty formula cells. Size label columns too:
   text only spills into an empty neighbour, so a label beside its value is cut
   at the column edge until `autofit_range` or an explicit width carries it.
   → runtime `label_truncated`, `column_too_narrow`
2. Set the report print area after all charts and panels exist. Fit reports to
   one page wide without shrinking text beyond readability; long data tables
   may continue vertically. Check the saved cell dimensions and drawing bounds,
   not an assumed points-per-column conversion.
3. Inspect every persisted report image at readable size. Record a keep/fix
   decision for hierarchy, grouping, legibility, chart meaning, and accidental
   empty regions. A compact Checks sheet is not a failed design merely because
   it leaves paper blank.
4. Fix material visual defects and render the changed sheets. Preserve the
   original and the improved workbook for a requested comparison. State which
   renderer was used and whether review was self-review.

Keep three outcomes separate: calculation/file integrity, visual judgement,
and the user's acceptance. Mechanical scores cannot substitute for the last
two. Never remove warnings or weaken formula, security, or compatibility checks
to make an attractive report pass.
