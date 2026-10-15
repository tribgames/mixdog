import { useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import type { SessionDiffRow } from './session-diff-model';

/** Which files of the session diff are folded. Collapsed files stay collapsed
 *  while the pane is open (and across refreshes). */
export function useSessionDiffCollapse(rows: readonly SessionDiffRow[]) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapsed = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  // Every file starts expanded except a deleted one (Codex); a file seen once
  // keeps whatever the user chose after that. A layout effect: the fold lands
  // before the first paint, so a deleted file never draws open and then shuts.
  const seenPaths = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const deleted = rows.filter((row) => !seenPaths.current.has(row.path) && row.status === 'D');
    for (const row of rows) seenPaths.current.add(row.path);
    if (deleted.length === 0) return;
    setCollapsed((current) => new Set([...current, ...deleted.map((row) => row.path)]));
  }, [rows]);
  /** Unfolds one file (a requested file opens expanded). */
  const expandPath = (path: string) =>
    setCollapsed((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  /** A new session starts with nothing folded and nothing seen. */
  const resetCollapsed = () => {
    setCollapsed(new Set());
    seenPaths.current = new Set();
  };
  const collapseActions: DockAction[] = [
    {
      id: 'collapse-all',
      label: t('Collapse all'),
      menuOnly: true,
      disabled: rows.length === 0 || rows.every((row) => collapsed.has(row.path)),
      onSelect: () => setCollapsed(new Set(rows.map((row) => row.path))),
    },
    {
      id: 'expand-all',
      label: t('Expand all'),
      menuOnly: true,
      disabled: collapsed.size === 0,
      onSelect: () => setCollapsed(new Set()),
    },
  ];
  return { collapsed, toggleCollapsed, expandPath, resetCollapsed, collapseActions };
}
