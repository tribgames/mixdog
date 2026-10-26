/**
 * The markers the window process writes in place of a secret (session-secrets.ts,
 * saved-login-registry.ts), and the one way to write them: a marker is opaque
 * to every redaction pass, whichever redactor wrote it. A secret is matched
 * whole against the text and replaced unless that occurrence lies entirely
 * inside a marker already there, so redacting twice is redacting once, a
 * secret such as `e` never rewrites the letters of a marker, and a secret that
 * contains or spans marker text (`prefix[redacted]suffix`) is still replaced.
 */

/** What replaces a filled secret wherever it later appears in tool output. */
export const REDACTED_MARKER = '[redacted]';
/** What replaces a Computer Use saved-login password wherever it later appears. */
export const SAVED_LOGIN_MARKER = '[saved login]';
/** Every marker any redactor writes. */
export const SECRET_MARKERS: readonly string[] = [REDACTED_MARKER, SAVED_LOGIN_MARKER];

/** [start, end) of every marker in `text`. */
function markerSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const marker of SECRET_MARKERS) {
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
      spans.push([at, at + marker.length]);
    }
  }
  return spans;
}

/** `text` with every one of `secrets` (non-empty, given longest first, so a
 *  secret containing a shorter one is replaced whole) replaced by `marker`,
 *  except an occurrence lying entirely inside a marker. The markers in `text`
 *  and the ones written here are looked up again for each secret, so a later,
 *  shorter secret cannot match inside a marker an earlier one wrote. */
export function redactSecrets(text: string, secrets: readonly string[], marker: string): string {
  let out = text;
  for (const secret of secrets) {
    const spans = markerSpans(out);
    let next = '';
    let copied = 0;
    for (let at = out.indexOf(secret); at >= 0; ) {
      const end = at + secret.length;
      if (spans.some(([from, to]) => from <= at && end <= to)) {
        at = out.indexOf(secret, at + 1);
      } else {
        next += out.slice(copied, at) + marker;
        copied = end;
        at = out.indexOf(secret, end);
      }
    }
    out = next + out.slice(copied);
  }
  return out;
}
