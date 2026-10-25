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

export const SECRET_INPUT_TIMEOUT_MS = 120_000;
/** A binding outlives the card's own wait (the runtime's 120 s) a little. */
const BINDING_TIMEOUT_MS = 180_000;
const MAX_SECRET_LENGTH = 4_096;
/** What replaces a filled secret wherever it later appears in tool output. */
export const REDACTED_MARKER = '[redacted]';
/** A session keeps at most this many filled secrets (the oldest leave first)
 *  and none shorter than this (they could not be told from page text). */
const MAX_SESSION_SECRETS = 64;
const MIN_REDACTED_LENGTH = 4;
const REQUEST_ID =/^secret_[A-Za-z0-9-]{8,80}$/;

/** What the agent hears about a fill (human-gate/requests.mjs HANDOFF_OUTCOMES). */
export type SecretFillOutcome = 'entered' | 'no_field' | 'page_changed' | 'blocked' | 'expired';
/** What a bound field is (requests.mjs SECRET_FORMS). */
export type SecretFieldForm = 'login' | 'password' | 'new-password' | 'otp';

/** The page a secret request was bound to when it was made. */
export interface SecretBinding {
  sessionId: string;
  pageId: string;
  origin: string;
  form: SecretFieldForm;
  /** The main frame's document when it was bound, as the browser reports it
   *  (frame id and CDP loader id, new for every document the frame loads;
   *  credential-autofill.ts mainDocumentOf): compared exactly, so a
   *  navigation since, even within the origin or to the same address, leaves
   *  nothing to fill. */
  document: string;
  /** The exact elements the value goes to, in order (the field, then its
   *  username, confirmation or one box per character): each one's CDP
   *  backend node id and input type at request time. A login takeover's
   *  saved-login binding has none. */
  targets?: Array<{ node: number; type: string }>;
}

/** The exact window and field a Computer Use secret request was bound to
 *  when it was made (the agent's window_id and ref; never a focused field). */
export interface ComputerSecretBinding {
  sessionId: string;
  windowId: string;
  ref: string;
}

