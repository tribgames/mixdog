import { sessionBotOf } from '../../session-runtime/bot-status.mjs';
import { isAgentOnlySession } from '../../runtime/agent/orchestrator/session/store-summary-visibility.mjs';
import { activityOf, encodeCatalogCursor } from '../../runtime/agent/orchestrator/session/catalog-db/schema.mjs';

// The keyset position before every catalog row: a page continuing from a
// pinned live row starts over at the top of the catalog order.
export const TOP_CURSOR = encodeCatalogCursor({ id: '', lastUsedAt: Number.MAX_SAFE_INTEGER });

/** Throws unless the list's opt-in flags are booleans when given. */
export function assertListFlags(args) {
  for (const flag of ['include_agents', 'include_archived']) {
    if (args[flag] !== undefined && typeof args[flag] !== 'boolean') {
      throw new Error(`session: ${flag} must be a boolean`);
    }
  }
}

/** Whether the listing keeps a catalog row: sub-agent sessions and archived
 *  ones (`archived`, the desktop's flags) only on request. */
export function listRowFilter(args, archived) {
  return (row) =>
    (args.include_agents === true || !isAgentOnlySession(row)) &&
    (args.include_archived === true || !Object.hasOwn(archived, row.id));
}

/** A row with the live work of `live` (storedLiveWork) overlaid. */
export function liveRowOverlay(live) {
  return (row) => {
    const working = row.working === true || live.own.has(row.id);
    const agentWorking = row.agentWorking === true || live.agents.has(row.id);
    if (!working && !agentWorking) return row;
    return {
      ...row,
      ...(working ? { working: true, liveAt: live.own.get(row.id) || 0 } : {}),
      ...(agentWorking ? { agentWorking: true } : {}),
    };
  };
}

const liveActivity = (row) => Math.max(row.liveAt || 0, activityOf(row), Number(row.updatedAt) || 0);

/** Every session with live work in `live`, each once. */
export function liveCandidates(live) {
  return [...new Set([...live.own.keys(), ...live.agents])];
}

/** The live rows a first page leads with: kept like the listing, overlaid,
 *  newest sign of work first, at most `limit`. */
export function pinnedLiveRows(rows, keep, withLive, limit) {
  return rows
    .filter((row) => row && keep(row))
    .map(withLive)
    .sort((left, right) => liveActivity(right) - liveActivity(left) || (left.id < right.id ? -1 : 1))
    .slice(0, limit);
}

/** The page's sessions: the pinned live rows, then the scanned ones overlaid,
 *  archived ones marked. */
export function listedSessions(pinned, scanned, withLive, archived) {
  return [...pinned, ...scanned.map(withLive)].map((row) =>
    Object.hasOwn(archived, row.id) ? { ...row, archived: true } : row
  );
}

/** sessionListOutput options: rich rows for the human, or only the caller
 *  bot's own (`own`, scopedBot); a pinned row continues from the top. */
export function listOutputOptions(own, pinnedIds) {
  return {
    rich: own ? (row) => sessionBotOf(row) === own : own !== null,
    cursorOf: (row) => (pinnedIds.has(row.id) ? TOP_CURSOR : encodeCatalogCursor(row)),
  };
}
