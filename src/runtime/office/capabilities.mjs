import { officeDesignCatalog } from './design-system.mjs';

export const OFFICE_ACTIONS = Object.freeze([
  'detect', 'transactions', 'recover', 'describe', 'create', 'attach', 'open', 'secure',
  'begin', 'snapshot', 'get', 'query', 'batch', 'diff', 'commit', 'rollback',
  'issues', 'qa', 'validate', 'render', 'save', 'finalize', 'close',
]);

const COMMON = {
  actions: OFFICE_ACTIONS,
  observation: {
    selection: 'attached and visible Microsoft Office snapshots include the active range, paragraph, slide, or shapes; background and portable sessions report document state only',
  },
  batch: {
    atomic: 'all modes roll back failed batches; live Word/PowerPoint use Office Undo boundaries and live Excel restores an in-memory checkpoint without saving',
    operationShape: '{ op, target-specific fields, properties?, allowNoChange? }; silent no-op results roll back unless requireChanges:false',
    initialOperations: 'create/open accept known operations; their results prove the edit without a redundant snapshot unless snapshotAfter:true',
  },
};

const TABULAR = {
  paths: ['/sheet[NAME]', '/sheet[NAME]/cell[A1]', '/sheet[NAME]/range[A1:C10]'],
  operations: {
    common: ['replace_text', 'set_cell', 'set_formula', 'set_range', 'append_row', 'clear_cell', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns'],
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
    paths: ['/body/p[N]', '/body/p[N]/run[N]', '/body/tbl[N]/row[N]/cell[N]', '/body/comment[N]', '/body/comment-thread[N]', '/body/revision[N]', '/body/footnote[N]', '/body/endnote[N]', '/body/content-control[N]'],
    operations: {
      common: ['replace_text', 'fill_template', 'compose_document', 'append_text', 'set_paragraph_text', 'set_table_cell', 'remove_paragraph', 'move_paragraph', 'add_table', 'set_table_style', 'merge_table_cells', 'set_table_cell_style', 'set_paragraph_format', 'set_font', 'add_image', 'set_header_footer', 'set_page', 'add_page_numbers', 'insert_break', 'set_list', 'add_hyperlink', 'insert_table_row', 'delete_table_row', 'insert_table_column', 'delete_table_column', 'insert_toc', 'add_bookmark', 'add_comment', 'delete_comment', 'add_provenance', 'fit_table', 'resolve_revision', 'resolve_revisions', 'track_changes', 'add_comment_reply', 'set_comment_resolved'],
      office: ['set_paragraph_style'],
      // set_run_text addresses OOXML runs. Word exposes no run object, so the
      // Office backend could only edit the Nth word instead, silently rewriting
      // different text for the same index. It stays portable-only rather than
      // meaning two different things.
      portable: ['set_paragraph_style', 'set_run_text'],
    },
    properties: {
      paragraph: ['style'],
      font: ['name', 'size', 'bold', 'italic', 'color'],
      page: ['orientation', 'topMargin', 'bottomMargin', 'leftMargin', 'rightMargin'],
      headerFooter: ['section', 'kind', 'header', 'text'],
      table: ['style', 'textStyle', 'fontName', 'fontSize', 'color', 'spacingAfter', 'columnWidths', 'rowHeights', 'borders', 'shading', 'alignment'],
      tableCell: ['fillColor', 'verticalAlignment', 'width', 'fontName', 'fontSize', 'bold', 'italic', 'color'],
      paragraphFormat: ['alignment', 'spacingBefore', 'spacingAfter', 'lineSpacing', 'keepWithNext', 'pageBreakBefore', 'border', 'tabStops', 'listKind', 'listLevel'],
      comment: ['author', 'initials', 'date', 'text', 'anchoredText', 'resolved', 'replies'],
      contentControl: ['tag', 'title', 'lock', 'text'],
      revision: ['author', 'date', 'type', 'typeCode', 'text', 'resolution'],
      fields: ['toc', 'page', 'numPages', 'pageBreak', 'sectionBreak'],
      links: ['address', 'subAddress', 'display', 'bookmark'],
      provenance: ['source.document', 'source.target', 'source.label'],
      design: ['profile', 'purpose', 'expressionMode', 'intent', 'audience', 'tone', 'density', 'palette', 'typography', 'signature', 'content.packageId', 'content.audience', 'content.objective', 'content.decision', 'content.period', 'content.facts', 'content.claims', 'review'],
    },
  },
  xlsx: {
    paths: ['/sheet[NAME]', '/sheet[NAME]/cell[A1]', '/sheet[NAME]/range[A1:C10]'],
    operations: {
      common: ['replace_text', 'set_cell', 'set_formula', 'set_range', 'append_row', 'clear_cell', 'compose_sheet', 'add_sheet', 'delete_sheet', 'rename_sheet', 'set_style', 'merge_cells', 'unmerge_cells', 'freeze_panes', 'autofit_range', 'set_page_setup', 'set_sheet_view', 'add_chart', 'add_table', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'set_autofilter', 'set_sheet_visibility', 'define_name', 'delete_name', 'copy_sheet', 'add_image', 'set_hyperlink', 'protect_sheet', 'unprotect_sheet', 'add_validation', 'add_conditional_format', 'delete_conditional_formats', 'add_note', 'delete_note', 'add_provenance', 'add_pivot_table'],
      office: [],
      portable: [],
    },
    properties: {
      cellStyle: ['fontName', 'fontSize', 'bold', 'italic', 'color', 'fillColor', 'numberFormat', 'horizontalAlignment', 'verticalAlignment', 'wrapText'],
      chart: ['chartType', 'left', 'top', 'width', 'height', 'title', 'seriesColors', 'showValues', 'showLegend', 'zeroBaseline', 'valueNumberFormat', 'dataLabelPosition', 'dataLabelColor'],
      table: ['name', 'style'],
      pivot: ['source', 'destination', 'name', 'rows', 'columns', 'values'],
      note: ['text', 'author'],
      structure: ['row', 'column', 'count', 'range', 'referenceAware'],
      links: ['address', 'text'],
      protection: ['password', 'allowFormattingCells', 'allowSorting', 'allowFiltering'],
      audit: ['conditionalFormats', 'formulaLineage', 'checksSheet', 'hardcodeSource', 'rogueHardcode'],
      pageSetup: ['printArea', 'fitToContent', 'orientation', 'fitToPagesWide', 'fitToPagesTall', 'centerHorizontally', 'centerVertically', 'topMargin', 'bottomMargin', 'leftMargin', 'rightMargin'],
      sheetView: ['showGridlines', 'zoom'],
      provenance: ['source.document', 'source.target', 'source.label'],
      design: ['profile', 'purpose', 'expressionMode', 'intent', 'audience', 'tone', 'density', 'palette', 'typography', 'signature', 'content.packageId', 'content.audience', 'content.objective', 'content.decision', 'content.period', 'content.facts', 'content.claims', 'review'],
    },
  },
  pptx: {
    paths: ['/slide[N]', '/slide[N]/shape[N]'],
    operations: {
      common: ['replace_text', 'fill_template', 'set_text', 'add_textbox', 'delete_shape', 'compose_slide', 'add_slide', 'delete_slide', 'move_slide', 'set_notes', 'add_image', 'add_shape', 'add_table', 'set_shape', 'set_slide_background', 'import_slides', 'replace_image', 'set_table_data', 'fit_text', 'add_chart', 'set_chart_data', 'duplicate_slide', 'z_order', 'align_shapes', 'distribute_shapes', 'keep_slides', 'set_hyperlink', 'add_provenance', 'set_layout', 'crop_image', 'set_transition', 'set_footer', 'set_slide_number', 'set_chart_axis', 'set_chart_data_labels', 'group_shapes', 'ungroup_shape', 'set_chart_trendline', 'set_chart_error_bars', 'set_chart_series', 'add_comment', 'delete_comment', 'apply_theme', 'add_media', 'add_animation'],
      office: [],
      portable: [],
    },
    properties: {
      shape: ['left', 'top', 'width', 'height', 'rotation', 'fillColor', 'fillTransparency', 'lineColor', 'lineTransparency', 'shadow', 'marginLeft', 'marginTop', 'marginRight', 'marginBottom', 'fontName', 'fontSize', 'bold', 'italic', 'color', 'paragraphSpacing'],
      chart: ['chartType', 'left', 'top', 'width', 'height', 'title', 'series', 'axis', 'dataLabels', 'seriesType', 'secondaryAxis', 'trendline', 'errorBars'],
      slide: ['background', 'layout', 'layoutName'],
      placeholder: ['type', 'index'],
      table: ['rows', 'columns', 'values', 'fontName', 'fontSize', 'color', 'headerFillColor', 'headerColor', 'bodyFillColor', 'headerRowHeight', 'bodyRowHeight'],
      template: ['tokens', 'strict'],
      authoring: ['shapeType', 'paragraphs', 'bullet', 'level', 'hyperlink', 'zOrder', 'align', 'distribute', 'group', 'crop', 'theme', 'footer', 'slideNumber'],
      transition: ['effect', 'duration', 'advanceOnTime', 'advanceTime'],
      animation: ['effect', 'trigger', 'duration', 'delay'],
      media: ['kind', 'link', 'embed', 'poster'],
      comment: ['author', 'initials', 'left', 'top'],
      provenance: ['source.document', 'source.target', 'source.label'],
      design: ['profile', 'purpose', 'expressionMode', 'intent', 'audience', 'tone', 'density', 'palette', 'typography', 'signature', 'content.packageId', 'content.audience', 'content.objective', 'content.decision', 'content.period', 'content.facts', 'content.claims', 'template', 'deck.backgroundMode', 'deck.dominantColorRole', 'deck.motif', 'deck.spacingScale', 'deck.sectionSlides', 'deck.roles', 'deck.requireSlidePlan', 'deck.templateMode', 'review', 'reviewed', 'reviewToken', 'critique'],
    },
  },
  pdf: {
    paths: ['/page[N]', '/field[N]', '/metadata', '/attachments'],
    operations: {
      common: ['add_text', 'watermark', 'stamp_image', 'ocr_pages', 'rotate_pages', 'delete_pages', 'move_page', 'extract_pages', 'fill_form', 'add_form_field', 'flatten_form', 'merge_pdf', 'add_attachment', 'compress', 'set_metadata'],
      office: [],
      portable: [],
    },
    properties: {
      text: ['x', 'y', 'size', 'color', 'opacity', 'rotation'],
      metadata: ['title', 'author', 'subject', 'keywords'],
      form: ['name', 'type', 'page', 'x', 'y', 'width', 'height', 'options', 'value', 'multiline'],
      attachment: ['path', 'name', 'mimeType', 'description'],
      textFont: ['fontPath'],
      unsupportedSecurity: ['secureRedaction', 'digitalSignature', 'PDF/A'],
    },
  },
  csv: TABULAR,
  tsv: TABULAR,
};

const BACKENDS = new Set(['microsoft-office-com', 'mixdog-ooxml', 'mixdog-tabular', 'mixdog-pdf']);
const VIRTUAL_OPERATIONS = new Set(['compose_document', 'compose_sheet', 'compose_slide']);

function signature(required = [], optional = [], {
  oneOf = [],
  propertySets = [],
  notes = '',
} = {}) {
  return { required, optional, oneOf, propertySets, notes };
}

const COMMON_SIGNATURES = {
  replace_text: signature(['find', 'replace']),
  fill_template: signature(['tokens'], ['strict'], {
    notes: 'Use strict:true to fail when a token is missing or left unresolved.',
  }),
};

const FORMAT_SIGNATURES = {
  docx: {
    compose_document: signature(['title'], ['claimId', 'purpose', 'expressionMode', 'variant', 'subtitle', 'summary', 'summaryLabel', 'meta', 'sections', 'footer', 'orientation', 'pageNumbers'], {
      propertySets: ['design'],
      notes: 'Purpose-aware native Word composition; variant is optional because content topology selects the default.',
    }),
    append_text: signature(['text'], ['style', 'properties'], {
      propertySets: ['paragraph', 'font', 'paragraphFormat'],
      notes: 'Creates one real paragraph.',
    }),
    set_paragraph_text: signature(['paragraph', 'text']),
    set_run_text: signature(['paragraph', 'run', 'text']),
    set_table_cell: signature(['table', 'row', 'col', 'text']),
    add_table: signature(['values'], ['paragraph', 'rows', 'columns', 'properties'], { propertySets: ['table'] }),
    set_table_style: signature(['table', 'properties'], [], { propertySets: ['table'] }),
    merge_table_cells: signature(['table', 'row', 'col'], ['rowSpan', 'colSpan']),
    set_table_cell_style: signature(['table', 'row', 'col', 'properties'], [], { propertySets: ['tableCell'] }),
    set_paragraph_format: signature(['paragraph', 'properties'], [], { propertySets: ['paragraphFormat'] }),
    remove_paragraph: signature(['paragraph']),
    move_paragraph: signature(['paragraph', 'index']),
    set_paragraph_style: signature(['paragraph', 'style']),
    set_font: signature(['find', 'properties'], [], { propertySets: ['font'] }),
    add_image: signature(['path'], ['paragraph', 'width', 'height']),
    add_comment: signature(['find', 'text'], ['author', 'initials']),
    add_comment_reply: signature(['comment', 'text'], ['author', 'initials']),
    delete_comment: signature(['comment']),
    set_comment_resolved: signature(['comment', 'resolved']),
    insert_table_row: signature(['table', 'row']),
    delete_table_row: signature(['table', 'row']),
    insert_table_column: signature(['table', 'column']),
    delete_table_column: signature(['table', 'column']),
    set_header_footer: signature(['text'], ['section', 'kind', 'header'], { propertySets: ['headerFooter'] }),
    track_changes: signature(['enabled']),
    resolve_revision: signature(['revision', 'resolution']),
    resolve_revisions: signature(['resolution']),
    set_page: signature(['properties'], ['section'], { propertySets: ['page'] }),
    fit_table: signature(['table']),
    insert_toc: signature([], ['paragraph', 'lowerHeadingLevel', 'upperHeadingLevel']),
    add_page_numbers: signature([], ['section', 'kind', 'prefix', 'separator', 'includeTotal', 'alignment']),
    insert_break: signature([], ['paragraph', 'kind']),
    set_list: signature(['paragraph', 'kind'], ['level']),
    add_hyperlink: signature([], ['find', 'paragraph', 'address', 'subAddress', 'display'], {
      oneOf: [['find'], ['paragraph']],
      propertySets: ['links'],
    }),
    add_bookmark: signature(['name'], ['find', 'paragraph'], { oneOf: [['find'], ['paragraph']] }),
    add_provenance: signature(['paragraph', 'source'], [], { propertySets: ['provenance'] }),
  },
  xlsx: {
    compose_sheet: signature(['rows'], ['claimId', 'purpose', 'expressionMode', 'variant', 'sheet', 'kind', 'title', 'subtitle', 'source', 'headers', 'metrics', 'insights', 'decision', 'gates', 'actions', 'columnFormats', 'tableName', 'tableStyle', 'chart'], {
      propertySets: ['design'],
      notes: 'Purpose-aware native Excel composition with content-selected dashboard, trend, comparison, scorecard, or analysis layout.',
    }),
    set_cell: signature(['cell', 'value'], ['sheet']),
    set_formula: signature(['cell', 'formula'], ['sheet']),
    set_range: signature(['range', 'values'], ['sheet']),
    append_row: signature(['values'], ['sheet']),
    clear_cell: signature(['cell'], ['sheet']),
    add_sheet: signature(['name']),
    copy_sheet: signature(['sheet'], ['name']),
    delete_sheet: signature(['sheet']),
    rename_sheet: signature(['name'], ['sheet']),
    set_style: signature(['properties'], ['sheet'], {
      oneOf: [['cell'], ['range']],
      propertySets: ['cellStyle'],
    }),
    add_note: signature(['cell', 'text'], ['sheet']),
    delete_note: signature(['cell'], ['sheet']),
    add_image: signature(['path'], ['sheet', 'left', 'top', 'width', 'height']),
    add_table: signature(['range'], ['sheet', 'name', 'style'], { propertySets: ['table'] }),
    add_chart: signature(['range'], ['sheet', 'chartType', 'title', 'left', 'top', 'width', 'height', 'seriesColors', 'showValues', 'showLegend', 'zeroBaseline', 'valueNumberFormat', 'dataLabelPosition', 'dataLabelColor'], {
      propertySets: ['chart'],
      notes: 'The first source column supplies categories; remaining columns become series.',
    }),
    add_conditional_format: signature(['range', 'formula'], ['sheet', 'color', 'fillColor']),
    delete_conditional_formats: signature(['range'], ['sheet']),
    add_validation: signature(['range', 'formula1'], ['sheet', 'inputMessage', 'errorMessage']),
    freeze_panes: signature([], ['sheet', 'row', 'column']),
    add_pivot_table: signature(['source', 'destination'], ['sheet', 'destinationSheet', 'name', 'rows', 'columns', 'values'], { propertySets: ['pivot'] }),
    autofit_range: signature(['range'], ['sheet', 'rows'], {
      notes: 'Accepts cell, whole-column, or whole-row ranges such as A1:D5, A:D, or 2:8.',
    }),
    set_page_setup: signature([], ['sheet', 'printArea', 'fitToContent', 'orientation', 'fitToPagesWide', 'fitToPagesTall', 'centerHorizontally', 'centerVertically', 'topMargin', 'bottomMargin', 'leftMargin', 'rightMargin'], {
      propertySets: ['pageSetup'],
    }),
    set_sheet_view: signature([], ['sheet', 'showGridlines', 'zoom'], {
      propertySets: ['sheetView'],
    }),
    set_sheet_visibility: signature(['sheet', 'visibility'], [], {
      notes: 'visibility is visible, hidden, or very_hidden; keep at least one worksheet visible.',
    }),
    insert_rows: signature(['row'], ['sheet', 'count']),
    delete_rows: signature(['row'], ['sheet', 'count']),
    insert_columns: signature(['column'], ['sheet', 'count']),
    delete_columns: signature(['column'], ['sheet', 'count']),
    merge_cells: signature(['range'], ['sheet']),
    unmerge_cells: signature(['range'], ['sheet']),
    set_autofilter: signature(['range'], ['sheet', 'enabled']),
    set_hyperlink: signature(['cell'], ['sheet', 'address', 'subAddress', 'text', 'screenTip'], { propertySets: ['links'] }),
    define_name: signature(['name', 'refersTo']),
    delete_name: signature(['name']),
    protect_sheet: signature([], ['sheet', 'password', 'allowFormattingCells', 'allowSorting', 'allowFiltering'], { propertySets: ['protection'] }),
    unprotect_sheet: signature([], ['sheet', 'password']),
    add_provenance: signature(['cell', 'source'], ['sheet'], { propertySets: ['provenance'] }),
  },
  pptx: {
    compose_slide: signature(['kind'], ['claimId', 'purpose', 'expressionMode', 'title', 'subtitle', 'takeaway', 'eyebrow', 'body', 'bullets', 'metrics', 'columns', 'steps', 'chart', 'table', 'image', 'imagePath', 'visualText', 'visualLabel', 'meta', 'notes', 'source', 'background', 'backgroundRole', 'slideRole', 'plan', 'create', 'slide', 'layoutId', 'variant', 'titleSize'], {
      propertySets: ['design'],
      notes: 'Model-first semantic slide. New scratch slides require plan.regions with 0-100 x/y/w/h boxes and roles: eyebrow, title, subtitle, meta, body, bullets, metric, metrics, chart, table, image, visual, process, comparison, shape, source. The renderer repairs safe bounds and small collisions; invalid plans fail for replanning and never fall back to a template. Native templates run only when layoutId or design.deck.templateMode prefer/strict is explicitly requested.',
    }),
    set_text: signature(['slide', 'shape', 'text']),
    add_textbox: signature(['slide', 'text'], ['paragraphs', 'left', 'top', 'width', 'height', 'fontName', 'fontSize', 'color', 'properties'], { propertySets: ['shape', 'authoring'] }),
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
    add_comment: signature(['slide', 'text'], ['author', 'initials', 'left', 'top'], { propertySets: ['comment'] }),
    delete_comment: signature(['slide', 'comment']),
    add_image: signature(['slide', 'path'], ['left', 'top', 'width', 'height', 'fit', 'focusX', 'focusY'], {
      notes: 'fit is stretch (legacy), contain (letterbox without distortion), or cover (crop without distortion). focusX/focusY are 0-1 focal points for cover.',
    }),
    replace_image: signature(['slide', 'shape', 'path']),
    crop_image: signature(['slide', 'shape'], ['left', 'top', 'right', 'bottom']),
    add_media: signature(['slide', 'path'], ['kind', 'link', 'embed', 'poster', 'left', 'top', 'width', 'height'], { propertySets: ['media', 'shape'] }),
    set_shape: signature(['slide', 'shape', 'properties'], [], { propertySets: ['shape'] }),
    group_shapes: signature(['slide', 'shapes']),
    ungroup_shape: signature(['slide', 'shape']),
    set_slide_background: signature(['slide', 'color']),
    set_layout: signature(['slide', 'layout']),
    apply_theme: signature(['path']),
    set_transition: signature(['slide'], ['effect', 'duration', 'advanceOnTime', 'advanceTime'], { propertySets: ['transition'] }),
    add_animation: signature(['slide', 'shape'], ['effect', 'trigger', 'duration', 'delay'], { propertySets: ['animation'] }),
    add_chart: signature(['slide'], ['chartType', 'title', 'categories', 'series', 'left', 'top', 'width', 'height'], { propertySets: ['chart'] }),
    fit_text: signature(['slide', 'shape'], ['minFontSize', 'allowNoChange']),
    add_shape: signature(['slide', 'shapeType'], ['text', 'paragraphs', 'left', 'top', 'width', 'height', 'fillColor', 'lineColor', 'properties'], { propertySets: ['shape', 'authoring'] }),
    add_table: signature(['slide', 'values'], ['rows', 'columns', 'left', 'top', 'width', 'height', 'properties'], { propertySets: ['table'] }),
    set_table_data: signature(['slide', 'shape', 'values'], [], { propertySets: ['table'] }),
    set_chart_data: signature(['slide', 'shape', 'series'], ['categories', 'title'], { propertySets: ['chart'] }),
    set_chart_series: signature(['slide', 'shape', 'series'], ['name', 'categories', 'values', 'chartType', 'secondaryAxis'], { propertySets: ['chart'] }),
    set_chart_axis: signature(['slide', 'shape', 'axis'], ['title', 'minimum', 'maximum', 'majorUnit', 'numberFormat', 'secondaryAxis'], { propertySets: ['chart'] }),
    set_chart_data_labels: signature(['slide', 'shape'], ['series', 'showValue', 'showCategoryName', 'position', 'numberFormat'], { propertySets: ['chart'] }),
    set_chart_trendline: signature(['slide', 'shape'], ['series', 'type', 'displayEquation', 'displayRSquared'], { propertySets: ['chart'] }),
    set_chart_error_bars: signature(['slide', 'shape'], ['series', 'amount', 'direction', 'endStyle'], { propertySets: ['chart'] }),
    set_hyperlink: signature(['slide', 'shape'], ['address', 'subAddress'], { propertySets: ['authoring'] }),
    z_order: signature(['slide', 'shape', 'command']),
    align_shapes: signature(['slide', 'shapes', 'align'], ['relativeToSlide']),
    distribute_shapes: signature(['slide', 'shapes', 'direction'], ['relativeToSlide']),
    add_provenance: signature(['slide', 'shape', 'source'], [], { propertySets: ['provenance'] }),
  },
  pdf: {
    add_text: signature(['text'], ['page', 'pages', 'x', 'y', 'size', 'color', 'opacity', 'rotation', 'fontPath'], {
      propertySets: ['text', 'textFont'],
      notes: 'Non-Latin text in an existing PDF requires fontPath.',
    }),
    watermark: signature(['text'], ['page', 'pages', 'x', 'y', 'size', 'color', 'opacity', 'rotation', 'fontPath'], {
      propertySets: ['text', 'textFont'],
      notes: 'Non-Latin text requires fontPath.',
    }),
    stamp_image: signature(['path'], ['page', 'pages', 'x', 'y', 'width', 'height', 'opacity']),
    ocr_pages: signature([], ['page', 'pages', 'languages', 'minConfidence', 'maxWidth', 'fontPath']),
    rotate_pages: signature([], ['page', 'pages', 'rotation']),
    delete_pages: signature([], ['page', 'pages']),
    move_page: signature(['page', 'index']),
    extract_pages: signature([], ['page', 'pages']),
    fill_form: signature(['values'], ['flatten']),
    add_form_field: signature(['name', 'type', 'page', 'x', 'y', 'width', 'height'], ['options', 'value', 'multiline'], { propertySets: ['form'] }),
    flatten_form: signature(),
    merge_pdf: signature(['path']),
    add_attachment: signature(['path'], ['name', 'mimeType', 'description'], { propertySets: ['attachment'] }),
    compress: signature(),
    set_metadata: signature(['properties'], [], { propertySets: ['metadata'] }),
  },
};

function rawCatalogOperations(catalog) {
  return [...new Set([
    ...catalog.operations.common,
    ...catalog.operations.office,
    ...catalog.operations.portable,
  ])];
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
  const formatSignatures = format === 'csv' || format === 'tsv'
    ? FORMAT_SIGNATURES.xlsx
    : FORMAT_SIGNATURES[format];
  if (Object.hasOwn(formatSignatures || {}, operation)) return formatSignatures[operation];
  if (Object.hasOwn(COMMON_SIGNATURES, operation)) return COMMON_SIGNATURES[operation];
  return null;
}

export const OFFICE_OPERATION_REGISTRY = Object.freeze(Object.fromEntries(
  Object.entries(CATALOG).map(([format, catalog]) => [
    format,
    Object.freeze(Object.fromEntries(rawCatalogOperations(catalog).map((operation) => {
      const input = explicitOperationSignature(format, operation);
      if (!input) throw new Error(`Office operation registry is missing a signature for ${format}.${operation}`);
      return [operation, Object.freeze({
        input,
        supportedBackends: Object.freeze(operationBackends(format, catalog, operation)),
      })];
    }))),
  ]),
));

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
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[b.length];
}

