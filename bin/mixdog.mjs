#!/usr/bin/env node
// The `mixdog` command of the npm package: starts the native program of the platform package npm installed for this
// machine (`mixdog-<platform>-<arch>`, an optional dependency of this package) with the same arguments and the same
// terminal, and ends with its exit code. Nothing of the product runs in this process.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_KEYS, ensureNativeLayout, nativeCandidates, platformPackageName, resolveNativeProgram } from './native-layout.mjs';

export { nativeCandidates, platformPackageName, resolveNativeProgram };

/** What to tell a user whose install has no program for this machine. */
export function missingProgramMessage(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const candidates = nativeCandidates(platform, arch);
  const names = candidates.map(platformPackageName).join(' or ');
  const supported = candidates.some((candidate) => SUPPORTED_KEYS.includes(candidate));
  const reason = supported
    ? `its package (${names}) is not installed: optional dependencies were disabled when mixdog was installed`
    : `${key} is not a platform mixdog supports (it supports ${SUPPORTED_KEYS.join(', ')})`;
  return (
    `mixdog: there is no program to start on ${key}: ${reason}.\n` +
    (supported ? 'Reinstall with optional dependencies enabled: npm install -g mixdog (not with --omit=optional or --no-optional).\n' : '')
  );
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
  const found = resolveNativeProgram({ packageRoot });
  if (!found) {
    process.stderr.write(missingProgramMessage());
    process.exit(1);
  }
  const { program } = found;
  try {
    // The manifest the core reads beside its programs: written by the install, and here when the install's scripts did not run.
    ensureNativeLayout({ folder: found.folder, packageRoot, platform: found.platform, arch: found.arch });
  } catch (error) {
    process.stderr.write(`mixdog: cannot prepare ${found.folder}: ${error.message}\nReinstall as a user who may write there: npm install -g mixdog\n`);
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
