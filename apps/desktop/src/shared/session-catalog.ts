import type { DesktopSessionSummary } from "./contract";

/** Current already has the newest id at the front; incoming only moved it. */
export function sessionListKeepsExistingTopInsert(
  currentIds: readonly string[],
  incomingIds: readonly string[],
): boolean {
  if (currentIds.length === 0 || currentIds.length !== incomingIds.length) return false;
  const top = currentIds[0];
  if (!top || top === incomingIds[0]) return false;
  const rest = currentIds.slice(1);
  const incomingRest = incomingIds.filter((id) => id !== top);
  return incomingRest.length === rest.length
    && incomingRest.every((id, index) => id === rest[index]);
}

function sessionSummaryVisibleEqual(
  left: DesktopSessionSummary,
  right: DesktopSessionSummary,
): boolean {
  if (left === right) return true;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    // updatedAt includes lifecycle-only persistence. activityAt is the
    // user-visible ordering signal, so a housekeeping save must not invalidate
    // the whole desktop tree.
    if (key === "updatedAt") continue;
    if (
      (left as unknown as Record<string, unknown>)[key]
      !== (right as unknown as Record<string, unknown>)[key]
    ) return false;
  }
  return true;
}

export function sessionCatalogRowsEqual(
  left: readonly DesktopSessionSummary[],
  right: readonly DesktopSessionSummary[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const leftById = new Map(left.map((row) => [row.id, row]));
  if (leftById.size !== left.length) return false;
  return right.every((row) => {
    const previous = leftById.get(row.id);
    return previous !== undefined && sessionSummaryVisibleEqual(previous, row);
  });
}

export function mergeSessionCatalogRows(
  current: readonly DesktopSessionSummary[],
  incoming: readonly DesktopSessionSummary[],
): DesktopSessionSummary[] {
  if (sessionCatalogRowsEqual(current, incoming)) return current as DesktopSessionSummary[];
  const currentById = new Map(current.map((row) => [row.id, row]));
  const incomingIds = incoming.map((row) => row.id);
  if (sessionListKeepsExistingTopInsert(current.map((row) => row.id), incomingIds)) {
    const incomingById = new Map(incoming.map((row) => [row.id, row]));
    return current.map((row) => {
      const next = incomingById.get(row.id);
      return next && !sessionSummaryVisibleEqual(row, next) ? next : row;
    });
  }
  return incoming.map((row) => {
    const previous = currentById.get(row.id);
    return previous && sessionSummaryVisibleEqual(previous, row) ? previous : row;
  });
}

/** Session watcher pushes are exact durable-store scans. Treat them as
 * authoritative so a deleted session cannot survive forever in renderer
 * memory merely because no fallback poll runs for push-capable hosts. */
export function mergeSessionCatalogPushRows(
  current: readonly DesktopSessionSummary[],
  incoming: readonly DesktopSessionSummary[],
): DesktopSessionSummary[] {
  return mergeSessionCatalogRows(current, incoming);
}
