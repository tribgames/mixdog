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

/** RFC 4180 parser (quoted fields, doubled quotes, embedded delimiters and
 *  newlines). Stops after `maxRows` rows or `maxCells` padded cells and
 *  reports whether more followed; fields past `maxColumns` are dropped and
 *  flagged in `columnsTruncated`. */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows = DELIMITED_ROW_CAP,
  maxColumns = DELIMITED_COLUMN_CAP,
  maxCells = DELIMITED_CELL_CAP
): { rows: string[][]; truncated: boolean; columnsTruncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  let columnsTruncated = false;
  let widest = 0;
  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else columnsTruncated = true;
    field = '';
  };
  const endRow = (): boolean => {
    pushField();
    rows.push(row);
    widest = Math.max(widest, row.length);
    row = [];
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
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (char === delimiter) {
      pushField();
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      if (endRow()) {
        rows.pop();
        return { rows, truncated: true, columnsTruncated };
      }
    } else {
      field += char;
      started = true;
    }
  }
  if (started || field !== '') {
    if (endRow()) {
      rows.pop();
      return { rows, truncated: true, columnsTruncated };
    }
  }
  return { rows, truncated: false, columnsTruncated };
}
