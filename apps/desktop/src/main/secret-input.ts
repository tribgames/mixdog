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

export type {
  SavedLoginOwnerProcess,
  SavedLoginPixelGuard,
  SavedLoginTurn,
} from './saved-login-registry';
export {
  type ComputerSecretBinding,
  SECRET_INPUT_TIMEOUT_MS,
  type SecretBinding,
  type SecretFieldForm,
} from './secret-requests';
export { REDACTED_MARKER, SAVED_LOGIN_MARKER } from './secret-markers';

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
    /** Saved-login passwords first (for every session), then the session's own
     *  secrets, repeated until neither changes the text: one redactor's marker
     *  could complete a marker-containing secret of the other. Both share the
     *  marker set and its shrinking invariant (secret-markers.ts), so this ends. */
    redact(sessionId: string, text: string): string {
      let out = text;
      for (;;) {
        const next = sessions.redact(sessionId, savedLogins.redact(out));
        if (next === out) return out;
        out = next;
      }
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

/** The bound field as a fresh read shows it after the background write. */
interface BoundField {
  /** The field's ref in that read: a read retires every earlier ref. */
  ref: string;
  value: string;
  /** UIA IsPassword / MSAA protected, as the typing guard reads them; true when unreadable. */
  isPassword: boolean;
}

/** Re-reads the window with the bound ref named: the host marks the element
 *  that ref pointed at (`bound_ref`, by its runtime identity, which survives
 *  the read's new refs) and says whether it is a password field. Nothing from
 *  the read is returned or stored. Null when that element is not found. */
async function readBoundField(
  execute: (command: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  binding: { windowId: string; ref: string }
): Promise<BoundField | null> {
  const reply = (await execute({
    action: 'find',
    session_id: sessionId,
    window_id: binding.windowId,
    ref: binding.ref,
    max_elements: 1000,
  })) as
    | { elements?: Array<{ ref?: unknown; value?: unknown; bound_ref?: unknown; is_password?: unknown }> }
    | undefined;
  const field = reply?.elements?.find((element) => element?.bound_ref === true);
  if (!field || typeof field.ref !== 'string' || !field.ref) return null;
  return {
    ref: field.ref,
    value: typeof field.value === 'string' ? field.value : '',
    isPassword: field.is_password !== false,
  };
}

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
    // Every secret first goes in by the background value write: a password is
    // never sent as keystrokes, which could land in another window.
    await execute({
      action: 'type',
      text: value,
      session_id: sessionId,
      ref: binding.ref,
      window_id: binding.windowId,
    });
    if ([...value].length === 1) return { text: 'entered' };
    // A background write sets one control's value, so a segmented code input
    // (one digit per box) keeps only the first digit. The field is read back
    // and identified by the element the bound ref pointed at, not by a ref.
    // Best effort: a read that fails or finds nothing leaves the result the
    // write itself produced.
    const field = await readBoundField(execute, sessionId, binding).catch(() => null);
    // Real keystrokes (focus advancing box to box) only when the field is
    // positively re-identified, is not a password, and holds just the first
    // character: a one-character box. The foreground delivery is held to this
    // window and refuses when the foreground moves.
    if (!field || field.isPassword || field.value !== [...value][0]) return { text: 'entered' };
    await execute({
      action: 'type',
      text: value,
      session_id: sessionId,
      ref: field.ref,
      window_id: binding.windowId,
      delivery: 'foreground',
    });
    return { text: 'entered' };
  } catch (error) {
    // The window or field went away: the input path refuses a stale target
    // before typing (input-refs.ps1, session.ps1).
    return { text: STALE_TARGET.test(String((error as Error)?.message || error)) ? 'page_changed' : 'blocked' };
  }
}
