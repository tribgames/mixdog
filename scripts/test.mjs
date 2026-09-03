#!/usr/bin/env node
// Discovery-based test entry (docs/testing.md). A test file joins the suite
// by existing; its lane comes from its name, never from a hand-kept list:
//
//   *.test.mjs        fast   the default lane; every push, every local run
//   *.slow.test.mjs   slow   files over ~10s; their own CI job
//   *.live.test.mjs   live   need a built artifact or a live system
//
// Usage: node scripts/test.mjs [--lane fast|slow|live|all] [--list]
//                              [--import <spec>]... [--test-*]... [filter...]
//   filter   substring of a file path; only matching files run.
//   --import forwarded to node (desktop passes its test-env and tsx loaders).
//   --test-* forwarded to node --test (e.g. --test-name-pattern, --test-only).
//
// Runs from the package that invokes it: `src/` and `scripts/` under cwd are
// the roots, so the root package and apps/desktop share this one entry.
import { spawn } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOTS = ['src', 'scripts'];
const PATTERNS = ['**/*.test.mjs', '**/*-test.mjs'];
const EXCLUDED_DIRS = new Set(['node_modules', '.runtime', 'out', 'dist', 'target']);
// A file URL: node resolves reporter specifiers through the ESM loader, which
// rejects a bare Windows drive path as an unknown "c:" scheme.
const REPORTER = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'lib', 'test-timing-reporter.mjs')).href;

export function laneOf(file) {
  if (/\.live\.test\.mjs$/.test(file)) return 'live';
  if (/\.slow\.test\.mjs$/.test(file)) return 'slow';
  return 'fast';
}

export function parseArgs(argv) {
  const options = { lane: 'fast', list: false, nodeArgs: [], filters: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--lane') options.lane = argv[++index];
    else if (arg.startsWith('--lane=')) options.lane = arg.slice('--lane='.length);
    else if (arg === '--list') options.list = true;
    else if (arg === '--import') options.nodeArgs.push(arg, argv[++index]);
    else if (arg.startsWith('--import=') || arg.startsWith('--test-')) options.nodeArgs.push(arg);
    else options.filters.push(arg.replaceAll('\\', '/'));
  }
  if (!['fast', 'slow', 'live', 'all'].includes(options.lane)) {
    throw new Error(`unknown lane "${options.lane}" (fast|slow|live|all)`);
  }
  return options;
}

export async function discoverTestFiles(cwd = process.cwd()) {
  const files = new Set();
  for (const root of ROOTS) {
    for (const pattern of PATTERNS) {
      for await (const entry of glob(`${root}/${pattern}`, {
        cwd,
        exclude: (path) => String(path).split(/[\\/]/).some((segment) => EXCLUDED_DIRS.has(segment)),
      })) files.add(entry.replaceAll('\\', '/'));
    }
  }
  return [...files].sort();
}

export function selectTestFiles(files, { lane, filters }) {
  return files
    .filter((file) => lane === 'all' || laneOf(file) === lane)
    .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = selectTestFiles(await discoverTestFiles(), options);
  if (options.list) {
    for (const file of files) console.log(`${laneOf(file).padEnd(5)} ${file}`);
    return;
  }
  if (files.length === 0) {
    console.error(`no ${options.lane} test files match ${options.filters.join(' ') || '(everything)'}`);
    process.exitCode = 1;
    return;
  }
  const args = [
    ...options.nodeArgs,
    '--test',
    // A suite that leaves a handle open (a session runtime closed without
    // waiting for its children) must not hang the whole run.
    '--test-force-exit',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`, '--test-reporter-destination=stderr',
    ...files,
  ];
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) await main();
