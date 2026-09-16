import { officeDesignCatalog } from './design/design-system.mjs';

export const OFFICE_ACTIONS = Object.freeze([
  'detect',
  'transactions',
  'recover',
  'describe',
  'author',
  'create',
  'attach',
  'open',
  'secure',
  'begin',
  'snapshot',
  'get',
  'query',
  'batch',
  'diff',
  'commit',
  'rollback',
  'issues',
  'qa',
  'validate',
  'render',
  'save',
  'finalize',
  'close',
]);

const COMMON = {
  actions: OFFICE_ACTIONS,
  observation: {
    selection:
      'attached and visible Microsoft Office snapshots include the active range, paragraph, slide, or shapes; background and portable sessions report document state only',
  },
  batch: {
    atomic:
      'all modes roll back failed batches; live Word/PowerPoint use Office Undo boundaries and live Excel restores an in-memory checkpoint without saving',
    operationShape:
      '{ op, target-specific fields, properties?, allowNoChange? }; silent no-op results roll back unless requireChanges:false',
    initialOperations:
      'create/open accept known operations; their results prove the edit without a redundant snapshot unless snapshotAfter:true',
  },
};

const TABULAR = {
  paths: ['/sheet[NAME]', '/sheet[NAME]/cell[A1]', '/sheet[NAME]/range[A1:C10]'],
  operations: {
    common: [
      'replace_text',
      'set_cell',
      'set_formula',
      'set_range',
      'append_row',
      'clear_cell',
      'insert_rows',
      'delete_rows',
      'insert_columns',
      'delete_columns',
    ],
    office: [],
    portable: [],
  },
  properties: {
    cell: ['value', 'formula'],
    structure: ['row', 'column', 'count', 'range'],
    safety: ['formulaLikeValue', 'raggedRow', 'utf8'],
  },
};

