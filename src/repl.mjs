/**
 * mixdog-cli REPL — styled inline terminal loop over the ported mixdog brain.
 *
 * Drives the *ported mixdog brain* directly: our own agentLoop + provider +
 * builtin tools, with no pi AgentSession engine in the path (per port-plan D8 /
 * "our engine is the owner"). The engine is untouched here — this module is
 * presentation only: markdown-rendered replies, tool-call cards, a per-turn
 * statusline footer, slash commands, and arrow-key input history.
 *
 * Flow:  stdin line → agentLoop(provider, messages, ...) → onTextDelta streams
 *        tokens to stdout live → tool calls render as cards → on turn end we
 *        re-render the assistant text as markdown → statusline footer.
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

const RUNTIME = './runtime/agent/orchestrator';

/** Help text shared by `--help` and the `/help` slash command. */
const HELP_LINES = [
  'mixdog-cli — a pi-based CLI/TUI coding agent (standalone mixdog brain).',
  '',
  'Usage:',
  '  mixdog-cli [--provider <name>] [--model <name>]',
  '  mixdog-cli --help',
  '  mixdog-cli --pi            (temporary: boot the vendored pi reference)',
  '',
  'Slash commands (inside the REPL):',
  '  /help              show this help',
  '  /clear             reset the conversation and clear the screen',
  '  /model <name>      switch model for subsequent turns',
  '  /exit              quit',
  '',
  'History: use ↑ / ↓ to recall previous inputs.',
];

/** Print the `--help` text. Routed here so app.mjs stays untouched. */
export function printHelp(write = (s) => stdout.write(s)) {
  write(HELP_LINES.join('\n') + '\n');
}

export async function runRepl({ provider: providerName = 'anthropic-oauth', model = 'claude-opus-4-8' } = {}) {
  // `--help` short-circuits before any provider init so the smoke test (which
  // invokes `src/cli.mjs --help`) gets clean help output and a 0 exit. We read
  // argv here rather than editing app.mjs, keeping changes confined to the REPL.
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    printHelp();
    return 0;
  }

  const reg = await import(`${RUNTIME}/providers/registry.mjs`);
  const { agentLoop } = await import(`${RUNTIME}/session/loop.mjs`);
  const { BUILTIN_TOOLS } = await import(`${RUNTIME}/tools/builtin/builtin-tools.mjs`);

  // Code-agent tool set: read/edit/write/bash/grep/glob/list. The loop executes
  // these through our ported executeBuiltinTool. Drop host-only tools that have
  // no meaning in the standalone CLI.
  const HOST_ONLY = new Set(['diagnostics', 'open_config']);
  const tools = BUILTIN_TOOLS.filter((t) => !HOST_ONLY.has(t.name));

  await reg.initProviders({ [providerName]: { enabled: true } });
  const provider = reg.getProvider(providerName);
  if (!provider) {
    stdout.write(red(`mixdog-cli: provider "${providerName}" is not configured.`) + '\n');
    return 1;
  }

  // Mutable session state. `model` switches via /model without restarting.
  let activeModel = model;
  const stats = createSessionStats();
  const cwd = process.cwd();

  printBanner(providerName, activeModel, cwd);

  const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: promptText(),
    // historySize > 0 enables readline's built-in ↑/↓ recall of prior inputs.
    historySize: 200,
  });

  const messages = [];
  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }

    // --- Slash commands -----------------------------------------------------
    if (line.startsWith('/')) {
      const handled = await handleSlash(line, {
        rl,
        messages,
        getModel: () => activeModel,
        setModel: (m) => { activeModel = m; },
        provider: providerName,
        cwd,
      });
      if (handled === 'exit') {
        rl.close();
        return 0;
      }
      rl.setPrompt(promptText());
      rl.prompt();
      continue;
    }

    messages.push({ role: 'user', content: line });
    stdout.write('\n');

    let streamedText = '';
    let printedAny = false;
    try {
      const result = await agentLoop(
        provider,
        messages,
        activeModel,
        tools,
        async (_iter, calls) => {
          for (const c of calls || []) stdout.write('\n' + renderToolCard(c) + '\n');
        },
        cwd,
        {
          sessionId: 'mixdog-cli-repl',
          maxOutputTokens: 8000,
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

      messages.push({ role: 'assistant', content: result?.content ?? finalText ?? '' });

      // Per-turn statusline footer.
      stdout.write('\n' + (await renderStatusline({ provider: providerName, model: activeModel, cwd, stats })) + '\n');
    } catch (error) {
      stdout.write('\n' + red(`[error] ${error?.message || error}`) + '\n');
    }

    stdout.write('\n');
    rl.setPrompt(promptText());
    rl.prompt();
  }

  return 0;
}

// --- UI bits -----------------------------------------------------------------

function promptText() {
  return colorEnabled() ? cyan(bold('› ')) : '› ';
}

function printBanner(providerName, model, cwd) {
  const title = bold('mixdog-cli');
  const id = cyan(`${providerName}/${model}`);
  stdout.write(`${title} ${dim('—')} ${id} ${dim('·')} ${dim(basename(cwd))}\n`);
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
      ctx.messages.length = 0;
      // Clear screen + scrollback and home the cursor.
      stdout.write(colorEnabled() ? '\x1b[2J\x1b[3J\x1b[H' : '\n');
      stdout.write(dim('conversation reset.') + '\n');
      stdout.write((await renderStatusline({
        provider: ctx.provider, model: ctx.getModel(), cwd: ctx.cwd, stats: createSessionStats(),
      })) + '\n');
      return;

    case 'model':
      if (!arg) {
        stdout.write(yellow(`current model: ${ctx.getModel()}`) + '\n');
        stdout.write(dim('usage: /model <name>') + '\n');
        return;
      }
      ctx.setModel(arg);
      stdout.write(green(`✓ model → ${arg}`) + '\n');
      return;

    case 'exit':
    case 'quit':
      stdout.write(dim('bye.') + '\n');
      return 'exit';

    default:
      stdout.write(red(`unknown command: /${cmd}`) + dim('  (try /help)') + '\n');
      return;
  }
}
