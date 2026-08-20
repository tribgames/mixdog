/**
 * termio-keypress.js — chunked keypress pipeline built on the termio tokenizer.
 *
 * Tokens arrive as text runs and raw escape sequences; this layer decides what
 * each one MEANS: bracketed-paste accumulation, terminal-response replies,
 * SGR/X10 mouse events, orphaned mouse tails, and ordinary keypresses.
 *
 * It emits a flat list of typed events:
 *   { kind: 'key',      sequence, isPasted, ... }  normal keypress or paste
 *   { kind: 'mouse',    button, action, col, row, sequence }  SGR click/drag
 *   { kind: 'response', sequence, response }  terminal query reply
 *
 * Single-sequence keypress decoding is delegated to the existing kitty-aware
 * parseKeypress (parse-keypress.js) so kitty/modifyOtherKeys handling is shared.
 */
import { createTokenizer, PASTE_START, PASTE_END } from './termio-tokenize.js';
import parseKeypress from './parse-keypress.js';

// SGR mouse event: CSI < button ; col ; row M (press) or m (release).
// Button bit 0x40 = wheel, bit 0x20 = drag/motion.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

// Wheel button classification shared by SGR + X10 decoding. Button bit 0x40 =
// wheel; low bit selects direction (0=up, 1=down). Mask 0x43 checks wheel-flag
// + direction while ignoring modifier bits so modified wheel events still
// classify. The vendored parse-keypress.js (enquirer-based) has NO mouse
// branches, so wheel naming lives here.
function wheelName(s) {
  let button;
  const m = SGR_MOUSE_RE.exec(s);
  if (m) {
    button = parseInt(m[1], 10);
  } else if (s.length === 6 && s.startsWith('\x1b[M')) {
    // X10: CSI M + 3 bytes (Cb+32, Cx+32, Cy+32).
    button = s.charCodeAt(3) - 32;
  } else {
    return null;
  }
  if ((button & 0x43) === 0x40) return 'wheelup';
  if ((button & 0x43) === 0x41) return 'wheeldown';
  return null;
}

// -- Terminal response patterns (inbound sequences from the terminal itself) --
// eslint-disable-next-line no-control-regex
const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/;
// eslint-disable-next-line no-control-regex
const DA1_RE = /^\x1b\[\?([\d;]*)c$/;
// eslint-disable-next-line no-control-regex
const DA2_RE = /^\x1b\[>([\d;]*)c$/;
// eslint-disable-next-line no-control-regex
const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/;
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/;
// eslint-disable-next-line no-control-regex
const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s;
// eslint-disable-next-line no-control-regex
const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s;

/** DECRPM status values (response to DECRQM). */
export const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
};

function splitNumericParams(params) {
  if (!params) return [];
  return params.split(';').map((p) => parseInt(p, 10));
}

/**
 * Recognize a sequence token as a terminal response, or null if it should be
 * treated as a keypress. These patterns are syntactically distinguishable from
 * keyboard input (no physical key produces CSI ? ... c etc.).
 */
function parseTerminalResponse(s) {
  if (s.startsWith('\x1b[')) {
    let m;
    if ((m = DECRPM_RE.exec(s))) {
      return { type: 'decrpm', mode: parseInt(m[1], 10), status: parseInt(m[2], 10) };
    }
    if ((m = DA1_RE.exec(s))) return { type: 'da1', params: splitNumericParams(m[1]) };
    if ((m = DA2_RE.exec(s))) return { type: 'da2', params: splitNumericParams(m[1]) };
    if ((m = KITTY_FLAGS_RE.exec(s))) return { type: 'kittyKeyboard', flags: parseInt(m[1], 10) };
    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return { type: 'cursorPosition', row: parseInt(m[1], 10), col: parseInt(m[2], 10) };
    }
    return null;
  }
  if (s.startsWith('\x1b]')) {
    const m = OSC_RESPONSE_RE.exec(s);
    if (m) return { type: 'osc', code: parseInt(m[1], 10), data: m[2] };
  }
  if (s.startsWith('\x1bP')) {
    const m = XTVERSION_RE.exec(s);
    if (m) return { type: 'xtversion', name: m[1] };
  }
  return null;
}

/**
 * Parse an SGR mouse sequence into a ParsedMouse, or null if not a mouse event
 * or if it's a wheel event (wheel stays a keypress for scroll routing).
 */
function parseMouseEvent(s) {
  const match = SGR_MOUSE_RE.exec(s);
  if (!match) return null;
  const button = parseInt(match[1], 10);
  // Wheel events (bit 6 set) stay as keys so the scroll path can route them.
  if ((button & 0x40) !== 0) return null;
  return {
    kind: 'mouse',
    button,
    action: match[4] === 'M' ? 'press' : 'release',
    col: parseInt(match[2], 10),
    row: parseInt(match[3], 10),
    sequence: s,
  };
}

