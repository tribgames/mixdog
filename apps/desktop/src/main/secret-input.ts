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

export const SECRET_INPUT_TIMEOUT_MS = 120_000;
const MAX_SECRET_LENGTH = 4_096;
const REQUEST_ID = /^secret_[A-Za-z0-9-]{8,80}$/;

export function createSecretInputs(options: { now?: () => number; timeoutMs?: number } = {}) {
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs ?? SECRET_INPUT_TIMEOUT_MS;
  const slots = new Map<string, { value: string; expiresAt: number }>();
  const sessionSecrets = new Map<string, Set<string>>();
  const focused = new Set<string>();

  const sweep = (): void => {
    const at = now();
    for (const [id, slot] of slots) if (slot.expiresAt <= at) slots.delete(id);
  };

  return {
    /** The card's value for `requestId`; false when the id or value is unusable. */
    provide(requestId: string, value: string): boolean {
      sweep();
      if (!REQUEST_ID.test(requestId) || typeof value !== 'string' || !value || value.length > MAX_SECRET_LENGTH) {
        return false;
      }
      slots.set(requestId, { value, expiresAt: now() + timeoutMs });
      return true;
    },
    /** One-shot: the value is gone from the slot once taken. */
    take(requestId: string): string {
      sweep();
      const slot = slots.get(requestId);
      slots.delete(requestId);
      return slot?.value || '';
    },
    /** Register `value` for redaction in every later reply of `sessionId`. */
    remember(sessionId: string, value: string): void {
      if (!value) return;
      const set = sessionSecrets.get(sessionId) ?? new Set<string>();
      set.add(value);
      sessionSecrets.set(sessionId, set);
    },
    secretsOf(sessionId: string): string[] {
      return [...(sessionSecrets.get(sessionId) || [])];
    },
    redact(sessionId: string, text: string): string {
      let out = text;
      for (const secret of sessionSecrets.get(sessionId) || []) out = out.replaceAll(secret, '[REDACTED SECRET]');
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
 * Computer Use: type the request's value once into `command.ref` (or the
 * focused field) through the ordinary input path, discarding its reply (the
 * capture of a field holding the secret never leaves). Answers 'provided' or
 * 'skipped' and nothing else.
 */
export async function typeComputerSecret(
  command: { session_id?: string; request_id?: string; ref?: string; window_id?: string },
  execute: (command: Record<string, unknown>) => Promise<unknown>,
  registry: SecretInputs = secretInputs
): Promise<{ text: 'provided' | 'skipped' }> {
  const sessionId = String(command.session_id || '');
  const value = registry.take(String(command.request_id || ''));
  if (!sessionId || !value) return { text: 'skipped' };
  registry.remember(sessionId, value);
  registry.armFocus(sessionId);
  try {
    await execute({
      action: 'type',
      text: value,
      session_id: sessionId,
      ...(command.ref ? { ref: command.ref } : {}),
      ...(command.window_id ? { window_id: command.window_id } : {}),
    });
    return { text: 'provided' };
  } catch {
    return { text: 'skipped' };
  }
}
