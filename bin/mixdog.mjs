#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureNativeLayout } from './native-layout.mjs';
import { skipsHostPrelude } from './invocation.mjs';
import { dataDir, missingRuntimeMessage, provision, resolveRuntime } from './runtime.mjs';
import { performPendingSwap } from './staged-swap.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** What to tell a user on a machine the package has no runtime for. */
export function unsupportedMessage(platform, arch, supported) {
  const key = `${platform}-${arch}`;
  return `mixdog: there is no program to start on ${key}: ${key} is not a platform mixdog supports (it supports ${supported.join(', ')}).\n`;
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

/**
 * What `main` starts: the native program of this install's runtime, or, right after a staged update replaced the package,
 * this launcher again from the new one. `{ provision }` when the runtime is not in the user's cache yet.
 */
export function launchPlan({
  packageRoot,
  swapped,
  argv = process.argv.slice(2),
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  arch = process.arch,
}) {
  if (swapped) {
    // The new package's launcher runs with a clean module cache; the variable stops it from swapping and starting again in its turn.
    return { program: execPath, args: [join(packageRoot, 'bin', 'mixdog.mjs'), ...argv], env: { ...env, MIXDOG_SWAP_REEXEC: '1' }, windowsHide: true, reexec: true };
  }
  const found = resolveRuntime({ packageRoot, platform, arch, data: dataDir(env) });
  if (found.error) return { error: `mixdog: ${found.error}\n` };
  if (found.unsupported) return { error: unsupportedMessage(platform, arch, Object.keys(found.manifest.targets)) };
  if (found.missing) return { provision: found };
  try {
    // The cache is shared by every install of this version: the manifest names this one's package root.
    ensureNativeLayout({ folder: found.folder, packageRoot, platform: found.platform, arch: found.arch });
  } catch (error) {
    return { error: `mixdog: cannot prepare ${found.folder}: ${error.message}\n` };
  }
  return { program: found.program, args: argv, env: nativeEnv(env, execPath), windowsHide: false };
}

/** The plan once the runtime `found` misses is fetched (first use: the install's scripts did not run), else what to import. */
export async function provisionedPlan(found, replan, { packageRoot, env = process.env, stderr = process.stderr, fetchArchive, url } = {}) {
  try {
    await provision(found, { env, stderr, fetchArchive, url });
  } catch (error) {
    return { error: missingRuntimeMessage({ ...found, packageRoot, reason: error.message }) };
  }
  return replan();
}

/** `plan` with the runtime it misses fetched first; one still missing once fetched is an error, never a start of nothing. */
export async function readyPlan(plan, replan, options) {
  if (!plan.provision) return plan;
  const next = await provisionedPlan(plan.provision, replan, options);
  if (!next.provision) return next;
  return { error: missingRuntimeMessage({ ...next.provision, packageRoot: options.packageRoot, reason: 'it is not complete in the cache once fetched' }) };
}

/**
 * 1.4.5's order: a staged update waiting for a clean start is applied before anything of the package is used, except on the
 * invocations that never touch the host's data folder (`mixdog exec` and the refusals made before the host matters).
 */
export function swapBeforeLaunch(argv, options, swap = performPendingSwap) {
  return !skipsHostPrelude(argv) && swap(options);
}

/** The command: this file, and src/cli.mjs, which an install made by 1.4.5 still links its `mixdog` command to. */
export async function main({ packageRoot = PACKAGE_ROOT, argv = process.argv.slice(2) } = {}) {
  const replan = () => launchPlan({ packageRoot, swapped: false, argv });
  const ready = (plan) => readyPlan(plan, replan, { packageRoot });
  const plan = await ready(launchPlan({ packageRoot, swapped: swapBeforeLaunch(argv, { packageRoot }), argv }));
  // The terminal sends an interrupt to the child as well: this process waits for the child to answer it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => {});
    } catch {
      // A signal this platform does not have.
    }
  }
  startPlan({ plan, fallback: () => ready(replan()) });
}

/**
 * Starts what `plan` names and ends this process with its exit code. A re-run after a swap that cannot be started falls back to
 * the plan `fallback()` resolves to, the native program in place with what the swap put on disk, as 1.4.5 did; any other
 * failure to start is an error.
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
      fallback().then((next) => startPlan({ plan: next, fallback, spawnProcess, exit, stderr }));
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
