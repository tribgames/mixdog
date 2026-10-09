# Native Word authoring

The model owns the editing design. The tool implements it and reports structural
and rendering evidence; it must not choose a visual style merely because the
file is a Word document.

## Control map

- Document face: `set_document_font properties:{ name, nameEastAsia, size, color }`
  sets the body's face, size and ink as the document's own, so a paragraph
  added later — by `append_text` or by hand in Word — matches the body; a
  Korean document names an installed face covering Hangul and digits
  (for example Noto Sans KR, Malgun Gothic, or a Korean serif) so they
  share one.
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
  while the prose before and after stays portrait. Break before the heading that
  introduces the table, so the heading, its lead-in, and the table share the
  landscape page: broken after the lead-in, the portrait page held a heading and one
  paragraph above an empty page, and the table stood on the next page without its
  heading. Running headers and page numbers carry across the break; `kind:'page'`
  is an ordinary page break.
- Paragraph: `append_text text style properties`. Use `Title`, `Heading 1`,
  `Heading 2` or `Normal` for the actual role. Each call creates one paragraph.
- Lists: `properties:{ listKind:'bullet'|'number', listLevel }`. A numbered list
  starts again at 1 after a heading, a body paragraph, a callout, or a table; the
  step that carries a procedure on past a note between its steps takes
  `listContinue:true`, or it reads 1 again. Its levels count the global
  1. a. i., and a list that opens on Korean text counts 1. 가. 1), the Korean
  document convention; `listNumbering:'global'|'korean'` names it for the list an
  item opens, and an item that continues a list keeps the list's own.
- Type: `properties:{ name, nameEastAsia, size, bold, italic, color }`. Hangul, kana, and Han have no italic (Word
  and LibreOffice slant them synthetically): a Korean pull quote or caption is set apart by colour, weight, a rule, or
  an indent instead.
  Latin and East Asian faces are independent. Set intentional values rather
  than inheriting an unknown template's display formatting.
- Flow: `properties:{ alignment, spacingBefore, spacingAfter, lineSpacing,
  keepWithNext, keepTogether, widowControl, pageBreakBefore }`.
  Spacing is in points. Keep headings with their next content, not every body
  paragraph with the next paragraph. Let body paragraphs flow before adding
  intentional breaks based on the render. A clause that carries its own mark in
  the text ("①", "가.") hangs it: `text:'①\t…'` with `indentLeft:18,
  indentFirstLine:-18`, so a wrapped line starts under the words, not under the mark.
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
  continuation page; `repeatHeader:false` says the row is data, and
  `headerRows:<n>` makes a header of several rows (see "Table anatomy").
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
Colours are the author's palette roles — `<ink>`, `<muted>`, `<line>`, `<tint>`, `<accent>` — as six-digit hex.
The optional concept examples are not required. The carriers below are the native route's (editing a
document, a template, a small generated one); a new designed document draws the same jobs in HTML, with the concept's
own forms (`references/html.md` §3). Where this list gives one form (a left-bar callout, a ruled table), it is one
option: a boxed note, a tinted band, or no callout, and open or zebra tables, are equally native (`border`, `shading`, `borders`).

