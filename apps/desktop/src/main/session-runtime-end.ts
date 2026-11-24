import { endBrowserApprovalSession } from './browser/approval-dialog';
import { secretInputs } from './secret-input';

/** What a deleted session was trusted with ends with it: its filled secrets, saved-login guards and "allow for this session" grants. */
export function endSessionRuntime(sessionId: string): void {
  secretInputs.forget(sessionId);
  endBrowserApprovalSession(sessionId);
}
