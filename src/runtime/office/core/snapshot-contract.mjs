// One snapshot contract for both backends. Microsoft Office and the portable
// reader describe the same document, and design review, assurance, and the agent
// itself all read these fields. Drift between them stays invisible until a rule
// quietly stops firing — exactly how portable decks lost their theme and visual
// evidence checks while every test still passed.

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function checkPagination(pagination, violations) {
  if (pagination === null || pagination === undefined) return;
  const at = '/pagination';
  if (typeof pagination.unit !== 'string' || !pagination.unit) {
    violations.push({ path: at, message: 'pagination.unit must be a non-empty string' });
  }
  for (const key of ['offset', 'limit', 'returned', 'total']) {
    if (!isCount(pagination[key])) {
      violations.push({ path: at, message: `pagination.${key} must be a non-negative integer` });
    }
  }
  if (typeof pagination.hasMore !== 'boolean') {
    violations.push({ path: at, message: 'pagination.hasMore must be a boolean' });
  }
  if (!(pagination.nextCursor === null || typeof pagination.nextCursor === 'string')) {
    violations.push({ path: at, message: 'pagination.nextCursor must be a string or null' });
  }
  if (isCount(pagination.returned) && isCount(pagination.total) && pagination.returned > pagination.total) {
    violations.push({
      path: at,
      message: `pagination.returned ${pagination.returned} exceeds total ${pagination.total}`,
    });
  }
  const advertisesMore = typeof pagination.nextCursor === 'string' && pagination.nextCursor.length > 0;
  if (typeof pagination.hasMore === 'boolean' && pagination.hasMore !== advertisesMore) {
    violations.push({ path: at, message: 'pagination.hasMore must agree with the presence of nextCursor' });
  }
}


function checkDocx(document, violations) {
  for (const key of ['paragraphCount', 'tableCount']) {
    if (!isCount(document[key])) {
      violations.push({ path: '/', message: `${key} must be a non-negative integer` });
    }
  }
  for (const paragraph of Array.isArray(document.paragraphs) ? document.paragraphs : []) {
    const index = paragraph?.index;
    if (!Number.isInteger(index) || index < 1) {
      violations.push({ path: '/body', message: 'every paragraph needs a positive integer index' });
      continue;
    }
    const at = `/body/p[${index}]`;
    if (paragraph.path !== at) {
      violations.push({ path: at, message: `paragraph path ${paragraph.path} does not match its index` });
    }
    if (typeof paragraph.text !== 'string') {
      violations.push({ path: at, message: 'paragraph.text must be a string' });
    }
    // Word resolves an unstyled paragraph to Normal and reports built-in styles
    // under the UI language. Both backends therefore owe a non-empty styleId, or
    // a caller cannot carry a style from one backend to the other.
    if (typeof paragraph.style !== 'string' || !paragraph.style) {
      violations.push({ path: at, message: 'paragraph.style must be a non-empty style identifier' });
    }
    if (typeof paragraph.inTable !== 'boolean') {
      violations.push({ path: at, message: 'paragraph.inTable must be a boolean' });
    }
  }
  for (const table of Array.isArray(document.tables) ? document.tables : []) {
    const index = table?.index;
    if (!Number.isInteger(index) || index < 1) {
      violations.push({ path: '/body', message: 'every table needs a positive integer index' });
      continue;
    }
    const at = `/body/tbl[${index}]`;
    if (table.path !== at) {
      violations.push({ path: at, message: `table path ${table.path} does not match its index` });
    }
    if (!Array.isArray(table.rows)) {
      violations.push({ path: at, message: 'table.rows must be an array' });
    }
    if (typeof table.style !== 'string' || !table.style) {
      violations.push({ path: at, message: 'table.style must be a non-empty style identifier' });
    }
  }
}


