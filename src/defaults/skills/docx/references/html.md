# HTML route (Word)

The default route for a new designed Word document: the model writes HTML/CSS for the content, without selecting a preset, and passes it as `author`'s `script`. A local Chrome or Edge lays it out at the printable width of its `@page` sheet. The runtime maps computed type, spacing, fills, rules, and widths to native Word paragraphs, runs, headings, lists, tables, and pictures. Text stays editable, not a screenshot. Word flows differently from a browser: the supported mappings below and the converted-page comparison define what can be delivered.

## 1. The call
`office action:'author' path:<file.docx> script:<html> [overwrite:true] [mode:'portable'|'background'] [render:false]`
- Returns `session`, `audit`, `logs` (what could not be carried — each names its element), and unless `render:false` the rendered pages with `render.reviewToken` and `render.compare`: one image per page, the browser's print of the HTML on the left, the Word render on the right.
- The HTML is kept as `<file>.docx.mixdog-source.html`. **Default — fix by editing that file** and calling `author path:<file.docx>` with no `script` (no `overwrite` needed).
- Refusals land nothing: `html_failed` names the cause (a missing `@page` size, a browser that could not start).
- After landing, the document is an ordinary session: `batch` edits, `render`, `qa`, `finalize` as SKILL.md describes. A `<!-- BRIEF … -->` comment (`subject/audience/action`, `sources`, `facts`, optionally `concept` as free text) holds the document to its facts and asks the scored critique at finalize, as `design.brief` does.

## 2. Document contract
**Hard rule — the sheet is declared**: `@page { size: A4; margin: 20mm 20mm 18mm; }` (A3, A4, A5, B4, B5, letter, legal, each optionally `landscape`, or two lengths). The body is the text column: the runtime sets `body { margin: 0 }` and lays it out at the sheet's width between its margins. Pad inside boxes, never on `body`. → runtime `html_failed`
**Hard rule — Word's flow, not a canvas**: the document reads top to bottom. What maps:
| HTML / CSS | Word |
|---|---|
| `p`, a `div` of text, `h1`–`h3` | a paragraph in its own type and spacing; `h1`–`h3` take Heading 1–3 (the navigation pane and a contents field read them) |
| inline `strong`, `em`, `span` with colour or a background | runs in that type; an inline background is the run's shading |
| margins and padding between blocks | the paragraph's space before and after, as the browser measured the gap |
| a block with a top or bottom `border` (a rule under a title) | the paragraph's own rule, its padding the rule's gap |
| a block with a `border-left` (a pull quote, a callout) | the paragraph's left rule |
| a block with a `background` or a full `border` and padding (a callout, a box, the closing ask) | a one-cell table in that fill, rules, and padding |
| `display:flex` (row) or `display:grid` with side-by-side children (cards, a text column beside a side note) | a borderless table on the grid the browser drew: each child a cell in its own fill and padding, each gap an empty column |
| `<table>` | a Word table: the column widths, cell fills, per-side rules, padding, and alignment the browser drew; `thead` rows repeat on a new page; `break-inside: avoid` keeps it whole |
| `ul`, `ol`, nested to three levels | Word bullets and numbering (a new `ol` restarts at 1) |
| `hr` | a paragraph rule |
| `<img src>` (a local file or a `data:` PNG/JPEG) | a picture at its laid-out size; centred in its column, it is set centred |
| inline `<svg>`, `<canvas>`, `data-chart`, `data-icon`, or any element marked `data-docx-picture` | photographed at twice its size and placed as a picture (alt from `aria-label` or `data-alt`) |
| `break-before: page` / `break-after: page` | a page break; `break-after: avoid` keeps a block with the next |
| `<header>` / `<footer>` as children of `body` | the running header and footer; `{page}` and `{pages}` in the text are page fields (`{page} / {pages}`); `data-first-page="none"` leaves the first page without it (a cover) |

