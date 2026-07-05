/**
 * src/tui/keyboard-protocol.mjs — terminal extended-keys capability gate.
 *
 * We do NOT query the terminal. Instead, we enable the
 * kitty keyboard protocol AND xterm modifyOtherKeys SYNCHRONOUSLY at the moment
 * raw mode turns on (see App.jsx's mount effect), gated by the allowlist below.
 * Writing both enables unconditionally is safe — a terminal honors whichever it
 * implements (Windows Terminal 1.24 has no kitty support but DOES honor
 * modifyOtherKeys), and doing it before the first keypair is read removes the
 * round-trip race that made the first Ctrl+Enter submit instead of inserting a
 * newline.
 *
 * Enable / disable byte sequences (used by App.jsx enable + index.jsx teardown):
 *   ENABLE_KITTY_KEYBOARD     \x1b[>1u    push kitty flags=1 (disambiguate)
 *   ENABLE_MODIFY_OTHER_KEYS  \x1b[>4;2m  xterm modifyOtherKeys level 2
 *   POP_KITTY                 \x1b[<u     pop the kitty stack entry
 *   DISABLE_MODIFY_OTHER_KEYS \x1b[>4;0m  modifyOtherKeys off
 */
export const ENABLE_KITTY_KEYBOARD = '\x1b[>1u';
export const ENABLE_MODIFY_OTHER_KEYS = '\x1b[>4;2m';
export const POP_KITTY = '\x1b[<u';
export const DISABLE_MODIFY_OTHER_KEYS = '\x1b[>4;0m';

// Allowlist of terminals known to honor kitty and/or xterm modifyOtherKeys.
// VS Code's xterm.js
// integrated terminal mishandles these sequences, so it is excluded first.
// Honors the MIXDOG_TUI_EXTENDED_KEYS opt-out (=0) / override (=1).
export function supportsExtendedKeys() {
  const raw = String(process.env.MIXDOG_TUI_EXTENDED_KEYS ?? '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (process.env.TERM_PROGRAM === 'vscode') return false;
  if (process.env.WT_SESSION) return true; // Windows Terminal
  if (process.env.TERM?.includes('kitty')) return true;
  if (process.env.KITTY_WINDOW_ID) return true;
  if (process.env.TERM_PROGRAM === 'WezTerm') return true;
  if (process.env.TERM_PROGRAM === 'ghostty') return true;
  if (process.env.TERM === 'xterm-ghostty') return true;
  if (process.env.TMUX) return true;
  if (process.env.TERM_PROGRAM === 'iTerm.app') return true;
  return false;
}
