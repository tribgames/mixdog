/**
 * mixdog REPL — styled inline terminal loop over the ported mixdog brain.
 *
 * Drives the *ported mixdog brain* through mixdog-session-runtime.mjs:
 * createSession + askSession own agentLoop/provider/tools/compaction, while
 * this module stays presentation-only: markdown-rendered replies, tool-call
 * cards, a per-turn statusline footer, slash commands, and arrow-key history.
 *
 * Flow:  stdin line → runtime.ask(prompt) → onTextDelta streams tokens to
 *        stdout live → tool calls render as cards → on turn end we re-render
 *        the assistant text as markdown → statusline footer.
 *
 * STREAMING DECISION (approach (a) from the brief):
 *   Live token streaming via onTextDelta conflicts with post-hoc markdown
 *   rendering (you can't style a heading until you've seen the whole line).
 *   We choose: stream raw tokens live so the turn FEELS alive, then on turn
 *   end clear the streamed raw block and re-print the markdown-rendered text.
 *   Rationale: the alternative (buffer silently, render once) loses all live
 *   feedback on slow turns, which is the worse UX. The re-render is cheap and
 *   only runs when stdout is a TTY (so piped/non-TTY output stays clean and is
 *   never clobbered by cursor-movement escapes).
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { basename } from 'node:path';

import { bold, dim, cyan, green, red, yellow, colorEnabled } from './ui/ansi.mjs';
import { printHelp } from './help.mjs';
import { createSessionStats, applyUsageDelta } from './ui/session-stats.mjs';

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
  const mod = await (markdownModulePromise ??= import('./ui/markdown.mjs'));
  return mod.renderMarkdown(text);
}

async function renderToolCardLazy(call) {
  const mod = await (toolCardModulePromise ??= import('./ui/tool-card.mjs'));
  return mod.renderToolCard(call);
}

async function renderStatuslineLazy(opts) {
  const mod = await (statuslineModulePromise ??= import('./ui/statusline.mjs'));
  return mod.renderStatusline(opts);
}

async function loadShutdownModule() {
  shutdownModulePromise ??= import('./runtime/shared/process-shutdown.mjs');
  return shutdownModulePromise;
}

export async function runRepl({ provider: providerName, model, toolMode = 'full' } = {}) {
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
  let runtime = null;
  let runtimePromise = null;
  let closed = false;

  const ensureRuntime = async () => {
    if (closed) throw new Error('runtime closed');
    if (runtime) return runtime;
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const { createMixdogSessionRuntime } = await loadRuntimeModule();
        const next = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });
        runtime = next;
        return next;
      })().finally(() => {
        runtimePromise = null;
      });
    }
    const next = await runtimePromise;
    if (closed) {
      try { await next.close('cli-exit'); } catch {}
      if (runtime === next) runtime = null;
      throw new Error('runtime closed');
    }
    return next;
  };

  const closeRuntime = async (reason = 'cli-exit') => {
    if (closed) return;
    closed = true;
    try { rl?.close(); } catch {}
    const pendingRuntime = runtime || (runtimePromise ? await runtimePromise.catch(() => null) : null);
    if (pendingRuntime) await pendingRuntime.close(reason);
  };

  printBanner(providerName, model, cwd, toolMode);

  rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: promptText(),
    // historySize > 0 enables readline's built-in ↑/↓ recall of prior inputs.
    historySize: 200,
  });
  const { installProcessSignalCleanup } = await loadShutdownModule();
  const signalCleanup = installProcessSignalCleanup({
    name: 'mixdog-repl',
    timeoutMs: 6500,
    beforeCleanup: () => { try { stdout.write('\n'); } catch {} },
    cleanup: closeRuntime,
  });
  rl.on('SIGINT', () => {
    void signalCleanup.run('SIGINT', { code: 130, shouldExit: true });
  });

  try {
    rl.prompt();

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        rl.prompt();
        continue;
      }

      // --- Slash commands ---------------------------------------------------
      if (line.startsWith('/')) {
        const handled = await handleSlash(line, {
          rl,
          ensureRuntime,
          getRuntime: () => runtime,
          stats,
          cwd,
          providerName,
          model,
          toolMode,
          closeRuntime,
        });
        if (handled === 'exit') {
          return 0;
        }
        rl.setPrompt(promptText());
        rl.prompt();
        continue;
      }

      stdout.write('\n');

      let streamedText = '';
      let printedAny = false;
      let printedToolCard = false;
      try {
        const runtime = await ensureRuntime();
        const { result } = await runtime.ask(
          line,
          {
            onToolCall: async (_iter, calls) => {
              for (const c of calls || []) {
                printedToolCard = true;
                stdout.write('\n' + (await renderToolCardLazy(c)) + '\n');
              }
          },
            onTextDelta: (chunk) => {
              printedAny = true;
              streamedText += chunk;
              stdout.write(chunk);
            },
            onUsageDelta: (delta) => applyUsageDelta(stats, delta),
          },
        );

        const finalText = (result?.content != null && String(result.content)) || streamedText;

        // Approach (a): clear the raw streamed block and re-print as markdown.
        // Only when we're on a TTY and actually streamed something — otherwise the
        // raw text already on screen is fine (and we must not emit cursor escapes
        // into a pipe).
        if (finalText) {
          if (printedAny && colorEnabled() && !printedToolCard) {
            eraseStreamedBlock(streamedText);
            stdout.write(await renderMarkdownLazy(finalText) + '\n');
          } else if (!printedAny) {
            // Nothing streamed live (provider without onTextDelta) — render once.
            stdout.write(await renderMarkdownLazy(finalText) + '\n');
          } else if (printedToolCard) {
            // Tool cards are printed after the streamed text. Erasing only the
            // streamed text from the current cursor position would clear/move
            // through the card rows and make the terminal scroll jump. Keep the
            // live transcript as-is for mixed text+tool turns.
            stdout.write('\n');
          } else {
            // Non-TTY / NO_COLOR: leave the raw stream, just terminate the line.
            stdout.write('\n');
          }
        }

        // Per-turn statusline footer.
        stdout.write('\n' + (await renderStatuslineLazy({
          provider: runtime.provider,
          model: runtime.model,
          cwd,
          stats,
          contextWindow: runtime.contextWindow,
          rawContextWindow: runtime.rawContextWindow,
        })) + '\n');
      } catch (error) {
        stdout.write('\n' + red(`[error] ${error?.message || error}`) + '\n');
      }

      stdout.write('\n');
      rl.setPrompt(promptText());
      rl.prompt();
    }
  } finally {
    signalCleanup.uninstall();
    await closeRuntime('cli-eof');
  }

  return 0;
}

// --- UI bits -----------------------------------------------------------------

function promptText() {
  return colorEnabled() ? cyan(bold('› ')) : '› ';
}

function printBanner(providerName, model, cwd, toolMode) {
  const title = bold('mixdog');
  const providerLabel = providerName || 'auto';
  const modelLabel = model || 'default';
  const id = cyan(`${providerLabel}/${modelLabel}`);
  stdout.write(`${title} ${dim('—')} ${id} ${dim('·')} ${dim(toolMode)} ${dim('·')} ${dim(basename(cwd))}\n`);
  stdout.write(dim('Type a message, or /help for commands. Ctrl+C to exit.') + '\n\n');
}

/**
 * Erase the raw streamed assistant block so we can re-print it as markdown.
 * Computes how many terminal rows the streamed text + tool-card lines consumed.
 * Conservative: if the math is off we still leave a readable transcript.
 */
