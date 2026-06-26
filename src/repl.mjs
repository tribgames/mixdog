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
import { renderMarkdown } from './ui/markdown.mjs';
import { renderToolCard } from './ui/tool-card.mjs';
import { createSessionStats, applyUsageDelta, renderStatusline } from './ui/statusline.mjs';
import { createMixdogSessionRuntime } from './mixdog-session-runtime.mjs';
import { installProcessSignalCleanup } from './runtime/shared/process-shutdown.mjs';

/** Help text shared by `--help` and the `/help` slash command. */
const HELP_LINES = [
  'mixdog — standalone mixdog CLI/TUI coding agent.',
  '',
  'Usage:',
  '  mixdog [--provider <name>] [--model <name>] [--readonly]',
  '  mixdog --help',
  '',
  'Slash commands (inside the REPL):',
  '  /help              show this help',
  '  /clear             reset the conversation and clear the screen',
  '  /compact           compact older conversation context',
  '  /model <name>      switch model/preset for subsequent turns',
  '  /mode <name>       switch tool surface: full | readonly',
  '  /exit              quit',
  '',
  'History: use ↑ / ↓ to recall previous inputs.',
];

/** Print the `--help` text. Routed here so app.mjs stays untouched. */
export function printHelp(write = (s) => stdout.write(s)) {
  write(HELP_LINES.join('\n') + '\n');
}

export async function runRepl({ provider: providerName, model, toolMode = 'full' } = {}) {
  // `--help` short-circuits before any provider init so the smoke test (which
  // invokes `src/cli.mjs --help`) gets clean help output and a 0 exit. We read
  // argv here rather than editing app.mjs, keeping changes confined to the REPL.
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    printHelp();
    return 0;
  }

  const runtime = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });
  const stats = createSessionStats();
  const cwd = process.cwd();
  let rl = null;
  let closed = false;
  const closeRuntime = async (reason = 'cli-exit') => {
    if (closed) return;
    closed = true;
    try { rl?.close(); } catch {}
    await runtime.close(reason);
  };

  printBanner(runtime.provider, runtime.model, cwd, runtime.toolMode);

  rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: promptText(),
    // historySize > 0 enables readline's built-in ↑/↓ recall of prior inputs.
    historySize: 200,
  });
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
          runtime,
          stats,
          cwd,
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
      try {
        const { result } = await runtime.ask(
          line,
          {
            onToolCall: async (_iter, calls) => {
            for (const c of calls || []) stdout.write('\n' + renderToolCard(c) + '\n');
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
          if (printedAny && colorEnabled()) {
            eraseStreamedBlock(streamedText);
            stdout.write(renderMarkdown(finalText) + '\n');
          } else if (!printedAny) {
            // Nothing streamed live (provider without onTextDelta) — render once.
            stdout.write(renderMarkdown(finalText) + '\n');
          } else {
            // Non-TTY / NO_COLOR: leave the raw stream, just terminate the line.
            stdout.write('\n');
          }
        }

        // Per-turn statusline footer.
        stdout.write('\n' + (await renderStatusline({
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
  const id = cyan(`${providerName}/${model}`);
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
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case 'help':
      printHelp();
      return;

    case 'clear':
      await ctx.runtime.clear();
      {
        const fresh = createSessionStats();
        for (const k of Object.keys(fresh)) ctx.stats[k] = fresh[k];
      }
      // Clear screen + scrollback and home the cursor.
      stdout.write(colorEnabled() ? '\x1b[2J\x1b[3J\x1b[H' : '\n');
      stdout.write(dim('conversation reset.') + '\n');
      stdout.write((await renderStatusline({
        provider: ctx.runtime.provider,
        model: ctx.runtime.model,
        cwd: ctx.cwd,
        stats: ctx.stats,
        contextWindow: ctx.runtime.contextWindow,
        rawContextWindow: ctx.runtime.rawContextWindow,
      })) + '\n');
      return;

    case 'compact':
      {
        const r = await ctx.runtime.compact();
        if (!r) {
          stdout.write(yellow('compact failed') + '\n');
          return;
        }
        if (r.changed === false && r.reason) {
          stdout.write(yellow(r.reason) + '\n');
          return;
        }
        stdout.write(green(`✓ compacted context: ${r.beforeMessages}→${r.afterMessages} messages, context ${r.beforeTokens}→${r.afterTokens}`) + '\n');
      }
      return;

    case 'model':
      if (!arg) {
        stdout.write(yellow(`current model: ${ctx.runtime.provider}/${ctx.runtime.model}`) + '\n');
        stdout.write(dim('usage: /model <preset-or-model>') + '\n');
        return;
      }
      await ctx.runtime.setRoute({ model: arg });
      stdout.write(green(`✓ model → ${ctx.runtime.provider}/${ctx.runtime.model}`) + '\n');
      return;

    case 'mode':
      if (!arg) {
        stdout.write(yellow(`current mode: ${ctx.runtime.toolMode}`) + '\n');
        stdout.write(dim('usage: /mode full|readonly') + '\n');
        return;
      }
      await ctx.runtime.setToolMode(arg);
      stdout.write(green(`✓ mode → ${ctx.runtime.toolMode}`) + '\n');
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
