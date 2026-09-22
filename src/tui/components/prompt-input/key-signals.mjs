/**
 * components/prompt-input/key-signals.mjs — raw terminal byte classification
 * for the prompt editor (no React).
 *
 * One responsibility: turn ink's (input, key) pair into the arrow/modifier
 * signals the key dispatch branches on, and recognize the byte sequences that
 * are terminal reports rather than text. Ink's useInput does not decode the
 * `;2` (shift) or `;6` (ctrl+shift) modifier for arrows, so those chords
 * arrive as raw bytes and are matched here instead.
 */

// Drop SGR mouse-tracking sequences (wheel/click). When app mouse tracking is
// explicitly enabled, App parses these off raw stdin itself; ink still
// forwards the bytes to useInput as "input", which would otherwise type
// garbage like `[<64;55;22M` into the prompt. Match with or without the
// leading ESC (terminals/ink may strip it): CSI '<' … final 'M'/'m'.
export function isMouseReportSequence(rawInput) {
  return /(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(rawInput) || /^\[?<\d+;\d+;\d+[Mm]?$/.test(rawInput);
}

// Safety net: CSI-private replies/fragments like \x1b[?<n>u / \x1b[?...c
// (escape may be stripped → `[?7u` / `[?1;0c`). We no longer query the
// terminal (enables are written unconditionally at raw-mode-on), so these
// should not normally appear — but a terminal that volunteers such a report
// must never type it into the prompt. The required `?` after `[` means this
// never matches a real kitty KEY event (those are \x1b[<codepoint>;<mods>u,
// no `?`); the optional final byte also discards any partial fragment.
export function isCsiPrivateReply(rawInput) {
  return /^(?:\x1b)?\[\?[\d;]*[uc]?$/.test(rawInput);
}

// Swallow Ctrl+Space raw encodings (lone NUL, or the kitty CSI-u form
// \x1b[32;5u) as a no-op so they never fall through into the prompt as
// garbage. No voice behavior — just discarded.
export function isDiscardedControlInput(rawInput) {
  return rawInput === '\x00' || /^(?:\x1b)?\[32;5u$/.test(rawInput);
}

// Printable input. Strip any embedded SGR mouse sequences as a
// belt-and-suspenders guard (isMouseReportSequence catches whole-sequence
// inputs; this removes partials that rode in with real text).
export function printableFromInput(rawInput) {
  return rawInput.replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, '').replace(/[\r\n]/g, '');
}

export function decodeArrowSignals(rawInput, key) {
  const rawShiftArrowForGrid =
    rawInput === '\x1b[1;2A' ||
    rawInput === '\x1b[a' ||
    rawInput === '[1;2A' ||
    rawInput === '\x1b[1;2B' ||
    rawInput === '\x1b[b' ||
    rawInput === '[1;2B' ||
    rawInput === '\x1b[1;2C' ||
    rawInput === '\x1b[c' ||
    rawInput === '[1;2C' ||
    rawInput === '\x1b[1;2D' ||
    rawInput === '\x1b[d' ||
    rawInput === '[1;2D' ||
    rawInput === '\x1b[1;6A' ||
    rawInput === '[1;6A' ||
    rawInput === '\x1b[1;6B' ||
    rawInput === '[1;6B' ||
    rawInput === '\x1b[1;6C' ||
    rawInput === '[1;6C' ||
    rawInput === '\x1b[1;6D' ||
    rawInput === '[1;6D';
  const rawUpArrow = rawInput === '\x1b[A' || rawInput === '\x1bOA' || rawInput === '[A' || rawInput === 'OA';
  const rawDownArrow = rawInput === '\x1b[B' || rawInput === '\x1bOB' || rawInput === '[B' || rawInput === 'OB';
  // Shift+Arrow modifier sequences (xterm `\x1b[1;2<dir>`, rxvt `\x1b[<dir>`
  // lowercase). Ink's useInput does not decode the `;2` (shift) modifier into
  // key.shift for arrows, so the bytes arrive as raw input and the plain-arrow
  // matchers above miss them — selection-extend never fires. Detect them here
  // and fold into a single `shiftHeld` signal used by every arrow/home/end
  // branch (alongside ink's key.shift for terminals that DO decode it).
  const rawShiftUp = rawInput === '\x1b[1;2A' || rawInput === '\x1b[a' || rawInput === '[1;2A';
  const rawShiftDown = rawInput === '\x1b[1;2B' || rawInput === '\x1b[b' || rawInput === '[1;2B';
  const rawShiftRight = rawInput === '\x1b[1;2C' || rawInput === '\x1b[c' || rawInput === '[1;2C';
  const rawShiftLeft = rawInput === '\x1b[1;2D' || rawInput === '\x1b[d' || rawInput === '[1;2D';
  // Ctrl+Shift+Arrow modifier sequences: xterm mod=6 (1 + shift(1) + ctrl(4))
  // arrives as `\x1b[1;6<dir>`; kitty keyboard protocol reports the same chord
  // as `\x1b[<code>;6<dir>` (also mod=6). Ink decodes neither the `;6` for
  // arrows, so the bytes arrive raw. Fold into a ctrlShiftHeld signal used to
  // drive whole-word selection-extend. `\x1b[1;6<dir>` covers both the
  // classic xterm form and kitty's default (which emits the legacy arrow form
  // with the CSI-u modifier param for arrow keys).
  const rawCtrlShiftUp = rawInput === '\x1b[1;6A' || rawInput === '[1;6A';
  const rawCtrlShiftDown = rawInput === '\x1b[1;6B' || rawInput === '[1;6B';
  const rawCtrlShiftRight = rawInput === '\x1b[1;6C' || rawInput === '[1;6C';
  const rawCtrlShiftLeft = rawInput === '\x1b[1;6D' || rawInput === '[1;6D';
  const ctrlShiftHeld =
    rawCtrlShiftUp ||
    rawCtrlShiftDown ||
    rawCtrlShiftLeft ||
    rawCtrlShiftRight ||
    (key.shift && key.ctrl && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow));
  const shiftHeld =
    key.shift ||
    rawShiftUp ||
    rawShiftDown ||
    rawShiftLeft ||
    rawShiftRight ||
    rawCtrlShiftUp ||
    rawCtrlShiftDown ||
    rawCtrlShiftLeft ||
    rawCtrlShiftRight;
  return {
    ctrlShiftHeld,
    rawCtrlShiftDown,
    rawCtrlShiftLeft,
    rawCtrlShiftRight,
    rawCtrlShiftUp,
    rawDownArrow,
    rawShiftArrowForGrid,
    rawShiftDown,
    rawShiftLeft,
    rawShiftRight,
    rawShiftUp,
    rawUpArrow,
    shiftHeld,
  };
}
