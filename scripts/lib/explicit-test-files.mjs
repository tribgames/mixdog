// The explicit file arguments of scripts/test-direct.mjs that match nothing.
// `node --test <glob>` exits 0 on a glob that matches no file, so a suite whose
// directory was deleted stayed green running zero tests. A run that names a file
// or a pattern must find at least one file for each.
import { existsSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

// Node options whose value is the next argument, not a test file.
const VALUE_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-timeout',
  '--test-concurrency',
  '--test-shard',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-isolation',
  '--test-coverage-include',
  '--test-coverage-exclude',
]);
const GLOB_CHARS = /[*?[\]{}]/;
const TEST_FILE = /\.(?:m?js|cjs|m?ts)$/;

export function filePatterns(argv) {
  const patterns = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) index++;
      continue;
    }
    if (/^file:/i.test(arg)) continue;
    if (GLOB_CHARS.test(arg) || TEST_FILE.test(arg)) patterns.push(arg);
  }
  return patterns;
}

export function unmatchedPatterns(argv, { cwd = process.cwd(), exists = existsSync, expand = globSync } = {}) {
  return filePatterns(argv).filter((pattern) =>
    GLOB_CHARS.test(pattern) ? expand(pattern, { cwd }).length === 0 : !exists(resolve(cwd, pattern))
  );
}
