import { REDACTED_MARKER, redactSecrets } from './secret-markers';

export function createSessionSecrets() {
  const sessionSecrets = new Map<string, Set<string>>();
  const focused = new Set<string>();

  return {
    /** Register `value` for redaction in every later reply of `sessionId`:
     *  every non-empty value, of any length, until `forget(sessionId)`. */
    remember(sessionId: string, value: string): void {
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
