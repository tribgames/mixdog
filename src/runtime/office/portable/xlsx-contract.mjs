import { columnNumber } from './portable-cells.mjs';
import { quoteSheetName } from './portable-sheet-xml.mjs';

const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_COLUMNS = 16_384;
const XLSX_MAX_RANGE_CELLS = 100_000;

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
  const text = String(reference || '').trim();
  // A single cell is a one-cell range — the writers already treat it as one,
  // and it is how a caller names a validated or styled cell.
  const match = /^([^:]+):([^:]+)$/.exec(text) || (text ? [text, text, text] : null);
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
      throw new Error(
        `XLSX set_range row ${index + 1} expected ${area.columns} value(s), received ${Array.isArray(row) ? row.length : 'a non-array'}`
      );
    }
  }
}

const PREFIXED_FUNCTIONS = Object.freeze(['TEXTJOIN', 'CONCAT', 'IFS', 'SWITCH', 'MAXIFS', 'MINIFS']);
const SPILLING_FUNCTIONS = Object.freeze([
  'XLOOKUP',
  'XMATCH',
  'SORTBY',
  'SORT',
  'FILTER',
  'UNIQUE',
  'SEQUENCE',
  'RANDARRAY',
]);

const SHEET_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `My Sheet!B5` evaluates to #VALUE!; Excel needs `'My Sheet'!B5`. Only names
// the workbook actually holds are quoted, and never inside a string literal.
function quoteSheetReferences(text, sheetNames) {
  const names = (sheetNames || [])
    .map((name) => String(name || ''))
    .filter((name) => name && !SHEET_IDENTIFIER.test(name))
    .sort((left, right) => right.length - left.length);
  if (!names.length) return text;
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      let output = segment;
      for (const name of names) {
        output = output.replace(
          new RegExp(`(^|[^'A-Za-z0-9_.\\]])${escapeRegExp(name)}!`, 'g'),
          (_match, lead) => `${lead}${quoteSheetName(name)}!`
        );
      }
      return output;
    })
    .join('');
}

// Without a sheet list (Excel sessions): a multi-word token written straight
// before `!` and a cell or range (`Data 2024!A1:A5`) can only be a sheet name
// Excel would reject, so it is quoted. A token that starts with a cell
// reference is left alone — `A1:C3 Sheet2!B2` is an intersection, not a name.
const UNQUOTED_MULTIWORD_SHEET =
  /(^|[^'A-Za-z0-9_.!\]])([A-Za-z0-9_.]+(?: +[A-Za-z0-9_.]+)+)!(?=\$?[A-Z]{1,3}\$?\d|\$?[A-Z]{1,3}:|\$?\d+:)/gi;

export function quoteUnquotedSheetReferences(formula) {
  return String(formula ?? '')
    .split(/("(?:[^"]|"")*")/)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(UNQUOTED_MULTIWORD_SHEET, (match, lead, name) =>
        /^[A-Z]{1,3}\d+(?:\s|$)/i.test(name) ? match : `${lead}${quoteSheetName(name)}!`
      );
    })
    .join('');
}

export function normalizeXlsxFormula(formula, { backend = '', sheetNames = null } = {}) {
  const text = String(formula ?? '').replace(/^=/, '');
  if (!text) throw new Error('XLSX formula must not be empty');
  if (backend === 'mixdog-ooxml') {
    const spilling = new RegExp(`(?:^|[^A-Za-z0-9_.])(${SPILLING_FUNCTIONS.join('|')})\\s*\\(`, 'i').exec(text);
    if (spilling) {
      throw new Error(
        `XLSX formula uses ${spilling[1].toUpperCase()}, which the portable recalculation engine cannot evaluate and would bake in as #NAME?; use INDEX/MATCH or precompute the values`
      );
    }
  }
  const prefixed = text.replace(
    new RegExp(`(^|[^A-Za-z0-9_.])(${PREFIXED_FUNCTIONS.join('|')})\\s*\\(`, 'gi'),
    (_match, lead, name) => `${lead}_xlfn.${name.toUpperCase()}(`
  );
  return quoteUnquotedSheetReferences(quoteSheetReferences(prefixed, sheetNames));
}

// Excel names a pivot source the way it appears in its own dialog — `원자료!A1:D25`
// — while the operation carries the sheet in a field of its own. The qualified
// form is split into those two fields instead of being refused as a range.
function splitSheetReference(text) {
  const raw = String(text ?? '').trim();
  const match = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(raw);
  if (!match) return { sheet: '', reference: raw };
  return { sheet: (match[1] ?? match[2]).replace(/''/g, "'").trim(), reference: match[3].trim() };
}

