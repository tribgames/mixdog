export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_MAX_RANGE_CELLS = 100_000;

function columnNumber(label) {
  let value = 0;
  for (const character of String(label || '').toUpperCase()) {
    value = (value * 26) + character.charCodeAt(0) - 64;
  }
  return value;
}

export function parseXlsxCell(reference) {
  const match = /^([A-Z]+)([1-9]\d*)$/i.exec(String(reference || '').trim());
  if (!match) throw new Error(`Invalid XLSX cell reference: ${reference}`);
  const column = columnNumber(match[1]);
  const row = Number(match[2]);
  if (column < 1 || column > XLSX_MAX_COLUMNS) {
    throw new Error(`XLSX column must be between A and XFD: ${reference}`);
  }
  if (row < 1 || row > XLSX_MAX_ROWS) {
    throw new Error(`XLSX row must be between 1 and ${XLSX_MAX_ROWS}: ${reference}`);
  }
  return { ref: `${match[1].toUpperCase()}${row}`, row, column };
}

export function parseXlsxRange(reference, { maxCells = XLSX_MAX_RANGE_CELLS } = {}) {
  const match = /^([^:]+):([^:]+)$/.exec(String(reference || '').trim());
  if (!match) throw new Error(`Invalid XLSX range: ${reference}`);
  const start = parseXlsxCell(match[1]);
  const end = parseXlsxCell(match[2]);
  if (start.row > end.row || start.column > end.column) {
    throw new Error(`XLSX range start must not follow range end: ${reference}`);
  }
  const rows = end.row - start.row + 1;
  const columns = end.column - start.column + 1;
  const cells = rows * columns;
  if (cells > maxCells) {
    throw new Error(`XLSX range contains ${cells} cells; maximum is ${maxCells}`);
  }
  return { start, end, rows, columns, cells };
}

export function parseXlsxAutofitRange(reference) {
  const text = String(reference || '').trim();
  const columns = /^([A-Z]+):([A-Z]+)$/i.exec(text);
  if (columns) {
    const start = columnNumber(columns[1]);
    const end = columnNumber(columns[2]);
    if (start < 1 || end > XLSX_MAX_COLUMNS || start > end) {
      throw new Error(`Invalid XLSX column range: ${reference}`);
    }
    return { type: 'columns', start, end };
  }
  const rows = /^([1-9]\d*):([1-9]\d*)$/.exec(text);
  if (rows) {
    const start = Number(rows[1]);
    const end = Number(rows[2]);
    if (end > XLSX_MAX_ROWS || start > end) throw new Error(`Invalid XLSX row range: ${reference}`);
    return { type: 'rows', start, end };
  }
  return { type: 'cells', ...parseXlsxRange(text) };
}

function validateRangeMatrix(operation, area) {
  if (!Array.isArray(operation.values)) {
    throw new Error('XLSX set_range requires values as a row matrix');
  }
  if (operation.values.length !== area.rows) {
    throw new Error(`XLSX set_range expected ${area.rows} value row(s), received ${operation.values.length}`);
  }
  for (let index = 0; index < operation.values.length; index += 1) {
    const row = operation.values[index];
    if (!Array.isArray(row) || row.length !== area.columns) {
      throw new Error(`XLSX set_range row ${index + 1} expected ${area.columns} value(s), received ${Array.isArray(row) ? row.length : 'a non-array'}`);
    }
  }
}

const PREFIXED_FUNCTIONS = Object.freeze(['TEXTJOIN', 'CONCAT', 'IFS', 'SWITCH', 'MAXIFS', 'MINIFS']);
const SPILLING_FUNCTIONS = Object.freeze([
  'XLOOKUP', 'XMATCH', 'SORTBY', 'SORT', 'FILTER', 'UNIQUE', 'SEQUENCE', 'RANDARRAY',
]);

