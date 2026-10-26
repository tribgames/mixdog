/**
 * Per-session secrets of the window process (secret-input.ts): every value
 * filled for a session, redacted from its later replies, and whether a secret
 * field of it may still hold focus (captures are withheld meanwhile).
 */

/** What replaces a filled secret wherever it later appears in tool output. */
export const REDACTED_MARKER = '[redacted]';
/** A session keeps at most this many filled secrets (the oldest leave first)
 *  and none shorter than this (they could not be told from page text). */
export const MAX_SESSION_SECRETS = 64;
export const MIN_REDACTED_LENGTH = 4;

export function createSessionSecrets() {
  const sessionSecrets = new Map<string, Set<string>>();
  const focused = new Set<string>();

  return {
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
    /** `text` with every secret of `sessionId` replaced by REDACTED_MARKER. */
    redact(sessionId: string, text: string): string {
      let out = text;
      for (const secret of sessionSecrets.get(sessionId) || []) out = out.replaceAll(secret, REDACTED_MARKER);
      return out;
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
