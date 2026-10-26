/**
 * The ask_user secret requests of the window process: each request id's
 * one-shot value slots (the secret, its username and save choice) and the
 * page or window it was bound to at request time (secret-input.ts).
 */

import { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } from '../shared/secret-slots';

export const SECRET_INPUT_TIMEOUT_MS = 120_000;
/** A binding outlives the card's own wait (the runtime's 120 s) a little. */
const BINDING_TIMEOUT_MS = 180_000;
const MAX_SECRET_LENGTH = 4_096;
const REQUEST_ID = /^secret_[A-Za-z0-9-]{8,80}$/;

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

/** A held entry and the timer that drops it when it expires. */
type Held<T> = { value: T; timer: ReturnType<typeof setTimeout> };

// Every entry leaves memory on its own when it expires, whether or not
// anything asks for it again; its timer never keeps the app alive and is
// cleared as soon as the entry is used or dropped.
function drop<T>(map: Map<string, Held<T>>, id: string): void {
  const held = map.get(id);
  if (!held) return;
  clearTimeout(held.timer);
  map.delete(id);
}

function hold<T>(map: Map<string, Held<T>>, id: string, value: T, ms: number): void {
  drop(map, id);
  const timer = setTimeout(() => {
    if (map.get(id)?.timer === timer) map.delete(id);
  }, ms);
  timer.unref?.();
  map.set(id, { value, timer });
}

export function createSecretRequests(options: { timeoutMs?: number; bindingTimeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? SECRET_INPUT_TIMEOUT_MS;
  const bindingTimeoutMs = options.bindingTimeoutMs ?? BINDING_TIMEOUT_MS;
  const slots = new Map<string, Held<string>>();
  const bindings = new Map<string, Held<SecretBinding | ComputerSecretBinding>>();

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
  };
}