- **Type ladder for a Korean report** (body 10.5 pt): `Title` 24-26 bold · `Heading 1` 15-16 bold,
  `spacingBefore:18, spacingAfter:6, keepWithNext:true` · `Heading 2` 12.5-13 bold, `spacingBefore:12,
  spacingAfter:4, keepWithNext:true` · body `size:10.5, lineSpacing:18, spacingAfter:8, alignment:'left'`
  (lineSpacing is a minimum in points: 1.7× for Hangul, never 1.15× — Korean lines set at Latin leading
  touch; the alignment is explicit because a Korean Word's Normal style justifies, and justified Hangul
  opens gaps between words that the portable file, set left, never shows) · caption
  9 pt `<muted>`. This is the one document scale, shared with flowing PDF. One Latin face and one East Asian face
  for the whole document (`name` + `nameEastAsia` on a paragraph, `fontName` + `fontNameEastAsia` on `add_table` — the
  table names its own type and refuses the paragraph's field names), chosen from the concept's face menu: an essay or
  letter takes a serif pairing (Cambria + 바탕/Noto Serif KR), a brief sets both faces in a Korean sans (`name` and
  `nameEastAsia` both Noto Sans KR, or both Malgun Gothic), an editorial piece mixes serif headings with a sans body:
  beside Calibri figures the Hangul prints larger and heavier, and "184,200건" reads as two sizes. The ladder is
  written once, as the document's styles, before the first
  paragraph: `{ op:'define_styles', styles:{ Title:{ name, nameEastAsia, size:24, bold:true, color:<ink>,
  alignment:'left', lineSpacing:30, lineSpacingRule:'exact', spacingAfter:8 }, 'Heading 1':{ …, size:15, bold:true,
  spacingBefore:18, spacingAfter:6, keepWithNext:true }, 'Heading 2':{ … }, Normal:{ name, nameEastAsia, size:10.5,
  lineSpacing:18, spacingAfter:8, alignment:'left' }, Caption:{ size:9, color:<muted>, spacingBefore:4,
  spacingAfter:14 } } }`; then `append_text style:'Heading 1' text:'2. 근거'` carries nothing else, and a
  caption is `style:'Caption'`.
- **Cover group**: eyebrow (`size:9.5, bold:true, color:<accent>, spacingAfter:4`) → `Title` with
  `alignment:'left'` (Word's own Title style centers it and the portable file does not; say which) and
  `lineSpacing:<1.25 × its size>, lineSpacingRule:'exact'` (30 for 24 pt) — a minimum can only widen a line, and on
  Malgun Gothic's own line the two lines of one wrapped title stood nearly twice the size apart → subtitle
  (`size:13, color:<ink> or <muted>, spacingAfter:8`) → meta lines (`size:9.5, color:<muted>`) → a rule: an empty
  paragraph with `border:{ side:'bottom', size:8, color:<accent> }, spacingAfter:24`. The summary follows on
  the same page; `insert_break kind:'page'` only when the document is long enough to earn a cover page.
- **Table of contents**: `insert_toc paragraph:<after the cover>` once every `Heading 1..3` exists
  (`SKILL.md` §4 boundary); `paragraph` is the one the contents follow (the "목차" label's number). A portable
  render writes each entry's page behind a dot leader, so render before reading the contents page; a document
  under six headings does not need one. Its own title ("목차") is a
  bold paragraph with the section-header look (`size:15, bold:true, keepWithNext:true`), never a `Heading`
  style — a heading lists itself as the first entry.
- **Section header**: `Heading 1` with `keepWithNext:true`; a numbered section carries its number in the text
  ("2. 근거"), never a typed tab or a list marker.
- **Callout** (the conclusion, a warning, the ask) — optional, and its form is the concept's: a tinted band
  (`shading:<tint>` with indents, no border), a boxed note (`border` on all four sides in `<line>` or `<accent>`), a
  left rule (below), or none — the conclusion as a larger first paragraph. The left-rule form: one paragraph with
  `shading:<tint>, border:{ side:'left',
  size:12, color:<accent> }, indentLeft:12, indentRight:12, spacingBefore:6, spacingAfter:12`; a label
  paragraph above it in the same field (`bold:true, size:8.5, color:<accent>, spacingAfter:2, shading, indentLeft`)
  when the field needs a name. Every paragraph of one callout carries the same `shading` and indents so the
  field reads as one. Points inside it (a warning's items) are list items with those same properties plus
  `listKind`: on a list item `indentLeft` places the mark and the text hangs 18 pt after it, inside the field.
- **Quote**: `indentLeft:16, border:{ side:'left', size:16, color:<accent> }, size:12.5, lineSpacing:20,
  color:<ink>, spacingBefore:10, keepTogether:true, keepWithNext:true`; the attribution a caption under it
  (`size:9, color:<muted>, indentLeft:16, spacingAfter:12`) beginning "— ". The two keeps hold the quote whole and on
  the page of its attribution — without them a two-line quote ending a page left one line behind and carried the other
  over with its speaker. The space above sets it apart from what it follows: without it a quote under a list sat as
  close to the last item as the items to each other and read as one more of them.
- **Stat strip** (two to four figures with one cause): `add_table` with one row of values and one row of labels,
  `properties:{ borders:{ top:{ enabled:false }, left:{ enabled:false }, right:{ enabled:false }, insideV:{ enabled:false },
  insideH:{ enabled:false }, bottom:{ style:'single', size:4, color:<line> } }, repeatHeader:false,
  columnAlignments:['left', …], rowStyles:[{ fontSize:22, color:<accent>, bold:true }, { fontSize:9, color:<muted> }] }`
  — one table, the figures at display size over their labels at caption size. A single `fontSize` sets the labels at
  22 pt too ("평균 대기 시간 단축" over three lines). → runtime `table_label_oversized`
- **Chart**: `add_chart categories:[…] values:[…] chartType:'bar'|'column' unit highlight forecast accent` — one series
  drawn as a picture in the document's accent (`accent:<accent hex>`, the concept's accent that the document's headings and emphasis use;
  without it the writer's teal), every bar carrying its value and no grid; `bar` for a ranking (names on the
  left), `column` for periods, `highlight` the bar the paragraph is about, `forecast` the bars that are projections
  (a plan, an estimate: drawn pale in a dashed outline, never as counted figures). It lands like `add_image` (`width`,
  `properties:{ alignment:'center' }`) with a caption under it; its altText names each figure. The bars cannot be
  edited in Word — a chart the reader will edit belongs in a workbook.
- **Caption**: the paragraph under a table or picture, `size:9, color:<muted>, spacingBefore:4,
  spacingAfter:14`: what it shows and its source. The table above it takes `properties.keepWithNext:true`
  so the caption never starts the next page alone, and the paragraph that introduces a table or chart takes
  `keepWithNext:true` too — without it a heading and its lead-in closed one page and the table opened the next; a picture (`add_image`) keeps with its caption on its own,
  and `properties:{ alignment:'center' }` centres it.
- **Running header**: `set_header_footer kind:'header'` with `properties:{ name, nameEastAsia, size:8.5,
  color:<muted> }` — a running head and folio are a choice of the concept (a letter or essay takes none) — without them the line prints in the document default, louder than the eyebrow under it.
  The cover page carries neither: after the default header and the page numbers (`add_page_numbers separator:' / '`
  prints "1 / 3"), `set_header_footer kind:'header' variant:'first' text:''` and the same for the footer give the
  first page empty ones.
- **Total row**: `add_table properties.totalRow:true` sets the last row bold over a rule; a total set like the rows
  it sums reads as one more of them. → runtime `total_row_unmarked`
- **Two columns**: not a paragraph property; long prose that wants two columns is a section of its own
  with `set_page properties:{ columns:2 }` (Control map), opened by `insert_break kind:'section_continuous'` under
  the masthead or picture and closed by another one (then `columns:1`) so the two columns balance on the page — use a table with two borderless cells only for a
  short side-by-side (a before/after, a term and its definition), never for running text.
- **Table anatomy**: the default (a bold header on a rule, hairlines between rows, figures right through
  `columnAlignments`, body cells on their top edge so a row reads from its first line and the header on its
  bottom edge over the rule, one exact line pitch per cell so a Latin-only figure and a Hangul one share the
  row's baseline) is the anatomy; `shading` on the header only when the document's fields use the same tint. A
  figure column names its unit in the header ("처리량 (건)"), not in every cell. `set_table_cell_style`
  patches one cell (`fillColor`, `fontSize`, `bold`, `color`, `verticalAlignment`) and keeps the rest.
  `insert_table_row` copies the row it goes before, so a data row inserted above a total takes the total's shading
  and weight: give its cells the data rows' look back (`fillColor:null` takes the shading away, `bold:false` on the
  figures). A two-level
  header — a group label over the columns it spans ("3분기 처리량" over 7월 · 8월 · 9월) — is `properties.headerRows:2`
  with the group merged across its columns and the single labels down both rows (`merge_table_cells`, right to
  left): every header row is set bold on its bottom edge and repeats on a continuation page. Left at one header
  row, the months under the group are set as data, plain and on their top edge.

## Optional preset

`compose_document` remains a convenience for a brief whose built-in structure
actually suits the task. It picks type sizes, summary emphasis and spacing;
do not select it for a design-led task and then fight those choices.

It takes `title`, optional `subtitle`, `summary`, `metrics` (`{ value, label,
detail? }`; the accent goes to the figure marked `emphasis: true`, else to the
first), `sections`, `footer` and `pageNumbers`. Sections may contain headings, paragraphs, bullets,
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
