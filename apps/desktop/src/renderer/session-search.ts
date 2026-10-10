// Session search: one popup over the session catalog, opened from the
// Sessions header.
import type { DesktopSessionContentMatch, DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';

export const SESSION_SEARCH_OPEN_EVENT = 'mixdog:open-session-search';

export function openSessionSearch(): void {
  window.dispatchEvent(new window.CustomEvent(SESSION_SEARCH_OPEN_EVENT));
}

/** An empty query lists the latest sessions; a typed query matches every one. */
const RECENT_SESSION_ROWS = 10;

function matchesQuery(values: readonly unknown[], needle: string): boolean {
  return values.some((value) =>
    String(value || '')
      .toLocaleLowerCase()
      .includes(needle)
  );
}

function sessionActivityAt(session: DesktopSessionSummary): number {
  return Number(session.activityAt) || session.updatedAt;
}

export interface SessionSearchRow {
  session: DesktopSessionSummary;
  /** Present only when the row came from a message-content hit. */
  snippet?: string;
}

/** Title matches keep their order; content hits follow in rank order for
 *  task/project sessions that are in the catalog and not already listed. */
export function mergeSessionContentMatches(
  sessions: readonly DesktopSessionSummary[],
  titleMatches: readonly DesktopSessionSummary[],
  contentMatches: readonly DesktopSessionContentMatch[]
): SessionSearchRow[] {
  const rows: SessionSearchRow[] = titleMatches.map((session) => ({ session }));
  const listed = new Set(titleMatches.map(({ id }) => id));
  const catalog = new Map(
    sessions
      .filter((session) => session.classification === 'task' || session.classification === 'project')
      .map((session) => [session.id, session] as const)
  );
  for (const hit of contentMatches) {
    const session = catalog.get(hit.sessionId);
    if (!session || listed.has(session.id)) continue;
    listed.add(session.id);
    rows.push({ session, snippet: hit.snippet });
  }
  return rows;
}

export function sessionSearchResults(
  sessions: readonly DesktopSessionSummary[],
  query: string
): DesktopSessionSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  const rows = sessions
    .filter((session) => session.classification === 'task' || session.classification === 'project')
    .filter((session) =>
      needle
        ? matchesQuery(
            [
              sessionSummaryTitle(session, ''),
              session.preview,
              session.cwd,
              session.projectPath,
              session.id,
              session.model,
              session.sourceName,
            ],
            needle
          )
        : session.archived !== true
    )
    // Archived sessions stay findable but rank below the live catalog.
    .sort(
      (left, right) =>
        Number(left.archived === true) - Number(right.archived === true) ||
        sessionActivityAt(right) - sessionActivityAt(left) ||
        left.id.localeCompare(right.id)
    );
  return needle ? rows : rows.slice(0, RECENT_SESSION_ROWS);
}
