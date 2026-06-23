/**
 * src/tui/app.mjs — the Claude-Code-style TUI front-end for mixdog-cli.
 *
 * This is the DEFAULT launch surface (app.mjs routes here when no flag is
 * given). It drives OUR engine (agentLoop + provider + builtin tools — the
 * ported mixdog brain, exactly like src/repl.mjs) but renders through the
 * vendored pi-tui differential renderer instead of raw readline/stdout.
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
 * Engine init mirrors src/repl.mjs (dynamic imports of the vendored runtime,
 * HOST_ONLY tool filtering, provider registry). Presentation lives in
 * theme.mjs / components.mjs / turn.mjs; this file only owns the app shell,
 * the editor submit loop, and slash commands.
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

const RUNTIME = '../runtime/agent/orchestrator';

/** Tools that have no meaning in the standalone CLI (same set as the REPL). */
const HOST_ONLY = new Set(['diagnostics', 'open_config']);

/** Number of trailing chrome components (statusline Text + Editor). */
const TRAILING = 2;

/** Help lines shown by the `/help` slash command (TUI-specific). */
const HELP_LINES = [
  'mixdog-cli — a pi-based CLI/TUI coding agent (standalone mixdog brain).',
  '',
  'Slash commands:',
  '  /help              show this help',
  '  /clear             reset the conversation',
  '  /model <name>      switch model for subsequent turns',
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
 * @returns {Promise<number>}
 */
export async function runTui({ provider: providerName = 'anthropic-oauth', model = 'claude-opus-4-8' } = {}) {
  // Silence providers' catalog-refresh stderr writes (D14 patch reads this) so
  // they can't tear through the raw-mode TUI screen. --plain/--pi don't set it,
  // keeping diagnostic logs visible there.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

  // --- Engine init (mirrors src/repl.mjs lines ~67-82) ----------------------
  const reg = await import(`${RUNTIME}/providers/registry.mjs`);
  const { agentLoop } = await import(`${RUNTIME}/session/loop.mjs`);
  const { BUILTIN_TOOLS } = await import(`${RUNTIME}/tools/builtin/builtin-tools.mjs`);

  const tools = BUILTIN_TOOLS.filter((t) => !HOST_ONLY.has(t.name));

  await reg.initProviders({ [providerName]: { enabled: true } });
  const provider = reg.getProvider(providerName);
  if (!provider) {
    process.stderr.write(`mixdog-cli: provider "${providerName}" is not configured.\n`);
    return 1;
  }

  // --- Session state --------------------------------------------------------
  let activeModel = model;
  const stats = createSessionStats();
  const cwd = process.cwd();
  const messages = [];

  // --- TUI shell ------------------------------------------------------------
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // children[0]: welcome banner (pinned top).
  const welcome = new Text(
    `mixdog-cli — ${providerName}/${activeModel} · ${basename(cwd)}\n` +
      `Type a message, or /help for commands. Ctrl+C to exit.`,
    1,
    1,
  );
  tui.addChild(welcome);

  // Bottom statusline Text (init from current stats). Added AFTER the editor so
  // it renders as the very last line — the L1/L2 footer sits BELOW the input box
  // (Claude-Code layout). Trailing chrome order is therefore [editor, statusText].
  const statusText = new Text(
    await renderStatusline({ provider: providerName, model: activeModel, cwd, stats }),
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
      const line = await renderStatusline({ provider: providerName, model: activeModel, cwd, stats });
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
        // Remove every message component between welcome[0] and the trailing 2.
        const children = tui.children;
        const removeCount = Math.max(0, children.length - 1 - TRAILING);
        if (removeCount > 0) children.splice(1, removeCount);
        // Reset state in place: drop history + zero the stats accumulator.
        messages.length = 0;
        const fresh = createSessionStats();
        for (const k of Object.keys(fresh)) stats[k] = fresh[k];
        await refreshStatus();
        tui.requestRender();
        return true;
      }

      case 'model':
        if (!arg) {
          notice(`current model: ${activeModel}  (usage: /model <name>)`);
          return true;
        }
        activeModel = arg;
        notice(`✓ model → ${arg}`);
        await refreshStatus();
        return true;

      case 'exit':
      case 'quit':
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

      // Echo the user message above the chrome + record it for history.
      messages.push({ role: 'user', content: line });
      insertAboveChrome(createUserMarkdown(line));
      editor.addToHistory(line);
      tui.requestRender();

      await runTurn({
        tui,
        trailing: TRAILING,
        provider,
        model: activeModel,
        tools,
        messages,
        stats,
        statusText,
        cwd,
        providerName,
        agentLoop,
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
