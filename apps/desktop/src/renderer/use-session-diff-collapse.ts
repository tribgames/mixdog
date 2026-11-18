import { useCallback, useRef, useState } from 'react';
import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import type { SessionDiffRow } from './session-diff-model';
import { rowListIndex } from './session-diff-row-index';

type Base = 'default' | 'folded' | 'open';
/** `default`: every file open except a deleted one (Codex); `folded` / `open`:
 *  Collapse all / Expand all. `differs` holds, by row ID, only the files the
 *  user set apart from the base (a toggle back removes the entry), and
 *  `delta` is what those entries add to the base's folded count for `rows`.
 *  Nothing is seeded per file: a file's fold is decided when it is drawn. */
type Folds = { base: Base; differs: Map<string, boolean>; delta: number; rows: readonly SessionDiffRow[] };

function baseFolded(base: Base, row: Pick<SessionDiffRow, 'status'>): boolean {
  return base === 'default' ? row.status === 'D' : base === 'folded';
}

/** Which files of the session diff are folded, by row ID (one relative path
 *  under two roots is two files). Choices stay while the pane is open (and
 *  across refreshes); a toggle and a render cost the same for any list. */
export function useSessionDiffCollapse(rows: readonly SessionDiffRow[]) {
  const [version, setVersion] = useState(0);
  const folds = useRef<Folds>({ base: 'default', differs: new Map(), delta: 0, rows });
  const state = folds.current;
  // A new list (a data change): the entries' contribution is counted against
  // it, once per list.
  if (state.rows !== rows) {
    const index = rowListIndex(rows);
    let delta = 0;
    for (const [id, folded] of state.differs) {
      const row = rows[index.byId.get(id) ?? -1];
      if (row && folded !== baseFolded(state.base, row)) delta += folded ? 1 : -1;
    }
    state.delta = delta;
    state.rows = rows;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks a change of the held fold state
  const isFolded = useCallback(
    (row: SessionDiffRow) => folds.current.differs.get(row.id) ?? baseFolded(folds.current.base, row),
    [version]
  );
  const setFold = (id: string, next: (folded: boolean) => boolean) => {
    const current = folds.current;
    const row = current.rows[rowListIndex(current.rows).byId.get(id) ?? -1];
    if (!row) return;
    const base = baseFolded(current.base, row);
    const folded = current.differs.get(id) ?? base;
    const wanted = next(folded);
    if (wanted === folded) return;
    if (wanted === base) {
      current.differs.delete(id);
      current.delta -= folded ? 1 : -1;
    } else {
      current.differs.set(id, wanted);
      current.delta += wanted ? 1 : -1;
    }
    setVersion((value) => value + 1);
  };
  const toggleCollapsed = (id: string) => setFold(id, (folded) => !folded);
  /** Unfolds one file (a requested file opens expanded). */
  const expandRow = (id: string) => setFold(id, () => false);
  const reset = (base: Base) => {
    folds.current = { base, differs: new Map(), delta: 0, rows: folds.current.rows };
    setVersion((value) => value + 1);
  };
  /** A new session starts with nothing chosen. */
  const resetCollapsed = () => reset('default');
  const index = rowListIndex(rows);
  const baseCount = state.base === 'default' ? index.deleted : state.base === 'folded' ? rows.length : 0;
  const folded = baseCount + state.delta;
  const collapseActions: DockAction[] = [
    {
      id: 'collapse-all',
      label: t('Collapse all'),
      menuOnly: true,
      disabled: rows.length === 0 || folded === rows.length,
      onSelect: () => reset('folded'),
    },
    {
      id: 'expand-all',
      label: t('Expand all'),
      menuOnly: true,
      disabled: folded === 0,
      onSelect: () => reset('open'),
    },
  ];
  return { isFolded, toggleCollapsed, expandRow, resetCollapsed, collapseActions };
}
