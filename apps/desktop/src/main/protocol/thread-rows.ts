// The sidebar rows of a core connection (`thread/list` rows and `thread/summary/updated`) through the same projection Node's
// rows take (`desktopSessionSummaries`, desktop-state.ts), so a row the core sends with no stored classification (`classification`
// is `{}`: the thread was not classified when it was created) is classified by its folder exactly as Node classifies it.
// The core's row carries the stored `desktopSession` flattened as `classification` and `projectPath`; the projection reads it nested.
import { desktopSessionSummaries } from '../desktop-state';
import type { DesktopSessionSummary } from '../../shared/contract';

type ThreadRow = Record<string, unknown>;

export function summariesOfThreadRows(
  rows: ReadonlyArray<ThreadRow>,
  titles: Readonly<Record<string, string>> = {},
  names: Readonly<Record<string, string>> = {},
  taskWorkspace = ''
): DesktopSessionSummary[] {
  const raw = rows.map((row) => {
    const { classification, projectPath, ...rest } = row;
    return typeof classification === 'string'
      ? { ...rest, desktopSession: { classification, projectPath: projectPath ?? null } }
      : rest;
  });
  return desktopSessionSummaries(raw, titles, names, taskWorkspace);
}
