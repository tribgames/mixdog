/**
 * repl/slash-commands.mjs — the REPL's `/command` table. Every command writes
 * to `ctx.out`; only `/exit` and `/quit` return 'exit'.
 */
import { dim, green, red, yellow, colorEnabled } from '../ui/ansi.mjs';
import { printHelp } from '../help.mjs';
import { createSessionStats } from '../ui/session-stats.mjs';
import { statuslineFor } from './turn-output.mjs';

async function clearConversation(ctx) {
  const { out } = ctx;
  const runtime = await ctx.ensureRuntime();
  await runtime.clear();
  const fresh = createSessionStats();
  for (const k of Object.keys(fresh)) ctx.stats[k] = fresh[k];
  // Clear screen + scrollback and home the cursor.
  out.write(colorEnabled() ? '\x1b[2J\x1b[3J\x1b[H' : '\n');
  out.write(`${dim('conversation reset.')}\n`);
  out.write(`${await statuslineFor(ctx.renderStatusline, { runtime, cwd: ctx.cwd, stats: ctx.stats })}\n`);
}

async function compactConversation(ctx) {
  const { out } = ctx;
  const runtime = await ctx.ensureRuntime();
  const r = await runtime.compact();
  if (!r) {
    out.write(`${yellow('compact failed')}\n`);
    return;
  }
  if (r.error) {
    out.write(`${red('compact failed')}\n`);
    return;
  }
  if (r.changed === false) {
    out.write(`${yellow(r.reason || 'nothing to compact')}\n`);
    return;
  }
  out.write(
    `${green(
      `✓ compacted context: ${r.beforeMessages}→${r.afterMessages} messages, context ${r.beforeTokens}→${r.afterTokens}`
    )}\n`
  );
}

async function setModel(ctx, arg) {
  const { out } = ctx;
  if (!arg) {
    const runtime = ctx.getRuntime?.();
    const provider = runtime?.provider || ctx.providerName || 'auto';
    const currentModel = runtime?.model || ctx.model || 'default';
    out.write(`${yellow(`current model: ${provider}/${currentModel}`)}\n`);
    out.write(`${dim('usage: /model <preset-or-model>')}\n`);
    return;
  }
  const runtime = await ctx.ensureRuntime();
  await runtime.setRoute({ model: arg });
  out.write(`${green(`✓ model → ${runtime.provider}/${runtime.model}`)}\n`);
}

async function setOutputStyle(ctx, arg) {
  const { out } = ctx;
  const runtime = await ctx.ensureRuntime();
  const lower = arg.toLowerCase();
  if (!arg || lower === 'status' || lower === 'current' || lower === 'show') {
    const status = runtime.getOutputStyle?.() || runtime.listOutputStyles?.();
    const label = status?.current?.label || status?.current?.id || status?.configured || 'Default';
    const available = (status?.styles || []).map((style) => style.label || style.id).join(', ');
    out.write(`${yellow(`current output style: ${label}`)}\n`);
    if (available) out.write(`${dim(`available: ${available}`)}\n`);
    return;
  }
  const result = await runtime.setOutputStyle(arg);
  const label = result?.current?.label || result?.current?.id || arg;
  const suffix = result?.appliedToCurrentSession === false ? ' (use /clear to apply to this chat)' : '';
  out.write(`${green(`✓ output style → ${label}${suffix}`)}\n`);
}

async function setMode(ctx, arg) {
  const { out } = ctx;
  if (!arg) {
    const runtime = ctx.getRuntime?.();
    out.write(`${yellow(`current mode: ${runtime?.toolMode || ctx.toolMode}`)}\n`);
    out.write(`${dim('usage: /mode full|readonly')}\n`);
    return;
  }
  const runtime = await ctx.ensureRuntime();
  await runtime.setToolMode(arg);
  out.write(`${green(`✓ mode → ${runtime.toolMode}`)}\n`);
}

/**
 * Handle a `/command` line. Returns 'exit' to quit, otherwise undefined.
 */
export async function handleSlash(line, ctx) {
  const { out } = ctx;
  const [rawCmd, ...rest] = line.slice(1).split(/\s+/);
  const cmd = String(rawCmd || '').toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case 'help':
      printHelp();
      return;
    case 'clear':
      await clearConversation(ctx);
      return;
    case 'compact':
      await compactConversation(ctx);
      return;
    case 'model':
      await setModel(ctx, arg);
      return;
    case 'outputstyle':
    case 'output-style':
    case 'style':
      await setOutputStyle(ctx, arg);
      return;
    case 'mode':
      await setMode(ctx, arg);
      return;
    case 'exit':
    case 'quit':
      await ctx.closeRuntime?.('cli-exit');
      out.write(`${dim('bye.')}\n`);
      return 'exit';
    default:
      out.write(`${red(`unknown command: /${cmd}`) + dim('  (try /help)')}\n`);
      return;
  }
}
