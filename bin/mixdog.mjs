#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_KEYS, ensureNativeLayout, nativeCandidates, platformPackageName, resolveNativeProgram } from './native-layout.mjs';
import { skipsHostPrelude } from './invocation.mjs';
import { performPendingSwap } from './staged-swap.mjs';

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

/** What `main` starts: the native program of this install, or, right after a staged update replaced the package, this launcher again from the new one. */
export function launchPlan({ packageRoot, swapped, argv = process.argv.slice(2), env = process.env, execPath = process.execPath }) {
  if (swapped) {
    // The new package's launcher runs with a clean module cache; the variable stops it from swapping and starting again in its turn.
    return { program: execPath, args: [join(packageRoot, 'bin', 'mixdog.mjs'), ...argv], env: { ...env, MIXDOG_SWAP_REEXEC: '1' }, windowsHide: true, reexec: true };
  }
  const found = resolveNativeProgram({ packageRoot });
  if (!found) return { error: missingProgramMessage() };
  try {
    // The manifest the core reads beside its programs: written by the install, and here when the install's scripts did not run.
    ensureNativeLayout({ folder: found.folder, packageRoot, platform: found.platform, arch: found.arch });
  } catch (error) {
    return { error: `mixdog: cannot prepare ${found.folder}: ${error.message}\nReinstall as a user who may write there: npm install -g mixdog\n` };
  }
  return { program: found.program, args: argv, env: nativeEnv(env, execPath), windowsHide: false };
}

/**
 * 1.4.5's order: a staged update waiting for a clean start is applied before anything of the package is used, except on the
 * invocations that never touch the host's data folder (`mixdog exec` and the refusals made before the host matters).
 */
export function swapBeforeLaunch(argv, options, swap = performPendingSwap) {
  return !skipsHostPrelude(argv) && swap(options);
}

function main() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const argv = process.argv.slice(2);
  const plan = launchPlan({ packageRoot, swapped: swapBeforeLaunch(argv, { packageRoot }), argv });
  // The terminal sends an interrupt to the child as well: this process waits for the child to answer it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => {});
    } catch {
      // A signal this platform does not have.
    }
  }
  startPlan({ plan, fallback: () => launchPlan({ packageRoot, swapped: false, argv }) });
}

/**
 * Starts what `plan` names and ends this process with its exit code. A re-run after a swap that cannot be started falls back to
 * `fallback()`, the native program in place with what the swap put on disk, as 1.4.5 did; any other failure to start is an error.
 */
export function startPlan({ plan, fallback, spawnProcess = spawn, exit = (code) => process.exit(code), stderr = process.stderr }) {
  if (plan.error) {
    stderr.write(plan.error);
    exit(1);
    return;
  }
  const child = spawnProcess(plan.program, plan.args, { stdio: 'inherit', env: plan.env, windowsHide: plan.windowsHide });
  child.on('error', (error) => {
    if (plan.reexec) {
      startPlan({ plan: fallback(), fallback, spawnProcess, exit, stderr });
      return;
    }
    stderr.write(`mixdog: cannot start ${plan.program}: ${error.message}\n`);
    exit(1);
  });
  child.on('exit', (code, signal) => exit(exitCodeOf(code, signal)));
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
