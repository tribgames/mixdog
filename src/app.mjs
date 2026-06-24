import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALUE_OPTIONS = new Set(['--provider', '--model']);
const FLAG_OPTIONS = new Set(['--readonly', '--help', '-h', '--plain', '--react']);

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
 * mixdog-cli launcher.
 *
 * The product path is the native mixdog runtime: session runtime, providers,
 * tools, and the canonical Ink TUI. Vendored reference code is not executable
 * from this entry point.
 */
export async function run(argv = []) {
  const badOption = unknownOption(argv);
  if (badOption) {
    process.stderr.write(`mixdog-cli: unknown option ${badOption}\n`);
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

  // `--help` / `-h`: print the help text and exit 0. The help source lives in
  // repl.mjs (single source of truth) and is exported as printHelp().
  if (argv.includes('--help') || argv.includes('-h')) {
    const { printHelp } = await import('./repl.mjs');
    printHelp();
    return 0;
  }

  // `--plain`: the OLD readline REPL, kept as a strangler fallback.
  if (argv.includes('--plain')) {
    const { runRepl } = await import('./repl.mjs');
    return await runRepl(opts);
  }

  if (argv.includes('--react')) {
    process.stderr.write('mixdog-cli: --react was removed; run `mixdog-cli` for the canonical TUI.\n');
    return 1;
  }

  // Default: the canonical React/Ink TUI over the mixdog session runtime.
  const bundle = join(__dirname, 'tui', 'dist', 'index.mjs');
  if (!existsSync(bundle)) {
    process.stderr.write(
      'mixdog-cli: TUI bundle not found. Build it with:\n  npm run build:tui\n',
    );
    return 1;
  }
  const { runTui } = await import('./tui/dist/index.mjs');
  return await runTui(opts);
}
