# HTML route (Excel report sheets)

The default route for a new workbook's designed surface: the model writes HTML/CSS for each sheet's purpose, without selecting a preset, and passes it as `author`'s `script`. A local Chrome or Edge lays it out; the runtime maps the measured edges to a native Excel grid with values, live formulas, number formats, merges, fills, borders, tables, charts, and notes. Cells are not screenshots. Excel's rectangular grid constrains the mapping, so compare the converted sheet with the HTML and check calculations, editability, and print layout.

## 1. The call
`office action:'author' path:<file.xlsx> script:<html> [overwrite:true] [mode:'portable'|'background'] [render:false]`
- Returns `session`, `audit`, `logs` (what could not be carried, each naming its element), and unless `render:false` the rendered pages with `render.reviewToken` and `render.compare`: per sheet, the browser's drawing of the section on the left and the Excel render on the right.
- The HTML is kept as `<file>.xlsx.mixdog-source.html`. **Default — fix by editing that file** and calling `author path:<file.xlsx>` with no `script`.
- After landing, the workbook is an ordinary session: `batch`, `render`, `qa`, `finalize` as SKILL.md describes; `finalize` recalculates and refuses formula errors. A `<!-- BRIEF … -->` comment (`subject/audience/action`, `sources`, `facts`, optionally `concept` as free text) holds the sheet to its facts and asks the scored critique at finalize.

## 2. Workbook contract
**Hard rule — one section per worksheet**: `<section data-sheet="보고">` is a sheet named 보고, in document order. Without one the call is refused. → runtime `html_failed`
**Hard rule — the numbers live**: every derived figure is `data-formula`, never typed. The element's text is what the browser shows (write the expected result so the HTML reads right); the cell holds the formula.
| HTML | Excel |
|---|---|
| a text block (`p`, a `div` of text) | its value in the top-left cell, merged across the cells its box spans, in its face, size, weight, colour, and alignment; several lines wrap |
| `data-formula="=SUMIFS(Ops[처리량],Ops[월],{m6})"` | a live formula; `{id}` is the cell the element with that `id` landed on (qualified with its sheet when it stands on another) |
| `data-value="2026-06-01"` `data-format='m"월"'` | the stored value and its number format (a date stays a date: `m"월"` shows 6월 and still sorts and computes) |
| `data-note="자료: …"` | the cell's note: the figure's source or assumption |
| `<td>` text `184,200`, `+12.0%`, `2026-09-30` | a number or date in the format it was written in (`#,##0`, `+0.0%`, `yyyy-mm-dd`) |
| `<table>` | cells on the grid the browser drew, `th` and `thead` as headers; `colspan`/`rowspan` merge |
| `<table data-table="Ops" data-freeze="header">` | an Excel table named Ops (structured references `Ops[처리량]`; no merges inside it), its header frozen and repeated in print |
| a block's `background`, `border-*` | cell fills and per-side rules over the cells it covers (a card is a filled block of cells) |
| `<div data-chart='{…}' data-range="{mh}:{m9},{wh}:{w9}">` | a native chart over those cells: the first area the categories, each next one a series, each from its header down |
| `data-chart` with `labels`/`values` and no `data-range` | a native chart over a hidden `차트 데이터` sheet holding those values |
| `<img>`, inline `<svg>`, `<canvas>` | a picture at its laid-out size (`alt` or `data-alt` is its alt text) |
| on the section: `data-freeze="5"`, `data-gridlines="show"`, `data-orientation="landscape"`, `data-fit="page"`, `data-hidden="true"` | frozen rows above row 5, gridlines on (off by default), print orientation, one printed page, a hidden sheet |

Chart spec keys: `type` (`col`, `bar`, `line`, `area`, `pie`, `doughnut`), `colors` (one series in two colours, one of them used once, is that bar highlighted and the rest muted), `format` (value labels, `0"분"`), `showValues`, `legend`, `grid`, `valueAxis`, `title` (or `data-title`). The chart takes the box the browser drew; give it a height.
Each sheet prints one page wide (a report sheet one page), orientation from its proportions unless set, with its print area at its content.
**Not carried** (reported in `logs`): text beside child blocks (wrap it in its own element), merges inside a `data-table`, `position: absolute|fixed` (placed where it lies — check the cell it lands on), underline and strikethrough, border radius and shadows.

## 3. Design
- **Choose the archetype first** (`references/report-design.md` "Archetypes"), and a concept if one helps (optional; `${MIXDOG_SKILL_DIR}/../pptx/references/concepts.md`); the layout, palette roles (as CSS custom properties: `--paper`, `--ink`, `--muted`, `--line`, `--tint`, `--accent`), and face come from them. The brief may carry `concept:` as free text; nothing requires it.
- **Report and data apart**: the report sheet is designed, the data sheet is one `data-table` with a frozen header. Each figure on the report is a formula over the table; the table's figures are formulas over the data sheet. `references/report-design.md` owns the sheet roles and the acceptance. Choose a layout skeleton that fits the surface — these are three, not a menu to default to the first of:
  - **KPI strip + table beside chart**: eyebrow, assertion title, a row of two to four figure cards (`display:grid; grid-template-columns: repeat(4, 1fr)`), then a table beside its chart (`grid-template-columns: 380px 1fr`) and a sourced note.
  - **Dashboard grid**: a header strip (period, source), a 12-column grid of modules — big-number cards, two or three small charts on shared scales, a compact table with status cells (`display:grid; grid-template-columns: repeat(12, 1fr)`, modules spanning 3, 4, or 6).
  - **Single-column story**: a headline, then alternating one short insight paragraph and one exhibit (a chart or table) down one column; no card row. Or, for a tracker or form, the table or entry grid fills the section under a one-line title with a legend, no cards at all.
- **Sizes in px on a fixed width**: the report section has a width (for example `width: 1060px`; 720–1280 px as the skeleton needs) and padding; Excel's grid is cut from it, so a layout left to the window's width lands on the window's. Type 11-14 px for cells, 20-26 px for a title and card figures; one face for Hangul and figures, from your chosen direction (the concept menu in `concepts.md` §5, if you use one) and one that carries Hangul and digits alike.
- **Ids name the cells**: give every cell a formula or a chart reads an `id` (`m6`, `v6`), the header cells a chart range starts at too (`{mh}:{m9}`), and write formulas and ranges with them — never a guessed `B15`.
- Avoid the generated look `${MIXDOG_SKILL_DIR}/../pptx/references/html.md` §8 lists (identical shaded boxes everywhere, decorative colour with no job, centred everything).

## 4. Review
Read every `render.compare` pair: the left is what the HTML meant, the right what Excel drew. A card's fill or span, a column's width, a chart's place, or a value's format that differs is fixed in the HTML (or reported). Snapshot the report sheet once to confirm the formulas and their values, then finalize as SKILL.md §3 step 5.