function operationSuggestions(operation, operations) {
  return [...operations]
    .map((candidate) => ({ candidate, distance: editDistance(operation, candidate) }))
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

function operationDescription(format, backend, catalog, operation) {
  const knownOperations = catalogOperations(format);
  if (!knownOperations.includes(operation)) {
    const suggestions = operationSuggestions(operation, knownOperations);
    throw new Error(`Unknown ${format.toUpperCase()} operation "${operation}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Call describe with format:"${format}" to list operations.`);
  }
  const available = operationsForBackend(format, backend);
  const signatureValue = operationSignature(format, operation);
  const properties = Object.fromEntries(
    signatureValue.propertySets
      .filter((name) => catalog.properties[name])
      .map((name) => [name, catalog.properties[name]]),
  );
  return {
    name: operation,
    ...(VIRTUAL_OPERATIONS.has(operation) ? { virtual: true } : {}),
    supported: !backend || available.includes(operation),
    supportedBackends: supportedBackends(format, operation),
    input: {
      required: ['op', ...signatureValue.required],
      ...(signatureValue.oneOf.length ? { oneOf: signatureValue.oneOf } : {}),
      optional: [...new Set([...signatureValue.optional, 'allowNoChange'])]
        .filter((field) => !signatureValue.required.includes(field)),
    },
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(signatureValue.notes ? { notes: signatureValue.notes } : {}),
  };
}

export function assertOfficeOperationContracts({ format = '', backend = '', operations = [] } = {}) {
  const catalog = CATALOG[format];
  if (!catalog) throw new Error(`Unsupported Office Use format: ${format}`);
  const available = operationsForBackend(format, backend);
  const known = catalogOperations(format);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`Office operation ${index + 1} must be an object`);
    }
    const name = String(operation.op || '').trim();
    if (!name) throw new Error(`Office operation ${index + 1} requires op`);
    if (!known.includes(name)) {
      const suggestions = operationSuggestions(name, known);
      throw new Error(`Unknown ${format.toUpperCase()} operation "${name}" at index ${index + 1}.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} ${describeHint(format, backend, name)}`);
    }
    if (!available.includes(name)) {
      const alternatives = supportedBackends(format, name);
      throw new Error(`${format.toUpperCase()} operation "${name}" is unsupported by ${backend || 'this backend'}.${alternatives.length ? ` Supported backend(s): ${alternatives.join(', ')}.` : ''} ${describeHint(format, backend, name)}`);
    }
    const signatureValue = operationSignature(format, name);
    const allowed = new Set([
      'op',
      'allowNoChange',
      ...signatureValue.required,
      ...signatureValue.optional,
      ...signatureValue.oneOf.flat(),
    ]);
    const unknown = Object.keys(operation).filter((field) => !allowed.has(field));
    if (unknown.length) {
      const suggestions = unknown.map((field) => {
        const [candidate] = operationSuggestions(field, allowed);
        return candidate && candidate !== field ? `${field}→${candidate}` : field;
      });
      throw new Error(`${format.toUpperCase()} operation "${name}" at index ${index + 1} has unknown field(s): ${unknown.join(', ')}.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} ${describeHint(format, backend, name)}`);
    }
    const missing = signatureValue.required.filter((field) => operation[field] === undefined);
    const matchesAlternative = !signatureValue.oneOf.length
      || signatureValue.oneOf.some((alternative) => alternative.every((field) => operation[field] !== undefined));
    if (missing.length || !matchesAlternative) {
      const requirements = [
        ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
        ...(!matchesAlternative ? [`requires one of: ${signatureValue.oneOf.map((entry) => entry.join('+')).join(' or ')}`] : []),
      ].join('; ');
      throw new Error(`${format.toUpperCase()} operation "${name}" at index ${index + 1} has invalid input (${requirements}). ${describeHint(format, backend, name)}`);
    }
  }
  return operations;
}

export function describeOfficeCapabilities({
  format = '',
  backend = '',
  target = '',
  operation = '',
} = {}) {
  if (backend && !BACKENDS.has(backend)) throw new Error(`Unsupported Office backend: ${backend}`);
  if (!format) {
    if (operation) throw new Error('describe with operation requires format, path, or session');
    return {
      ...COMMON,
      designs: officeDesignCatalog(),
      formats: Object.fromEntries(Object.entries(CATALOG).map(([name, value]) => [name, {
        paths: value.paths,
        operationCount: catalogOperations(name).length,
      }])),
      nextAction: 'When discovery is needed, add format for its operation list or add operation for one compact input contract; otherwise call create/open/batch directly.',
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
  const unsupported = backend
    ? catalogOperations(format).filter((name) => !operations.includes(name))
    : [];
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
    nextAction: 'If exact fields are unknown, add operation for its compact contract; otherwise call create/open/batch directly.',
  };
}
