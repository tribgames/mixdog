/**
 * src/tui/index.jsx — entry that mounts the React/ink TUI.
 *
 * Creates the engine session (runs OUR agentLoop outside React) and ink-renders
 * <App store={...}/>. Resolves when the app exits (/exit or /quit).
 */
import React from 'react';
import { render } from 'ink';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { App } from './App.jsx';
import { normalizeStatusLine } from './components/StatusLine.jsx';
import { createEngineSession } from './engine.mjs';

const STATUSLINE_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../ui/statusline.mjs'
  : '../ui/statusline.mjs';

const TERMINAL_MODE_RESET = '\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h';
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

function resolveTuiStderrLogPath() {
  return process.env.MIXDOG_TUI_STDERR_LOG
    || join(process.env.MIXDOG_RUNTIME_ROOT || join(tmpdir(), 'mixdog'), 'mixdog-cli-tui.stderr.log');
}

function installTuiStderrGuard() {
  if (process.env.MIXDOG_TUI_ALLOW_STDERR === '1') return () => {};
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logPath = resolveTuiStderrLogPath();
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }

  process.stderr.write = ((chunk, encoding, callback) => {
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      appendFileSync(logPath, text, 'utf8');
    } catch {
      // Last-resort fallback: if the log file is unavailable, drop diagnostics
      // while the fullscreen TUI owns the terminal.
    }
    if (typeof encoding === 'function') {
      try { encoding(); } catch { /* ignore */ }
    } else if (typeof callback === 'function') {
      try { callback(); } catch { /* ignore */ }
    }
    return true;
  });

  return () => {
    process.stderr.write = originalWrite;
  };
}

export async function runTui({ provider, model, toolMode } = {}) {
  // The React/ink TUI needs a raw-mode-capable TTY (interactive input). In a
  // pipe/redirect/CI, ink's input hooks throw — bail with a clear hint instead.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'mixdog-cli: the TUI needs an interactive terminal (TTY).\n' +
        'Run it directly in a terminal, or use --plain for the readline REPL.\n',
    );
    return 1;
  }

  const restoreStderr = installTuiStderrGuard();
  let store;
  try {
    store = await createEngineSession({ provider, model, toolMode });
  } catch (error) {
    restoreStderr();
    process.stderr.write(`mixdog-cli: ${error?.message || error}\n`);
    return 1;
  }

  let initialStatusLine = '';
  try {
    const state = store.getState();
    const { renderStatusline } = await import(STATUSLINE_MODULE);
    initialStatusLine = normalizeStatusLine(await renderStatusline({
      sessionId: state.sessionId,
      provider: state.provider,
      model: state.model,
      cwd: state.cwd,
      stats: state.stats,
      contextWindow: state.contextWindow,
      rawContextWindow: state.rawContextWindow,
    }));
  } catch {
    initialStatusLine = '';
  }

  // Enter the alternate screen buffer for a true fullscreen UI: the input bar
  // pins to the physical bottom (App uses height={rows}) and, on exit, the
  // shell's original screen is restored untouched. \x1b[?1049h enters alt
  // screen; then clear it and home the cursor so we start from a clean top.
  process.stdout.write(`${TERMINAL_MODE_RESET}\x1b[?1049h${TERMINAL_MODE_RESET}\x1b[2J\x1b[H`);

  // Use a blinking BAR cursor (DECSCUSR 5) — a thin caret behind the text, not a
  // fat block. PromptInput parks this hardware cursor at the insertion point via
  // useCursor; the terminal also anchors IME composition to it.
  process.stdout.write('\x1b[5 q'); // blinking bar

  // Mouse tracking is required for wheel scrolling inside the fullscreen
  // alternate-screen viewport. Keep an escape hatch for terminals/users that
  // prefer native selection over app-managed wheel/drag handling.
  const mouseTracking = process.env.MIXDOG_TUI_MOUSE !== '0';
  if (mouseTracking) {
    process.stdout.write(MOUSE_TRACKING_ON);
  }

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    try { process.stdout.write(`${TERMINAL_MODE_RESET}\x1b[0 q\x1b[?1049l${TERMINAL_MODE_RESET}`); } catch { /* ignore */ }
  };
  process.on('exit', restoreTerminal);
  const restoreAndSignal = (signal) => {
    restoreTerminal();
    process.removeListener('SIGINT', restoreAndSignal);
    process.removeListener('SIGTERM', restoreAndSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', restoreAndSignal);
  process.once('SIGTERM', restoreAndSignal);

  // exitOnCtrlC:false — keep Ctrl+C available for terminal copy behavior.
  // Explicit exits go through /exit or /quit so teardown still restores the
  // cursor, mouse mode, and alternate screen cleanly.
  try {
    const instance = render(<App store={store} initialStatusLine={initialStatusLine} />, { exitOnCtrlC: false, maxFps: 60 });
    const { waitUntilExit } = instance;
    // [mixdog fork] Hand the ink renderer's drag-selection setter to the store so
    // App's mouse handler can push selection rectangles (absolute terminal cells)
    // that ink paints as an inverse highlight. render() returns synchronously
    // after the first mount, while the mouse handler only fires on user drag, so
    // wiring it here (post-render) is in time.
    if (mouseTracking && typeof instance.setSelection === 'function') {
      store.setRenderSelection = instance.setSelection;
    }
    if (mouseTracking && typeof instance.getSelectionText === 'function') {
      store.getRenderSelectionText = instance.getSelectionText;
    }
    await waitUntilExit();
  } finally {
    process.removeListener('SIGINT', restoreAndSignal);
    process.removeListener('SIGTERM', restoreAndSignal);
    restoreTerminal();
    restoreStderr();
  }
  return 0;
}
