// The sessions the host catalog marks as waiting on the user's approval
// (`awaitingApproval`: the daemon's live runtime shows the card), fed to the
// session attention index. A lane carries the approval only while a pane
// receives it; this mark reaches every list row, a background session's too.
// Fed by the session catalog (app-session-catalog.ts); a new set identity only
// when membership changes.
import type { DesktopSessionSummary } from '../shared/contract';

let ids: ReadonlySet<string> = new Set();
// The subset whose pending wait is an ask_user question (`awaitingQuestion`).
let questionIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export const catalogApprovalSessionIds = (): ReadonlySet<string> => ids;
export const catalogQuestionSessionIds = (): ReadonlySet<string> => questionIds;

const sameMembers = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((id) => right.has(id));

export function subscribeCatalogApprovalSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishCatalogApprovalSessions(
  sessions: readonly Pick<DesktopSessionSummary, 'id' | 'awaitingApproval' | 'awaitingQuestion'>[]
): void {
  const waiting = sessions.filter((session) => session.awaitingApproval === true);
  const next = new Set(waiting.map((session) => session.id));
  const nextQuestions = new Set(
    waiting.filter((session) => session.awaitingQuestion === true).map((session) => session.id)
  );
  const sameIds = sameMembers(next, ids);
  const sameQuestions = sameMembers(nextQuestions, questionIds);
  if (sameIds && sameQuestions) return;
  if (!sameIds) ids = next;
  if (!sameQuestions) questionIds = nextQuestions;
  for (const listener of [...listeners]) listener();
}