export function normalizeXlsxFormula(formula, { backend = '' } = {}) {
  const text = String(formula ?? '').replace(/^=/, '');
  if (!text) throw new Error('XLSX formula must not be empty');
  if (backend === 'mixdog-ooxml') {
    const spilling = new RegExp(`(?:^|[^A-Za-z0-9_.])(${SPILLING_FUNCTIONS.join('|')})\\s*\\(`, 'i').exec(text);
    if (spilling) {
      throw new Error(`XLSX formula uses ${spilling[1].toUpperCase()}, which the portable recalculation engine cannot evaluate and would bake in as #NAME?; use INDEX/MATCH or precompute the values`);
    }
  }
  return text.replace(
    new RegExp(`(^|[^A-Za-z0-9_.])(${PREFIXED_FUNCTIONS.join('|')})\\s*\\(`, 'gi'),
    (_match, lead, name) => `${lead}_xlfn.${name.toUpperCase()}(`,
  );
}

export function validateXlsxOperations(operations) {
  for (const operation of operations || []) {
    if (!operation || typeof operation !== 'object') throw new Error('XLSX operation must be an object');
    const op = String(operation.op || '');
    if (['set_cell', 'set_formula', 'clear_cell', 'add_note', 'delete_note'].includes(op)) {
      parseXlsxCell(operation.cell);
    }
    if (op === 'freeze_panes') {
      const row = operation.row ?? 1;
      const column = operation.column ?? 0;
      if (!Number.isInteger(row) || row < 0 || row > XLSX_MAX_ROWS) {
        throw new Error(`XLSX freeze_panes row must be between 0 and ${XLSX_MAX_ROWS}`);
      }
      if (!Number.isInteger(column) || column < 0 || column > XLSX_MAX_COLUMNS) {
        throw new Error(`XLSX freeze_panes column must be between 0 and ${XLSX_MAX_COLUMNS}`);
      }
    }
    if (op === 'set_style' && operation.cell) parseXlsxCell(operation.cell);
    if (operation.range && [
      'set_range',
      'set_style',
      'add_table',
      'add_chart',
      'add_conditional_format',
      'add_validation',
    ].includes(op)) {
      const area = parseXlsxRange(operation.range);
      if (op === 'set_range') validateRangeMatrix(operation, area);
    } else if (op === 'set_range') {
      throw new Error('XLSX set_range requires range');
    }
    if (op === 'autofit_range') {
      if (!operation.range) throw new Error('XLSX autofit_range requires range');
      parseXlsxAutofitRange(operation.range);
    }
    if (op === 'append_row') {
      if (!Array.isArray(operation.values)) throw new Error('XLSX append_row requires values');
      if (operation.values.length > XLSX_MAX_COLUMNS) {
        throw new Error(`XLSX append_row contains ${operation.values.length} values; maximum is ${XLSX_MAX_COLUMNS}`);
      }
    }
    if (['insert_rows', 'delete_rows'].includes(op)) {
      const row = operation.row;
      const count = operation.count ?? 1;
      if (!Number.isInteger(row) || row < 1 || row > XLSX_MAX_ROWS) {
        throw new Error(`XLSX ${op} row must be between 1 and ${XLSX_MAX_ROWS}`);
      }
      if (!Number.isInteger(count) || count < 1 || row + count - 1 > XLSX_MAX_ROWS) {
        throw new Error(`XLSX ${op} count exceeds the worksheet row limit`);
      }
    }
    if (['insert_columns', 'delete_columns'].includes(op)) {
      const column = operation.column;
      const count = operation.count ?? 1;
      if (!Number.isInteger(column) || column < 1 || column > XLSX_MAX_COLUMNS) {
        throw new Error(`XLSX ${op} column must be between 1 and ${XLSX_MAX_COLUMNS}`);
      }
      if (!Number.isInteger(count) || count < 1 || column + count - 1 > XLSX_MAX_COLUMNS) {
        throw new Error(`XLSX ${op} count exceeds the worksheet column limit`);
      }
    }
    if (['merge_cells', 'unmerge_cells', 'set_autofilter'].includes(op)) {
      if (!operation.range) throw new Error(`XLSX ${op} requires range`);
      parseXlsxRange(operation.range);
    }
  }
  return operations;
}
