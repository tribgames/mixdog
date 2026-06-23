/**
 * src/tui/app.mjs — the Claude-Code-style TUI front-end for mixdog-cli.
 *
 * This is the DEFAULT launch surface (app.mjs routes here when no flag is
 * given). It drives the ported mixdog session manager (createSession +
 * askSession, which owns agentLoop/provider/tools/compaction) and renders
 * through the vendored pi-tui differential renderer.
 *
 * Structure (modelled on vendor/pi/.../test/chat-simple.ts):
 *   children[0]            → a static welcome Text (stays pinned at the top)
 *   children[1..n-3]       → user / assistant / tool-card components (spliced in
 *                            ABOVE the trailing chrome by turn.mjs)
 *   children[n-2]          → the Editor (input box, focused)
 *   children[n-1]          → the bottom statusline Text (L1/L2 footer, BELOW input)
 * So there are TWO trailing chrome components (editor + statusline): every turn
 * is run with `trailing: 2`, and insertBeforeTrailing() keeps new blocks above
 * them. The statusline is the LAST child so the footer sits below the input box,
 * matching the Claude-Code layout.
 *
 * Engine init mirrors src/repl.mjs through mixdog-session-runtime.mjs.
 * Presentation lives in theme.mjs / components.mjs / turn.mjs; this file only
 * owns the app shell, the editor submit loop, and slash commands.
 *
 * Robustness: the onSubmit body is wrapped in try/catch so a thrown error is
 * rendered as a dim notice line and NEVER escapes into pi-tui's raw-mode input
 * loop (an uncaught throw there corrupts the tty).
 */
import { basename } from 'node:path';

import {
  TUI,
  ProcessTerminal,
  Text,
  Editor,
} from '../../vendor/pi/packages/tui/dist/index.js';

import { editorTheme } from './theme.mjs';
import {
  createUserMarkdown,
  createNoticeText,
} from './components.mjs';
import { runTurn } from './turn.mjs';
import {
  createSessionStats,
  renderStatusline,
} from '../ui/statusline.mjs';
import { createMixdogSessionRuntime } from '../mixdog-session-runtime.mjs';

/** Number of trailing chrome components (statusline Text + Editor). */
const TRAILING = 2;

/** Help lines shown by the `/help` slash command (TUI-specific). */
const HELP_LINES = [
  'mixdog-cli — a pi-based CLI/TUI coding agent (standalone mixdog brain).',
  '',
  'Slash commands:',
  '  /help              show this help',
  '  /clear             reset the conversation',
  '  /model <name>      switch model/preset for subsequent turns',
  '  /mode <name>       switch tool surface: full | readonly',
  '  /exit, /quit       quit',
  '',
  'Ctrl+C exits.',
];

/**
 * Launch the TUI. Resolves with a process exit code.
 *
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.toolMode]
 * @returns {Promise<number>}
 */