**Not carried** (reported in `logs`, never silently): `position: absolute|fixed` (left out), `transform` (drawn upright), CSS columns (one column), a picture inside a line of text (left out), `rowspan` (the cell keeps its first row), border radius and shadows (square, flat).
**Default — charts are `data-chart`**: the pdf skill's spec (type, labels, values or series, colors, format, labelColor, size, gap, axisLine…) drawn as SVG and placed as a picture; give the element a height. A chart the reader must edit belongs in a workbook.
**Default — type in pt, faces from the concept**: `font-family` lists the concept's face for each script (`${MIXDOG_SKILL_DIR}/../pptx/references/concepts.md` §5 menu: sans, serif, or mixed), the Latin face and the Korean face both named, a generic family last. Word writes the face name into the file; a recipient without it sees a substitute and the runtime says so (advisory, not blocking). **The document type scale** (shared with flowing PDF): body 10–11 pt at `line-height` 1.6–1.7 for Hangul (1.4–1.5 Latin; Word holds each line at exactly that pitch), captions and running heads 8.5–9 pt, title 24–32 pt, section heading 15–18 pt, subsection 12–13 pt. The deck's 13 pt text-mode body is a screen size and does not apply. `word-break: keep-all` on `body`.

## 3. Design
The document's direction is the one you chose, optionally from a concept (`${MIXDOG_SKILL_DIR}/../pptx/references/concepts.md`; the brief's `concept:` line is optional free text): its palette roles (`paper`, `ink`, `muted`, `line`, `tint`, `accent`) written as CSS custom properties on `:root` and used by name, its type pairing, and its table and emphasis forms. `writing.md` is for the words. Write the stylesheet for this document; do not carry over an earlier unrelated document's. What a frontier page does, and what to avoid:
- **The opening follows the genre**, not one anatomy. A decision brief or board report opens with the conclusion (title → lede → optionally a row of two to four figure cards → the conclusion in a carrier); a feature or essay opens with a headline and the first paragraph; a letter or memo opens with the sender block and subject line; a technical manual opens with title, version, and contents; a form opens with its title and instructions. Break an assertion title at a phrase with `<br>`, never leaving one word on its own line. Pages after it follow the same genre: assertion headings and an exhibit per section for a report, flowing prose for an essay.
- **Emphasis carriers — choose one for the concept, or none**: a boxed note (full border or one-cell table in `tint`), a tinted band across the text column, a margin note beside the prose, a left-rule quote, a bold lead sentence, an oversized numeral, or no callout at all. The order of this list is not a default order; a left-bar callout is one option among them, not the house form. A conclusion that is only one sentence may just be the first paragraph, set larger.
- **Exhibits are numbered and titled above, sourced below** where the document has exhibits: `그림 1. 월별 평균 대기 시간 (분)` in caption type over the chart or table, `출처: …` in `muted` caption type under it. A letter or essay has none.
- **A side note beside the prose** (`display:grid; grid-template-columns: 1.6fr 1fr`) carries a definition, a method, or a quote; it fills the space a short paragraph leaves beside a chart.
- **Tables are sized to their content**, figures right-aligned with the header over them and a total row set apart; the rest of the anatomy is the concept's: ruled (bold header on a rule, hairlines between rows, no vertical rules), zebra (alternating `tint` rows, no rules), open (a single rule under the header, generous rows), or a full grid (forms, technical parameter tables).
- **No page half empty by accident**: content that leaves most of the last page blank is regrouped (a side note, a closing box) or tightened, not padded. A page before the last that stops short — a table or figure kept whole moved on — is reported by `qa` and finalize as `page_bottom_empty`: keep `break-inside: avoid` for short tables and figures, and let a long table break with its `thead` repeating. A deliberate chapter or section break (`break-before: page`) that leaves a page short is fine when the critique records it as deliberate.
- Avoid the generated look `${MIXDOG_SKILL_DIR}/../pptx/references/html.md` §8 lists (cream paper and a terracotta accent, an all-caps label over every heading, identical shaded boxes everywhere, centred everything).

## 4. Review
Read every `render.compare` pair: the left is what the HTML meant, the right what Word drew. A difference in a box's fill or width, a table's columns, a picture's place, or a heading kept with its table is fixed in the HTML (or reported); the page breaks may fall differently — judge the Word side's breaks on their own. Then finalize as SKILL.md §1 step 5.
