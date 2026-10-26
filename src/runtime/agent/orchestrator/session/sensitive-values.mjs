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
// A marker is opaque to every redaction (the one written here, and the one the
// desktop writes for a saved login, which reaches the transcript in replies):
// a value is matched whole against the text and replaced unless that
// occurrence lies entirely inside markers already there, so redacting twice
// is redacting once and a value such as `e` never rewrites a marker's letters,
// while a value that contains or spans marker text is still replaced.
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

/** [start, end) of every marker in `text`, in order. */
function markerSpans(text) {
  const spans = [];
  for (const marker of MARKERS) {
    for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
      spans.push([at, at + marker.length]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** `text` with each occurrence of `spelling` replaced by MARKER, except one
 *  lying entirely inside markers. An occurrence that partly overlaps a marker
 *  replaces that marker whole, so no marker is left broken. */
function redactSpelling(text, spelling) {
  const spans = markerSpans(text);
  let next = '';
  let copied = 0;
  for (let at = text.indexOf(spelling); at >= 0; ) {
    const end = at + spelling.length;
    const touched = spans.filter(([from, to]) => from < end && at < to);
    let reach = at;
    for (const [from, to] of touched) {
      if (from > reach) break;
      reach = Math.max(reach, to);
    }
    if (reach >= end) {
      at = text.indexOf(spelling, at + 1);
      continue;
    }
    const from = Math.min(at, touched[0]?.[0] ?? at);
    const to = Math.max(end, touched.at(-1)?.[1] ?? end);
    next += text.slice(copied, from) + MARKER;
    copied = to;
    at = text.indexOf(spelling, to);
  }
  return next + text.slice(copied);
}

/** `text` with every spelling (longest first) replaced by MARKER, passes
 *  repeated until no spelling occurs outside the markers: a replacement can
 *  join a spelling that holds marker text (`a[redacted]`) to the text before
 *  it, so one pass is not enough. The repetition ends without a bound: every
 *  replacement covers at least one character outside the markers and takes in
 *  whole every marker it touches (writing one marker, which adds no character
 *  outside), so each replacement lowers the number of characters outside the
 *  markers and a pass that changes nothing comes after at most that many.
 *  The result is stable: redacting it again changes nothing, and a later,
 *  shorter spelling cannot match inside a marker an earlier one wrote. */
function redactText(text, spellings) {
  let out = text;
  let before;
  do {
    before = out;
    for (const spelling of spellings) out = redactSpelling(out, spelling);
  } while (out !== before);
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

/** Where the longest tail of `text` that is a proper prefix of one of
 *  `strings` starts; the end of `text` when there is none. */
function pendingStart(text, strings) {
  let start = text.length;
  for (const string of strings) {
    for (let length = Math.min(string.length - 1, text.length); length > text.length - start; length -= 1) {
      if (text.endsWith(string.slice(0, length))) {
        start = text.length - length;
        break;
      }
    }
  }
  return start;
}

/** `start`, moved left to the start of every one of `strings` that lies
 *  across it, until none does. */
function coverStart(text, start, strings) {
  for (let moved = true; moved; ) {
    moved = false;
    for (const string of strings) {
      for (let at = text.indexOf(string); at >= 0 && at < start; at = text.indexOf(string, at + 1)) {
        if (start < at + string.length) {
          start = at;
          moved = true;
        }
      }
    }
  }
  return start;
}

/** How much of the redacted text `out` no later text can change: the start of
 *  the held part, `out.length` when nothing is held. Held is every part that
 *  may still be taken into a replacement:
 *   - the tail that starts a value (or a marker) and may yet complete it;
 *   - the marker such a tail starts inside, which a replacement takes in whole;
 *   - the text before the held part that would join it, once it is replaced by
 *     a marker, into a value holding marker text, as `a` before the held part
 *     does for `a[redacted]`; this repeats, as the joined part is held too. */
function settledEnd(out, spellings) {
  const spans = markerSpans(out);
  const longest = spellings[0].length;
  let end = pendingStart(out, [...spellings, ...MARKERS]);
  for (let moved = true; moved; ) {
    moved = false;
    const marker = spans.find(([start, stop]) => start < end && end < stop);
    if (marker) {
      end = marker[0];
      moved = true;
    }
    for (let start = Math.max(0, end - longest + 1); start < end; start += 1) {
      const part = out.slice(start, end);
      const joins = (spelling) =>
        spelling.length > part.length &&
        MARKERS.some((m) => spelling.startsWith(part + m) || (part + m).startsWith(spelling));
      if (spellings.some(joins)) {
        end = start;
        moved = true;
        break;
      }
    }
  }
  return end;
}

/** Text that is still streaming, redacted, without the part that later text
 *  can still change: what of `text` can be journaled now
 *  (manager/turn-checkpoint-journal.mjs). As the text grows each result starts
 *  the next, and none shows what the finished text's redaction hides. The tail
 *  of `text` that starts a value or a marker is cut off before redacting (a
 *  replacement inside a half-written marker is undone when it is completed),
 *  with every value or marker lying across the cut; settledEnd then holds
 *  back what of the redacted rest a replacement can still reach. */
export function redactSettledText(sessionId, text) {
  const known = bySession.get(sessionId);
  if (!known?.spellings.length || typeof text !== 'string') return text;
  const pending = [...known.spellings, ...MARKERS];
  const out = redactText(text.slice(0, coverStart(text, pendingStart(text, pending), pending)), known.spellings);
  return out.slice(0, settledEnd(out, known.spellings));
}
