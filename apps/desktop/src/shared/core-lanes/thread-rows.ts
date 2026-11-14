// The sidebar rows of a core connection (`thread/list` rows and `thread/summary/updated`) through the same projection Node's
// rows take (`desktopSessionSummaries`, desktop-state.ts), so a row the core sends with no stored classification (`classification`
// is `{}`: the thread was not classified when it was created) is classified by its folder exactly as Node classifies it.
// The core's row carries the stored `desktopSession` flattened as `classification` and `projectPath`; the projection reads it nested.
//
// Node's roster row is that projection plus what the host laid over it (session-host.ts sessionCatalog: rooms, archive, retired,
// favorite, read cursors) and the turn activity the daemon overlaid. The core's row already carries those as fields of its own, which
// the projection does not read: they are taken from the core row as Node's overlays wrote them (a flag only when set, a cursor only
// when one exists), and `activityAt` is the core's (`lastUsedAt || updatedAt`, which the projection would recompute from `updatedAt`).
import { desktopSessionSummaries } from '../desktop-state';
import type { DesktopSessionSummary } from '../contract';

type ThreadRow = Record<string, unknown>;

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function summariesOfThreadRows(
  rows: ReadonlyArray<ThreadRow>,
  titles: Readonly<Record<string, string>> = {},
  names: Readonly<Record<string, string>> = {},
  taskWorkspace = ''
): DesktopSessionSummary[] {
  const raw = rows.map((row) => {
    const { classification, projectPath, forkedFromId, ...rest } = row;
    // The core names the inherit source `forkedFromId`; the projection reads Node's `inheritedFromSessionId`.
    const named = typeof forkedFromId === 'string' && forkedFromId ? { ...rest, inheritedFromSessionId: forkedFromId } : rest;
    return typeof classification === 'string'
      ? { ...named, desktopSession: { classification, projectPath: projectPath ?? null } }
      : named;
  });
  const byId = new Map(rows.map((row) => [String(row.id ?? ''), row]));
  return desktopSessionSummaries(raw, titles, names, taskWorkspace).map((summary) => {
    const core = byId.get(summary.id) ?? {};
    const activityAt = finite(core.activityAt);
    const readMessageCount = finite(core.readMessageCount);
    const readRevision = finite(core.readRevision);
    // The core's row says compactCount: 0 for a thread never compacted; Node's summary has no such field until the first compaction (>= 1).
    // Node's roster row of a bot home or room carries no `incomingTail` either: its daemon lists the live session, and only the summary
    // index row has the tail (remote-protocol-chat-roster.recorded.json: the home row after "hello Bot One" has none, while the same run's
    // session-summaries.log holds [2]).
    const { working: _w, leadWorking: _l, agentWorking: _a, compactCount, incomingTail: _t, ...rest } = summary as DesktopSessionSummary & Record<string, unknown>;
    return {
      ...rest,
      ...(typeof compactCount === 'number' && compactCount > 0 ? { compactCount } : {}),
      ...(activityAt ? { activityAt } : {}),
      // Node's listing leaves an agent's worker sessions out of the sidebar by the stored `owner`/`visibility`, which the core's
      // row does not carry: it says `agentSession` itself.
      ...(core.agentSession === true ? { agentSession: true } : {}),
      // The runtime's own activity flags, not the projection's reading of `working` (it would make every working row a lead's).
      ...(core.working === true ? { working: true } : {}),
      ...(core.leadWorking === true ? { leadWorking: true } : {}),
      ...(core.agentWorking === true ? { agentWorking: true } : {}),
      ...(core.archived === true ? { archived: true } : {}),
      ...(core.favorite === true ? { favorite: true } : {}),
      ...(core.agentDeleted === true ? { agentDeleted: true } : {}),
      ...(readMessageCount === undefined ? {} : { readMessageCount }),
      ...(readRevision === undefined ? {} : { readRevision }),
      ...(core.agentRoom && typeof core.agentRoom === 'object' ? { agentRoom: core.agentRoom } : {}),
    } as DesktopSessionSummary;
  });
}
