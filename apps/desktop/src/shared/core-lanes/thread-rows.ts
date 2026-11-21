import { desktopSessionSummaries } from '../desktop-state';
import type { DesktopSessionSummary } from '../contract';
import { cleanIncomingTail } from '../incoming-tail';

type ThreadRow = Record<string, unknown>;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const projectionInputOf = (row: ThreadRow): ThreadRow => {
  const { classification, projectPath, forkedFromId, ...rest } = row;
  // The core names the inherit source `forkedFromId`; the projection reads `inheritedFromSessionId`.
  const named =
    typeof forkedFromId === 'string' && forkedFromId ? { ...rest, inheritedFromSessionId: forkedFromId } : rest;
  return typeof classification === 'string'
    ? { ...named, desktopSession: { classification, projectPath: projectPath ?? null } }
    : named;
};

const withCoreFields = (summary: DesktopSessionSummary, core: ThreadRow): DesktopSessionSummary => {
  const activityAt = finite(core.activityAt);
  const readMessageCount = finite(core.readMessageCount);
  const readRevision = finite(core.readRevision);
  const incomingTail = cleanIncomingTail(core.incomingTail);
  // The core's row says compactCount: 0 for a thread never compacted; the summary has no such field until the first compaction (>= 1).
  const {
    working: _w,
    leadWorking: _l,
    agentWorking: _a,
    compactCount,
    incomingTail: _t,
    ...rest
  } = summary as DesktopSessionSummary & Record<string, unknown>;
  return {
    ...rest,
    ...(typeof compactCount === 'number' && compactCount > 0 ? { compactCount } : {}),
    ...(activityAt ? { activityAt } : {}),
    // An agent's worker sessions are left out of the sidebar; the core's row says `agentSession` itself.
    ...(core.agentSession === true ? { agentSession: true } : {}),
    // The runtime's own activity flags, not the projection's reading of `working` (it would make every working row a lead's).
    ...(core.working === true ? { working: true } : {}),
    ...(core.leadWorking === true ? { leadWorking: true } : {}),
    ...(core.agentWorking === true ? { agentWorking: true } : {}),
    ...(core.archived === true ? { archived: true } : {}),
    ...(core.favorite === true ? { favorite: true } : {}),
    ...(core.agentDeleted === true ? { agentDeleted: true } : {}),
    // The places of the incoming messages past which an unread pill counts: without them a bot's or room's pill reads 1.
    ...(incomingTail ? { incomingTail } : {}),
    ...(readMessageCount === undefined ? {} : { readMessageCount }),
    ...(readRevision === undefined ? {} : { readRevision }),
    ...(core.agentRoom && typeof core.agentRoom === 'object' ? { agentRoom: core.agentRoom } : {}),
  } as DesktopSessionSummary;
};

export function summariesOfThreadRows(
  rows: ReadonlyArray<ThreadRow>,
  titles: Readonly<Record<string, string>> = {},
  names: Readonly<Record<string, string>> = {},
  taskWorkspace = ''
): DesktopSessionSummary[] {
  const byId = new Map(rows.map((row) => [String(row.id ?? ''), row]));
  return desktopSessionSummaries(rows.map(projectionInputOf), titles, names, taskWorkspace).map((summary) =>
    withCoreFields(summary, byId.get(summary.id) ?? {})
  );
}
