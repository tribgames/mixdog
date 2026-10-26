/**
 * The markers the window process writes in place of a secret (session-secrets.ts,
 * saved-login-registry.ts), and the one way to write them: a marker is opaque
 * to every redaction pass, whichever redactor wrote it. A secret is matched
 * whole against the text and replaced unless that occurrence lies entirely
 * inside markers already there, so redacting twice is redacting once, a
 * secret such as `e` never rewrites the letters of a marker, and a secret that
 * contains or spans marker text (`prefix[redacted]suffix`) is still replaced.
 */

/** What replaces a filled secret wherever it later appears in tool output. */
export const REDACTED_MARKER = '[redacted]';
/** What replaces a Computer Use saved-login password wherever it later appears. */
export const SAVED_LOGIN_MARKER = '[saved login]';
/** Every marker any redactor writes. */
export const SECRET_MARKERS: readonly string[] = [REDACTED_MARKER, SAVED_LOGIN_MARKER];

/** [start, end) of every marker in `text`, in order. */
function markerSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const marker of SECRET_MARKERS) {
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
      spans.push([at, at + marker.length]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** `text` with each occurrence of `secret` (non-empty) replaced by `marker`,
 *  except one lying entirely inside markers. An occurrence that partly
 *  overlaps a marker replaces that marker whole, so no marker is left broken. */
function redactSecret(text: string, secret: string, marker: string): string {
  const spans = markerSpans(text);
  let next = '';
  let copied = 0;
  for (let at = text.indexOf(secret); at >= 0; ) {
    const end = at + secret.length;
    const touched = spans.filter(([from, to]) => from < end && at < to);
    let reach = at;
    for (const [from, to] of touched) {
      if (from > reach) break;
      reach = Math.max(reach, to);
    }
    if (reach >= end) {
      at = text.indexOf(secret, at + 1);
      continue;
    }
    const from = Math.min(at, touched[0]?.[0] ?? at);
    const to = Math.max(end, touched.at(-1)?.[1] ?? end);
    next += text.slice(copied, from) + marker;
    copied = to;
    at = text.indexOf(secret, to);
  }
  return next + text.slice(copied);
}

/** `text` with every one of `secrets` (non-empty, given longest first, so a
 *  secret containing a shorter one is replaced whole) replaced by `marker`,
 *  passes repeated until no secret occurs outside the markers: a replacement
 *  can join a secret that holds marker text (`a[redacted]`) to the text before
 *  it, so one pass is not enough. The repetition ends without a bound: every
 *  replacement covers at least one character outside the markers and takes in
 *  whole every marker it touches (writing one marker, which adds no character
 *  outside), so each replacement lowers the number of characters outside the
 *  markers and a pass that changes nothing comes after at most that many.
 *  The result is stable: redacting it again changes nothing, and a later,
 *  shorter secret cannot match inside a marker an earlier one wrote. */
export function redactSecrets(text: string, secrets: readonly string[], marker: string): string {
  let out = text;
  let before: string;
  do {
    before = out;
    for (const secret of secrets) out = redactSecret(out, secret, marker);
  } while (out !== before);
  return out;
}
