const REDACTED_SECRET = '[redacted]';

/** `message` with each of `secrets` (plain and JSON-escaped) replaced by `[redacted]`. */
export function redactSecrets(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (!secret) continue;
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (const form of escaped === secret ? [secret] : [secret, escaped]) safe = safe.split(form).join(REDACTED_SECRET);
  }
  return safe;
}
