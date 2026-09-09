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
   against cached results, not empty formula cells.
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
