/** turn-changes-model's normalizeChangePath (kept here: that module imports the
 *  diff model, which builds this index). */
const normalizeChangePath = (path: string) =>
  String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

/** What the index reads of a listed row. */
type IndexedRow = { path: string; id?: string; status?: string; additions?: number; deletions?: number };

/** One list's lookups and totals, built once per list (data change) and
 *  shared by every reader: no pick, reveal, tab, fold or total walks the
 *  rows again. Positions are the first row holding the key. */
export type RowListIndex = {
  byId: ReadonlyMap<string, number>;
  byPath: ReadonlyMap<string, number>;
  /** A request's normalized path, exactly. */
  byRequestPath: ReadonlyMap<string, number>;
  /** Lowercased normalized path, every row (a drive-letter or UNC request). */
  byFoldedPath: ReadonlyMap<string, number>;
  /** Lowercased normalized path, drive-letter and UNC rows only. */
  byFoldedWindowsPath: ReadonlyMap<string, number>;
  additions: number;
  deletions: number;
  /** Rows with status D. */
  deleted: number;
};

const indexes = new WeakMap<readonly IndexedRow[], RowListIndex>();
/** Drive-letter and UNC paths compare case-insensitively; POSIX paths exactly. */
const windowsStyle = (path: string) => /^(?:[A-Za-z]:|\/\/)/.test(path);
const first = (map: Map<string, number>, key: string, index: number) => {
  if (!map.has(key)) map.set(key, index);
};

/** An index filled one row at a time (a parse that yields between rows);
 *  `finish` registers it for the finished list. */
export function rowListIndexBuilder() {
  const index = {
    byId: new Map<string, number>(),
    byPath: new Map<string, number>(),
    byRequestPath: new Map<string, number>(),
    byFoldedPath: new Map<string, number>(),
    byFoldedWindowsPath: new Map<string, number>(),
    additions: 0,
    deletions: 0,
    deleted: 0,
  };
  return {
    add(row: IndexedRow, position: number) {
      first(index.byId, row.id ?? row.path, position);
      first(index.byPath, row.path, position);
      const request = normalizeChangePath(row.path);
      const folded = request.toLowerCase();
      first(index.byRequestPath, request, position);
      first(index.byFoldedPath, folded, position);
      if (windowsStyle(request)) first(index.byFoldedWindowsPath, folded, position);
      index.additions += row.additions ?? 0;
      index.deletions += row.deletions ?? 0;
      if (row.status === 'D') index.deleted += 1;
    },
    finish(rows: readonly IndexedRow[]): RowListIndex {
      indexes.set(rows, index);
      return index;
    },
  };
}

/** The list's index: built when the list is adopted, looked up after. */
export function rowListIndex(rows: readonly IndexedRow[]): RowListIndex {
  const known = indexes.get(rows);
  if (known) return known;
  const builder = rowListIndexBuilder();
  rows.forEach((row, position) => {
    builder.add(row, position);
  });
  return builder.finish(rows);
}

/** The first row a request's paths name (see sessionDiffRequestPaths), or -1. */
export function requestedRowIndex(index: RowListIndex, wanted: readonly string[]): number {
  for (const path of wanted) {
    const folded = path.toLowerCase();
    const candidates = windowsStyle(path)
      ? [index.byFoldedPath.get(folded)]
      : [index.byRequestPath.get(path), index.byFoldedWindowsPath.get(folded)];
    const found = candidates.filter((position): position is number => position !== undefined);
    if (found.length) return Math.min(...found);
  }
  return -1;
}
