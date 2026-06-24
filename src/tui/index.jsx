/**
 * src/tui/index.jsx — entry that mounts the React/ink TUI.
 *
 * Creates the engine session (runs OUR agentLoop outside React) and ink-renders
 * <App store={...}/>. Resolves when the app exits (Ctrl+C / /exit).
 */
import React from 'react';
import { render } from 'ink';
import { App } from './App.jsx';
import { normalizeStatusLine } from './components/StatusLine.jsx';
import { createEngineSession } from './engine.mjs';

const STATUSLINE_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../ui/statusline.mjs'
  : '../ui/statusline.mjs';

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

  let store;
  try {
    store = await createEngineSession({ provider, model, toolMode });
  } catch (error) {
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
    }));
  } catch {
    initialStatusLine = '';
  }

  // Enter the alternate screen buffer for a true fullscreen UI: the input bar
  // pins to the physical bottom (App uses height={rows}) and, on exit, the
  // shell's original screen is restored untouched. \x1b[?1049h enters alt
  // screen; then clear it and home the cursor so we start from a clean top.
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');

  // Use a blinking BAR cursor (DECSCUSR 5) — a thin caret behind the text, not a
  // fat block. PromptInput parks this hardware cursor at the insertion point via
  // useCursor; the terminal also anchors IME composition to it.
  process.stdout.write('\x1b[5 q'); // blinking bar

  // Enable mouse tracking so we receive wheel events in the alt screen (where
  // the terminal's own scrollback is unavailable). \x1b[?1000h = button events,
  // \x1b[?1002h = button-press drag motion, \x1b[?1006h = SGR extended coords.
  // The App parses wheel up/down (SGR button 64/65) to scroll the transcript and
  // button-0 press+drag+release to drive an in-app text selection + copy (like
  // OpenCode: capture stays on, so wheel and drag-select coexist). Disabled on
  // exit. ?1002h (not ?1003h) reports motion only while a button is held, so
  // idle mouse movement doesn't flood stdin.
  process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');

  const restoreTerminal = () => {
    try { process.stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0 q\x1b[?1049l'); } catch { /* ignore */ }
  };
  process.on('exit', restoreTerminal);

  // exitOnCtrlC:false — ink's own Ctrl+C path unmounts IMMEDIATELY, before our
  // useInput handler runs, so our cursor-return-to-bottom teardown frame would
  // never render and the shell prompt would overlap our frame. We take over
  // Ctrl+C in App (requestExit) to draw the teardown frame first, then exit.
  const instance = render(<App store={store} initialStatusLine={initialStatusLine} />, { exitOnCtrlC: false, maxFps: 60 });
  const { waitUntilExit } = instance;
  // [mixdog fork] Hand the ink renderer's drag-selection setter to the store so
  // App's mouse handler can push selection rectangles (absolute terminal cells)
  // that ink paints as an inverse highlight. render() returns synchronously
  // after the first mount, while the mouse handler only fires on user drag, so
  // wiring it here (post-render) is in time.
  if (typeof instance.setSelection === 'function') {
    store.setRenderSelection = instance.setSelection;
  }
  if (typeof instance.getSelectionText === 'function') {
    store.getRenderSelectionText = instance.getSelectionText;
  }
  try {
    await waitUntilExit();
  } finally {
    restoreTerminal();
  }
  return 0;
}
