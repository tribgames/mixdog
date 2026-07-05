/**
 * termio-keypress.js — chunked keypress pipeline built on the termio tokenizer.
 *
 * Ported from claude-code src/ink/parse-keypress.ts (parseMultipleKeypresses +
 * paste IN_PASTE buffering + orphaned mouse-tail resynthesis + terminal-response
 * / SGR-mouse recognition) to plain ESM JS.
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

/**
 * Feed a chunk (or null to flush) through the tokenizer + paste/mouse/response
 * classification. Returns [events, newState]. The tokenizer instance lives on
 * the returned state so incomplete sequences buffer across calls.
 */
export function parseMultipleKeypresses(prevState, input = '') {
  const isFlush = input === null;
  const inputString = isFlush ? '' : typeof input === 'string' ? input : String(input ?? '');

  const tokenizer = prevState._tokenizer ?? createTokenizer({ x10Mouse: true });
  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString);

  const keys = [];
  let inPaste = prevState.mode === 'IN_PASTE';
  let pasteBuffer = prevState.pasteBuffer;

  for (const token of tokens) {
    if (token.type === 'sequence') {
      if (token.value === PASTE_START) {
        inPaste = true;
        pasteBuffer = '';
      } else if (token.value === PASTE_END) {
        // Always emit a paste key, even for empty pastes.
        keys.push(createPasteKey(pasteBuffer));
        inPaste = false;
        pasteBuffer = '';
      } else if (inPaste) {
        // Sequences inside paste are literal text.
        pasteBuffer += token.value;
      } else {
        const response = parseTerminalResponse(token.value);
        if (response) {
          keys.push({ kind: 'response', sequence: token.value, response });
        } else {
          const mouse = parseMouseEvent(token.value);
          keys.push(mouse ?? asKey(token.value));
        }
      }
    } else if (token.type === 'text') {
      if (inPaste) {
        pasteBuffer += token.value;
      } else if (
        /^\[<\d+;\d+;\d+[Mm]$/.test(token.value) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        // Orphaned SGR/X10 mouse tail (fullscreen only). A heavy render blocked
        // the event loop past the pending-ESC flush timer, so the buffered ESC
        // flushed as a lone Escape and the continuation `[<btn;col;rowM` arrived
        // as text. Re-synthesize with the ESC prefix so the scroll/mouse event
        // still fires. X10 Cb slot narrowed to wheel range [\x60-\x7f] so typed
        // input like `[MAX]` batched into one read isn't dropped as a click.
        const resynthesized = '\x1b' + token.value;
        const mouse = parseMouseEvent(resynthesized);
        keys.push(mouse ?? asKey(resynthesized));
      } else {
        // Split 0x7F (DEL) and 0x08 (BS) bytes into individual key events so
        // held-backspace chunks (`\x7f\x7f\x7f`) don't parse as one garbage
        // key. \r and \t are left intact — only backspace bytes are split.
        let run = '';
        for (const ch of token.value) {
          if (ch === '\x7f' || ch === '\x08') {
            if (run) {
              keys.push(asKey(run));
              run = '';
            }
            keys.push(asKey(ch));
          } else {
            run += ch;
          }
        }
        if (run) keys.push(asKey(run));
      }
    }
  }

  if (isFlush && inPaste && pasteBuffer) {
    keys.push(createPasteKey(pasteBuffer));
    inPaste = false;
    pasteBuffer = '';
  }

  const newState = {
    mode: inPaste ? 'IN_PASTE' : 'NORMAL',
    incomplete: tokenizer.buffer(),
    pasteBuffer,
    _tokenizer: tokenizer,
  };

  return [keys, newState];
}
