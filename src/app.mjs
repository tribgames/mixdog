import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the vendored pi coding-agent compiled entry. */
const VENDOR_CLI = join(__dirname, '..', 'vendor', 'pi', 'packages', 'coding-agent', 'dist', 'cli.js');

/** Local mixdog gateway (Anthropic-compatible HTTP server). */
const GATEWAY_URL = process.env.MIXDOG_GATEWAY_URL ?? 'http://127.0.0.1:3468';

/**
 * Stage 1 brain wiring: point pi's Anthropic provider at the local mixdog
 * gateway. The gateway owns real provider routing + OAuth-bypass spoofing, so
 * pi never touches the blocked subscription-OAuth path — it just speaks plain
 * Anthropic SSE to loopback. A dummy api key satisfies pi's env-key auth so it
 * skips the OAuth code path entirely (the gateway does not validate the key).
 * See docs/design/port-plan.md §5.6 / D4.
 */
function gatewayEnv() {
  return {
    ...process.env,
    MIXDOG_ANTHROPIC_BASE_URL: GATEWAY_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'mixdog-gateway',
  };
}

/**
 * mixdog-cli launcher.
 *
 * DEFAULT: the ported mixdog brain (our agentLoop + provider + builtin tools)
 * runs directly — this is the product. pi's engine is bypassed entirely.
 *
 * `--pi` boots the vendored pi coding-agent instead. This is a TEMPORARY
 * reference escape hatch used only while we port pi's TUI widgets (input
 * editor, markdown/tool-card rendering) onto our engine. Once the TUI layer is
 * ported, `--pi` and the entire vendor/pi tree are removed (strangler: the host
 * is fully consumed). See docs/design/port-plan.md D9/D10.
 */
export async function run(argv = []) {
  // TEMPORARY reference path — remove once pi's TUI widgets are ported.
  if (argv.includes('--pi')) {
    return await runVendoredPi(argv.filter((a) => a !== '--pi'));
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
  // repl.mjs (single source of truth) and is exported as printHelp(); the smoke
  // test runs `src/cli.mjs --help` and greps for `pi-based CLI/TUI`.
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

/** Boot the vendored pi coding-agent (temporary reference path; see `--pi`). */
async function runVendoredPi(argv) {
  if (!existsSync(VENDOR_CLI)) {
    process.stderr.write(
      [
        'mixdog-cli: vendored pi build not found.',
        `  expected: ${VENDOR_CLI}`,
        '',
        'Build it once with:',
        '  cd vendor/pi && npm install && npm run build',
        '',
      ].join('\n'),
    );
    return 1;
  }

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [VENDOR_CLI, ...argv], {
      stdio: 'inherit',
      env: gatewayEnv(),
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        // Re-raise the signal exit shape so the shell sees it correctly.
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
    child.on('error', (error) => {
      process.stderr.write(`mixdog-cli: failed to launch vendored pi — ${error?.message || error}\n`);
      resolve(1);
    });
  });
}
