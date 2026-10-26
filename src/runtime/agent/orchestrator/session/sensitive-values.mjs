// Values a tool call marked sensitive — a browser `fill` with sensitive:true,
// such as a verification code read from a mail — remembered per session and
// replaced by a marker wherever the session's transcript is stored: the
// session file (store/serialize.mjs), the crash-recovery checkpoint
// (manager/turn-checkpoint-journal.mjs) and the search copy
// (session-search/session-search-ingest.mjs), earlier records that carried
// the value included: marking one notifies the running turn, which rewrites
// them (manager/ask-turn-state.mjs). The live transcript the provider sees is
// left as sent (its prefix must not change); the desktop redacts the value in
// its own replies (browser/actions/forms.ts).
//
// A value stays known for the life of the process — as long as any plaintext
// copy of it (the loaded session) can still be written — and is never
// evicted. In text, replacement is the exact substring, longest spelling
// first, so a shorter value never splits a longer one. Which parts of a
// message are text is sensitive-projection.mjs's business.
//
// A marker is opaque to every redaction: values are replaced only in the text
// between markers (the one written here, and the one the desktop writes for a
// saved login, which reaches the transcript in replies), so redacting twice
// is redacting once and a value such as `e` never rewrites a marker's letters.
export const MARKER = '[redacted]';
/** What the desktop writes for a Computer Use saved-login password
 *  (apps/desktop/src/main/secret-markers.ts). */
export const SAVED_LOGIN_MARKER = '[saved login]';
/** Every marker a redactor writes. */
export const MARKERS = [MARKER, SAVED_LOGIN_MARKER];
/** sessionId → { version, values: Set(value), spellings: string[] (longest first) } */
const bySession = new Map();
/** sessionId → Set(listener) notified synchronously when the session gains a value. */
const listeners = new Map();

function fillValues(call) {
  let args = call?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return [];
    }
  }
  if (call?.name !== 'browser' || args?.action !== 'fill') return [];
  const input = args.input && typeof args.input === 'object' ? args.input : args;
  if (input.sensitive !== true) return [];
  const fields = Array.isArray(input.fields) ? input.fields : [];
  return [input.text, ...fields.flatMap((field) => [field?.text, field?.value])].filter(
    (value) => typeof value === 'string' && value.length > 0
  );
}

/** Remembers the sensitive values of execution calls `calls` for `sessionId`
 *  and, when one is new, tells the session's listeners before returning (so
 *  before the call runs). True when the session gained a value. */
export function rememberSensitiveValues(sessionId, calls) {
  const values = (Array.isArray(calls) ? calls : []).flatMap(fillValues);
  if (!sessionId || !values.length) return false;
  const known = bySession.get(sessionId) ?? { version: 0, values: new Set(), spellings: [] };
  const fresh = values.filter((value) => !known.values.has(value));
  if (!fresh.length) return false;
  const spellings = new Set(known.spellings);
  for (const value of fresh) {
    known.values.add(value);
    // As typed, and as a JSON string spells it (an echo may keep arguments as JSON text).
    spellings.add(value).add(JSON.stringify(value).slice(1, -1));
  }
  known.spellings = [...spellings].sort((a, b) => b.length - a.length);
  known.version += 1;
  bySession.set(sessionId, known);
  for (const listener of [...(listeners.get(sessionId) || [])]) {
    try {
      listener(known.version);
    } catch (error) {
      try {
        process.stderr.write(`[sensitive-values] listener failed session=${sessionId}: ${error?.message || error}\n`);
      } catch {
        // stderr may be closed; the listener failure is only reported
      }
    }
  }
  return true;
}

/** Calls `listener` whenever `sessionId` gains a sensitive value; returns the
 *  function that stops it. */
export function onSensitiveValuesMarked(sessionId, listener) {
  if (!sessionId || typeof listener !== 'function') return () => {};
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(sessionId) === set) listeners.delete(sessionId);
  };
}

/** Changes whenever `sessionId` gains a value, so a stored copy made before
 *  is written again in full (store/save-delta.mjs, the turn checkpoint, the
 *  search rows). */
export function sensitiveValuesVersion(sessionId) {
  return bySession.get(sessionId)?.version || 0;
}

/** `text` with `edit` applied to each stretch between markers, the markers
 *  themselves kept as written. */
function editBetweenMarkers(text, edit, next = 0) {
  if (next === MARKERS.length) return edit(text);
  const marker = MARKERS[next];
  return text
    .split(marker)
    .map((part) => editBetweenMarkers(part, edit, next + 1))
    .join(marker);
}

function redactText(text, spellings) {
  let out = text;
  for (const spelling of spellings) {
    if (out.includes(spelling)) out = editBetweenMarkers(out, (plain) => plain.replaceAll(spelling, MARKER));
  }
  return out;
}

/** Text `text` with the session's sensitive values replaced; `text` itself
 *  when none occurs (or it is no string). */
export function redactSensitiveText(sessionId, text) {
  const known = bySession.get(sessionId);
  return known?.spellings.length && typeof text === 'string' ? redactText(text, known.spellings) : text;
}

/** Whether text `text` holds one of the session's sensitive values. */
export function containsSensitive(sessionId, text) {
  const known = bySession.get(sessionId);
  return Boolean(known && typeof text === 'string' && known.spellings.some((spelling) => text.includes(spelling)));
}

/** Text that is still streaming, redacted, without the trailing part that is
 *  the start of a value and may yet complete it: what of `text` can be
 *  journaled now (manager/turn-checkpoint-journal.mjs). */
export function redactSettledText(sessionId, text) {
  const known = bySession.get(sessionId);
  if (!known?.spellings.length || typeof text !== 'string') return text;
  const out = redactText(text, known.spellings);
  // Only the plain text after the last marker can start a value; a marker is never held.
  const plainFrom = Math.max(
    ...MARKERS.map((marker) => {
      const at = out.lastIndexOf(marker);
      return at < 0 ? 0 : at + marker.length;
    })
  );
  const tail = out.slice(plainFrom);
  let held = 0;
  for (const spelling of known.spellings) {
    for (let length = Math.min(spelling.length - 1, tail.length); length > held; length -= 1) {
      if (tail.endsWith(spelling.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held ? out.slice(0, out.length - held) : out;
}
