# Report surfaces and working grids

Use this guide for an Excel report, dashboard, or visual redesign. A CSV export
or a small input correction does not need a presentation workflow.

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

Native ranges, styles and charts are the default authoring route.
`compose_sheet` is an optional preset; its `metrics` accept `formula`, `label`,
`detail`, and `numberFormat`. Use it only when its arrangement fits the design.
Keep record tables unmerged; merged report labels live outside them. Set page
setup after all intended charts and panels exist.

## Sheet anatomy — the recipes

One workbook, three kinds of sheet, and the same anatomy on both backends. Distances are Excel column
characters; colors are hex without `#`.

- **Sheets by job**: `Report` (or `Summary`) first — the finding, the important measures, one or two native
  charts, the print area; `Data` / `Inputs` — one rectangular table per sheet, header in row 1, `freeze_panes
  row:1`, `add_table` for records, `add_autofilter`; `Calc` — formulas that read the inputs, one formula per row
  copied across; `Checks` — the tie-outs (`model-conventions.md` §4). The report links to the model
  (`=Calc!B12`), never repeats a number by hand; a workbook with one table needs one sheet.
- **Title block on a report**: A1 eyebrow (`fontSize:9, bold:true, color:<accent>`), A2 title (`fontSize:16,
  bold:true`), A3 subtitle or period (`fontSize:10, color:'6B7280'`), one empty row, then the table or the
  metric strip. Merge the title cells across the report width only; never merge inside a data table.
- **Header row**: `set_style range:<header> properties:{ bold:true, fillColor:'EEF2F7', borders:{ bottom:{ style:'thin',
  color:'C9CED6' } }, verticalAlignment:'center' }`; figure columns `horizontalAlignment:'right'` (their header
  too); the unit in the header (`처리량 (건)`), never in every cell.
- **Total row**: `bold:true, borders:{ top:{ style:'medium', color:<accent> } }`, formulas (`=SUM`), never typed.
- **Body rows**: no borders; `numberFormat` per column (`#,##0`, `0.0%`, `yyyy-mm-dd`, years `0`); banding
  (`fillColor:'F7F9FB'` on every other row) only on a table over ~15 rows; `autofit_range` on the whole
  table after the values are in, `minWidth` for a label column.
- **Input cells** (a model or a sheet someone fills in): `color:'0000FF'` for a typed input, `fillColor:'FFFF00'`
  for a cell to fill in, black for formulas, and the three-line legend where the reader lands
  (`model-conventions.md` §1); `add_validation` on constrained inputs.
- **Charts**: `add_chart` with `seriesColors:[<accent>, 'A6B4C4', 'D1D9E0']` (one accent, neutrals after it),
  `title` naming the unit, `showValues:true` for six or fewer points, `showLegend` only with two or more
  series, `zeroBaseline:true` for bars; placed at `cell` beside or under the table, as wide as the table.
  `range` is the header row plus the rows under it, categories in its first column; a series that is not
  next to its categories joins by comma the way Excel reads it (`range:'A7:A12,D7:D12'`), same rows in
  every area. `width`/`height` are points: a 420 × 260 chart at `F5` reaches about column N and row 22,
  so the print area has to reach past it.
- **Conditional format**: at most two hues with a meaning the header or a legend states — good
  `fillColor:'E3F1E8', color:'1B6B3A'`, bad `fillColor:'FBE4E1', color:'8A2A20'` — `formula` relative to the
  range's first cell (`B2<0.9`); a `colorScale` only on a heat-map the reader compares across, never on a
  total column.
- **Print**: `set_page_setup printArea:<report range> fitToPagesWide:1 orientation:'landscape'` after the last
  chart exists; a data sheet prints as it lies.

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
