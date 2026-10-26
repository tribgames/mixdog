/**
 * Secret input: the one path a secret takes is renderer → this process →
 * target field. The card hands the value here (IPC `provideSecretInput`)
 * under the request id the runtime minted; the runtime then asks the browser
 * or computer bridge to fill that request, which takes the value exactly once.
 * The value never goes back to the runtime, the transcript, an approval
 * decision, a log, a notification or the clipboard. Each filled value is
 * remembered for its session so every later reply of that session is
 * redacted, and captures stay withheld while the field may still be focused.
 */

import { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } from '../shared/secret-slots';
import { beginComputerOperation } from './human-only-approval';
import { createSavedLoginRegistry } from './saved-login-registry';
import { createSecretRequests } from './secret-requests';
import { createSessionSecrets } from './session-secrets';

export {
  MAX_SAVED_LOGIN_ENTRIES,
  SAVED_LOGIN_MARKER,
  type SavedLoginOwnerProcess,
  type SavedLoginPixelGuard,
  type SavedLoginTurn,
} from './saved-login-registry';
export {
  type ComputerSecretBinding,
  SECRET_INPUT_TIMEOUT_MS,
  type SecretBinding,
  type SecretFieldForm,
} from './secret-requests';
export { REDACTED_MARKER } from './session-secrets';

/** What the agent hears about a fill (human-gate/requests.mjs HANDOFF_OUTCOMES). */
export type SecretFillOutcome = 'entered' | 'no_field' | 'page_changed' | 'blocked' | 'expired';

export { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX };

export function createSecretInputs(options: { timeoutMs?: number; bindingTimeoutMs?: number } = {}) {
  const sessions = createSessionSecrets();
  const savedLogins = createSavedLoginRegistry();
  return {
    ...createSecretRequests(options),
    ...sessions,
    ...savedLogins,
    /** Saved-login passwords first (for every session), then the session's own secrets. */
    redact(sessionId: string, text: string): string {
      return sessions.redact(sessionId, savedLogins.redact(text));
    },
    /** The session ended: its secrets leave memory, and every turn of it any
     *  owner admitted a fill for is settled at once. */
    forget(sessionId: string): void {
      sessions.forget(sessionId);
      savedLogins.forget(sessionId);
    },
  };
}

export type SecretInputs = ReturnType<typeof createSecretInputs>;

/** The window process's one registry (IPC, browser bridge and computer bridge share it). */
export const secretInputs = createSecretInputs();

/**
 * Computer Use, at request time (bridge `secret_bind`): bind the request to
 * the exact window and field ref the agent named. Answers 'bound', or
 * 'no_field' when that target is missing or not a plain token.
 */
export function bindComputerSecret(
  command: { session_id?: string; request_id?: string; ref?: string; window_id?: string },
  registry: SecretInputs = secretInputs
): { text: 'bound' | 'no_field' } {
  const bound = registry.bindComputer(String(command.request_id || ''), {
    sessionId: String(command.session_id || ''),
    windowId: String(command.window_id || ''),
    ref: String(command.ref || ''),
  });
  return { text: bound ? 'bound' : 'no_field' };
}

/** A computer input error that says its window or ref no longer exists. */
const STALE_TARGET = /stale_target|\bis stale\b|stale or invalid/i;

/**
 * Computer Use: type the request's value once into the window and field ref
 * it was bound to at request time (bindComputerSecret), never the focused
 * field, through the ordinary input path, discarding its reply (the capture
 * of a field holding the secret never leaves). The binding and the lock are
 * checked before the value is taken: a request never bound (no_field), a
 * target other than its binding (page_changed) or a held session (blocked)
 * drops the value and binding unused, never types it. Answers the outcome
 * and nothing else.
 */
export async function typeComputerSecret(
  command: { session_id?: string; request_id?: string; ref?: string; window_id?: string },
  execute: (command: Record<string, unknown>) => Promise<unknown>,
  registry: SecretInputs = secretInputs,
  assertFree: () => void = () => beginComputerOperation()()
): Promise<{ text: SecretFillOutcome }> {
  const sessionId = String(command.session_id || '');
  const requestId = String(command.request_id || '');
  const binding = registry.computerBinding(requestId);
  const refuse = (text: SecretFillOutcome) => {
    registry.discard(requestId);
    return { text };
  };
  if (!sessionId || !registry.has(requestId)) return refuse('expired');
  if (!binding) return refuse('no_field');
  if (binding.sessionId !== sessionId) return refuse('blocked');
  if ((command.window_id && command.window_id !== binding.windowId) || (command.ref && command.ref !== binding.ref)) {
    return refuse('page_changed');
  }
  try {
    assertFree();
  } catch {
    return refuse('blocked');
  }
  const value = registry.take(requestId);
  registry.discard(requestId);
  registry.remember(sessionId, value);
  registry.armFocus(sessionId);
  try {
    await execute({
      action: 'type',
      text: value,
      session_id: sessionId,
      ref: binding.ref,
      window_id: binding.windowId,
    });
    return { text: 'entered' };
  } catch (error) {
    // The window or field went away: the input path refuses a stale target
    // before typing (input-refs.ps1, session.ps1).
    return { text: STALE_TARGET.test(String((error as Error)?.message || error)) ? 'page_changed' : 'blocked' };
  }
}