function createPasteKey(content) {
  const key = parseKeypress('');
  key.kind = 'key';
  key.sequence = content;
  key.raw = content;
  key.isPasted = true;
  return key;
}

function asKey(s) {
  const key = parseKeypress(s);
  key.kind = 'key';
  if (key.isPasted === undefined) key.isPasted = false;
  // Vendored parse-keypress.js has no mouse branches; classify wheel here so
  // App.js can route wheel keys to the 'mouse' channel.
  const wheel = wheelName(s);
  if (wheel) key.name = wheel;
  return key;
}

export const INITIAL_STATE = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
};

// An orphaned mouse tail: the ESC was flushed on its own as a lone Escape (a
// heavy render blocked the event loop past the pending-ESC timer), so the
// continuation reached us as plain text. The X10 Cb slot is narrowed to the
// wheel range so ordinary typing like `[MAX]` batched into one read is not
// mistaken for a click.
// eslint-disable-next-line no-control-regex
const ORPHAN_SGR_TAIL_RE = /^\[<\d+;\d+;\d+[Mm]$/;
// eslint-disable-next-line no-control-regex
const ORPHAN_X10_TAIL_RE = /^\[M[\x60-\x7f][\x20-\uffff]{2}$/;

/** A non-paste sequence token becomes a response, a mouse event, or a key. */
function eventForSequence(sequence) {
  const response = parseTerminalResponse(sequence);
  if (response) return { kind: 'response', sequence, response };
  return parseMouseEvent(sequence) ?? asKey(sequence);
}

/** Restore the ESC an orphaned mouse tail lost, or null when it is real text. */
function eventForOrphanTail(text) {
  if (!ORPHAN_SGR_TAIL_RE.test(text) && !ORPHAN_X10_TAIL_RE.test(text)) return null;
  const restored = `\x1b${text}`;
  return parseMouseEvent(restored) ?? asKey(restored);
}

/**
 * Cut a text run at every DEL/BS byte. A held backspace arrives as one chunk
 * (`\x7f\x7f\x7f`) and must land as three key events, not one garbage key.
 * Carriage returns and tabs stay inside their run.
 */
function splitEditingBytes(text) {
  const pieces = [];
  let run = '';
  for (const character of text) {
    if (character !== '\x7f' && character !== '\x08') {
      run += character;
      continue;
    }
    if (run) pieces.push(run);
    pieces.push(character);
    run = '';
  }
  if (run) pieces.push(run);
  return pieces;
}

/** Bracketed-paste accumulator: everything between the markers is literal. */
function pasteAccumulator(open, buffer) {
  return {
    open,
    buffer,
    start() {
      this.open = true;
      this.buffer = '';
    },
    absorb(text) {
      this.buffer += text;
    },
    take() {
      const content = this.buffer;
      this.open = false;
      this.buffer = '';
      return content;
    },
  };
}

function asInputString(input) {
  if (typeof input === 'string') return input;
  return String(input ?? '');
}

/**
 * Feed a chunk (or null to flush) through the tokenizer and turn the resulting
 * tokens into typed events. Returns [events, newState]; the tokenizer instance
 * rides on the returned state so incomplete sequences buffer across calls.
 */
export function parseMultipleKeypresses(prevState, input = '') {
  const flushing = input === null;
  const tokenizer = prevState._tokenizer ?? createTokenizer({ x10Mouse: true });
  const tokens = flushing ? tokenizer.flush() : tokenizer.feed(asInputString(input));

  const events = [];
  const paste = pasteAccumulator(prevState.mode === 'IN_PASTE', prevState.pasteBuffer);

  for (const token of tokens) {
    const isText = token.type === 'text';
    if (!isText && token.value === PASTE_START) {
      paste.start();
      continue;
    }
    if (!isText && token.value === PASTE_END) {
      // An empty paste still emits a key so callers can react to it.
      events.push(createPasteKey(paste.take()));
      continue;
    }
    if (paste.open) {
      paste.absorb(token.value);
      continue;
    }
    if (!isText) {
      events.push(eventForSequence(token.value));
      continue;
    }
    const orphan = eventForOrphanTail(token.value);
    if (orphan) {
      events.push(orphan);
      continue;
    }
    for (const piece of splitEditingBytes(token.value)) events.push(asKey(piece));
  }

  // A paste left open at end-of-stream is delivered rather than dropped.
  if (flushing && paste.open && paste.buffer) events.push(createPasteKey(paste.take()));

  return [events, {
    mode: paste.open ? 'IN_PASTE' : 'NORMAL',
    incomplete: tokenizer.buffer(),
    pasteBuffer: paste.buffer,
    _tokenizer: tokenizer,
  }];
}
