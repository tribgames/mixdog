import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALUE_OPTIONS = new Set(['--provider', '--model']);
const FLAG_OPTIONS = new Set(['--readonly', '--help', '-h', '--plain', '--react']);
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

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
    if (String(arg || '').startsWith('-')) return arg;
  }
  return null;
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
  const toolMode = argv.includes('--readonly') ? 'readonly' : 'full';
  const opts = {
    provider: provIdx >= 0 ? argv[provIdx + 1] : undefined,
    model: modelIdx >= 0 ? argv[modelIdx + 1] : undefined,
    toolMode,
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

  // Default: the canonical React/Ink TUI over the mixdog session runtime.
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
