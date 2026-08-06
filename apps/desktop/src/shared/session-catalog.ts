import type { DesktopSessionSummary } from "./contract";

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
  return incoming.map((row) => {
    const previous = currentById.get(row.id);
    return previous && sessionSummaryVisibleEqual(previous, row) ? previous : row;
  });
}

/** Backend watcher pushes are exact durable-store scans. Treat them as
 * authoritative so a deleted session cannot survive forever in renderer
 * memory merely because no fallback poll runs for push-capable hosts. */
export function mergeSessionCatalogPushRows(
  current: readonly DesktopSessionSummary[],
  incoming: readonly DesktopSessionSummary[],
): DesktopSessionSummary[] {
  return mergeSessionCatalogRows(current, incoming);
}

/** Paint a just-accepted session before the debounced store watcher publishes
 * its durable row. The authoritative catalog replaces this projection. */
export function optimisticSubmittedSessionCatalog(
  current: readonly DesktopSessionSummary[],
  submitted: DesktopSessionSummary,
): DesktopSessionSummary[] {
  const previous = current.find((row) => row.id === submitted.id);
  const active = previous ? { ...previous, ...submitted } : submitted;
  return [
    active,
    ...current
      .filter((row) => row.id !== submitted.id)
      .map((row) => row.currentSession ? { ...row, currentSession: false } : row),
  ];
}
