import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { parseXlsxCell, parseXlsxRange } from '../portable/xlsx-contract.mjs';
import { columnLabel } from '../portable/portable-cells.mjs';

function delimiterFor(format) {
  return format === 'tsv' ? '\t' : ',';
}

function sheetName(path, format) {
  return basename(path, extname(path)) || format.toUpperCase();
}

function parseDelimited(text, delimiter) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  if (!source) return [];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (character === '\r' && source[index + 1] === '\n') index += 1;
    } else {
      field += character;
    }
  }
  if (field.length || row.length || !/[\r\n]$/.test(source)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function serializeField(value, delimiter) {
  const text = value == null ? '' : String(value);
  return /["\r\n]/.test(text) || text.includes(delimiter)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function serializeDelimited(rows, delimiter) {
  if (!rows.length) return '';
  return `${rows.map((row) => row.map((value) => serializeField(value, delimiter)).join(delimiter)).join('\r\n')}\r\n`;
}

async function loadRows(path, format) {
  return parseDelimited(await readFile(path, 'utf8'), delimiterFor(format));
}

async function saveRows(path, format, rows) {
  await writeFile(path, serializeDelimited(rows, delimiterFor(format)), 'utf8');
}

function ensureCell(rows, row, column) {
  while (rows.length < row) rows.push([]);
  while (rows[row - 1].length < column) rows[row - 1].push('');
}

function setCell(rows, reference, value) {
  const cell = parseXlsxCell(reference);
  ensureCell(rows, cell.row, cell.column);
  rows[cell.row - 1][cell.column - 1] = value == null ? '' : String(value);
  return cell;
}

function snapshotRows(path, format, rows, options = {}) {
  const name = sheetName(path, format);
  if (options.sheet && String(options.sheet).toLowerCase() !== name.toLowerCase()) {
    throw new Error(`${format.toUpperCase()} sheet not found: ${options.sheet}`);
  }
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 2_000) : Number.POSITIVE_INFINITY;
  const bounds = options.range ? parseXlsxRange(options.range, { maxCells: Number.MAX_SAFE_INTEGER }) : null;
  const cells = [];
  let totalCells = 0;
  let columns = 0;
  for (let row = 0; row < rows.length; row += 1) {
    columns = Math.max(columns, rows[row].length);
    for (let column = 0; column < rows[row].length; column += 1) {
      const value = rows[row][column];
      if (value === '') continue;
      if (bounds && (
        row + 1 < bounds.start.row
        || row + 1 > bounds.end.row
        || column + 1 < bounds.start.column
        || column + 1 > bounds.end.column
      )) continue;
      const ref = `${columnLabel(column + 1)}${row + 1}`;
      if (!paged || (totalCells >= offset && cells.length < limit)) {
        cells.push({
          path: `/sheet[${name}]/cell[${ref}]`,
          ref,
          row: row + 1,
          column: column + 1,
          value,
          formula: String(value).startsWith('=') ? String(value) : '',
        });
      }
      totalCells += 1;
    }
  }
  return {
    format,
    path,
    delimiter: delimiterFor(format),
    sheetCount: 1,
    sheets: [{
      path: `/sheet[${name}]`,
      name,
      rows: rows.length,
      columns,
      cellCount: totalCells,
      cells,
    }],
    ...(paged ? {
      pagination: {
        unit: 'populated-cell',
        scope: `${name}${options.range ? `!${options.range}` : ''}`,
        offset,
        limit,
        returned: cells.length,
        total: totalCells,
        nextOffset: offset + cells.length < totalCells ? offset + cells.length : null,
      },
    } : {}),
  };
}

export async function createTabular(path) {
  await writeFile(path, '', 'utf8');
}

export async function snapshotTabular(path, format, options = {}) {
  return snapshotRows(path, format, await loadRows(path, format), options);
}

export async function applyTabularBatch(path, format, operations) {
  const rows = await loadRows(path, format);
  const results = [];
  for (const operation of operations || []) {
    const op = String(operation.op || '');
    if (op === 'set_cell' || op === 'set_formula') {
      const cell = setCell(rows, operation.cell, op === 'set_formula' ? operation.formula : operation.value);
      results.push({ op, changed: true, cell: cell.ref });
      continue;
    }
    if (op === 'set_range') {
      const area = parseXlsxRange(operation.range);
      for (let row = 0; row < area.rows; row += 1) {
        for (let column = 0; column < area.columns; column += 1) {
          setCell(rows, `${columnLabel(area.start.column + column)}${area.start.row + row}`, operation.values[row][column]);
        }
      }
      results.push({ op, changed: true, range: operation.range });
      continue;
    }
    if (op === 'append_row') {
      rows.push((operation.values || []).map((value) => value == null ? '' : String(value)));
      results.push({ op, changed: true, row: rows.length });
      continue;
    }
    if (op === 'clear_cell') {
      const cell = parseXlsxCell(operation.cell);
      const changed = cell.row <= rows.length && cell.column <= rows[cell.row - 1].length && rows[cell.row - 1][cell.column - 1] !== '';
      if (changed) rows[cell.row - 1][cell.column - 1] = '';
      results.push({ op, changed, cell: cell.ref });
      continue;
    }
    if (op === 'replace_text') {
      let count = 0;
      const find = String(operation.find || '');
      for (const row of rows) {
        for (let column = 0; column < row.length; column += 1) {
          const before = String(row[column]);
          if (!find || !before.includes(find)) continue;
          count += before.split(find).length - 1;
          row[column] = before.replaceAll(find, String(operation.replace ?? ''));
        }
      }
      results.push({ op, changed: count > 0, count });
      continue;
    }
    if (op === 'insert_rows') {
      rows.splice(Number(operation.row) - 1, 0, ...Array.from({ length: Number(operation.count ?? 1) }, () => []));
      results.push({ op, changed: true, row: Number(operation.row), count: Number(operation.count ?? 1) });
      continue;
    }
    if (op === 'delete_rows') {
      const removed = rows.splice(Number(operation.row) - 1, Number(operation.count ?? 1));
      results.push({ op, changed: removed.length > 0, row: Number(operation.row), count: removed.length });
      continue;
    }
    if (op === 'insert_columns' || op === 'delete_columns') {
      const column = Number(operation.column) - 1;
      const count = Number(operation.count ?? 1);
      for (const row of rows) {
        if (op === 'insert_columns') row.splice(column, 0, ...Array.from({ length: count }, () => ''));
        else row.splice(column, count);
      }
      results.push({ op, changed: true, column: column + 1, count });
      continue;
    }
    throw new Error(`${format.toUpperCase()} backend does not support operation: ${op}`);
  }
  await saveRows(path, format, rows);
  return results;
}

export async function validateTabular(path, format) {
  const text = await readFile(path, 'utf8');
  const rows = parseDelimited(text, delimiterFor(format));
  const columns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const invalidEncoding = text.includes('\uFFFD');
  const nulBytes = [...text].filter((character) => character === '\0').length;
  return {
    ok: !invalidEncoding && nulBytes === 0 && columns <= 16_384,
    format,
    rows: rows.length,
    columns,
    invalidEncoding,
    nulBytes,
    validation: 'utf8-delimited-structure',
  };
}

export async function issuesTabular(path, format, options = {}) {
  const rows = await loadRows(path, format);
  const issues = [];
  const bounds = options.range ? parseXlsxRange(options.range, { maxCells: Number.MAX_SAFE_INTEGER }) : null;
  const widths = rows.map((row) => row.length);
  const expectedColumns = widths.length ? Math.max(...widths) : 0;
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row].length !== expectedColumns) {
      issues.push({
        severity: 'warning',
        code: 'ragged_row',
        path: `/row[${row + 1}]`,
        message: `Row has ${rows[row].length} column(s); expected ${expectedColumns}.`,
      });
    }
    for (let column = 0; column < rows[row].length; column += 1) {
      if (bounds && (
        row + 1 < bounds.start.row
        || row + 1 > bounds.end.row
        || column + 1 < bounds.start.column
        || column + 1 > bounds.end.column
      )) continue;
      if (/^[=+\-@]/.test(String(rows[row][column] || ''))) {
        const ref = `${columnLabel(column + 1)}${row + 1}`;
        issues.push({
          severity: 'warning',
          code: 'formula_like_value',
          path: `/sheet[${sheetName(path, format)}]/cell[${ref}]`,
          message: 'Value may execute as a formula when opened by spreadsheet software.',
        });
      }
    }
  }
  const validation = await validateTabular(path, format);
  if (validation.invalidEncoding) issues.push({ severity: 'error', code: 'invalid_utf8', path: '/', message: 'File contains invalid UTF-8 replacement characters.' });
  if (validation.nulBytes) issues.push({ severity: 'error', code: 'nul_byte', path: '/', message: `File contains ${validation.nulBytes} NUL byte(s).` });
  return {
    ok: validation.ok && !issues.some((issue) => issue.severity === 'error'),
    format,
    issueCount: issues.length,
    issues,
  };
}
