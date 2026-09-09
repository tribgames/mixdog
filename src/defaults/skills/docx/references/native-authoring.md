# Native Word authoring

The model owns the editing design. The tool implements it and reports structural
and rendering evidence; it must not choose a visual style merely because the
file is a Word document.

## Control map

- Page: `set_page properties:{ orientation, topMargin, bottomMargin, leftMargin,
  rightMargin }`. Margins are points; together they determine the body width.
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
- Tables and figures: use native `add_table`, cell/column formatting and
  `add_image`. Define column widths from the usable body width, not the page
  width. A table should not stand in for ordinary prose.
- Footer: `add_page_numbers` supplies fields. `prefix:''`, `separator:' / '`
  is one available numbering treatment, not a required style.

Use `describe format:'docx' operation:<op>` for a missing operation field.
There is no required design-plan JSON or preliminary specimen; decide enough
to author the requested document, then inspect the real pages.

## Optional preset

`compose_document` remains a convenience for a brief whose built-in structure
actually suits the task. It picks type sizes, summary emphasis and spacing;
do not select it for a design-led task and then fight those choices.

It takes `title`, optional `subtitle`, `summary`, `metrics`, `sections`,
`footer` and `pageNumbers`. Sections may contain headings, paragraphs, bullets,
tables, quotes, callouts and roadmaps. `purpose` and `variant` select its family.
Use `describe ... operation:'compose_document'` before relying on unlisted
controls. Calling the composer or explicitly selecting `design.profile` opts
into preset design; otherwise use native operations.

## Local refinement

`set_paragraph_format` changes only supplied fields. `set_font find` styles
only the first matching phrase in the body, across text fragments; it does not
change matching footer text. Use those operations for local corrections.
If the design direction is wrong, revisit the hierarchy or body width rather
than shrinking the text until a page counter turns green.
