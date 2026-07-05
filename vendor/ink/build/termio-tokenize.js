/**
 * Input Tokenizer - Escape sequence boundary detection
 *
 * Ported from claude-code src/ink/termio/tokenize.ts (+ ansi.ts / csi.ts
 * byte-range helpers) to plain ESM JS. Splits terminal input into tokens:
 * text chunks and raw escape sequences. Unlike a semantic parser this just
 * identifies boundaries for keyboard input parsing.
 *
 * Token shape: { type: 'text' | 'sequence', value: string }
 */

// C0 control chars we care about.
const C0 = { BEL: 0x07, ESC: 0x1b };

// Byte after ESC selecting the sequence type.
const ESC_TYPE = {
  CSI: 0x5b, // [
  OSC: 0x5d, // ]
  DCS: 0x50, // P
  APC: 0x5f, // _
  ST: 0x5c, // \
};

// ESC sequences have a wider final-byte range than CSI (0-9,:,;,<,=,>,?,@..~)
const isEscFinal = (byte) => byte >= 0x30 && byte <= 0x7e;
const isCSIParam = (byte) => byte >= 0x30 && byte <= 0x3f;
const isCSIIntermediate = (byte) => byte >= 0x20 && byte <= 0x2f;
const isCSIFinal = (byte) => byte >= 0x40 && byte <= 0x7e;

/**
 * Create a streaming tokenizer for terminal input.
 *
 * options.x10Mouse: treat `CSI M` as an X10 mouse event prefix and consume 3
 * payload bytes. Only enable for stdin — `\x1b[M` is also CSI DL (Delete
 * Lines) in output streams. Default false.
 */
export function createTokenizer(options) {
  let currentState = 'ground';
  let currentBuffer = '';
  const x10Mouse = options?.x10Mouse ?? false;

  return {
    feed(input) {
      const result = tokenize(input, currentState, currentBuffer, false, x10Mouse);
      currentState = result.state.state;
      currentBuffer = result.state.buffer;
      return result.tokens;
    },
    flush() {
      const result = tokenize('', currentState, currentBuffer, true, x10Mouse);
      currentState = result.state.state;
      currentBuffer = result.state.buffer;
      return result.tokens;
    },
    reset() {
      currentState = 'ground';
      currentBuffer = '';
    },
    buffer() {
      return currentBuffer;
    },
  };
}

function tokenize(input, initialState, initialBuffer, flush, x10Mouse) {
  const tokens = [];
  const result = { state: initialState, buffer: '' };

  const data = initialBuffer + input;
  let i = 0;
  let textStart = 0;
  let seqStart = 0;

  const flushText = () => {
    if (i > textStart) {
      const text = data.slice(textStart, i);
      if (text) tokens.push({ type: 'text', value: text });
    }
    textStart = i;
  };

  const emitSequence = (seq) => {
    if (seq) tokens.push({ type: 'sequence', value: seq });
    result.state = 'ground';
    textStart = i;
  };

  while (i < data.length) {
    const code = data.charCodeAt(i);

    switch (result.state) {
      case 'ground':
        if (code === C0.ESC) {
          flushText();
          seqStart = i;
          result.state = 'escape';
          i++;
        } else {
          i++;
        }
        break;

      case 'escape':
        if (code === ESC_TYPE.CSI) {
          result.state = 'csi';
          i++;
        } else if (code === ESC_TYPE.OSC) {
          result.state = 'osc';
          i++;
        } else if (code === ESC_TYPE.DCS) {
          result.state = 'dcs';
          i++;
        } else if (code === ESC_TYPE.APC) {
          result.state = 'apc';
          i++;
        } else if (code === 0x4f) {
          // 'O' - SS3
          result.state = 'ss3';
          i++;
        } else if (isCSIIntermediate(code)) {
          // Intermediate byte (e.g., ESC ( for charset) - continue buffering
          result.state = 'escapeIntermediate';
          i++;
        } else if (isEscFinal(code)) {
          // Two-character escape sequence
          i++;
          emitSequence(data.slice(seqStart, i));
        } else if (code === C0.ESC) {
          // Double escape - emit first, start new
          emitSequence(data.slice(seqStart, i));
          seqStart = i;
          result.state = 'escape';
          i++;
        } else {
          // Invalid - treat ESC as text
          result.state = 'ground';
          textStart = seqStart;
        }
        break;

      case 'escapeIntermediate':
        if (isCSIIntermediate(code)) {
          i++;
        } else if (isEscFinal(code)) {
          i++;
          emitSequence(data.slice(seqStart, i));
        } else {
          result.state = 'ground';
          textStart = seqStart;
        }
        break;

      case 'csi':
        // X10 mouse: CSI M + 3 raw payload bytes (Cb+32, Cx+32, Cy+32).
        // M immediately after [ (offset 2) means no params — SGR mouse
        // (CSI < … M) has a `<` param byte first and reaches M at offset > 2.
        // Terminals that ignore DECSET 1006 but honor 1000/1002 emit this
        // legacy encoding; without this branch the 3 payload bytes leak
        // through as text. Gated on x10Mouse — `\x1b[M` is also CSI DL and
        // blindly consuming 3 chars corrupts output. The >=0x20 check on each
        // payload slot is belt-and-suspenders: X10 guarantees Cb>=32, so a
        // control byte (ESC) in any slot means this is CSI DL / adjacent
        // PASTE_END, not a mouse event.
        if (
          x10Mouse &&
          code === 0x4d /* M */ &&
          i - seqStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            i += 4;
            emitSequence(data.slice(seqStart, i));
          } else {
            // Incomplete — exit loop; end-of-input buffers from seqStart.
            i = data.length;
          }
          break;
        }
        if (isCSIFinal(code)) {
          i++;
          emitSequence(data.slice(seqStart, i));
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i++;
        } else {
          // Invalid CSI - abort, treat as text
          result.state = 'ground';
          textStart = seqStart;
        }
        break;

      case 'ss3':
        if (code >= 0x40 && code <= 0x7e) {
          i++;
          emitSequence(data.slice(seqStart, i));
        } else {
          result.state = 'ground';
          textStart = seqStart;
        }
        break;

      case 'osc':
        if (code === C0.BEL) {
          i++;
          emitSequence(data.slice(seqStart, i));
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2;
          emitSequence(data.slice(seqStart, i));
        } else {
          i++;
        }
        break;

      case 'dcs':
      case 'apc':
        if (code === C0.BEL) {
          i++;
          emitSequence(data.slice(seqStart, i));
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2;
          emitSequence(data.slice(seqStart, i));
        } else {
          i++;
        }
        break;
    }
  }

  if (result.state === 'ground') {
    flushText();
  } else if (flush) {
    const remaining = data.slice(seqStart);
    if (remaining) tokens.push({ type: 'sequence', value: remaining });
    result.state = 'ground';
  } else {
    result.buffer = data.slice(seqStart);
  }

  return { tokens, state: result };
}

// Bracketed paste markers (DEC mode 2004).
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
