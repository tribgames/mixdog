# Native Word authoring

The model owns the editing design. The tool implements it and reports structural
and rendering evidence; it must not choose a visual style merely because the
file is a Word document.

## Control map

- Page: `set_page properties:{ pageSize, orientation, topMargin, bottomMargin,
  leftMargin, rightMargin, columns, columnSpacing }`. A new document is A4;
  a US reader gets `pageSize:'letter'` (also `'legal'`, `'a3'`, `'a5'`,
  `'tabloid'`, or `[width, height]` in points), and `orientation` turns the
  sheet. Margins and `columnSpacing` are points;
  the margins together determine the body width. `columns:<n>` lays the section
  out in that many even columns and the prose flows through them — a newsletter
  or brochure page is a section property, never a row of text boxes — and
  `columns:1` returns the section to a single column.
  Without `section` the edit lands on the section being written into (the last);
  `section:<n>` revisits an earlier one.
- Notes: `add_note` (`SKILL.md` §4) also takes `paragraph:<n>` instead of
  `find`; its mark is a superscript reference.
- Sections: `insert_break kind:'section_next'` closes the current section and
  starts the next one on a new page (`'section_continuous'` on the same page),
  so a wide table can take `set_page properties:{ orientation:'landscape' }`
  while the prose before and after stays portrait. Running headers and page
  numbers carry across the break; `kind:'page'` is an ordinary page break.
- Paragraph: `append_text text style properties`. Use `Title`, `Heading 1`,
  `Heading 2` or `Normal` for the actual role. Each call creates one paragraph.
- Type: `properties:{ name, nameEastAsia, size, bold, italic, color }`.
  Latin and East Asian faces are independent. Set intentional values rather
  than inheriting an unknown template's display formatting.
- Flow: `properties:{ alignment, spacingBefore, spacingAfter, lineSpacing,
  keepWithNext, keepTogether, widowControl, pageBreakBefore }`.
  Spacing is in points. Keep headings with their next content, not every body
  paragraph with the next paragraph. Let body paragraphs flow before adding
  intentional breaks based on the render.
- Tab stops: a contents line, a signature line, or a label with its figure at
  the right margin is one paragraph with `\t` in `text` and
  `properties:{ tabStops:[{ position:<pt from the left margin>, alignment:'right',
  leader:'dot' }] }` — never dots or spaces typed to fill the gap, which break
  at any font or width change. The snapshot reads the tab back as `\t`.
