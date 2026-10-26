/**
 * The markers the window process writes in place of a secret (session-secrets.ts,
 * saved-login-registry.ts), and the one way to write them: a marker is opaque
 * to every redaction pass, whichever redactor wrote it. Secrets are replaced
 * only in the text between markers, so redacting twice is redacting once, and
 * a secret such as `e` never rewrites the letters of a marker already there.
 */

/** What replaces a filled secret wherever it later appears in tool output. */
export const REDACTED_MARKER = '[redacted]';
/** What replaces a Computer Use saved-login password wherever it later appears. */
export const SAVED_LOGIN_MARKER = '[saved login]';
/** Every marker any redactor writes. */
export const SECRET_MARKERS: readonly string[] = [REDACTED_MARKER, SAVED_LOGIN_MARKER];

/** `text` with `edit` applied to each stretch between markers, the markers
 *  themselves kept as written. */
function editBetweenMarkers(text: string, edit: (plain: string) => string, next = 0): string {
  if (next === SECRET_MARKERS.length) return edit(text);
  const marker = SECRET_MARKERS[next];
  return text
    .split(marker)
    .map((part) => editBetweenMarkers(part, edit, next + 1))
    .join(marker);
}

/** `text` with every one of `secrets` (given longest first, so a secret
 *  containing a shorter one is replaced whole) replaced by `marker`, outside
 *  the markers already in `text`. */
export function redactBetweenMarkers(text: string, secrets: readonly string[], marker: string): string {
  let out = text;
  for (const secret of secrets) out = editBetweenMarkers(out, (plain) => plain.replaceAll(secret, marker));
  return out;
}
