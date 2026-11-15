#!/usr/bin/env node
// The `mixdog` command of the npm package: starts the native program the package carries for this platform
// (native-bin/<platform>-<arch>/mixdog) with the same arguments and the same terminal, and ends with its exit code.
// Nothing of the product runs in this process.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder of the package's native programs for a platform, and the program in it. */
export function nativeProgram(packageRoot, platform = process.platform, arch = process.arch) {
  const folder = join(packageRoot, 'native-bin', `${platform}-${arch}`);
  return { folder, program: join(folder, platform === 'win32' ? 'mixdog.exe' : 'mixdog') };
}

/**
 * The environment of the native program: this process's, with the folder of the Node that runs this file first on the
 * search path. The install's js-runtime.json names the script interpreter as `node`; it is the one npm installed with.
 */
export function nativeEnv(env = process.env, execPath = process.execPath) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const current = env[key] ?? '';
  return { ...env, [key]: current ? `${dirname(execPath)}${delimiter}${current}` : dirname(execPath) };
}

/** The exit code of a child that ended with `code` or by `signal` (128 + the signal's number, as a shell reports it). */
export function exitCodeOf(code, signal, signals = SIGNAL_NUMBERS) {
  if (typeof code === 'number') return code;
  return 128 + (signals[signal] ?? 0);
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };

function main() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const { folder, program } = nativeProgram(packageRoot);
  if (!existsSync(program)) {
    process.stderr.write(
      `mixdog: this package has no program for ${process.platform}-${process.arch} (looked for ${program}).\n` +
        `Reinstall it (npm install -g mixdog), or see ${folder} for what was installed.\n`
    );
    process.exit(1);
  }
  const child = spawn(program, process.argv.slice(2), { stdio: 'inherit', env: nativeEnv(), windowsHide: false });
  // The terminal sends an interrupt to the child as well: this process waits for the child to answer it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => {});
    } catch {
      // A signal this platform does not have.
    }
  }
  child.on('error', (error) => {
    process.stderr.write(`mixdog: cannot start ${program}: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(exitCodeOf(code, signal)));
}

/** Whether this file is the program being run (npm starts it through a link or a shim that names it). */
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