export async function runTui({ provider: providerName, model, toolMode = 'full' } = {}) {
  // Silence providers' catalog-refresh stderr writes (D14 patch reads this) so
  // they can't tear through the raw-mode TUI screen. --plain/--pi don't set it,
  // keeping diagnostic logs visible there.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

  // --- Engine init ----------------------------------------------------------
  const runtime = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });

  const stats = createSessionStats();
  const cwd = process.cwd();

  // --- TUI shell ------------------------------------------------------------
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // children[0]: welcome banner (pinned top).
  const welcome = new Text(
    `mixdog-cli — ${runtime.provider}/${runtime.model} · ${runtime.toolMode} · ${basename(cwd)}\n` +
      `Type a message, or /help for commands. Ctrl+C to exit.`,
    1,
    1,
  );
  tui.addChild(welcome);

  // Bottom statusline Text (init from current stats). Added AFTER the editor so
  // it renders as the very last line — the L1/L2 footer sits BELOW the input box
  // (Claude-Code layout). Trailing chrome order is therefore [editor, statusText].
  const statusText = new Text(
    await renderStatusline({ provider: runtime.provider, model: runtime.model, cwd, stats }),
    1,
    0,
  );

  // The input editor (focused). New message/tool blocks splice in ABOVE the
  // editor (at length - TRAILING), keeping order: welcome → messages → editor → status.
  const editor = new Editor(tui, editorTheme);
  tui.addChild(editor);
  tui.addChild(statusText);
  tui.setFocus(editor);

  // Refresh the bottom statusline from the current stats (used by /clear, /model).
  const refreshStatus = async () => {
    try {
      const line = await renderStatusline({ provider: runtime.provider, model: runtime.model, cwd, stats });
      statusText.setText(line);
      tui.requestRender();
    } catch {
      // Statusline must never break the loop.
    }
  };

  // Insert a component just above the trailing chrome (same math as turn.mjs).
  const insertAboveChrome = (component) => {
    const children = tui.children;
    const idx = Math.max(0, children.length - TRAILING);
    children.splice(idx, 0, component);
  };

  // Drop a dim notice line above the chrome.
  const notice = (text) => {
    insertAboveChrome(createNoticeText(text));
    tui.requestRender();
  };

  const resetVisibleConversation = () => {
    const children = tui.children;
    const removeCount = Math.max(0, children.length - 1 - TRAILING);
    if (removeCount > 0) children.splice(1, removeCount);
  };

  const resetStats = () => {
    const fresh = createSessionStats();
    for (const k of Object.keys(fresh)) stats[k] = fresh[k];
  };

  // --- Slash commands -------------------------------------------------------
  // Returns true if the line was a (handled) slash command.
  const handleSlash = async (line) => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case 'help':
        notice(HELP_LINES.join('\n'));
        return true;

      case 'clear': {
        resetVisibleConversation();
        resetStats();
        await runtime.clear();
        await refreshStatus();
        tui.requestRender();
        return true;
      }

      case 'model':
        if (!arg) {
          notice(`current model: ${runtime.provider}/${runtime.model}  (usage: /model <preset-or-model>)`);
          return true;
        }
        await runtime.setRoute({ model: arg });
        resetVisibleConversation();
        resetStats();
        notice(`✓ model → ${runtime.provider}/${runtime.model}`);
        await refreshStatus();
        return true;

      case 'mode':
        if (!arg) {
          notice(`current mode: ${runtime.toolMode}  (usage: /mode full|readonly)`);
          return true;
        }
        await runtime.setToolMode(arg);
        resetVisibleConversation();
        resetStats();
        notice(`✓ mode → ${runtime.toolMode}`);
        await refreshStatus();
        return true;

      case 'exit':
      case 'quit':
        runtime.close('cli-exit');
        try { tui.stop(); } catch { /* ignore */ }
        process.exit(0);
        return true; // unreachable

      default:
        notice(`unknown command: /${cmd}  (try /help)`);
        return true;
    }
  };

  // --- Submit loop ----------------------------------------------------------
  let busy = false;

  editor.onSubmit = async (value) => {
    const line = String(value ?? '').trim();
    if (!line) return;
    if (busy) return;

    // Wrap EVERYTHING so a throw never reaches pi-tui's raw-mode input loop.
    try {
      // Slash commands run inline (no engine turn).
      if (line.startsWith('/')) {
        editor.addToHistory(line);
        await handleSlash(line);
        return;
      }

      busy = true;
      editor.disableSubmit = true;

      // Echo the user message above the chrome + record it for input history.
      insertAboveChrome(createUserMarkdown(line));
      editor.addToHistory(line);
      tui.requestRender();

      await runTurn({
        tui,
        trailing: TRAILING,
        prompt: line,
        runtime,
        stats,
        statusText,
        cwd,
      });
    } catch (error) {
      notice(`[error] ${error?.message || error}`);
    } finally {
      busy = false;
      editor.disableSubmit = false;
      tui.requestRender();
    }
  };

  // --- Ctrl+C ---------------------------------------------------------------
  // ProcessTerminal puts stdin in raw mode (terminal.js setRawMode(true)), which
  // disables Node's automatic SIGINT — so `process.on('SIGINT')` would NEVER
  // fire here. The Editor also deliberately ignores Ctrl+C ("let parent handle",
  // editor.js). So the mechanism that actually fires is a TUI input listener
  // catching the raw ETX byte (\x03); we consume it and exit cleanly.
  tui.addInputListener((data) => {
    if (data === '\x03') {
      runtime.close('cli-sigint');
      try { tui.stop(); } catch { /* ignore */ }
      // Consume the ETX byte so it can't leak to the focused editor / terminal
      // input pipeline during shutdown (would corrupt the restored cooked mode).
      process.exit(0);
      return { consume: true }; // unreachable after exit, but correct intent
    }
    return undefined;
  });

  // Start the render/input loop. start() resolves synchronously; the process
  // stays alive on the raw stdin handler until Ctrl+C / /exit.
  tui.start();

  // Keep the returned promise pending; the app exits via process.exit() above.
  return await new Promise(() => {});
}
