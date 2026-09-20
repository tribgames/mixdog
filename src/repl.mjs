/**
 * mixdog REPL — styled inline terminal loop over the mixdog session runtime.
 *
 * Drives the session runtime through mixdog-session-runtime.mjs:
 * createSession + askSession own agentLoop/provider/tools/compaction, while
 * this module stays presentation-only: markdown-rendered replies, tool-call
 * cards, a per-turn statusline footer, slash commands, and arrow-key history.
 *
 * Flow:  stdin line → runtime.ask(prompt) → onTextDelta streams tokens to
 * stdout live → tool calls render as cards → on turn end we re-render
 * the assistant text as markdown → statusline footer.
 *
 * STREAMING DECISION:
 *   Live token streaming via onTextDelta conflicts with post-hoc markdown
 *   rendering (you can't style a heading until you've seen the whole line).
 *   We choose: stream raw tokens live so the turn FEELS alive, then on turn
 *   end replace only changed rows with markdown-rendered text, falling back to
 *   a full block redraw when wrapping or row structure makes patching unsafe.
 *   Rationale: the alternative (buffer silently, render once) loses all live
 *   feedback on slow turns, which is the worse UX. The re-render is cheap and
 *   only runs when stdout is a TTY (so piped/non-TTY output stays clean and is
 *   never clobbered by cursor-movement escapes).
 *
 * repl/: runtime-handle (lazy runtime ownership), stream-sink (live stream +
 * cursor flags), turn-output (final render + statusline), slash-commands.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { basename } from 'node:path';

import { bold, dim, cyan, red, colorEnabled } from './ui/ansi.mjs';
import { printHelp } from './help.mjs';
import { createSessionStats, applyUsageDelta } from './ui/session-stats.mjs';
import { createRuntimeHandle } from './repl/runtime-handle.mjs';
import { createStreamSink } from './repl/stream-sink.mjs';
import { finalizeTurnOutput, statuslineFor } from './repl/turn-output.mjs';
import { handleSlash } from './repl/slash-commands.mjs';

let runtimeModulePromise = null;
let markdownModulePromise = null;
let toolCardModulePromise = null;
let statuslineModulePromise = null;
let shutdownModulePromise = null;

function loadRuntimeModule() {
  runtimeModulePromise ??= import('./mixdog-session-runtime.mjs');
  return runtimeModulePromise;
}

async function renderMarkdownLazy(text) {
  markdownModulePromise ??= import('./ui/markdown.mjs');
  const mod = await markdownModulePromise;
  return mod.renderMarkdown(text);
}

async function renderToolCardLazy(call) {
  toolCardModulePromise ??= import('./ui/tool-card.mjs');
  const mod = await toolCardModulePromise;
  return mod.renderToolCard(call);
}

async function renderStatuslineLazy(opts) {
  statuslineModulePromise ??= import('./ui/statusline.mjs');
  const mod = await statuslineModulePromise;
  return mod.renderStatusline(opts);
}

async function loadShutdownModule() {
  shutdownModulePromise ??= import('./runtime/shared/process-shutdown.mjs');
  return shutdownModulePromise;
}

function promptText() {
  return colorEnabled() ? cyan(bold('› ')) : '› ';
}

function printBanner(out, providerName, model, cwd, toolMode) {
  const title = bold('mixdog');
  const providerLabel = providerName || 'auto';
  const modelLabel = model || 'default';
  const id = cyan(`${providerLabel}/${modelLabel}`);
  out.write(`${title} ${dim('—')} ${id} ${dim('·')} ${dim(toolMode)} ${dim('·')} ${dim(basename(cwd))}\n`);
  out.write(`${dim('Type a message, or /help for commands. Ctrl+C to exit.')}\n\n`);
}

/** One prompt → one runtime turn: live stream, tool cards, final render, footer. */
async function runTurn(line, { out, handle, stats, cwd }) {
  out.write('\n');
  const sink = createStreamSink({ out });
  try {
    const runtime = await handle.ensureRuntime();
    const { result } = await runtime.ask(line, {
      onToolCall: async (_iter, calls) => {
        for (const c of calls || []) await sink.writeToolCard(() => renderToolCardLazy(c));
      },
      onTextDelta: (chunk) => sink.pushDelta(chunk),
      onTextReset: (reset) => sink.resetTail(reset),
      onUsageDelta: (delta) => applyUsageDelta(stats, delta),
    });
    sink.flush();

    const finalText = (result?.content != null && String(result.content)) || sink.currentText();
    await finalizeTurnOutput({ out, sink, finalText, renderMarkdown: renderMarkdownLazy });

    // Per-turn statusline footer.
    out.write(`\n${await statuslineFor(renderStatuslineLazy, { runtime, cwd, stats })}\n`);
  } catch (error) {
    let displayError = error;
    try {
      sink.flush();
    } catch (flushError) {
      displayError = flushError;
    }
    out.write(`\n${red(`[error] ${displayError?.message || displayError}`)}\n`);
  }
  out.write('\n');
}

export async function runRepl({
  provider: providerName,
  model,
  toolMode = 'full',
  input = stdin,
  output: out = stdout,
} = {}) {
  // `--help` short-circuits before any provider init so the smoke test (which
  // invokes `src/cli.mjs --help`) gets clean help output and a 0 exit. We read
  // argv here rather than editing app.mjs, keeping changes confined to the REPL.
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    printHelp();
    return 0;
  }

  const stats = createSessionStats();
  const cwd = process.cwd();
  let rl = null;
  const handle = createRuntimeHandle({
    loadRuntimeModule,
    providerName,
    model,
    toolMode,
    closeInput: () => rl?.close(),
  });

  printBanner(out, providerName, model, cwd, toolMode);

  rl = createInterface({
    input,
    output: out,
    prompt: promptText(),
    // historySize > 0 enables readline's built-in ↑/↓ recall of prior inputs.
    historySize: 200,
  });
  const { installProcessSignalCleanup } = await loadShutdownModule();
  const signalCleanup = installProcessSignalCleanup({
    name: 'mixdog-repl',
    timeoutMs: 6500,
    beforeCleanup: () => {
      try {
        out.write('\n');
      } catch {}
    },
    cleanup: handle.closeRuntime,
  });
  rl.on('SIGINT', () => {
    void signalCleanup.run('SIGINT', { code: 130, shouldExit: true });
  });

  const slashContext = {
    out,
    rl,
    ensureRuntime: handle.ensureRuntime,
    getRuntime: handle.getRuntime,
    closeRuntime: handle.closeRuntime,
    renderStatusline: renderStatuslineLazy,
    stats,
    cwd,
    providerName,
    model,
    toolMode,
  };

  try {
    rl.prompt();

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        rl.prompt();
        continue;
      }

      if (line.startsWith('/')) {
        const handled = await handleSlash(line, slashContext);
        if (handled === 'exit') return 0;
      } else {
        await runTurn(line, { out, handle, stats, cwd });
      }
      rl.setPrompt(promptText());
      rl.prompt();
    }
  } finally {
    signalCleanup.uninstall();
    await handle.closeRuntime('cli-eof');
  }

  return 0;
}
