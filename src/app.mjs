import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ensureProcessListenerHeadroom } from './runtime/shared/process-listener-headroom.mjs';
import {
  classifyCliInvocation,
  parseHeadlessRoleCommand,
} from './headless-command.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

// Many independent singletons self-register a process 'exit' drain (session
// store, bash sessions, search/memory state, bridge trace, channel worker, …),
// which legitimately exceeds Node's default 10-listener warning threshold in a
// fully-loaded runtime. Raise the cap once at the CLI entry so a benign
// MaxListenersExceededWarning never leaks into the user's terminal.
ensureProcessListenerHeadroom(64);

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

export { parseHeadlessRoleCommand };

/**
 * mixdog launcher.
 *
 * The product path is the native mixdog runtime: session runtime, providers,
 * tools, and the canonical Ink TUI. Vendored reference code is not executable
 * from this entry point.
 */
export async function run(argv = []) {
  const invocation = classifyCliInvocation(argv);
  // Headless commands establish their own audited environment after route
  // validation; do not let an inherited MIXDOG_BOOT_PROFILE affect that path.
  if (invocation.kind !== 'headless' && invocation.skipHostPrelude !== true) {
    bootProfile('run:start', { argv: argv.join(',') });
  }
  if (invocation.kind === 'error') {
    process.stderr.write(`mixdog: ${invocation.error}\n`);
    return 1;
  }
  const opts = invocation.options;

  // `--help` / `-h`: keep this path tiny; do not import the REPL/runtime stack.
  if (invocation.kind === 'help') {
    const { printHelp } = await import('./help.mjs');
    printHelp();
    return 0;
  }

  // `--plain`: the OLD readline REPL, kept as a strangler fallback.
  if (invocation.kind === 'plain') {
    const { runRepl } = await import('./repl.mjs');
    return await runRepl(opts);
  }

  if (invocation.kind === 'react') {
    process.stderr.write('mixdog: --react was removed; run `mixdog` for the canonical TUI.\n');
    return 1;
  }

  if (invocation.kind === 'headless') {
    const { validateExplicitPristineRoute } = await import(
      './runtime/shared/pristine-execution.mjs'
    );
    const routeError = validateExplicitPristineRoute(opts);
    if (routeError) {
      process.stderr.write(`mixdog: ${routeError}\n`);
      return 1;
    }
    const { runHeadlessRole } = await import('./headless-role.mjs');
    return await runHeadlessRole({
      agent: invocation.headless.agent,
      message: invocation.headless.message,
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
  // Stale-bundle guard: a dist built before hot runtime sources caused weeks
  // of ghost failures (compaction placeholder patches) that no longer existed
  // in src. Sample a few hot files — a newer source than the bundle means the
  // running behavior will NOT match the tree, so warn loudly.
  try {
    const { statSync } = await import('node:fs');
    const bundleMtime = statSync(bundle).mtimeMs;
    const hotSources = [
      join(__dirname, 'runtime', 'agent', 'orchestrator', 'session', 'agent-loop.mjs'),
      join(__dirname, 'runtime', 'agent', 'orchestrator', 'session', 'loop', 'stored-tool-args.mjs'),
      join(__dirname, 'tui', 'engine', 'session-api-ext.mjs'),
      join(__dirname, 'standalone', 'agent-tool.mjs'),
    ];
    const stale = hotSources.some((file) => {
      try { return statSync(file).mtimeMs > bundleMtime + 1_000; } catch { return false; }
    });
    if (stale) {
      process.stderr.write(
        'mixdog: TUI bundle is OLDER than runtime sources — behavior will not match the tree.\n'
        + '  Rebuild with: npm run build:tui\n',
      );
    }
  } catch { /* advisory only */ }
  const { runTui } = await import('./tui/dist/index.mjs');
  bootProfile('tui:imported');
  return await runTui(opts);
}