// Both backends total a pivot value field (Excel's AddDataField uses xlSum);
// a caller who writes the field as an object gets the field name read out of it
// rather than a stringified object in the error.
function pivotValueFields(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return list
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const field = String(entry.field ?? entry.name ?? '').trim();
        if (!field) {
          throw new Error(
            'XLSX add_pivot_table values entries need a field name: values:["매출"] or values:[{ field: "매출" }]'
          );
        }
        const aggregate = String(entry.function ?? entry.aggregation ?? 'sum')
          .trim()
          .toLowerCase();
        if (aggregate !== 'sum') {
          throw new Error(
            `XLSX add_pivot_table totals its value fields; "${aggregate}" is not available. Precompute that column in the source range instead.`
          );
        }
        return field;
      }
      return String(entry ?? '').trim();
    })
    .filter(Boolean);
}

function normalizePivotFields(operation) {
  for (const [field, owner] of [
    ['source', 'sheet'],
    ['destination', 'destinationSheet'],
  ]) {
    if (operation[field] == null) continue;
    const { sheet, reference } = splitSheetReference(operation[field]);
    if (!sheet) continue;
    const declared = String(operation[owner] ?? '').trim();
    if (declared && declared !== sheet) {
      throw new Error(
        `XLSX add_pivot_table ${field} names sheet "${sheet}" but ${owner} is "${declared}"; name the sheet once.`
      );
    }
    operation[field] = reference;
    operation[owner] = sheet;
  }
  if (operation.values != null) operation.values = pivotValueFields(operation.values);
}

// A dropdown names its choices — "서울,부산" — or points at the cells holding
// them; anything that compares, calls, or tests is a rule the sheet evaluates.
export function listValidationFormula(formula1) {
  const text = String(formula1 ?? '')
    .trim()
    .replace(/^=/, '');
  if (!text) return false;
  if (/^"[^"]*"$/.test(text)) return true;
  if (/^(?:'[^']+'!|[A-Za-z_][\w.]*!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/.test(text)) return true;
  // Bare comma-separated items are what a caller writes when the quotes are
  // forgotten; an expression never looks like that.
  return text.includes(',') && !/[=<>+*/()"]/.test(text);
}

// Three ways a sheet marks its numbers: a rule that paints the cells it picks,
// a scale that colors every cell by where its value sits, and a bar drawn in
// the cell. The first needs a formula and a format; the other two carry their
// colors and take none, so the kind decides which fields are required.
const CONDITIONAL_FORMAT_KINDS = Object.freeze({
  expression: 'expression',
  formula: 'expression',
  cellis: 'expression',
  colorscale: 'colorScale',
  colourscale: 'colorScale',
  scale: 'colorScale',
  heatmap: 'colorScale',
  databar: 'dataBar',
  bar: 'dataBar',
});

export function conditionalFormatKind(operation) {
  const declared = String(operation?.type ?? '').trim();
  if (!declared) return 'expression';
  const kind = CONDITIONAL_FORMAT_KINDS[declared.toLowerCase().replace(/[^a-z]/g, '')];
  if (!kind) {
    throw new Error(
      `XLSX add_conditional_format type must be expression, colorScale, or dataBar; received "${declared}".`
    );
  }
  return kind;
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
    if (op === 'sort_range') {
      if (!operation.range) throw new Error('XLSX sort_range requires range');
      const order = String(operation.order ?? '')
        .trim()
        .toLowerCase();
      if (order && !['asc', 'ascending', 'desc', 'descending'].includes(order)) {
        throw new Error(`XLSX sort_range order must be asc or desc; received "${operation.order}".`);
      }
      parseXlsxRange(operation.range);
    }
    if (op === 'add_conditional_format') {
      const kind = conditionalFormatKind(operation);
      if (kind === 'expression' && !String(operation.formula ?? '').trim()) {
        throw new Error(
          "XLSX add_conditional_format needs formula for a rule that picks cells, or type: 'colorScale' / 'dataBar' to shade every cell in the range by its value."
        );
      }
      if (kind !== 'expression' && String(operation.formula ?? '').trim()) {
        throw new Error(
          `XLSX add_conditional_format type: '${kind}' shades the range by value and takes no formula; drop formula, or use the default rule with it.`
        );
      }
      operation.type = kind;
    }
    if (op === 'add_pivot_table') normalizePivotFields(operation);
    // Both backends write the kind named here, so the default is settled once:
    // a formula that names choices is a dropdown, a formula that states a test
    // is a custom rule. Writing B2>0 as a list would offer it as one entry.
    if (op === 'add_validation' && !String(operation.type ?? '').trim()) {
      operation.type = listValidationFormula(operation.formula1) ? 'list' : 'custom';
    }
    if (op === 'set_style' && operation.cell) parseXlsxCell(operation.cell);
    if (
      operation.range &&
      ['set_range', 'set_style', 'add_table', 'add_chart', 'add_conditional_format', 'add_validation'].includes(op)
    ) {
      // A chart's source may be several areas joined by commas, the way Excel's
      // Range("A7:A12,D7:D12") reads them; each one is a bounded range.
      const parts =
        op === 'add_chart'
          ? String(operation.range)
              .split(',')
              .map((part) => part.trim())
          : [operation.range];
      const area = parseXlsxRange(parts[0]);
      for (const part of parts.slice(1)) parseXlsxRange(part);
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
