/**
 * termio-tokenize.js — terminal input split into text runs and raw escape
 * sequences, per the ECMA-48 control-function shapes.
 *
 * This is a BOUNDARY scanner, not a semantic parser: it answers only "where
 * does this escape sequence end", leaving interpretation to the keypress
 * layer. Each ESC found in the stream is handed to a family scanner that
 * either reports the end offset, reports that the stream ran out mid-sequence
 * (so the tail is carried into the next feed), or rejects the sequence — in
 * which case the ESC and everything scanned after it degrade to plain text,
 * exactly as a terminal would display them.
 *
 * Token shape: { type: 'text' | 'sequence', value: string }
 */

const ESC = 0x1b;
const BEL = 0x07;

// Byte directly after ESC that opens a multi-byte family.
const OPEN_CSI = 0x5b; // [
const OPEN_OSC = 0x5d; // ]
const OPEN_DCS = 0x50; // P
const OPEN_APC = 0x5f; // _
const OPEN_SS3 = 0x4f; // O
const STRING_TERMINATOR = 0x5c; // \  (as ESC \)
const X10_MOUSE_FINAL = 0x4d; // M

const within = (code, low, high) => code >= low && code <= high;
// ECMA-48 byte classes. An ESC-introduced sequence accepts a wider final range
// than a CSI body does, which is why the two predicates differ.
const isParameter = (code) => within(code, 0x30, 0x3f);
const isIntermediate = (code) => within(code, 0x20, 0x2f);
const isControlFinal = (code) => within(code, 0x40, 0x7e);
const isEscapeFinal = (code) => within(code, 0x30, 0x7e);

const COMPLETE = (end) => ({ kind: 'complete', end });
const PENDING = { kind: 'pending' };
const LITERAL = (resume) => ({ kind: 'literal', resume });

/**
 * X10 mouse payload plausibility. The legacy encoding puts three bytes after
 * `CSI M`, each biased by 32, so every present slot must be >= 0x20. A control
 * byte in any slot means this `M` really is CSI DL (Delete Lines) or the head
 * of an adjacent sequence, and consuming three bytes would corrupt the stream.
 * Absent slots pass: the decision is revisited once more input arrives.
 */
function x10PayloadPlausible(data, at) {
  for (let slot = 1; slot <= 3; slot += 1) {
    const index = at + slot;
    if (index < data.length && data.charCodeAt(index) < 0x20) return false;
  }
  return true;
}

/** OSC / DCS / APC: opaque payload closed by BEL or ESC \. */
function scanStringFamily(data, from) {
  for (let at = from; at < data.length; at += 1) {
    const code = data.charCodeAt(at);
    if (code === BEL) return COMPLETE(at + 1);
    const terminated = code === ESC
      && at + 1 < data.length
      && data.charCodeAt(at + 1) === STRING_TERMINATOR;
    if (terminated) return COMPLETE(at + 2);
  }
  return PENDING;
}

/** CSI: parameter and intermediate bytes, closed by one final byte. */
function scanControlSequence(data, start, x10Mouse) {
  const body = start + 2;
  for (let at = body; at < data.length; at += 1) {
    const code = data.charCodeAt(at);
    // `CSI M` with nothing in between is the X10 mouse prefix; SGR mouse
    // (`CSI < … M`) carries parameters and so reaches its M further along.
    if (x10Mouse && code === X10_MOUSE_FINAL && at === body && x10PayloadPlausible(data, at)) {
      return at + 4 <= data.length ? COMPLETE(at + 4) : PENDING;
    }
    if (isControlFinal(code)) return COMPLETE(at + 1);
    if (isParameter(code) || isIntermediate(code)) continue;
    return LITERAL(at);
  }
  return PENDING;
}

/** ESC + intermediates (charset designators and friends) + one final byte. */
function scanIntermediateEscape(data, from) {
  for (let at = from; at < data.length; at += 1) {
    const code = data.charCodeAt(at);
    if (isIntermediate(code)) continue;
    if (isEscapeFinal(code)) return COMPLETE(at + 1);
    return LITERAL(at);
  }
  return PENDING;
}

/** Dispatch on the byte following ESC at `start`. */
function scanEscape(data, start, x10Mouse) {
  const head = start + 1;
  if (head >= data.length) return PENDING;
  const code = data.charCodeAt(head);
  if (code === OPEN_CSI) return scanControlSequence(data, start, x10Mouse);
  if (code === OPEN_OSC || code === OPEN_DCS || code === OPEN_APC) {
    return scanStringFamily(data, head + 1);
  }
  if (code === OPEN_SS3) {
    if (head + 1 >= data.length) return PENDING;
    return isControlFinal(data.charCodeAt(head + 1)) ? COMPLETE(head + 2) : LITERAL(head + 1);
  }
  if (isIntermediate(code)) return scanIntermediateEscape(data, head + 1);
  if (isEscapeFinal(code)) return COMPLETE(head + 1);
  // ESC ESC: the first one stands alone so the second can open a fresh scan.
  if (code === ESC) return COMPLETE(head);
  return LITERAL(head);
}

function tokenize(input, carry, flush, x10Mouse) {
  const data = carry + input;
  const tokens = [];
  let textStart = 0;
  let cursor = 0;
  let pendingAt = -1;

  const emitText = (to) => {
    if (to <= textStart) return;
    const value = data.slice(textStart, to);
    if (value) tokens.push({ type: 'text', value });
  };

  while (cursor < data.length) {
    if (data.charCodeAt(cursor) !== ESC) {
      cursor += 1;
      continue;
    }
    // Text accumulated so far closes here whether or not the sequence pans out;
    // a rejected sequence simply opens the NEXT text run at this same ESC.
    emitText(cursor);
    const scan = scanEscape(data, cursor, x10Mouse);
    if (scan.kind === 'complete') {
      tokens.push({ type: 'sequence', value: data.slice(cursor, scan.end) });
      cursor = scan.end;
      textStart = cursor;
      continue;
    }
    if (scan.kind === 'pending') {
      pendingAt = cursor;
      break;
    }
    textStart = cursor;
    cursor = scan.resume;
  }

  if (pendingAt < 0) {
    emitText(data.length);
    return { tokens, buffer: '' };
  }
  if (!flush) return { tokens, buffer: data.slice(pendingAt) };
  const tail = data.slice(pendingAt);
  if (tail) tokens.push({ type: 'sequence', value: tail });
  return { tokens, buffer: '' };
}

/**
 * Streaming tokenizer. The only state carried between calls is the unfinished
 * sequence text; a scan always restarts from its leading ESC, so re-reading the
 * carry reproduces the position the previous call stopped at.
 *
 * options.x10Mouse: treat `CSI M` as an X10 mouse prefix and consume 3 payload
 * bytes. Enable for stdin only — `\x1b[M` is CSI DL in an output stream.
 */
export function createTokenizer(options) {
  const x10Mouse = options?.x10Mouse ?? false;
  let carry = '';
  const run = (input, flush) => {
    const result = tokenize(input, carry, flush, x10Mouse);
    carry = result.buffer;
    return result.tokens;
  };
  return {
    feed: (input) => run(input, false),
    flush: () => run('', true),
    reset: () => { carry = ''; },
    buffer: () => carry,
  };
}

// Bracketed paste markers (DEC mode 2004).
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
