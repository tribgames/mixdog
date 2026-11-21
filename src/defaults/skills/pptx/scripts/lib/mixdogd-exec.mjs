// Headless one-shot for the QC and review scripts: `mixdogd exec` (native/core/crates/mixdog-cli/src/exec).
// The answer goes to `write`, errors to `writeErr`, and the exit code is returned.
// `toolMode` maps to `--tool-mode readonly|full`.
import { spawn } from 'node:child_process';

export function mixdogdBin(env = process.env) {
  return env.MIXDOGD_BIN || 'mixdogd';
}

/** The `mixdogd exec` arguments for one run. */
export function mixdogdExecArgs({
  message,
  provider,
  model,
  effort,
  cwd,
  webSearch = false,
  usageLogPath,
  toolMode = 'full',
}) {
  const args = ['exec', '--provider', provider, '--model', model];
  if (effort) args.push('--effort', effort);
  if (cwd) args.push('--cwd', cwd);
  if (webSearch) args.push('--web-search');
  if (usageLogPath) args.push('--usage-log', usageLogPath);
  args.push('--tool-mode', toolMode, '--', message);
  return args;
}

/** Runs `mixdogd exec` hidden and resolves its exit code; a spawn failure resolves 1 with the error on `writeErr`. */
export function runMixdogdExec(options, { spawnImpl = spawn, env = process.env } = {}) {
  const { write = () => {}, writeErr = () => {} } = options;
  return new Promise((resolveCode) => {
    const child = spawnImpl(mixdogdBin(env), mixdogdExecArgs(options), {
      cwd: options.cwd || undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => write(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => writeErr(chunk));
    child.once('error', (error) => {
      writeErr(`mixdogd exec could not start: ${error.message}\n`);
      resolveCode(1);
    });
    child.once('close', (code) => resolveCode(code ?? 1));
  });
}
