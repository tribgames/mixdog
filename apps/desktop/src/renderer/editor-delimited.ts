export type EditorViewMode = 'rendered' | 'source';

/** Rows shown by the read-only table view; larger files get a notice. */
export const DELIMITED_ROW_CAP = 1000;

/** Which rendered view a file offers next to its text source. */
export function editorViewKindForPath(path: string): 'svg' | 'markdown' | 'table' | null {
  if (/\.svg$/i.test(path)) return 'svg';
  if (/\.(md|mdx|markdown)$/i.test(path)) return 'markdown';
  return delimiterForPath(path) ? 'table' : null;
}

export function svgDataUrl(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

export function delimiterForPath(path: string): ',' | '\t' | null {
  if (/\.csv$/i.test(path)) return ',';
  if (/\.tsv$/i.test(path)) return '\t';
  return null;
}

/** Columns kept per row, and the ceiling on rendered cells (rows × widest row,
 *  since the table pads every row to the widest). */
export const DELIMITED_COLUMN_CAP = 100;
export const DELIMITED_CELL_CAP = 20000;

/** An RFC 4180 violation; `line` is the 1-based file line, `row`/`column` the
 *  1-based position of the field. An unterminated quote is reported where the
 *  quote opened. */
export interface DelimitedDiagnostic {
  kind: 'unterminatedQuote' | 'strayQuote';
  line: number;
  row: number;
  column: number;
}

export interface DelimitedParse {
  rows: string[][];
  truncated: boolean;
  columnsTruncated: boolean;
  diagnostics: DelimitedDiagnostic[];
}

/** RFC 4180 parser (quoted fields, doubled quotes, embedded delimiters and
 *  newlines). Stops after `maxRows` rows or `maxCells` padded cells and
 *  reports whether more followed; fields past `maxColumns` are dropped and
 *  flagged in `columnsTruncated`. Quote violations (an unterminated quote, a
 *  quote inside an unquoted field or text after a closing quote) are listed
 *  in `diagnostics`. */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows = DELIMITED_ROW_CAP,
  maxColumns = DELIMITED_COLUMN_CAP,
  maxCells = DELIMITED_CELL_CAP
): DelimitedParse {
  const rows: string[][] = [];
  const diagnostics: DelimitedDiagnostic[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  let started = false;
  let columnsTruncated = false;
  let widest = 0;
  let line = 1;
  let fieldIndex = 0;
  let openAt: Omit<DelimitedDiagnostic, 'kind'> = { line, row: 1, column: 1 };
  const here = (): Omit<DelimitedDiagnostic, 'kind'> => ({ line, row: rows.length + 1, column: fieldIndex + 1 });
  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else columnsTruncated = true;
    field = '';
    closed = false;
    fieldIndex += 1;
  };
  const endRow = (): boolean => {
    pushField();
    rows.push(row);
    widest = Math.max(widest, row.length);
    row = [];
    fieldIndex = 0;
    started = false;
    return rows.length > maxRows || rows.length * widest > maxCells;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        if (char === '\n' || (char === '\r' && text[index + 1] !== '\n')) line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '' && !closed) {
      quoted = true;
      started = true;
      openAt = here();
    } else if (char === '"') {
      diagnostics.push({ kind: 'strayQuote', ...here() });
      field += char;
      started = true;
    } else if (char === delimiter) {
      pushField();
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      const over = endRow();
      line += 1;
      if (over) {
        rows.pop();
        return { rows, truncated: true, columnsTruncated, diagnostics };
      }
    } else {
      if (closed) {
        diagnostics.push({ kind: 'strayQuote', ...here() });
        closed = false;
      }
      field += char;
      started = true;
    }
  }
  if (quoted) diagnostics.push({ kind: 'unterminatedQuote', ...openAt });
  if (started || field !== '') {
    if (endRow()) {
      rows.pop();
      return { rows, truncated: true, columnsTruncated, diagnostics };
    }
  }
  return { rows, truncated: false, columnsTruncated, diagnostics };
}

