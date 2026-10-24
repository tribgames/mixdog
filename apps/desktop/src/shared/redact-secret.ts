// One redaction for every route that carries a credential to a server: the
// SSH logins and the phone/relay capability frames. A failure can echo the
// secret back plainly or inside JSON (quotes, backslashes and control
// characters escaped), so both spellings are removed.
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
