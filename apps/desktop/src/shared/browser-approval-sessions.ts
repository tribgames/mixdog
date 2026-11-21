/** `hostState` keys for the core's cards and the desktop's own dialogs. */
export const BROWSER_APPROVAL_SESSIONS_KEY = 'browserApprovalSessions';
export const BROWSER_DIALOG_APPROVAL_SESSIONS_KEY = 'browserDialogApprovalSessions';

const MAX_ID_LENGTH = 200;

/** The list a push carries, or null when it is not one. */
export function readBrowserApprovalSessions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)) return null;
  return [...new Set(value as string[])];
}