export interface DelimitedFormat {
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

/** The file's own line ending (first break wins) and trailing-newline state. */
export function detectDelimitedFormat(text: string): DelimitedFormat {
  const first = text.search(/\r|\n/);
  const eol = first >= 0 && text[first] === '\r' && text[first + 1] === '\n' ? '\r\n' : '\n';
  return { eol, trailingNewline: /[\r\n]$/.test(text) };
}

function serializeField(field: string, delimiter: string): string {
  const needsQuotes =
    field.includes(delimiter) || /["\r\n]/.test(field) || field.startsWith(' ') || field.endsWith(' ');
  return needsQuotes ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Inverse of `parseDelimited`: quotes only fields that need it, keeps the
 *  file's line ending and trailing newline. Rows keep their own length. */
export function serializeDelimited(
  rows: readonly (readonly string[])[],
  delimiter: string,
  options: Partial<DelimitedFormat> = {}
): string {
  const eol = options.eol ?? '\n';
  const lastIndex = rows.length - 1;
  const body = rows
    .map((row, index) => {
      // A final record that is one empty field would serialize to nothing and
      // vanish from the record count without a trailing newline: quote it.
      if (index === lastIndex && !options.trailingNewline && row.length === 1 && row[0] === '') return '""';
      return row.map((field) => serializeField(field, delimiter)).join(delimiter);
    })
    .join(eol);
  return rows.length > 0 && options.trailingNewline ? body + eol : body;
}

export function delimitedWidth(rows: readonly (readonly string[])[]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Per column: true when every non-empty body cell (row 0 is the header)
 *  parses as a number. */
export function numericColumns(rows: readonly (readonly string[])[]): boolean[] {
  return Array.from({ length: delimitedWidth(rows) }, (_, column) => {
    let seen = false;
    for (let index = 1; index < rows.length; index += 1) {
      const cell = (rows[index][column] ?? '').trim();
      if (cell === '') continue;
      if (!NUMBER_PATTERN.test(cell)) return false;
      seen = true;
    }
    return seen;
  });
}

type Rows = readonly (readonly string[])[];

function withinCaps(rows: Rows): boolean {
  return (
    rows.length <= DELIMITED_ROW_CAP &&
    delimitedWidth(rows) <= DELIMITED_COLUMN_CAP &&
    rows.length * delimitedWidth(rows) <= DELIMITED_CELL_CAP
  );
}

/** Edits return a new grid, or the same one when the result would pass a cap. */
function capped(next: string[][], previous: Rows): string[][] {
  return withinCaps(next) ? next : (previous as string[][]);
}

function growTo(row: readonly string[], width: number): string[] {
  const next = row.slice();
  while (next.length < width) next.push('');
  return next;
}

export function pasteGrid(rows: Rows, row: number, column: number, block: Rows): string[][] {
  const next = rows.map((cells) => cells.slice());
  block.forEach((cells, rowOffset) => {
    const target = row + rowOffset;
    while (next.length <= target) next.push([]);
    next[target] = growTo(next[target], column);
    cells.forEach((value, columnOffset) => {
      const at = column + columnOffset;
      while (next[target].length <= at) next[target].push('');
      next[target][at] = value;
    });
  });
  return capped(next, rows);
}

export function setCell(rows: Rows, row: number, column: number, value: string): string[][] {
  return pasteGrid(rows, row, column, [[value]]);
}

export function insertRow(rows: Rows, at: number): string[][] {
  const next = rows.map((cells) => cells.slice());
  next.splice(Math.max(0, Math.min(at, next.length)), 0, new Array<string>(delimitedWidth(rows)).fill(''));
  return capped(next, rows);
}

export function deleteRow(rows: Rows, at: number): string[][] {
  return rows.filter((_, index) => index !== at).map((cells) => cells.slice());
}

export function insertColumn(rows: Rows, at: number): string[][] {
  const next = rows.map((cells) => {
    const copy = cells.slice();
    if (copy.length > at) copy.splice(at, 0, '');
    return copy;
  });
  if (next.length === 0) next.push(['']);
  return capped(delimitedWidth(next) > delimitedWidth(rows) ? next : next.map((cells) => growTo(cells, at + 1)), rows);
}

export function deleteColumn(rows: Rows, at: number): string[][] {
  return rows.map((cells) => cells.filter((_, index) => index !== at));
}

/** Clipboard text as a block: tab-separated when it contains a tab, else in the
 *  file's own delimiter. */
export function parseClipboardBlock(text: string, delimiter: string): { rows: string[][]; refused: boolean } {
  const parsed = parseDelimited(text, text.includes('\t') ? '\t' : delimiter);
  return {
    rows: parsed.rows,
    refused: parsed.truncated || parsed.columnsTruncated || parsed.diagnostics.length > 0,
  };
}

export function serializeClipboardBlock(block: Rows): string {
  return serializeDelimited(block, '\t');
}

/** The slice of Monaco's ITextModel the grid writes through. */
export type DelimitedModel = Pick<
  import('monaco-editor').editor.ITextModel,
  'getValue' | 'getFullModelRange' | 'pushStackElement' | 'pushEditOperations' | 'undo' | 'redo'
>;

/** Replaces the whole model text as ONE undoable edit. */
export function applyDelimitedToModel(model: DelimitedModel, text: string): void {
  if (model.getValue() === text) return;
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
}