const CATALOG = {
  docx: {
    paths: [
      '/body/p[N]',
      '/body/p[N]/run[N]',
      '/body/tbl[N]/row[N]/cell[N]',
      '/body/comment[N]',
      '/body/comment-thread[N]',
      '/body/revision[N]',
      '/body/footnote[N]',
      '/body/endnote[N]',
      '/body/content-control[N]',
    ],
    operations: {
      common: [
        'replace_text',
        'fill_template',
        'compose_document',
        'append_text',
        'set_paragraph_text',
        'set_table_cell',
        'remove_paragraph',
        'move_paragraph',
        'add_table',
        'set_table_style',
        'merge_table_cells',
        'set_table_cell_style',
        'set_paragraph_format',
        'set_font',
        'add_image',
        'set_header_footer',
        'set_page',
        'add_page_numbers',
        'insert_break',
        'set_list',
        'add_hyperlink',
        'insert_table_row',
        'delete_table_row',
        'insert_table_column',
        'delete_table_column',
        'insert_toc',
        'add_bookmark',
        'add_note',
        'set_content_control',
        'add_comment',
        'delete_comment',
        'add_provenance',
        'fit_table',
        'resolve_revision',
        'resolve_revisions',
        'track_changes',
        'add_comment_reply',
        'set_comment_resolved',
        'normalize_runs',
      ],
      office: ['set_paragraph_style'],
      // set_run_text addresses OOXML runs. Word exposes no run object, so the
      // Office backend could only edit the Nth word instead, silently rewriting
      // different text for the same index. It stays portable-only rather than
      // meaning two different things. normalize_runs is common so one opening
      // batch works on both backends: Word searches across runs itself and
      // reports the operation as unnecessary (changed:false).
      portable: ['set_paragraph_style', 'set_run_text'],
    },
    properties: {
      paragraph: ['style'],
      font: ['name', 'nameEastAsia', 'size', 'bold', 'italic', 'underline', 'color', 'hidden'],
      page: ['orientation', 'topMargin', 'bottomMargin', 'leftMargin', 'rightMargin'],
      headerFooter: ['section', 'kind', 'header', 'text'],
      table: [
        'style',
        'textStyle',
        'fontName',
        'fontNameEastAsia',
        'fontSize',
        'color',
        'spacingAfter',
        'columnWidths',
        'rowHeights',
        'borders',
        'shading',
        'alignment',
        'columnAlignments',
        'repeatHeader',
        'headerBold',
      ],
      tableCell: [
        'fillColor',
        'horizontalAlignment',
        'verticalAlignment',
        'width',
        'fontName',
        'fontNameEastAsia',
        'fontSize',
        'bold',
        'italic',
        'color',
      ],
      paragraphFormat: [
        'alignment',
        'spacingBefore',
        'spacingAfter',
        'lineSpacing',
        'keepWithNext',
        'keepTogether',
        'widowControl',
        'pageBreakBefore',
        'border',
        'shading',
        'indentLeft',
        'indentRight',
        'indentFirstLine',
        'tabStops',
        'listKind',
        'listLevel',
      ],
      comment: ['author', 'initials', 'date', 'text', 'anchoredText', 'resolved', 'replies'],
      contentControl: ['tag', 'title', 'lock', 'text'],
      revision: ['author', 'date', 'type', 'typeCode', 'text', 'resolution'],
      fields: ['toc', 'page', 'numPages', 'pageBreak', 'sectionBreak'],
      links: ['address', 'subAddress', 'display', 'bookmark'],
      provenance: ['source.document', 'source.target', 'source.label'],
      design: [
        'profile',
        'purpose',
        'expressionMode',
        'intent',
        'audience',
        'tone',
        'density',
        'palette',
        'typography',
        'signature',
        'content.packageId',
        'content.audience',
        'content.objective',
        'content.decision',
        'content.period',
        'content.facts',
        'content.claims',
        'review',
      ],
    },
  },
  xlsx: {
    paths: ['/sheet[NAME]', '/sheet[NAME]/cell[A1]', '/sheet[NAME]/range[A1:C10]'],
    operations: {
      common: [
        'replace_text',
        'set_cell',
        'set_formula',
        'set_range',
        'append_row',
        'clear_cell',
        'compose_sheet',
        'add_sheet',
        'delete_sheet',
        'rename_sheet',
        'set_style',
        'merge_cells',
        'unmerge_cells',
        'freeze_panes',
        'autofit_range',
        'set_page_setup',
        'set_sheet_view',
        'add_chart',
        'add_table',
        'insert_rows',
        'delete_rows',
        'insert_columns',
        'delete_columns',
        'set_autofilter',
        'sort_range',
        'set_sheet_visibility',
        'set_row_visibility',
        'set_column_visibility',
        'set_header_footer',
        'define_name',
        'delete_name',
        'copy_sheet',
        'add_image',
        'set_hyperlink',
        'protect_sheet',
        'unprotect_sheet',
        'add_validation',
        'add_conditional_format',
        'delete_conditional_formats',
        'add_note',
        'delete_note',
        'add_provenance',
        'add_pivot_table',
      ],
      office: [],
      portable: [],
    },
    properties: {
      cellStyle: [
        'fontName',
        'fontSize',
        'bold',
        'italic',
        'color',
        'fillColor',
        'numberFormat',
        'horizontalAlignment',
        'verticalAlignment',
        'wrapText',
        'locked',
        'borders',
      ],
      chart: [
        'chartType',
        'left',
        'top',
        'width',
        'height',
        'title',
        'seriesColors',
        'showValues',
        'showLegend',
        'zeroBaseline',
        'valueNumberFormat',
        'dataLabelPosition',
        'dataLabelColor',
      ],
      table: ['name', 'style'],
      pivot: ['source', 'destination', 'name', 'rows', 'columns', 'values'],
      note: ['text', 'author'],
      structure: ['row', 'column', 'count', 'range', 'referenceAware'],
      links: ['address', 'text'],
      protection: ['password', 'allowFormattingCells', 'allowSorting', 'allowFiltering'],
      audit: ['conditionalFormats', 'formulaLineage', 'checksSheet', 'hardcodeSource', 'rogueHardcode'],
      pageSetup: [
        'printArea',
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
      sheetView: ['showGridlines', 'zoom'],
      provenance: ['source.document', 'source.target', 'source.label'],
      design: [
        'profile',
        'purpose',
        'expressionMode',
        'intent',
        'audience',
        'tone',
        'density',
        'palette',
        'typography',
        'signature',
        'content.packageId',
        'content.audience',
        'content.objective',
        'content.decision',
        'content.period',
        'content.facts',
        'content.claims',
        'review',
      ],
    },
  },
  pptx: {
    paths: ['/slide[N]', '/slide[N]/shape[N]'],
    stableTargets:
      'Portable batch operations may replace slide/shape indices with slideId/shapeId from snapshot. IDs survive ordering changes; conflicting indices fail rather than edit a different element. COM continues to use indices.',
    operations: {
      common: [
        'replace_text',
        'fill_template',
        'set_text',
        'add_textbox',
        'delete_shape',
        'add_slide',
        'delete_slide',
        'move_slide',
        'set_notes',
        'add_image',
        'add_shape',
        'add_table',
        'set_shape',
        'set_slide_background',
        'import_slides',
        'replace_image',
        'set_table_data',
        'fit_text',
        'add_chart',
        'set_chart_data',
        'duplicate_slide',
        'z_order',
        'align_shapes',
        'distribute_shapes',
        'keep_slides',
        'set_hyperlink',
        'add_provenance',
        'set_layout',
        'crop_image',
        'set_transition',
        'set_footer',
        'set_slide_number',
        'set_slide_visibility',
        'set_chart_axis',
        'set_chart_data_labels',
        'group_shapes',
        'ungroup_shape',
        'set_chart_trendline',
        'set_chart_error_bars',
        'set_chart_series',
        'add_comment',
        'delete_comment',
        'apply_theme',
        'add_media',
        'add_animation',
      ],
      office: [],
      portable: [],
    },
    properties: {
      shape: [
        'left',
        'top',
        'width',
        'height',
        'rotation',
        'fillColor',
        'fillTransparency',
        'lineColor',
        'lineTransparency',
        'lineWidth',
        'shadow',
        'marginLeft',
        'marginTop',
        'marginRight',
        'marginBottom',
        'fontName',
        'fontSize',
        'bold',
        'italic',
        'color',
        'alignment',
        'verticalAlignment',
        'paragraphSpacing',
        'altText',
      ],
      chart: [
        'chartType',
        'left',
        'top',
        'width',
        'height',
        'title',
        'series',
        'axis',
        'dataLabels',
        'seriesType',
        'secondaryAxis',
        'trendline',
        'errorBars',
        'showValues',
        'showLegend',
        'zeroBaseline',
        'valueNumberFormat',
        'dataLabelPosition',
        'dataLabelColor',
      ],
      slide: ['background', 'layout', 'layoutName'],
      placeholder: ['type', 'index'],
      table: [
        'rows',
        'columns',
        'values',
        'fontName',
        'fontSize',
        'color',
        'headerFillColor',
        'headerColor',
        'bodyFillColor',
        'headerRowHeight',
        'bodyRowHeight',
      ],
      template: ['tokens', 'strict'],
      authoring: [
        'shapeType',
        'paragraphs',
        'bullet',
        'level',
        'hyperlink',
        'zOrder',
        'align',
        'distribute',
        'group',
        'crop',
        'theme',
        'footer',
        'slideNumber',
      ],
      transition: ['effect', 'duration', 'advanceOnTime', 'advanceTime'],
      animation: ['effect', 'trigger', 'duration', 'delay'],
      media: ['kind', 'link', 'embed', 'poster'],
      comment: ['author', 'initials', 'left', 'top'],
      provenance: ['source.document', 'source.target', 'source.label'],
      design: [
        'profile',
        'purpose',
        'expressionMode',
        'intent',
        'audience',
        'tone',
        'density',
        'palette',
        'typography',
        'signature',
        'content.packageId',
        'content.audience',
        'content.objective',
        'content.decision',
        'content.period',
        'content.facts',
        'content.claims',
        'template',
        'deck.backgroundMode',
        'deck.dominantColorRole',
        'deck.motif',
        'deck.spacingScale',
        'deck.sectionSlides',
        'deck.roles',
        'deck.requireSlidePlan',
        'deck.templateMode',
        'review',
        'reviewed',
        'reviewToken',
        'critique',
      ],
    },
  },
  pdf: {
    paths: ['/page[N]', '/field[N]', '/outline[N]', '/attachments[N]', '/metadata'],
    operations: {
      common: [
        'add_text',
        'watermark',
        'highlight',
        'add_link',
        'stamp_image',
        'ocr_pages',
        'rotate_pages',
        'delete_pages',
        'move_page',
        'extract_pages',
        'split_pages',
        'fill_form',
        'add_form_field',
        'flatten_form',
        'preview_fields',
        'merge_pdf',
        'add_bookmark',
        'add_attachment',
        'extract_attachment',
        'compress',
        'set_metadata',
      ],
      office: [],
      portable: [],
    },
    properties: {
      text: ['x', 'y', 'size', 'color', 'opacity', 'rotation', 'align'],
      metadata: ['title', 'author', 'subject', 'keywords', 'creator'],
      form: [
        'name',
        'type',
        'page',
        'x',
        'y',
        'width',
        'height',
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
      attachment: ['path', 'name', 'mimeType', 'description', 'index', 'output'],
      textFont: ['fontPath'],
      create: [
        'blocks',
        'fields',
        'properties.pageSize',
        'properties.orientation',
        'properties.margin',
        'properties.fontPath',
        'properties.pageNumbers',
        'properties.footer',
        'properties.title',
        'properties.author',
        'properties.subject',
        'properties.keywords',
      ],
      units: ['points; origin bottom-left; 1 inch = 72 pt; A4 = 595.28 x 841.89'],
      unsupportedSecurity: ['secureRedaction', 'digitalSignature', 'PDF/A'],
    },
  },
  csv: TABULAR,
  tsv: TABULAR,
};

const BACKENDS = new Set(['microsoft-office-com', 'mixdog-ooxml', 'mixdog-tabular', 'mixdog-pdf']);
const VIRTUAL_OPERATIONS = new Set(['compose_document', 'compose_sheet']);

function signature(required = [], optional = [], { oneOf = [], propertySets = [], notes = '' } = {}) {
  return { required, optional, oneOf, propertySets, notes };
}

const COMMON_SIGNATURES = {
  replace_text: signature(['find', 'replace'], ['author'], {
    notes:
      'In a Word document with track_changes on, only the matched characters are wrapped as a deletion plus an insertion (a match across a tab, break, or field rewrites that paragraph whole) and author labels the change.',
  }),
  fill_template: signature(['tokens'], ['strict', 'author'], {
    notes:
      'Use strict:true to fail when a token is missing or left unresolved. In a Word document with track_changes on, each token is filled as a tracked deletion plus insertion and author labels the change.',
  }),
};

const FORMAT_SIGNATURES = {
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
    append_text: signature(['text'], ['style', 'properties'], {
      propertySets: ['paragraph', 'font', 'paragraphFormat'],
      notes: 'Creates one real paragraph.',
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
        'properties.alignment places the table on the page (left, center, right); properties.columnAlignments sets the text of each column (one of left, center, right, justify per column). Without style, borders, or shading the table takes a bold header row with a rule under it and hairlines between rows; headerBold:false keeps the header plain.',
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
    add_image: signature(['path'], ['paragraph', 'width', 'height', 'altText'], {
      notes:
        'altText describes the picture for a reader who cannot see it; without it the audit reports missing_alt_text.',
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
    set_header_footer: signature(['text'], ['section', 'kind', 'variant', 'header'], {
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
    set_page: signature(['properties'], ['section'], { propertySets: ['page'] }),
    fit_table: signature(['table']),
    insert_toc: signature([], ['paragraph', 'lowerHeadingLevel', 'upperHeadingLevel'], {
      notes:
        'Lands in a paragraph of its own after paragraph (or at the end of the document, where the batch has reached) on both backends, and is rebuilt from the Heading 1..3 paragraphs at every save. Its own title is a bold paragraph, never a Heading — a heading would list itself.',
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
      ],
      {
        propertySets: ['chart'],
        notes:
          "The first source column supplies categories; remaining columns become series. A series that is not beside its categories joins by comma the way Excel reads it (range:'A7:A12,D7:D12', same rows in every area). cell (H2) places the frame's top-left corner on the grid; left/top are points and win when both are given; width/height are points (420 × 260 at F5 reaches about N22), and the print area has to reach past the frame.",
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
    freeze_panes: signature([], ['sheet', 'row', 'column']),
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
        "What every printed page of the sheet carries. kind is 'header' or 'footer'; alignment places the text left, center (default), or right. The snapshot reports both under pageSetup.",
    }),
    set_row_visibility: signature(['row', 'visible'], ['sheet', 'count'], {
      notes:
        'A hidden row keeps its values and the sheet stops showing them; the snapshot reports the same state as hiddenRows.',
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
    set_text: signature(['slide', 'shape', 'text']),
    add_textbox: signature(
      ['slide', 'text'],
      ['paragraphs', 'left', 'top', 'width', 'height', 'fontName', 'fontSize', 'color', 'name', 'properties'],
      {
        propertySets: ['shape', 'authoring'],
        notes:
          'left/top/width/height are points (72 per inch; the wide canvas is 960 × 540), the unit the snapshot reports — not the inches of an authoring script.',
      }
    ),
    delete_shape: signature(['slide', 'shape']),
    add_slide: signature([], ['index', 'layout']),
    delete_slide: signature(['slide']),
    move_slide: signature(['slide', 'index']),
    duplicate_slide: signature(['slide'], ['index']),
    import_slides: signature(['path'], ['after', 'slides']),
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
        'properties.left/top/width/height are points (72 per inch; the wide canvas is 960 × 540), the unit the snapshot reports — not the inches of an authoring script.',
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
      { propertySets: ['chart'] }
    ),
    fit_text: signature(['slide', 'shape'], ['minFontSize', 'allowNoChange']),
    add_shape: signature(
      ['slide', 'shapeType'],
      ['text', 'paragraphs', 'left', 'top', 'width', 'height', 'fillColor', 'lineColor', 'name', 'properties'],
      {
        propertySets: ['shape', 'authoring'],
        notes:
          'left/top/width/height are points (72 per inch; the wide canvas is 960 × 540), the unit the snapshot reports — not the inches of an authoring script.',
      }
    ),
    add_table: signature(['slide', 'values'], ['rows', 'columns', 'left', 'top', 'width', 'height', 'properties'], {
      propertySets: ['table'],
    }),
    set_table_data: signature(['slide', 'shape', 'values'], [], { propertySets: ['table'] }),
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
      { propertySets: ['chart'] }
    ),
    set_chart_trendline: signature(['slide', 'shape'], ['series', 'type', 'displayEquation', 'displayRSquared'], {
      propertySets: ['chart'],
    }),
    set_chart_error_bars: signature(['slide', 'shape'], ['series', 'amount', 'direction', 'endStyle'], {
      propertySets: ['chart'],
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
          "x, y are the baseline start in points from the bottom-left; align center|right places the run between the margins when x is omitted. {page} and {pages} in text become each page's number and the page count. Non-Latin text embeds an installed Unicode font (fontPath chooses).",
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

function rawCatalogOperations(catalog) {
  return [...new Set([...catalog.operations.common, ...catalog.operations.office, ...catalog.operations.portable])];
}

function operationBackends(format, catalog, operation) {
  if (format === 'pdf') return ['mixdog-pdf'];
  if (format === 'csv' || format === 'tsv') return ['mixdog-tabular'];
  const backends = [];
  if (catalog.operations.common.includes(operation) || catalog.operations.office.includes(operation)) {
    backends.push('microsoft-office-com');
  }
  if (catalog.operations.common.includes(operation) || catalog.operations.portable.includes(operation)) {
    backends.push('mixdog-ooxml');
  }
  return backends;
}

function explicitOperationSignature(format, operation) {
  const formatSignatures = format === 'csv' || format === 'tsv' ? FORMAT_SIGNATURES.xlsx : FORMAT_SIGNATURES[format];
  if (Object.hasOwn(formatSignatures || {}, operation)) return formatSignatures[operation];
  if (Object.hasOwn(COMMON_SIGNATURES, operation)) return COMMON_SIGNATURES[operation];
  return null;
}

const OFFICE_OPERATION_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOG).map(([format, catalog]) => [
      format,
      Object.freeze(
        Object.fromEntries(
          rawCatalogOperations(catalog).map((operation) => {
            const input = explicitOperationSignature(format, operation);
            if (!input) throw new Error(`Office operation registry is missing a signature for ${format}.${operation}`);
            return [
              operation,
              Object.freeze({
                input,
                supportedBackends: Object.freeze(operationBackends(format, catalog, operation)),
              }),
            ];
          })
        )
      ),
    ])
  )
);

function catalogOperations(format) {
  return Object.keys(OFFICE_OPERATION_REGISTRY[format] || {});
}

function operationsForBackend(format, backend) {
  const entries = Object.entries(OFFICE_OPERATION_REGISTRY[format] || {});
  if (!backend) return entries.map(([operation]) => operation);
  return entries
    .filter(([, definition]) => definition.supportedBackends.includes(backend))
    .map(([operation]) => operation);
}

function supportedBackends(format, operation) {
  return [...(OFFICE_OPERATION_REGISTRY[format]?.[operation]?.supportedBackends || [])];
}

function operationSignature(format, operation) {
  return OFFICE_OPERATION_REGISTRY[format]?.[operation]?.input || signature();
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

// What a name is about, ignoring the verb it starts with: add_toc and
// insert_toc are the same subject under two verbs, which is how a caller
// usually misses a name.
function subjectTokens(name) {
  return new Set(
    String(name)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(1)
  );
}

// A suggestion is worth a retry only when it reads as a typo of what was
// written or names the same subject. Nearest-neighbour alone hands back
// unrelated names (source→op), and a wrong hint costs a whole round trip, so
// unrelated candidates are dropped and the caller is given the real list.
function operationSuggestions(operation, operations) {
  const token = String(operation);
  const budget = Math.max(1, Math.floor(token.length / 3));
  const subject = subjectTokens(token);
  return [...operations]
    .map((candidate) => ({
      candidate,
      distance: editDistance(token, candidate),
      sameSubject: [...subjectTokens(candidate)].some((part) => subject.has(part)),
    }))
    .filter(
      ({ candidate, distance, sameSubject }) =>
        distance <= budget ||
        sameSubject ||
        (token.length >= 3 && candidate.toLowerCase().includes(token.toLowerCase())) ||
        (token.length >= 4 && (candidate.startsWith(token) || token.startsWith(candidate)))
    )
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function describeHint(format, backend, operation) {
  return `Call office with ${JSON.stringify({
    action: 'describe',
    format,
    ...(backend ? { backend } : {}),
    operation,
  })}.`;
}

function operationDescription(format, backend, catalog, requested) {
  const knownOperations = catalogOperations(format);
  const operation = resolveOperationAlias(format, requested);
  if (!knownOperations.includes(operation)) {
    const suggestions = operationSuggestions(operation, knownOperations);
    throw new Error(
      `Unknown ${format.toUpperCase()} operation "${operation}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Call describe with format:"${format}" to list operations.`
    );
  }
  const available = operationsForBackend(format, backend);
  const signatureValue = operationSignature(format, operation);
  const properties = Object.fromEntries(
    signatureValue.propertySets
      .filter((name) => catalog.properties[name])
      .map((name) => [name, catalog.properties[name]])
  );
  return {
    name: operation,
    ...(VIRTUAL_OPERATIONS.has(operation) ? { virtual: true } : {}),
    supported: !backend || available.includes(operation),
    supportedBackends: supportedBackends(format, operation),
    input: {
      required: ['op', ...signatureValue.required],
      ...(signatureValue.oneOf.length ? { oneOf: signatureValue.oneOf } : {}),
      optional: [...new Set([...signatureValue.optional, 'allowNoChange'])].filter(
        (field) => !signatureValue.required.includes(field)
      ),
    },
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(signatureValue.notes ? { notes: signatureValue.notes } : {}),
  };
}

// A caller names a field with the word the snapshot uses for it. Where the
// reading and writing names differ for the same thing, the operation takes
// both rather than charging a round trip for the spelling.
const FIELD_ALIASES = Object.freeze({
  // A link target is url in this runtime's PDF operations and address in the
  // Office ones, because each surface kept its own vocabulary. Both names
  // reach the same field instead of costing a round trip.
  docx: { add_comment: { anchoredText: 'find' }, add_hyperlink: { url: 'address' } },
  xlsx: { set_hyperlink: { url: 'address' } },
  // align_shapes takes align and distribute_shapes takes direction: the same
  // gesture, named after two different things. The word the operation is called
  // by reaches its field too.
  pptx: { set_hyperlink: { url: 'address' }, distribute_shapes: { distribute: 'direction' } },
});

// Font keys drifted apart between property sets of the same format: a Word run
// takes name / size / nameEastAsia while a table takes fontName / fontSize /
// fontNameEastAsia, and a worksheet cell takes the font- spelling. Each written
// name reaches the key its operation declares, in whichever direction.
// Only the font- spellings travel: they can mean nothing else. A bare name or
// size stays a question the operation answers with its own key list, since a
// table's name is not its font.
const PROPERTY_ALIASES = Object.freeze({
  fontName: 'name',
  fontSize: 'size',
  fontNameEastAsia: 'nameEastAsia',
  nameEastAsia: 'fontNameEastAsia',
});

// The same act carries different names across this runtime's own formats: a
// link is add_hyperlink in Word, set_hyperlink in Excel and PowerPoint, and
// add_link in PDF. That drift is ours, so the caller's reasonable name reaches
// the operation instead of costing a round trip and a rewritten batch.
const OPERATION_ALIASES = Object.freeze({
  docx: {
    add_paragraph: 'append_text',
    insert_paragraph: 'append_text',
    add_text: 'append_text',
    add_link: 'add_hyperlink',
    set_hyperlink: 'add_hyperlink',
    add_footnote: 'add_note',
  },
  xlsx: {
    add_row: 'append_row',
    add_link: 'set_hyperlink',
    add_hyperlink: 'set_hyperlink',
  },
  pptx: {
    add_link: 'set_hyperlink',
    add_hyperlink: 'set_hyperlink',
    add_notes: 'set_notes',
    set_note: 'set_notes',
  },
  pdf: {
    add_hyperlink: 'add_link',
    set_hyperlink: 'add_link',
  },
});

function resolveOperationAlias(format, name) {
  const known = catalogOperations(format);
  if (known.includes(name)) return name;
  const alias = OPERATION_ALIASES[format]?.[name];
  return alias && known.includes(alias) ? alias : name;
}

// One cell, optionally sheet-qualified and absolute: Sheet1!$B$4, '운영 자료'!C12, D5.
const SINGLE_CELL_REFERENCE = /^(?:(?:'[^']+'|[^'!]+)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}$/;

export function assertOfficeOperationContracts({ format = '', backend = '', operations = [] } = {}) {
  const catalog = CATALOG[format];
  if (!catalog) throw new Error(`Unsupported Office Use format: ${format}`);
  const available = operationsForBackend(format, backend);
  const known = catalogOperations(format);
  // Every contract violation in the batch is reported together. The batch is
  // refused as a whole either way, and a caller who learns one wrong field per
  // answer pays a round trip for each of them.
  const faults = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      faults.push(`Office operation ${index + 1} must be an object`);
      continue;
    }
    const written = String(operation.op || '').trim();
    if (!written) {
      faults.push(`Office operation ${index + 1} requires op`);
      continue;
    }
    const name = resolveOperationAlias(format, written);
    if (name !== written) operation.op = name;
    if (!known.includes(name)) {
      const suggestions = operationSuggestions(name, known);
      // Describing a name the catalog does not hold only repeats this error:
      // the caller is sent to the list that does answer the question.
      faults.push(
        `Unknown ${format.toUpperCase()} operation "${name}" at operation ${index + 1}.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Call office with ${JSON.stringify({ action: 'describe', format, ...(backend ? { backend } : {}) })} to list operations.`
      );
      continue;
    }
    if (!available.includes(name)) {
      const alternatives = supportedBackends(format, name);
      faults.push(
        `${format.toUpperCase()} operation "${name}" is unsupported by ${backend || 'this backend'}.${alternatives.length ? ` Supported backend(s): ${alternatives.join(', ')}.` : ''} ${describeHint(format, backend, name)}`
      );
      continue;
    }
    for (const [alias, field] of Object.entries(FIELD_ALIASES[format]?.[name] || {})) {
      if (operation[alias] !== undefined && operation[field] === undefined) {
        operation[field] = operation[alias];
        delete operation[alias];
      }
    }
    const signatureValue = operationSignature(format, name);
    // Every other worksheet operation takes `range`, so a caller naming one cell
    // that way is not making a mistake worth a round trip — while a real range
    // handed to a single-cell operation is one, and says which operation writes it.
    const fields = [...signatureValue.required, ...signatureValue.optional, ...signatureValue.oneOf.flat()];
    if (
      format === 'xlsx' &&
      fields.includes('cell') &&
      !fields.includes('range') &&
      operation.range !== undefined &&
      operation.cell === undefined
    ) {
      if (SINGLE_CELL_REFERENCE.test(String(operation.range).trim())) {
        operation.cell = operation.range;
        delete operation.range;
      } else {
        faults.push(
          `XLSX operation "${name}" at operation ${index + 1} writes one cell: pass cell instead of range.` +
            ` For ${operation.range} use set_range (values) or set_style (formatting). ${describeHint(format, backend, name)}`
        );
        continue;
      }
    }
    const allowed = new Set([
      'op',
      'allowNoChange',
      ...signatureValue.required,
      ...signatureValue.optional,
      ...signatureValue.oneOf.flat(),
    ]);
    const stableTargets = format === 'pptx' && backend === 'mixdog-ooxml';
    if (stableTargets && allowed.has('slide')) allowed.add('slideId');
    if (stableTargets && allowed.has('shape')) allowed.add('shapeId');
    // A table is a table: compose_document takes one as { headers, rows } and
    // compose_sheet takes those two at the top level. The caller who writes the
    // document's shape here is writing a sheet with a table in it, not a
    // mistake, and "table→tableName" was the only thing the contract had to say.
    if (
      format === 'xlsx' &&
      name === 'compose_sheet' &&
      operation.table &&
      typeof operation.table === 'object' &&
      !Array.isArray(operation.table) &&
      operation.headers === undefined &&
      operation.rows === undefined &&
      (Array.isArray(operation.table.rows) || Array.isArray(operation.table.headers))
    ) {
      if (Array.isArray(operation.table.headers)) operation.headers = operation.table.headers;
      if (Array.isArray(operation.table.rows)) operation.rows = operation.table.rows;
      delete operation.table;
    }
    // Geometry sits in properties for add_shape and at the top level for
    // add_image in the same format: our own inconsistency, so a caller who
    // wrote the fields in the neighbouring operation's place is taken at their
    // word instead of paying a round trip to move them.
    if (
      !signatureValue.propertySets.length &&
      operation.properties &&
      typeof operation.properties === 'object' &&
      !Array.isArray(operation.properties) &&
      Object.keys(operation.properties).every((field) => allowed.has(field) && operation[field] === undefined)
    ) {
      Object.assign(operation, operation.properties);
      delete operation.properties;
    }
    const unknown = Object.keys(operation).filter((field) => !allowed.has(field));
    if (unknown.length) {
      // A style key passed as a field is not a typo: it belongs in properties,
      // and saying so costs the caller one answer instead of one round trip.
      const propertyKeys = new Set(
        operationSignature(format, name)
          .propertySets.flatMap((set) => catalog.properties?.[set] || [])
          .map((entry) => String(entry).split('.')[0])
      );
      // A declared style key written one level up is unambiguous: it is applied
      // where it belongs. Only a key the operation contradicts — the same name
      // present in properties with another value — is worth an answer.
      const hoisted = unknown.filter(
        (field) =>
          propertyKeys.has(field) &&
          (operation.properties === undefined ||
            (operation.properties &&
              typeof operation.properties === 'object' &&
              !Array.isArray(operation.properties) &&
              operation.properties[field] === undefined))
      );
      if (hoisted.length) {
        const properties =
          operation.properties && typeof operation.properties === 'object' && !Array.isArray(operation.properties)
            ? operation.properties
            : {};
        for (const field of hoisted) {
          properties[field] = operation[field];
          delete operation[field];
        }
        operation.properties = properties;
      }
      const remaining = unknown.filter((field) => !hoisted.includes(field));
      if (remaining.length) {
        const misplaced = remaining.filter((field) => propertyKeys.has(field));
        const corrections = remaining
          .filter((field) => !misplaced.includes(field))
          .map((field) => {
            const [candidate] = operationSuggestions(field, allowed);
            return candidate && candidate !== field ? `${field}→${candidate}` : '';
          })
          .filter(Boolean);
        const accepted = [...allowed].filter((field) => field !== 'allowNoChange').join(', ');
        faults.push(
          `${format.toUpperCase()} operation "${name}" at operation ${index + 1} has unknown field(s): ${remaining.join(', ')}.${
            misplaced.length
              ? ` ${misplaced.join(', ')} ${misplaced.length === 1 ? 'is a properties key' : 'are properties keys'}: pass properties:{ ${misplaced.map((field) => `${field}: …`).join(', ')} }.`
              : ''
          }${
            corrections.length
              ? ` Did you mean: ${corrections.join(', ')}?`
              : misplaced.length
                ? ''
                : ` ${name} takes: ${accepted}.`
          } ${describeHint(format, backend, name)}`
        );
      }
    }
    // Properties are where an unnoticed miss hurts most: an unknown key is
    // dropped silently, so the caller believes the table was styled and only
    // the rendered page says otherwise.
    const declaredProperties = signatureValue.propertySets.flatMap((set) => catalog.properties?.[set] || []);
    const properties = operation.properties;
    if (declaredProperties.length && properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const allowedProperties = new Set(declaredProperties.map((entry) => String(entry).split('.')[0]));
      // The same font key is spelled two ways inside one format — a run takes
      // name/size, a table cell fontName/fontSize — because each set grew on
      // its own. Either spelling reaches the key the operation declares.
      for (const [written, canonical] of Object.entries(PROPERTY_ALIASES)) {
        if (properties[written] === undefined || allowedProperties.has(written)) continue;
        if (!allowedProperties.has(canonical) || properties[canonical] !== undefined) continue;
        properties[canonical] = properties[written];
        delete properties[written];
      }
      const unknownProperties = Object.keys(properties).filter((field) => !allowedProperties.has(field));
      if (unknownProperties.length) {
        const corrections = unknownProperties
          .map((field) => {
            const [candidate] = operationSuggestions(field, allowedProperties);
            return candidate && candidate !== field ? `${field}→${candidate}` : '';
          })
          .filter(Boolean);
        faults.push(
          `${format.toUpperCase()} operation "${name}" at operation ${index + 1} has unknown properties: ${unknownProperties.join(', ')}.${
            corrections.length ? ` Did you mean: ${corrections.join(', ')}?` : ''
          } ${name} properties: ${[...allowedProperties].join(', ')}. ${describeHint(format, backend, name)}`
        );
      }
    }
    // A Word table has two alignments that read alike: `alignment` places the
    // table on the page and `columnAlignments` sets the text of each column.
    // A list written into the first used to be serialized verbatim into the
    // table's justification and refused by Word's schema at finalize.
    if (
      format === 'docx' &&
      ['add_table', 'set_table_style'].includes(name) &&
      properties &&
      typeof properties === 'object' &&
      !Array.isArray(properties)
    ) {
      const placements = ['left', 'center', 'right'];
      const textAlignments = [...placements, 'justify'];
      if (properties.alignment !== undefined) {
        const placement = String(properties.alignment).trim().toLowerCase();
        if (Array.isArray(properties.alignment)) {
          faults.push(
            `DOCX operation "${name}" at operation ${index + 1}: properties.alignment places the whole table (${placements.join(', ')}); the text alignment of each column is properties.columnAlignments: ${JSON.stringify(properties.alignment)}.`
          );
        } else if (!placements.includes(placement)) {
          faults.push(
            `DOCX operation "${name}" at operation ${index + 1}: properties.alignment places the whole table and must be ${placements.join(', ')}, not ${JSON.stringify(properties.alignment)}; per-column text alignment is properties.columnAlignments.`
          );
        } else {
          properties.alignment = placement;
        }
      }
      if (properties.columnAlignments !== undefined) {
        const columns = Array.isArray(properties.columnAlignments) ? properties.columnAlignments : null;
        const invalid = columns
          ? columns.filter((entry) => !textAlignments.includes(String(entry).trim().toLowerCase()))
          : [];
        if (!columns || invalid.length) {
          faults.push(
            `DOCX operation "${name}" at operation ${index + 1}: properties.columnAlignments is one of ${textAlignments.join(', ')} per column${columns ? `, not ${invalid.map((entry) => JSON.stringify(entry)).join(', ')}` : ` (an array), not ${JSON.stringify(properties.columnAlignments)}`}.`
          );
        } else {
          properties.columnAlignments = columns.map((entry) => String(entry).trim().toLowerCase());
        }
      }
    }
    const supplied = (field) =>
      operation[field] !== undefined ||
      (stableTargets && ['slide', 'shape'].includes(field) && operation[`${field}Id`] !== undefined);
    const missing = signatureValue.required.filter((field) => !supplied(field));
    const matchesAlternative =
      !signatureValue.oneOf.length || signatureValue.oneOf.some((alternative) => alternative.every(supplied));
    if (missing.length || !matchesAlternative) {
      const requirements = [
        ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
        ...(!matchesAlternative
          ? [`requires one of: ${signatureValue.oneOf.map((entry) => entry.join('+')).join(' or ')}`]
          : []),
      ].join('; ');
      faults.push(
        `${format.toUpperCase()} operation "${name}" at operation ${index + 1} has invalid input (${requirements}). ${describeHint(format, backend, name)}`
      );
    }
  }
  if (faults.length === 1) throw new Error(faults[0]);
  if (faults.length) {
    throw new Error(`This batch breaks ${faults.length} input contracts; fix them together. ${faults.join(' ')}`);
  }
  return operations;
}

export function describeOfficeCapabilities({ format = '', backend = '', target = '', operation = '' } = {}) {
  if (backend && !BACKENDS.has(backend)) throw new Error(`Unsupported Office backend: ${backend}`);
  if (!format) {
    if (operation) throw new Error('describe with operation requires format, path, or session');
    return {
      ...COMMON,
      designs: officeDesignCatalog(),
      formats: Object.fromEntries(
        Object.entries(CATALOG).map(([name, value]) => [
          name,
          {
            paths: value.paths,
            operationCount: catalogOperations(name).length,
          },
        ])
      ),
      nextAction:
        'When discovery is needed, add format for its operation list or add operation for one compact input contract; otherwise call create/open/batch directly.',
    };
  }
  const catalog = CATALOG[format];
  if (!catalog) throw new Error(`Unsupported Office Use format: ${format}`);
  const normalizedOperation = String(operation || '').trim();
  if (normalizedOperation) {
    return {
      ...COMMON,
      format,
      backend,
      target: target || '/',
      paths: catalog.paths,
      operation: operationDescription(format, backend, catalog, normalizedOperation),
      designs: officeDesignCatalog(format),
    };
  }
  const operations = operationsForBackend(format, backend);
  const unsupported = backend ? catalogOperations(format).filter((name) => !operations.includes(name)) : [];
  return {
    ...COMMON,
    format,
    backend,
    target: target || '/',
    paths: catalog.paths,
    operations,
    unsupportedInBackend: unsupported,
    properties: catalog.properties,
    designs: officeDesignCatalog(format),
    nextAction:
      'If exact fields are unknown, add operation for its compact contract; otherwise call create/open/batch directly.',
  };
}
