// The sessions with a Browser Use approval waiting on the PC, as paired
// devices learn them: the full list on every change and on each connection's
// handshake, empty once none waits. Session ids only — the card, its page and
// its answer never leave the PC.

/** Desktop event and remote push name. */
export const BROWSER_APPROVAL_SESSIONS_EVENT = 'browserApprovalSessions';

const MAX_SESSIONS = 200;
const MAX_ID_LENGTH = 200;

/** The list a push carries, or null when it is not one. */
export function readBrowserApprovalSessions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) return null;
  if (!value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)) return null;
  return [...new Set(value as string[])];
}