/** A window id or field ref as the runtime validates it (ask-user-tool-defs.mjs). */
const TARGET_TOKEN = /^[\w.:#@-]+$/;

export { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX };

/** A held entry and the timer that drops it when it expires. */
type Held<T> = { value: T; timer: ReturnType<typeof setTimeout> };

export function createSecretInputs(options: { timeoutMs?: number; bindingTimeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? SECRET_INPUT_TIMEOUT_MS;
  const bindingTimeoutMs = options.bindingTimeoutMs ?? BINDING_TIMEOUT_MS;
  const slots = new Map<string, Held<string>>();
  const bindings = new Map<string, Held<SecretBinding | ComputerSecretBinding>>();
  const sessionSecrets = new Map<string, Set<string>>();
  const focused = new Set<string>();

  // Every entry leaves memory on its own when it expires, whether or not
  // anything asks for it again; its timer never keeps the app alive and is
  // cleared as soon as the entry is used or dropped.
  const drop = <T>(map: Map<string, Held<T>>, id: string): void => {
    const held = map.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    map.delete(id);
  };
  const hold = <T>(map: Map<string, Held<T>>, id: string, value: T, ms: number): void => {
    drop(map, id);
    const timer = setTimeout(() => {
      if (map.get(id)?.timer === timer) map.delete(id);
    }, ms);
    timer.unref?.();
    map.set(id, { value, timer });
  };

  return {
    /** Bind `requestId` to its page at request time (no value involved), for
     *  `ttlMs` (default: a little past the card's wait). */
    bind(requestId: string, binding: SecretBinding, ttlMs = bindingTimeoutMs): boolean {
      if (!REQUEST_ID.test(requestId)) return false;
      hold(bindings, requestId, { ...binding }, ttlMs);
      return true;
    },
    /** The page binding of `requestId`, left in place (the fill drops it with `discard`). */
    binding(requestId: string): SecretBinding | null {
      const held = bindings.get(requestId)?.value;
      return held && 'pageId' in held ? { ...held } : null;
    },
    /** Bind a Computer Use request to the exact window and field the agent
     *  named; false (nothing bound) unless both are plain tokens. */
    bindComputer(requestId: string, binding: ComputerSecretBinding): boolean {
      const { sessionId, windowId, ref } = binding;
      if (!REQUEST_ID.test(requestId) || !sessionId) return false;
      if (!TARGET_TOKEN.test(windowId) || windowId.length > 128 || !TARGET_TOKEN.test(ref) || ref.length > 64) {
        return false;
      }
      hold(bindings, requestId, { sessionId, windowId, ref }, bindingTimeoutMs);
      return true;
    },
    /** The window binding of `requestId`, left in place. */
    computerBinding(requestId: string): ComputerSecretBinding | null {
      const held = bindings.get(requestId)?.value;
      return held && 'windowId' in held ? { ...held } : null;
    },
    /** Whether the card handed a value for `requestId` (it is not taken). */
    has(requestId: string): boolean {
      return slots.has(requestId);
    },
    /** Drop every slot and the binding of `requestId` unused: the fill is
     *  over, or refused (blocked, page changed, no field). */
    discard(requestId: string): void {
      for (const id of [requestId, requestId + SECRET_USERNAME_SUFFIX, requestId + SECRET_SAVE_SUFFIX]) {
        drop(slots, id);
      }
      drop(bindings, requestId);
    },
    /** The card's value for `requestId`; false when the id or value is unusable. */
    provide(requestId: string, value: string): boolean {
      if (!REQUEST_ID.test(requestId) || typeof value !== 'string' || !value || value.length > MAX_SECRET_LENGTH) {
        return false;
      }
      hold(slots, requestId, value, timeoutMs);
      return true;
    },
    /** One-shot: the value is gone from the slot once taken. */
    take(requestId: string): string {
      const value = slots.get(requestId)?.value || '';
      drop(slots, requestId);
      return value;
    },
    /** Register `value` for redaction in every later reply of `sessionId`. */
    remember(sessionId: string, value: string): void {
      // Passwords, one-time codes and ask_user/agent-typed secrets only; a
      // username is no secret and is never registered. In memory only,
      // bounded: a value too short to tell from page text is
      // not kept, and the oldest of a session's values leaves first.
      if (!sessionId || value.length < MIN_REDACTED_LENGTH) return;
      const set = sessionSecrets.get(sessionId) ?? new Set<string>();
      set.delete(value);
      set.add(value);
      while (set.size > MAX_SESSION_SECRETS) set.delete(set.values().next().value as string);
      sessionSecrets.set(sessionId, set);
    },
    secretsOf(sessionId: string): string[] {
      return [...(sessionSecrets.get(sessionId) || [])];
    },
    redact(sessionId: string, text: string): string {
      let out = text;
      for (const secret of sessionSecrets.get(sessionId) || []) out = out.replaceAll(secret, REDACTED_MARKER);
      return out;
    },
    /** The session ended: its secrets leave memory. */
    forget(sessionId: string): void {
      sessionSecrets.delete(sessionId);
      focused.delete(sessionId);
    },
    /** A secret field of `sessionId` may hold focus: captures are withheld. */
    armFocus(sessionId: string): void {
      focused.add(sessionId);
    },
    clearFocus(sessionId: string): void {
      focused.delete(sessionId);
    },
    focusArmed(sessionId: string): boolean {
      return focused.has(sessionId);
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
  if (
    (command.window_id && command.window_id !== binding.windowId) ||
    (command.ref && command.ref !== binding.ref)
  ) {
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
    await execute({ action: 'type', text: value, session_id: sessionId, ref: binding.ref, window_id: binding.windowId });
    return { text: 'entered' };
  } catch (error) {
    // The window or field went away: the input path refuses a stale target
    // before typing (input-refs.ps1, session.ps1).
    return { text: STALE_TARGET.test(String((error as Error)?.message || error)) ? 'page_changed' : 'blocked' };
  }
}
