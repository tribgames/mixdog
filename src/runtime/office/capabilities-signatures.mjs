// Operation input signatures: which fields each Office operation requires,
// accepts, or takes as alternatives, per format.

export function signature(required = [], optional = [], { oneOf = [], propertySets = [], notes = '' } = {}) {
  return { required, optional, oneOf, propertySets, notes };
}

export const COMMON_SIGNATURES = {
  replace_text: signature(['find', 'replace'], ['author'], {
    notes:
      'In a Word document with track_changes on, only the matched characters are wrapped as a deletion plus an insertion (a match across a tab, break, or field rewrites that paragraph whole) and author labels the change.',
  }),
  fill_template: signature(['tokens'], ['strict', 'author'], {
    notes:
      'Use strict:true to fail when a token is missing or left unresolved. In a Word document with track_changes on, each token is filled as a tracked deletion plus insertion and author labels the change.',
  }),
};

export const FORMAT_SIGNATURES = {
  docx: {
    compose_document: signature(
      ['title'],
      [
        'claimId',
        'purpose',
        'expressionMode',
        'variant',
        'subtitle',
        'summary',
        'summaryLabel',
        'eyebrow',
        'titleSize',
        'language',
        'nameEastAsia',
        'meta',
        'metrics',
        'sections',
        'footer',
        'orientation',
        'pageNumbers',
      ],
      {
        propertySets: ['design'],
        notes:
          'Optional preset, not the default authoring path. It chooses typography, summary emphasis and spacing. For an authored design use set_page and native append_text/table/image operations with explicit properties.',
      }
    ),
    append_text: signature(['text'], ['style', 'properties', 'author'], {
      propertySets: ['paragraph', 'font', 'paragraphFormat'],
      notes:
        'Creates one real paragraph. With track_changes on the paragraph is inserted as a tracked change; author labels it, as it does on every other tracked edit.',
    }),
    set_paragraph_text: signature(['paragraph', 'text'], ['author'], {
      notes:
        'With track_changes on, the old runs are marked deleted and one inserted run carries the new text; author labels the change.',
    }),
    set_run_text: signature(['paragraph', 'run', 'text']),
    normalize_runs: signature([], [], {
      notes:
        'Portable backend: merges adjacent runs with identical formatting, drops proofing marks and rsid attributes, and never crosses a tracked-change boundary; run it first on a document Word fragmented so replace_text and fill_template match whole phrases. An already-clean document, and every Microsoft Office session (Word searches across runs itself), returns changed:false — pass allowNoChange:true when running it routinely.',
    }),
    set_table_cell: signature(['table', 'row', 'col', 'text'], ['author']),
    add_table: signature(['values'], ['paragraph', 'rows', 'columns', 'properties'], {
      propertySets: ['table'],
      notes:
        'properties.alignment places the table on the page (left, center, right); properties.columnAlignments sets the text of each column (one of left, center, right, justify per column); without it a column of figures (184,200, 2.1%, 2.6억 원) sets right and the rest left. Without style, borders, or shading the table takes a bold header row with a rule under it and hairlines between rows; headerBold:false keeps the header plain.',
    }),
    set_table_style: signature(['table', 'properties'], [], {
      propertySets: ['table'],
      notes:
        'Replaces the table-level properties; columnAlignments re-aligns the text of every existing cell in each column.',
    }),
    merge_table_cells: signature(['table', 'row', 'col'], ['rowSpan', 'colSpan']),
    set_table_cell_style: signature(['table', 'row', 'col', 'properties'], [], {
      propertySets: ['tableCell'],
      notes:
        "Patches the named properties only: the width and the bottom alignment a new table's cells carry stay unless set. fontSize also repitches the cell's lines (1.3× the size, at least), so a 9 pt label row under a 22 pt value row sits close to it.",
    }),
    set_paragraph_format: signature(['paragraph', 'properties'], [], {
      propertySets: ['paragraphFormat'],
      notes: 'Patches supplied properties only; lineSpacing is a minimum in points on both backends.',
    }),
    remove_paragraph: signature(['paragraph'], ['author']),
    move_paragraph: signature(['paragraph', 'index']),
    set_paragraph_style: signature(['paragraph', 'style']),
    set_font: signature(['find', 'properties'], [], {
      propertySets: ['font'],
      notes:
        'Formats only the first matching body phrase across runs; excludes headers/footers and preserves unrelated formatting. nameEastAsia sets the East Asian font independently.',
    }),
    add_image: signature(['path'], ['paragraph', 'width', 'height', 'altText', 'properties'], {
      propertySets: ['paragraphFormat'],
      notes:
        "altText describes the picture for a reader who cannot see it; without it the audit reports missing_alt_text. The picture's paragraph keeps with the next one (its caption) unless properties.keepWithNext is false; properties.alignment:'center' centres it.",
    }),
    add_comment: signature(['find', 'text'], ['author', 'initials'], {
      notes:
        'find is the body phrase the comment anchors to — the snapshot reports it back as anchoredText, which this operation also accepts.',
    }),
    add_comment_reply: signature(['comment', 'text'], ['author', 'initials']),
    delete_comment: signature(['comment']),
    set_comment_resolved: signature(['comment', 'resolved']),
    insert_table_row: signature(['table', 'row']),
    delete_table_row: signature(['table', 'row']),
    insert_table_column: signature(['table', 'column']),
    delete_table_column: signature(['table', 'column']),
    set_header_footer: signature(['text'], ['section', 'kind', 'variant', 'header', 'properties'], {
      propertySets: ['headerFooter'],
      notes:
        "kind names what to write — 'header' or 'footer' (header:false means the footer too). variant picks the page it applies to: default, first (also sets titlePg), or even.",
    }),
    track_changes: signature(['enabled']),
    resolve_revision: signature(['resolution'], ['revision', 'id'], {
      oneOf: [['revision'], ['id']],
      notes:
        'revision is the ordinal of the snapshot revisions list on both backends; id is the w:id the snapshot reports and is honoured by the portable backend only (Word exposes no revision id).',
    }),
    resolve_revisions: signature(['resolution'], ['author'], {
      notes:
        "author settles only that reviewer's revisions (text wrappers, paragraph marks, table rows, formatting records) on both backends and leaves the other reviewers' changes tracked; without it every revision resolves.",
    }),
    set_page: signature(['properties'], ['section'], {
      propertySets: ['page'],
      notes:
        "pageSize names the sheet ('a4' default, 'letter', 'legal', 'a3', 'a5', 'tabloid', or [width, height] in points) and orientation turns it; without orientation the section keeps the way it lies. Margins and columnSpacing are points. columns lays the section out in that many even columns and the text flows through them (1 returns it to a single column), so a newsletter page needs no text boxes.",
    }),
    fit_table: signature(['table']),
    insert_toc: signature([], ['paragraph', 'lowerHeadingLevel', 'upperHeadingLevel'], {
      notes:
        'Lands in a paragraph of its own after paragraph (or at the end of the document, where the batch has reached) on both backends, and is rebuilt from the Heading 1..3 paragraphs at every save. The list carries no title of its own: write one before it as a bold paragraph, never as a Heading, or the contents would list themselves.',
    }),
    add_page_numbers: signature(
      [],
      ['section', 'kind', 'variant', 'prefix', 'separator', 'includeTotal', 'alignment'],
      {
        notes:
          "Writes into the footer unless kind:'header' asks otherwise; variant picks default, first, or even, as for set_header_footer. The number alone, centred, on both backends; prefix ('Page') and includeTotal:true with separator ('/' by default) add to it.",
      }
    ),
    insert_break: signature([], ['paragraph', 'kind']),
    set_list: signature(['paragraph', 'kind'], ['level']),
    add_hyperlink: signature([], ['find', 'paragraph', 'address', 'subAddress', 'display'], {
      oneOf: [['find'], ['paragraph']],
      propertySets: ['links'],
    }),
    add_bookmark: signature(['name'], ['find', 'paragraph'], { oneOf: [['find'], ['paragraph']] }),
    set_content_control: signature(['text'], ['tag', 'control'], {
      oneOf: [['tag'], ['control']],
      notes:
        'Fills a Word content control the snapshot lists under contentControls (tag, or its 1-based control ordinal), across the body, headers, and footers. The value replaces the placeholder outright and the control stops showing prompt text; a control locked against editing is reported rather than silently skipped.',
    }),
    add_note: signature(['text'], ['kind', 'find', 'paragraph'], {
      oneOf: [['find'], ['paragraph']],
      notes:
        'kind: footnote (default) | endnote. The superscript mark follows the cited phrase (anchor: "phrase"), or the end of the paragraph when the phrase is split by a tab, field, or drawing; the note text lands at the foot of the page or the end of the document, where a reader expects a source.',
    }),
    add_provenance: signature(['paragraph', 'source'], [], { propertySets: ['provenance'] }),
  },
  xlsx: {
    compose_sheet: signature(
      ['rows'],
      [
        'claimId',
        'purpose',
        'expressionMode',
        'variant',
        'sheet',
        'kind',
        'eyebrow',
        'title',
        'subtitle',
        'source',
        'headers',
        'metrics',
        'insights',
        'decision',
        'gates',
        'actions',
        'columnFormats',
        'tableName',
        'tableStyle',
        'chart',
      ],
      {
        propertySets: ['design'],
        notes:
          'Optional layout preset. For a model-authored report use native ranges, styles, merges and charts with explicit placement; choose this composer only when its built-in arrangement fits.',
      }
    ),
    set_cell: signature(['cell', 'value'], ['sheet']),
    set_formula: signature(['cell', 'formula'], ['sheet']),
    set_range: signature(['range', 'values'], ['sheet']),
    append_row: signature(['values'], ['sheet']),
    clear_cell: signature(['cell'], ['sheet']),
    add_sheet: signature(['name'], [], {
      notes:
        'Appends the sheet after the last one on both backends, so the order the batch names is the order the workbook opens in.',
    }),
    copy_sheet: signature(['sheet'], ['name']),
    delete_sheet: signature(['sheet']),
    rename_sheet: signature(['name'], ['sheet']),
    set_style: signature(['properties'], ['sheet'], {
      oneOf: [['cell'], ['range']],
      propertySets: ['cellStyle'],
    }),
    add_note: signature(['cell', 'text'], ['sheet']),
    delete_note: signature(['cell'], ['sheet']),
    set_drawing: signature(['drawing'], ['sheet', 'left', 'top', 'width', 'height'], {
      notes:
        'Moves or resizes a chart or picture already on the sheet. drawing is the name the snapshot reports or its 1-based index on that sheet; left/top/width/height are points, the unit add_chart places one with. This is the answer to drawing_overlap and drawing_outside_print_area.',
    }),
    delete_drawing: signature(['drawing'], ['sheet'], {
      notes:
        'Removes a chart or picture from the sheet along with the parts only it owned, such as its chart part and embedded workbook.',
    }),
    add_image: signature(['path'], ['sheet', 'cell', 'left', 'top', 'width', 'height', 'altText'], {
      notes:
        'cell (H2) anchors the top-left corner where the snapshot reports it; left/top are points from the sheet origin and win when both are given. altText describes the picture for a reader who cannot see it; without it the audit reports missing_alt_text.',
    }),
    add_table: signature(['range'], ['sheet', 'name', 'style'], { propertySets: ['table'] }),
    add_chart: signature(
      ['range'],
      [
        'sheet',
        'cell',
        'toColumn',
        'chartType',
        'title',
        'left',
        'top',
        'width',
        'height',
        'seriesColors',
        'showValues',
        'showLegend',
        'zeroBaseline',
        'valueNumberFormat',
        'dataLabelPosition',
        'dataLabelColor',
        'plotBy',
      ],
      {
        propertySets: ['chart'],
        notes:
          "plotBy:'rows' reads one bounded range the other way — the first row supplies the categories and every other row is a series named by its first cell — for a sheet that grows a column per period. The first source column supplies categories; remaining columns become series. A series that is not beside its categories joins by comma the way Excel reads it (range:'A7:A12,D7:D12', same rows in every area). cell (H2) places the frame's top-left corner on the grid; left/top are points and win when both are given; width/height are points (420 × 260 at F5 reaches about N22), and the print area has to reach past the frame. toColumn (F) with cell ends the frame at that column's right edge in place of width, so a chart spans a table exactly: a column's points depend on the workbook's font (a Korean Excel's is wider), which a width cannot know.",
      }
    ),
    add_conditional_format: signature(
      ['range'],
      ['sheet', 'type', 'formula', 'color', 'fillColor', 'minColor', 'midColor', 'maxColor'],
      {
        notes:
          "Default rule: formula (B2<0.9, relative to the range's top-left cell) with color/fillColor for the cells it picks. type: 'colorScale' shades every cell by where its value sits (minColor, midColor, maxColor) and type: 'dataBar' draws a bar in the cell (color); neither takes a formula.",
      }
    ),
    delete_conditional_formats: signature(['range'], ['sheet']),
    add_validation: signature(
      ['range', 'formula1'],
      ['sheet', 'type', 'operator', 'formula2', 'inputMessage', 'errorMessage'],
      {
        notes:
          'type is list, whole, decimal, date, time, textLength, or custom; without it a formula naming choices ("a,b,c" or $A$1:$A$9) becomes a list and any other formula a custom rule. A ranged kind takes operator (between by default with formula2) and its bounds. Under protect_sheet the entry cells need set_style properties { locked: false } or nobody can type in them.',
      }
    ),
    freeze_panes: signature([], ['sheet', 'row', 'column'], {
      notes:
        'row and column are the first row and column that scroll, as Excel freezes at the selected cell: row:2 keeps row 1 in view, column:2 keeps column A; neither unfreezes.',
    }),
    add_pivot_table: signature(
      ['source', 'destination'],
      ['sheet', 'destinationSheet', 'name', 'rows', 'columns', 'values'],
      { propertySets: ['pivot'] }
    ),
    autofit_range: signature(['range'], ['sheet', 'rows', 'minWidth'], {
      notes:
        'Accepts cell, whole-column, or whole-row ranges such as A1:D5, A:D, or 2:8. minWidth (characters) is a floor for a composed layout: columns still grow to their content, and every column in the range reaches that width, so the block keeps its width on the printed page (fit-to-page only scales down).',
    }),
    set_page_setup: signature(
      [],
      [
        'sheet',
        'printArea',
        'printTitleRows',
        'fitToContent',
        'orientation',
        'fitToPagesWide',
        'fitToPagesTall',
        'centerHorizontally',
        'centerVertically',
        'topMargin',
        'bottomMargin',
        'leftMargin',
        'rightMargin',
      ],
      {
        propertySets: ['pageSetup'],
        notes:
          'Margins are inches, as Excel\'s Page Setup shows them. printTitleRows repeats header rows on every printed page: "1" or "4:5".',
      }
    ),
    set_sheet_view: signature([], ['sheet', 'showGridlines', 'zoom'], {
      propertySets: ['sheetView'],
    }),
    set_sheet_visibility: signature(['sheet'], ['visibility', 'visible'], {
      notes:
        'visibility is visible, hidden, or very_hidden; visible: true/false works too, as it does for rows and columns. Keep at least one worksheet visible.',
    }),
    insert_rows: signature(['row'], ['sheet', 'count']),
    delete_rows: signature(['row'], ['sheet', 'count']),
    insert_columns: signature(['column'], ['sheet', 'count']),
    delete_columns: signature(['column'], ['sheet', 'count']),
    merge_cells: signature(['range'], ['sheet']),
    unmerge_cells: signature(['range'], ['sheet']),
    set_autofilter: signature(['range'], ['sheet', 'enabled']),
    sort_range: signature(['range'], ['sheet', 'by', 'order', 'hasHeader'], {
      notes:
        "by names the key column by letter (C) or by its header text; without it the range's first column sorts. order is asc (default) or desc, and hasHeader (default true) keeps the first row in place. The rows move with their formats; a range holding formulas is refused, since their references would follow the move.",
    }),
    set_hyperlink: signature(['cell'], ['sheet', 'address', 'subAddress', 'text', 'screenTip'], {
      propertySets: ['links'],
    }),
    set_header_footer: signature(['kind', 'text'], ['sheet', 'alignment'], {
      notes:
        "What every printed page of the sheet carries. kind is 'header' or 'footer'; alignment places the text left, center (default), or right. {page}, {pages}, {date}, and {time} print the page number, the page count, and the print date and time (text: '{page} / {pages}'); an '&' is printed as written, so Excel's own &P codes are not the way to number pages. The snapshot reports both under pageSetup.",
    }),
    set_row_visibility: signature(['row', 'visible'], ['sheet', 'count'], {
      notes:
        'A hidden row keeps its values and the sheet stops showing them; the snapshot reports the same state as hiddenRows.',
    }),
    set_row_height: signature(['row', 'height'], ['sheet', 'count'], {
      notes:
        'height is points (0-409). A merged title band never grows to its wrapped lines on its own, so a report sets the band rows it wraps; count extends the span.',
    }),
    set_column_width: signature(['column', 'width'], ['sheet', 'count'], {
      notes:
        "column takes a letter (D) or a 1-based number; width is Excel's characters (0-255) — a narrow gutter, a label column set to its report width. autofit_range sizes to the content instead.",
    }),
    set_column_visibility: signature(['column', 'visible'], ['sheet', 'count'], {
      notes:
        'column takes a letter (D) or a 1-based number. A hidden column keeps its values; the snapshot reports it as hiddenColumns.',
    }),
    define_name: signature(['name', 'refersTo']),
    delete_name: signature(['name']),
    protect_sheet: signature([], ['sheet', 'password', 'allowFormattingCells', 'allowSorting', 'allowFiltering'], {
      propertySets: ['protection'],
    }),
    unprotect_sheet: signature([], ['sheet', 'password']),
    add_provenance: signature(['cell', 'source'], ['sheet'], { propertySets: ['provenance'] }),
  },
  pptx: {
    set_text: signature(['slide', 'shape', 'text'], [], {
      notes:
        "Replaces the shape's whole text with one paragraph in the formatting of the paragraph that held its first text, as PowerPoint does; the other paragraphs go. To change one bullet of several, use replace_text; to rebuild a list, add_textbox paragraphs.",
    }),
    // paragraphs alone is a whole text box, as it is for add_shape: text was required beside it and then ignored.
    add_textbox: signature(
      ['slide'],
      ['text', 'paragraphs', 'left', 'top', 'width', 'height', 'fontName', 'fontSize', 'color', 'name', 'properties'],
      {
        oneOf: [['text'], ['paragraphs']],
        propertySets: ['shape', 'authoring'],
        notes:
          'left/top/width/height are points (72 per inch; the wide canvas is 960 × 540), the unit the snapshot reports — not the inches of an authoring script. fillTransparency and lineTransparency are percentages (0-100); properties.shadow is true (PowerPoint’s own) or { color, transparency 0-1, blur, offsetX, offsetY } in points.',
      }
    ),
    delete_shape: signature(['slide', 'shape']),
    add_slide: signature([], ['index', 'layout']),
    delete_slide: signature(['slide']),
    move_slide: signature(['slide', 'index']),
    duplicate_slide: signature(['slide'], ['index']),
    import_slides: signature(['path'], ['after', 'slides']),
    use_template_page: signature(['path', 'after'], ['role', 'slide', 'title', 'eyebrow', 'subtitle', 'body', 'source', 'items', 'notes'], {
      notes:
        "Takes a page from the template deck at path and fills it: role picks the page by the job it does (the snapshot reports it as slide.role — cover, comparison, process, metrics, split, statement, closing, content), or slide names one exact page. after is the slide the new page follows, 0 for the front. title fills the title slot; eyebrow, subtitle, body (the page's lead prose), and source (its 출처/Source line) fill their own, and text given for a box the page lacks is refused; items[] fill the page's repeated group in order, each { title, body } (a metric page reads them as { value, label }). A template's sidecar (<path>.mixdog.json) names the roles when it has one. Fewer items than slots empties the unused ones, and an eyebrow, subtitle, body, or detail line given no text is emptied rather than left in the template's words; more items than the page holds is refused, since a page takes another item by being replaced, never by shrinking its type.",
    }),
    keep_slides: signature(['slides']),
    set_notes: signature(['slide', 'text']),
    set_footer: signature(['slide', 'text']),
    set_slide_number: signature(['slide', 'visible']),
    set_slide_visibility: signature(['slide', 'visible'], [], {
      notes:
        'A hidden slide (visible: false) stays in the file and is skipped when the deck is presented — how an appendix travels with its deck. The snapshot reports it as slide.hidden.',
    }),
    add_comment: signature(['slide', 'text'], ['author', 'initials', 'left', 'top'], { propertySets: ['comment'] }),
    delete_comment: signature(['slide', 'comment']),
    add_image: signature(['slide', 'path'], ['left', 'top', 'width', 'height', 'fit', 'focusX', 'focusY', 'altText'], {
      notes:
        'fit is stretch (legacy), contain (letterbox without distortion), or cover (crop without distortion). focusX/focusY are 0-1 focal points for cover. altText describes the picture for a reader who cannot see it; without it the audit reports missing_alt_text.',
    }),
    replace_image: signature(['slide', 'shape', 'path'], ['altText'], {
      notes:
        "The frame keeps the replaced picture's description until altText renames it, so a swapped photo is otherwise announced as the old one.",
    }),
    crop_image: signature(['slide', 'shape'], ['left', 'top', 'right', 'bottom']),
    add_media: signature(
      ['slide', 'path', 'poster'],
      ['kind', 'link', 'embed', 'left', 'top', 'width', 'height', 'altText'],
      {
        propertySets: ['media', 'shape'],
        notes:
          'A slide shows a video or sound as a picture with the clip attached, so poster (the preview image) is what the audience sees before playback and the file cannot omit it.',
      }
    ),
    set_shape: signature(['slide', 'shape', 'properties'], [], {
      propertySets: ['shape'],
      notes:
        'properties.left/top/width/height are points (72 per inch; the wide canvas is 960 × 540), the unit the snapshot reports — not the inches of an authoring script. fillTransparency and lineTransparency are percentages (0-100); shadow is true (PowerPoint’s own) or { color, transparency 0-1, blur, offsetX, offsetY } in points; paragraphSpacing is the space before each paragraph in points.',
    }),
    group_shapes: signature(['slide', 'shapes']),
    ungroup_shape: signature(['slide', 'shape']),
    set_slide_background: signature(['slide', 'color']),
    set_layout: signature(['slide', 'layout']),
    apply_theme: signature(['path']),
    set_transition: signature(['slide'], ['effect', 'duration', 'advanceOnTime', 'advanceTime'], {
      propertySets: ['transition'],
    }),
    add_animation: signature(['slide', 'shape'], ['effect', 'trigger', 'duration', 'delay'], {
      propertySets: ['animation'],
    }),
    add_chart: signature(
      ['slide'],
      [
        'chartType',
        'title',
        'categories',
        'series',
        'left',
        'top',
        'width',
        'height',
        'showValues',
        'showLegend',
        'zeroBaseline',
        'valueNumberFormat',
        'dataLabelPosition',
        'dataLabelColor',
      ],
      {
        propertySets: ['chart'],
        notes:
          "series[] is { name, values, color?, pointColors? }: color fills the series, pointColors[] one bar or slice each. A chart added to an existing deck takes the deck's colours from the page it joins — the snapshot reports each shape's font.color and fill.color — rather than the neutral default blue, so it does not read as pasted in. left/top/width/height are points (960 × 540 on the wide canvas).",
      }
    ),
    fit_text: signature(['slide', 'shape'], ['minFontSize', 'allowNoChange']),
    add_shape: signature(
      ['slide', 'shapeType'],
      ['text', 'paragraphs', 'left', 'top', 'width', 'height', 'fillColor', 'lineColor', 'name', 'properties'],
      {
        propertySets: ['shape', 'authoring'],
        notes:
          'left/top/width/height are points (72 per inch; the wide canvas is 960 × 540), the unit the snapshot reports — not the inches of an authoring script. fillTransparency and lineTransparency are percentages (0-100); properties.shadow is true (PowerPoint’s own) or { color, transparency 0-1, blur, offsetX, offsetY } in points.',
      }
    ),
    add_table: signature(['slide', 'values'], ['rows', 'columns', 'left', 'top', 'width', 'height', 'properties'], {
      propertySets: ['table'],
      notes:
        'properties.columnWidths (points, one per column) share the table width in their proportions; without them each column takes the width its text needs.',
    }),
    set_table_data: signature(['slide', 'shape', 'values'], [], {
      propertySets: ['table'],
      notes:
        'The table takes the shape of the data on both backends: a row or column past its edge repeats the last one (formatting and width), and rows past the data are removed.',
    }),
    set_chart_data: signature(
      ['slide', 'shape', 'series'],
      [
        'categories',
        'title',
        'chartType',
        'showValues',
        'showLegend',
        'zeroBaseline',
        'valueNumberFormat',
        'dataLabelPosition',
        'dataLabelColor',
      ],
      {
        propertySets: ['chart'],
        notes:
          'New numbers keep the chart as it stands — labels, number format, legend, base line, and series colours — unless a field here overrides one.',
      }
    ),
    set_chart_series: signature(
      ['slide', 'shape', 'series'],
      ['name', 'categories', 'values', 'chartType', 'secondaryAxis'],
      { propertySets: ['chart'] }
    ),
    set_chart_axis: signature(
      ['slide', 'shape', 'axis'],
      ['title', 'minimum', 'maximum', 'majorUnit', 'numberFormat', 'secondaryAxis'],
      { propertySets: ['chart'] }
    ),
    set_chart_data_labels: signature(
      ['slide', 'shape'],
      ['series', 'showValue', 'showCategoryName', 'position', 'numberFormat'],
      {
        propertySets: ['chart'],
        notes:
          'Without series every series is labelled. position is center, inside_end, inside_base, outside_end, or best_fit, as add_chart takes dataLabelPosition; a stacked bar sets outside_end at the center and a pie or doughnut keeps its own placement.',
      }
    ),
    set_chart_trendline: signature(['slide', 'shape'], ['series', 'type', 'displayEquation', 'displayRSquared'], {
      propertySets: ['chart'],
      notes:
        'type is linear (default), exponential, logarithmic, polynomial, power, or moving_average (the file codes exp, log, poly, movingAvg also read); without series every series takes one.',
    }),
    set_chart_error_bars: signature(['slide', 'shape'], ['series', 'amount', 'direction', 'endStyle'], {
      propertySets: ['chart'],
      notes:
        'amount is a positive fixed value; direction is y (default) or x; endStyle is which side the bars reach: both (default), plus, or minus. Without series every series takes them.',
    }),
    set_hyperlink: signature(['slide', 'shape'], ['address', 'subAddress'], { propertySets: ['authoring'] }),
    z_order: signature(['slide', 'shape', 'command']),
    align_shapes: signature(['slide', 'shapes', 'align'], ['relativeToSlide']),
    distribute_shapes: signature(['slide', 'shapes', 'direction'], ['relativeToSlide']),
    add_provenance: signature(['slide', 'shape', 'source'], [], { propertySets: ['provenance'] }),
  },
  pdf: {
    add_text: signature(
      ['text'],
      ['page', 'pages', 'x', 'y', 'size', 'color', 'opacity', 'rotation', 'align', 'fontPath'],
      {
        propertySets: ['text', 'textFont'],
        notes:
          "x, y are the baseline start in points from the bottom-left; align center|right places the run between the margins when x is omitted, and with x puts the run's centre or right end at x. {page} and {pages} in text become each page's number and the page count. Non-Latin text embeds an installed Unicode font (fontPath chooses).",
      }
    ),
    highlight: signature(
      [],
      ['find', 'wholeWord', 'regex', 'first', 'page', 'pages', 'x', 'y', 'width', 'height', 'color', 'opacity'],
      {
        oneOf: [['find'], ['page', 'x', 'y', 'width', 'height']],
        notes:
          'find marks every case-insensitive match on the selected pages, including 90/180/270-degree page rotations and shifted page origins; wholeWord:true skips matches inside longer words, regex:true treats find as a pattern, first:true marks only the first match. A box in bottom-left PDF points marks one region. Yellow at 45% with multiply blend unless told otherwise; text remains extractable: this is not redaction.',
      }
    ),
    add_link: signature(
      [],
      ['find', 'wholeWord', 'regex', 'first', 'page', 'pages', 'x', 'y', 'width', 'height', 'url', 'toPage', 'urls'],
      {
        oneOf: [['url'], ['toPage'], ['urls']],
        notes:
          'Lays an invisible link over every find match (or one box) that opens url (http, https, mailto) or toPage in the same document; urls:true instead links every http(s) address in the text to itself and reports them as urls.',
      }
    ),
    watermark: signature(
      ['text'],
      ['page', 'pages', 'x', 'y', 'size', 'color', 'opacity', 'rotation', 'align', 'fontPath'],
      {
        propertySets: ['text', 'textFont'],
        notes:
          'Centred, 48 pt, 25% opacity, rotated 45° unless told otherwise. Non-Latin text embeds an installed Unicode font (fontPath chooses).',
      }
    ),
    stamp_image: signature(['path'], ['page', 'pages', 'x', 'y', 'width', 'height', 'opacity'], {
      notes:
        "PNG, JPEG, or SVG (rasterized at high resolution, placed at the vector's own size); x, y are the bottom-left corner in points.",
    }),
    ocr_pages: signature([], ['page', 'pages', 'languages', 'minConfidence', 'maxWidth', 'fontPath'], {
      notes:
        'Adds an invisible searchable text layer in place; a Unicode font is resolved from the system when the text is non-Latin.',
    }),
    rotate_pages: signature([], ['page', 'pages', 'rotation', 'absolute'], {
      notes: "rotation (multiple of 90) is added to each page's current rotation; absolute:true sets it instead.",
    }),
    crop_pages: signature([], ['page', 'pages', 'left', 'right', 'top', 'bottom', 'margin'], {
      notes:
        'Trims points from the sides as the page is displayed (rotation handled); margin trims all four. The trimmed content is hidden, not removed, so a crop is never redaction.',
    }),
    delete_pages: signature([], ['page', 'pages'], { notes: 'At least one page must remain.' }),
    move_page: signature(['page', 'index']),
    extract_pages: signature([], ['page', 'pages', 'output'], {
      notes:
        'With output the selected pages are written to that file and the session document is unchanged; without it the document becomes that subset.',
    }),
    split_pages: signature([], ['page', 'pages', 'every', 'output'], {
      notes:
        'Writes <name>-001.pdf, -002.pdf … beside the document (or into output), one file per page or per `every` pages; the session document is unchanged.',
    }),
    fill_form: signature(['values'], ['flatten', 'fontPath'], {
      notes:
        'values maps field name → value: text string, checkbox true/false, radio/dropdown by option text, optionlist an array. Unknown names or options fail listing what exists; non-Latin values embed a Unicode font automatically when one is installed.',
    }),
    add_form_field: signature(
      ['name', 'type', 'page', 'x', 'y', 'width', 'height'],
      [
        'options',
        'value',
        'multiline',
        'multiselect',
        'editable',
        'maxLength',
        'fontSize',
        'required',
        'readOnly',
        'fontPath',
      ],
      {
        propertySets: ['form'],
        notes:
          'type: text | checkbox | radio | dropdown | optionlist; the box is linted (name, page bounds, overlap, minimum size) before it is added.',
      }
    ),
    flatten_form: signature([], ['fontPath'], {
      notes:
        'Bakes every field into page content; fill first, then flatten only when the form must stop being editable.',
    }),
    preview_fields: signature(['output'], ['boxes'], {
      notes:
        'Writes a copy beside the document with every form field outlined and named, plus any boxes:[{ page, x, y, width, height, label }] you propose, for a render to check placement; the document is unchanged.',
    }),
    merge_pdf: signature([], ['sources', 'path', 'index', 'bookmarks'], {
      oneOf: [['sources'], ['path']],
      notes:
        'sources: [path | { path, pages, title }] appended in order (or inserted before page index); bookmarks:true adds an outline entry per source; encrypted sources must be decrypted first.',
    }),
    add_bookmark: signature(['title', 'page'], [], {
      notes: 'Appends an outline entry that opens the page; the snapshot lists them under outline.',
    }),
    add_attachment: signature(['path'], ['name', 'mimeType', 'description'], { propertySets: ['attachment'] }),
    extract_attachment: signature([], ['name', 'index', 'output'], {
      oneOf: [['name'], ['index']],
      notes: 'Writes an embedded file beside the document (or to output); the document is unchanged.',
    }),
    compress: signature([], [], {
      notes:
        'Re-serializes with object streams and reports bytesBefore/bytesAfter; images are not resampled, so savings are small.',
    }),
    set_metadata: signature(['properties'], [], { propertySets: ['metadata'] }),
  },
};