function checkXlsx(document, violations) {
  const sheets = Array.isArray(document.sheets) ? document.sheets : [];
  if (!sheets.length) violations.push({ path: '/', message: 'a workbook snapshot must report at least one sheet' });
  for (const sheet of sheets) {
    if (typeof sheet?.name !== 'string' || !sheet.name) {
      violations.push({ path: '/', message: 'every sheet needs a non-empty name' });
      continue;
    }
    const at = `/sheet[${sheet.name}]`;
    if (sheet.path !== at) {
      violations.push({ path: at, message: `sheet path ${sheet.path} does not match its name` });
    }
    if (!Array.isArray(sheet.cells)) continue;
    for (const cell of sheet.cells) {
      if (typeof cell?.ref !== 'string' || !/^[A-Z]+\d+$/.test(cell.ref)) {
        violations.push({ path: at, message: `cell ref ${cell?.ref} is not an A1 reference` });
        continue;
      }
      const cellPath = `${at}/cell[${cell.ref}]`;
      if (cell.path !== cellPath) {
        violations.push({ path: cellPath, message: `cell path ${cell.path} does not match its reference` });
      }
      if (!('value' in cell)) {
        violations.push({ path: cellPath, message: 'cell must report a value key' });
      }
      // Optional facets both readers publish in one shape.
      if ('style' in cell && (!cell.style || typeof cell.style !== 'object' || Array.isArray(cell.style))) {
        violations.push({ path: cellPath, message: 'cell.style must be an object when present' });
      }
      if ('dataType' in cell && cell.dataType !== 'text') {
        violations.push({ path: cellPath, message: "cell.dataType must be 'text' when present" });
      }
      if ('note' in cell && typeof cell.note !== 'string') {
        violations.push({ path: cellPath, message: 'cell.note must be a string when present' });
      }
    }
    for (const table of Array.isArray(sheet.tables) ? sheet.tables : []) {
      if (typeof table?.name !== 'string' || !/^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+$/i.test(String(table?.range || ''))) {
        violations.push({ path: `${at}/table`, message: 'every table needs a name and an A1:B2 range' });
      }
    }
    for (const note of Array.isArray(sheet.notes) ? sheet.notes : []) {
      if (typeof note?.cell !== 'string' || !/^\$?[A-Z]+\$?\d+$/i.test(note.cell) || typeof note?.text !== 'string') {
        violations.push({ path: `${at}/note`, message: 'every note needs a cell reference and text' });
      }
    }
    if ('freezePanes' in sheet && sheet.freezePanes !== null
      && (typeof sheet.freezePanes !== 'object' || typeof sheet.freezePanes.frozen !== 'boolean')) {
      violations.push({ path: at, message: 'freezePanes must be null or { frozen, splitRow, splitColumn }' });
    }
  }
  if ('conventions' in document && document.conventions !== null
    && (typeof document.conventions !== 'object' || !Array.isArray(document.conventions.fonts))) {
    violations.push({ path: '/conventions', message: 'conventions must summarize fonts, numberFormats, and inputMarkers' });
  }
}


function checkPptx(document, violations) {
  if (!isCount(document.slideCount)) {
    violations.push({ path: '/', message: 'slideCount must be a non-negative integer' });
  }
  let previousIndex = 0;
  for (const slide of Array.isArray(document.slides) ? document.slides : []) {
    const index = slide?.index;
    if (!Number.isInteger(index) || index < 1) {
      violations.push({ path: '/', message: 'every slide needs a positive integer index' });
      continue;
    }
    const at = `/slide[${index}]`;
    if (slide.path !== at) {
      violations.push({ path: at, message: `slide path ${slide.path} does not match its index` });
    }
    if (index <= previousIndex) {
      violations.push({ path: at, message: 'slides must be reported in deck order' });
    }
    previousIndex = index;
    if (typeof slide.notes !== 'string') {
      violations.push({ path: at, message: 'slide.notes must be a string' });
    }
    if (!slide.background || typeof slide.background !== 'object') {
      violations.push({ path: at, message: 'slide.background must be an object' });
    } else if (typeof slide.background.color !== 'string') {
      violations.push({ path: at, message: 'slide.background.color must be a string' });
    }
    const shapes = Array.isArray(slide.shapes) ? slide.shapes : [];
    shapes.forEach((shape, position) => {
      const shapePath = `${at}/shape[${position + 1}]`;
      if (shape?.index !== position + 1) {
        violations.push({ path: shapePath, message: `shape.index ${shape?.index} does not match its position` });
      }
      if (shape?.path !== shapePath) {
        violations.push({ path: shapePath, message: `shape path ${shape?.path} does not match its position` });
      }
      const type = shape?.type;
      if (!(typeof type === 'number' || (typeof type === 'string' && type))) {
        violations.push({ path: shapePath, message: 'shape.type must be a number or a non-empty string' });
      }
      if (!(shape?.text === null || typeof shape?.text === 'string')) {
        violations.push({ path: shapePath, message: 'shape.text must be a string or null' });
      }
    });
  }
}


export function officeSnapshotContractViolations(document, { format = '', paged = false } = {}) {
  const violations = [];
  if (!document || typeof document !== 'object') {
    return [{ path: '/', message: 'snapshot document must be an object' }];
  }
  const declared = String(format || '').toLowerCase();
  if (declared && document.format !== declared) {
    violations.push({ path: '/', message: `document.format ${document.format} does not match the ${declared} session` });
  }
  if (paged && (document.pagination === null || document.pagination === undefined)) {
    violations.push({ path: '/pagination', message: 'a paged snapshot must report pagination' });
  }
  checkPagination(document.pagination, violations);
  if (declared === 'docx') checkDocx(document, violations);
  if (declared === 'xlsx') checkXlsx(document, violations);
  if (declared === 'pptx') checkPptx(document, violations);
  return violations;
}


export function describeOfficeSnapshotViolations(violations) {
  return (violations || []).map((entry) => `${entry.path}: ${entry.message}`).join('\n');
}
