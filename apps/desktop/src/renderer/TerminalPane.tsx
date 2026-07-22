// Dock terminal view: a module-shared xterm
// instance over the main-process PTY. The xterm DOM is re-appended on
// remount so tab switches keep scrollback; the PTY survives regardless.
import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

let shared: { id: string | null; term: Terminal; fit: FitAddon } | null = null;

// Terminals stay DARK on both app themes (Cursor grammar): ANSI palettes —
// PSReadLine yellows included — assume a dark background, and a light sheet
// made typed input and the cursor unreadable (user-flagged).
const TERMINAL_THEME = {
  background: '#141312',
  foreground: '#f4f2ee',
  cursor: '#f4f2ee',
  cursorAccent: '#141312',
  selectionBackground: 'rgba(244, 242, 238, .28)',
};

export default function TerminalPane({ cwd }: { cwd: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let dataDisposable: { dispose(): void } | undefined;
    if (!shared) {
      const term = new Terminal({
        fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.35,
        cursorBlink: true,
        cursorStyle: 'bar',
        // Unfocused xterm defaults to a hollow block; keep the same slim bar.
        cursorInactiveStyle: 'bar',
        theme: TERMINAL_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      shared = { id: null, term, fit };
    }
    const { term, fit } = shared;
    if (term.element) container.appendChild(term.element);
    else term.open(container);
    void (async () => {
      const ensured = await window.mixdogDesktop.termEnsure?.(shared?.id ?? null, cwd);
      if (!ensured || disposed || !shared) return;
      const isNewPty = shared.id !== ensured.id;
      shared.id = ensured.id;
      if (isNewPty && ensured.replay) term.write(ensured.replay);
      unsubscribe = window.mixdogDesktop.subscribeTermData?.((event) => {
        if (event.id === shared?.id) term.write(event.data);
      });
      dataDisposable = term.onData((data) => {
        if (shared?.id) window.mixdogDesktop.termWrite?.(shared.id, data);
      });
      const doFit = () => {
        try {
          fit.fit();
          if (shared?.id) window.mixdogDesktop.termResize?.(shared.id, term.cols, term.rows);
        } catch { /* container hidden mid-measure */ }
      };
      doFit();
      observer = new ResizeObserver(doFit);
      observer.observe(container);
      term.focus();
    })();
    return () => {
      disposed = true;
      unsubscribe?.();
      observer?.disconnect();
      dataDisposable?.dispose();
      // The xterm DOM node stays alive for the next attach; only detach it.
      if (term.element?.parentElement === container) container.removeChild(term.element);
    };
  }, [cwd]);
  return <div className="dock-terminal" ref={host} />;
}