- Tables and figures: use native `add_table`, cell/column formatting and
  `add_image altText:<what the picture shows>` — without the description the
  audit reports `missing_alt_text` and a reader who cannot see it gets nothing.
  Define column widths from the usable body width, not the page
  width. A table should not stand in for ordinary prose.
  A table's own text is set on the operation: `properties:{ fontName,
  fontNameEastAsia, fontSize, color, textStyle, spacingAfter }` reach every
  cell. Set `fontNameEastAsia` for a Korean table — cells left on the document
  default fall back per cell, and a Korean label lands on a different baseline
  from the figure beside it. Emphasis inside one cell stays with
  `set_table_cell_style`. The first row is the header and repeats on every
  continuation page; `repeatHeader:false` says the row is data.
  `alignment` places the whole table on the page (`left`, `center`, `right`);
  column alignment and the default anatomy are in `SKILL.md` §4 and "Table
  anatomy" below. Bullets, Korean word wrapping, and that anatomy read the same
  in Word and in the portable file.
- Footer: `add_page_numbers` supplies fields. `prefix:''`, `separator:' / '`
  is one available numbering treatment, not a required style.

Use `describe format:'docx' operation:<op>` for a missing operation field.
There is no required design-plan JSON or preliminary specimen; decide enough
to author the requested document, then inspect the real pages.

## Document anatomy (recipes in native operations)

The carriers a report needs beyond running prose, each as the operations that draw it the same in Word
and in the portable file. Distances are points; `properties` go on `append_text` (or `set_paragraph_format`
for an existing paragraph). Use a carrier when the content has that job, never as decoration (`SKILL.md` §4).

- **Type ladder for a Korean report** (body 10.5 pt): `Title` 24-26 bold · `Heading 1` 15-16 bold,
  `spacingBefore:18, spacingAfter:6, keepWithNext:true` · `Heading 2` 12.5-13 bold, `spacingBefore:12,
  spacingAfter:4, keepWithNext:true` · body `size:10.5, lineSpacing:18, spacingAfter:8, alignment:'left'`
  (lineSpacing is a minimum in points: 1.7× for Hangul, never 1.15× — Korean lines set at Latin leading
  touch; the alignment is explicit because a Korean Word's Normal style justifies, and justified Hangul
  opens gaps between words that the portable file, set left, never shows) · caption
  9 pt muted (`color:'6B7280'`). One Latin face and one East Asian face for the whole document
  (`name` + `nameEastAsia` on a paragraph, `fontName` + `fontNameEastAsia` on `add_table` — the table names its
  own type and refuses the paragraph's field names); an essay takes a serif pairing
  (Cambria + 바탕/Noto Serif KR), a brief a sans one (Calibri + 맑은 고딕/Noto Sans KR).
- **Cover group**: eyebrow (`size:9.5, bold:true, color:<accent>, spacingAfter:4`) → `Title` with
  `alignment:'left'` (Word's own Title style centers it and the portable file does not; say which) → subtitle
  (`size:13, color:'374151', spacingAfter:8`) → meta lines (`size:9.5, color:'6B7280'`) → a rule: an empty
  paragraph with `border:{ side:'bottom', size:8, color:<accent> }, spacingAfter:24`. The summary follows on
  the same page; `insert_break kind:'page'` only when the document is long enough to earn a cover page.
- **Table of contents**: `insert_toc paragraph:<after the cover>` once every `Heading 1..3` exists
  (`SKILL.md` §4 boundary); a document under six headings does not need one. Its own title ("목차") is a
  bold paragraph with the section-header look (`size:15, bold:true, keepWithNext:true`), never a `Heading`
  style — a heading lists itself as the first entry.
- **Section header**: `Heading 1` with `keepWithNext:true`; a numbered section carries its number in the text
  ("2. 근거"), never a typed tab or a list marker.
- **Callout** (the conclusion, a warning, the ask): one paragraph with `shading:'EEF2F7', border:{ side:'left',
  size:12, color:<accent> }, indentLeft:12, indentRight:12, spacingBefore:6, spacingAfter:12`; a label
  paragraph above it in the same field (`bold:true, size:8.5, color:<accent>, spacingAfter:2, shading, indentLeft`)
  when the field needs a name. Every paragraph of one callout carries the same `shading` and indents so the
  field reads as one.
- **Quote**: `indentLeft:16, border:{ side:'left', size:16, color:<accent> }, size:12.5, lineSpacing:20,
  color:'1F2937'`; the attribution a caption under it (`size:9, color:'6B7280', indentLeft:16`) beginning "— ".
- **Stat strip** (two to four figures with one cause): `add_table` with one row of values and one row of labels,
  `properties:{ borders:{ top:{ enabled:false }, left:{ enabled:false }, right:{ enabled:false }, insideV:{ enabled:false },
  insideH:{ enabled:false }, bottom:{ style:'single', size:4, color:'C9CED6' } }, fontSize:22, color:<accent>,
  columnAlignments:['left', …] }` and `set_table_cell_style` on the label row (`fontSize:9, color:'6B7280'`).
- **Caption**: the paragraph under a table or picture, `size:9, color:'6B7280', spacingBefore:4,
  spacingAfter:14`: what it shows and its source.
- **Two columns**: not a paragraph property; long prose that wants two columns is a section of its own
  with `set_page properties:{ columns:2 }` (Control map) — use a table with two borderless cells only for a
  short side-by-side (a before/after, a term and its definition), never for running text.
- **Table anatomy**: the default (a bold header on a rule, hairlines between rows, figures right through
  `columnAlignments`, every cell on its bottom edge so a Latin-only figure and a Hangul one share the row's
  baseline) is the anatomy; `shading` on the header only when the document's fields use the same tint. A
  figure column names its unit in the header ("처리량 (건)"), not in every cell. `set_table_cell_style`
  patches one cell (`fillColor`, `fontSize`, `bold`, `color`, `verticalAlignment`) and keeps the rest.

## Optional preset

`compose_document` remains a convenience for a brief whose built-in structure
actually suits the task. It picks type sizes, summary emphasis and spacing;
do not select it for a design-led task and then fight those choices.

It takes `title`, optional `subtitle`, `summary`, `metrics`, `sections`,
`footer` and `pageNumbers`. Sections may contain headings, paragraphs, bullets,
tables, quotes, callouts and roadmaps. A section table is `table:[[…],[…]]`
(first row as the header) or `table:{ headers:[…], rows:[[…]] }`; any other
shape is refused rather than dropped. `purpose` and `variant` select its family.
Use `describe ... operation:'compose_document'` before relying on unlisted
controls. Calling the composer or explicitly selecting `design.profile` opts
into preset design; otherwise use native operations.

## Local refinement

`set_paragraph_format` changes only supplied fields. `set_font find` styles
only the first matching phrase in the body, across text fragments; it does not
change matching footer text. Use those operations for local corrections.
If the design direction is wrong, revisit the hierarchy or body width rather
than shrinking the text until a page counter turns green.
