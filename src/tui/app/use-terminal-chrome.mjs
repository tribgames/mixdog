// Terminal chrome, extracted from App.jsx: the debounced resize listener
// (leading-edge + trailing settle, no-op on unchanged dimensions) and the
// one-shot extended-keyboard enable (kitty + modifyOtherKeys).
import { useEffect } from 'react';
import { terminalSize } from './app-format.mjs';
import { supportsExtendedKeys, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS } from '../keyboard-protocol.mjs';

export function useTerminalChrome({ stdout, isRawModeSupported, setResizeState }) {
  useEffect(() => {
    if (!stdout) return undefined;
    let trailing = null;
    // Leading-edge fire on the first event of a burst, then coalesce the rest:
    // events arriving within DEBOUNCE_MS skip the immediate full-layout update
    // and only refresh the (reset) trailing timer, so a resize storm commits at
    // most once per window plus one settle update instead of once per event.
    const DEBOUNCE_MS = 80;
    let lastRun = 0;
    const update = () => {
      setResizeState((prev) => {
        const next = terminalSize(stdout);
        // No-op when dimensions are unchanged: the unconditional post-mount
        // update() otherwise forces an extra full-frame commit (epoch bump)
        // right after the first paint, which reads as a boot flicker.
        if (next.columns === prev.columns && next.rows === prev.rows) return prev;
        return {
          ...next,
          epoch: prev.epoch + 1,
        };
      });
    };
    const onResize = () => {
      const now = Date.now();
      if (now - lastRun >= DEBOUNCE_MS) {
        lastRun = now;
        update();
      }
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = null;
        lastRun = Date.now();
        update();
      }, DEBOUNCE_MS);
    };
    stdout.on('resize', onResize);
    update();
    return () => {
      if (trailing) clearTimeout(trailing);
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Enable extended keyboard reporting (kitty + xterm modifyOtherKeys)
  // SYNCHRONOUSLY, ONCE, with NO query/round-trip. ink
  // turns raw mode on during the first useInput mount (synchronously, inside
  // render); this mount effect runs in the same commit phase, right after — i.e.
  // before the user can realistically press a key. We write BOTH enables
  // unconditionally (the terminal honors whichever it implements; Windows
  // Terminal 1.24 has no kitty but DOES honor modifyOtherKeys), gated only by the
  // supportsExtendedKeys() allowlist. Because the enable lands before the first
  // keypress is read, the FIRST Ctrl+Enter already arrives as a distinguishable
  // \x1b[27;5;13~ (or kitty \x1b[13;5u) instead of a bare \r — fixing the old
  // "first Ctrl+Enter submits, second works" race. Teardown lives in index.jsx's
  // restoreTerminal(). The empty dep array makes this run exactly once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isRawModeSupported || !stdout?.write) return;
    if (!supportsExtendedKeys()) return;
    try {
      stdout.write(ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS);
    } catch { /* terminal may be closing */ }
  }, []);
}
