import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
// --workflow is consumed (with its value) but ignored on the headless role
// path: workflow selection is Lead-session-scoped. Accepting it keeps a
// mistakenly passed `--workflow X` from leaking "X" into the role message.
const VALUE_OPTIONS = new Set(['--provider', '--model', '--effort', '--workflow']);
const FLAG_OPTIONS = new Set(['--readonly', '--help', '-h', '--plain', '--react', '--remote', '--onboarding']);
const HEADLESS_FLAG_OPTIONS = new Set(['--fast']);
const HEADLESS_ROLE_ALIASES = new Map([
  ['explorer', 'explore'],
  ['explore', 'explore'],
  ['maint', 'maintainer'],
  ['maintenance', 'maintainer'],
  ['maintainer', 'maintainer'],
  ['worker', 'worker'],
  ['heavy', 'heavy-worker'],
  ['heavyworker', 'heavy-worker'],
  ['heavy-worker', 'heavy-worker'],
  ['review', 'reviewer'],
  ['reviewer', 'reviewer'],
  ['debug', 'debugger'],
  ['debugger', 'debugger'],
  ['web', 'web-researcher'],
  ['web-researcher', 'web-researcher'],
]);
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

// Many independent singletons self-register a process 'exit' drain (session
// store, bash sessions, search/memory state, bridge trace, channel worker, …),
// which legitimately exceeds Node's default 10-listener warning threshold in a
// fully-loaded runtime. Raise the cap once at the CLI entry so a benign
// MaxListenersExceededWarning never leaks into the user's terminal.
try { process.setMaxListeners(Math.max(process.getMaxListeners(), 64)); } catch { /* ignore */ }

function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, `app:${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch {}
}

function unknownOption(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) continue;
    if (HEADLESS_FLAG_OPTIONS.has(arg)) continue;
    if (String(arg || '').startsWith('-')) return arg;
  }
  return null;
}

function positionalArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) continue;
    if (HEADLESS_FLAG_OPTIONS.has(arg)) continue;
    if (String(arg || '').startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

function normalizeHeadlessAgent(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return HEADLESS_ROLE_ALIASES.get(key) || null;
}

export function parseHeadlessRoleCommand(argv = []) {
  const args = positionalArgs(argv);
  if (args.length === 0) return null;

  if (String(args[0] || '').toLowerCase() === 'role') {
    return { error: 'usage: mixdog <role> <message...>' };
  }

  const agent = normalizeHeadlessAgent(args[0]);
  if (!agent) return null;
  const message = args.slice(1).join(' ').trim();
  if (!message) return { error: `usage: mixdog ${args[0]} <message...>` };
  return { agent, message };
}

/**
 * mixdog launcher.
 *
 * The product path is the native mixdog runtime: session runtime, providers,
 * tools, and the canonical Ink TUI. Vendored reference code is not executable
 * from this entry point.
 */
export async function run(argv = []) {
  bootProfile('run:start', { argv: argv.join(',') });
  const badOption = unknownOption(argv);
  if (badOption) {
    process.stderr.write(`mixdog: unknown option ${badOption}\n`);
    return 1;
  }

  const provIdx = argv.indexOf('--provider');
  const modelIdx = argv.indexOf('--model');
  const effortIdx = argv.indexOf('--effort');
  const toolMode = argv.includes('--readonly') ? 'readonly' : 'full';
  const remote = argv.includes('--remote');
  const forceOnboarding = argv.includes('--onboarding');
  const opts = {
    provider: provIdx >= 0 ? argv[provIdx + 1] : undefined,
    model: modelIdx >= 0 ? argv[modelIdx + 1] : undefined,
    effort: effortIdx >= 0 ? argv[effortIdx + 1] : undefined,
    fast: argv.includes('--fast'),
    toolMode,
    remote,
    forceOnboarding,
  };

  // `--help` / `-h`: keep this path tiny; do not import the REPL/runtime stack.
  if (argv.includes('--help') || argv.includes('-h')) {
    const { printHelp } = await import('./help.mjs');
    printHelp();
    return 0;
  }

  // `--plain`: the OLD readline REPL, kept as a strangler fallback.
  if (argv.includes('--plain')) {
    const { runRepl } = await import('./repl.mjs');
    return await runRepl(opts);
  }

  if (argv.includes('--react')) {
    process.stderr.write('mixdog: --react was removed; run `mixdog` for the canonical TUI.\n');
    return 1;
  }

  const headless = parseHeadlessRoleCommand(argv);
  if (headless?.error) {
    process.stderr.write(`mixdog: ${headless.error}\n`);
    return 1;
  }
  if (headless) {
    const { runHeadlessRole } = await import('./headless-role.mjs');
    return await runHeadlessRole({
      agent: headless.agent,
      message: headless.message,
      provider: opts.provider,
      model: opts.model,
      effort: opts.effort,
      fast: opts.fast,
      cwd: process.cwd(),
    });
  }

  // Default: the canonical React/Ink TUI over the mixdog session runtime.
  // DEV convenience (opt-in via MIXDOG_TUI_DEV): rebuild the JSX bundle from
  // source before launch so local edits reflect without a manual build. The
  // dev module is excluded from the published package ("files" negation) and
  // esbuild is a devDependency, so this is a no-op fallback on any install.
  if (process.env.MIXDOG_TUI_DEV) {
    try {
      const { rebuildTuiFromSource } = await import('./tui/dev/jit-rebuild.mjs');
      await rebuildTuiFromSource();
    } catch (err) {
      if (process.env.MIXDOG_TUI_DEV_VERBOSE) {
        process.stderr.write(`mixdog[tui-dev]: rebuild skipped — ${err?.message ?? err}\n`);
      }
    }
  }
  const bundle = join(__dirname, 'tui', 'dist', 'index.mjs');
  if (!existsSync(bundle)) {
    process.stderr.write(
      'mixdog: TUI bundle not found. Build it with:\n  npm run build:tui\n',
    );
    return 1;
  }
  const { runTui } = await import('./tui/dist/index.mjs');
  bootProfile('tui:imported');
  return await runTui(opts);
}