function eraseStreamedBlock(streamedText) {
  const cols = (stdout.columns && stdout.columns > 0) ? stdout.columns : 80;
  let rows = 0;
  for (const seg of String(streamedText).split('\n')) {
    rows += Math.max(1, Math.ceil((seg.length || 1) / cols));
  }
  // Move to column 0, then for each consumed row move up and clear it.
  stdout.write('\r');
  for (let i = 0; i < rows; i++) {
    stdout.write('\x1b[2K'); // clear current line
    if (i < rows - 1) stdout.write('\x1b[1A'); // cursor up
  }
  stdout.write('\r');
}

// --- Slash commands ----------------------------------------------------------

/**
 * Handle a `/command` line. Returns 'exit' to quit, otherwise undefined.
 */
async function handleSlash(line, ctx) {
  const [rawCmd, ...rest] = line.slice(1).split(/\s+/);
  const cmd = String(rawCmd || '').toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case 'help':
      printHelp();
      return;

    case 'clear':
      {
        const runtime = await ctx.ensureRuntime();
        await runtime.clear();
        const fresh = createSessionStats();
        for (const k of Object.keys(fresh)) ctx.stats[k] = fresh[k];
        // Clear screen + scrollback and home the cursor.
        stdout.write(colorEnabled() ? '\x1b[2J\x1b[3J\x1b[H' : '\n');
        stdout.write(dim('conversation reset.') + '\n');
        stdout.write((await renderStatuslineLazy({
          provider: runtime.provider,
          model: runtime.model,
          cwd: ctx.cwd,
          stats: ctx.stats,
          contextWindow: runtime.contextWindow,
          rawContextWindow: runtime.rawContextWindow,
        })) + '\n');
      }
      return;

    case 'compact':
      {
        const runtime = await ctx.ensureRuntime();
        const r = await runtime.compact();
        if (!r) {
          stdout.write(yellow('compact failed') + '\n');
          return;
        }
        if (r.error) {
          stdout.write(red('compact failed') + '\n');
          return;
        }
        if (r.changed === false && r.reason) {
          stdout.write(yellow(r.reason) + '\n');
          return;
        }
        if (r.changed === false) {
          stdout.write(yellow('nothing to compact') + '\n');
          return;
        }
        stdout.write(green(`✓ compacted context: ${r.beforeMessages}→${r.afterMessages} messages, context ${r.beforeTokens}→${r.afterTokens}`) + '\n');
      }
      return;

    case 'model':
      if (!arg) {
        const runtime = ctx.getRuntime?.();
        const provider = runtime?.provider || ctx.providerName || 'auto';
        const currentModel = runtime?.model || ctx.model || 'default';
        stdout.write(yellow(`current model: ${provider}/${currentModel}`) + '\n');
        stdout.write(dim('usage: /model <preset-or-model>') + '\n');
        return;
      }
      {
        const runtime = await ctx.ensureRuntime();
        await runtime.setRoute({ model: arg });
        stdout.write(green(`✓ model → ${runtime.provider}/${runtime.model}`) + '\n');
      }
      return;

    case 'outputstyle':
    case 'output-style':
    case 'style':
      {
        const runtime = await ctx.ensureRuntime();
        const lower = arg.toLowerCase();
        if (!arg || lower === 'status' || lower === 'current' || lower === 'show') {
          const status = runtime.getOutputStyle?.() || runtime.listOutputStyles?.();
          const label = status?.current?.label || status?.current?.id || status?.configured || 'Default';
          const available = (status?.styles || []).map((style) => style.label || style.id).join(', ');
          stdout.write(yellow(`current output style: ${label}`) + '\n');
          if (available) stdout.write(dim(`available: ${available}`) + '\n');
          return;
        }
        const result = await runtime.setOutputStyle(arg);
        const label = result?.current?.label || result?.current?.id || arg;
        const suffix = result?.appliedToCurrentSession === false ? ' (use /clear to apply to this chat)' : '';
        stdout.write(green(`✓ output style → ${label}${suffix}`) + '\n');
      }
      return;

    case 'mode':
      if (!arg) {
        const runtime = ctx.getRuntime?.();
        stdout.write(yellow(`current mode: ${runtime?.toolMode || ctx.toolMode}`) + '\n');
        stdout.write(dim('usage: /mode full|readonly') + '\n');
        return;
      }
      {
        const runtime = await ctx.ensureRuntime();
        await runtime.setToolMode(arg);
        stdout.write(green(`✓ mode → ${runtime.toolMode}`) + '\n');
      }
      return;

    case 'exit':
    case 'quit':
      await ctx.closeRuntime?.('cli-exit');
      stdout.write(dim('bye.') + '\n');
      return 'exit';

    default:
      stdout.write(red(`unknown command: /${cmd}`) + dim('  (try /help)') + '\n');
      return;
  }
}
