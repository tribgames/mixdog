/**
 * Per-session secrets of the window process (secret-input.ts): every value
 * filled for a session, redacted from its later replies, and whether a secret
 * field of it may still hold focus (captures are withheld meanwhile).
 */

import { REDACTED_MARKER, redactSecrets } from './secret-markers';

export function createSessionSecrets() {
  const sessionSecrets = new Map<string, Set<string>>();
  const focused = new Set<string>();

  return {
    /** Register `value` for redaction in every later reply of `sessionId`:
     *  every non-empty value, of any length, until `forget(sessionId)`. */
    remember(sessionId: string, value: string): void {
      // Passwords, one-time codes and ask_user/agent-typed secrets only; a
      // username is no secret and is never registered. In memory only, and
      // never dropped or evicted: the value was typed into the page, so it
      // must be hidden from every later reply, however short or numerous.
      // An empty value hides nothing (replacing it would mark every
      // character boundary), so it is not kept.
      if (!sessionId || !value) return;
      const set = sessionSecrets.get(sessionId) ?? new Set<string>();
      set.add(value);
      sessionSecrets.set(sessionId, set);
    },
    secretsOf(sessionId: string): string[] {
      return [...(sessionSecrets.get(sessionId) || [])];
    },
    /** `text` with every secret of `sessionId` replaced by REDACTED_MARKER:
     *  longest first, so a secret containing a shorter one is replaced whole;
     *  markers already in `text` (secret-markers.ts) are left as they are. */
    redact(sessionId: string, text: string): string {
      const secrets = [...(sessionSecrets.get(sessionId) || [])].sort((a, b) => b.length - a.length);
      return redactSecrets(text, secrets, REDACTED_MARKER);
    },
    /** The session ended: its secrets and focus leave memory. */
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
