// The sessions the host catalog marks as waiting on the user's approval
// (`awaitingApproval`: the daemon's live runtime shows the card), fed to the
// session attention index. A lane carries the approval only while a pane
// receives it; this mark reaches every list row, a background session's too.
// Fed by the session catalog (app-session-catalog.ts); a new set identity only
// when membership changes.
import type { DesktopSessionSummary } from '../shared/contract';

let ids: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export const catalogApprovalSessionIds = (): ReadonlySet<string> => ids;

export function subscribeCatalogApprovalSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishCatalogApprovalSessions(
  sessions: readonly Pick<DesktopSessionSummary, 'id' | 'awaitingApproval'>[]
): void {
  const next = new Set(sessions.filter((session) => session.awaitingApproval === true).map((session) => session.id));
  if (next.size === ids.size && [...next].every((id) => ids.has(id))) return;
  ids = next;
  for (const listener of [...listeners]) listener();
}
