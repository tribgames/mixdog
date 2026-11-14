// Loader for the shared TS/Rust parity case files (native/core/crates/mixdog-testkit/parity/<name>.json).
// The Rust side is mixdog_testkit::parity; both read the same file and report mismatches by case id.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PARITY_DIR = join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-testkit', 'parity');

/** The cases of `<PARITY_DIR>/<name>.json`, in file order: [{ id, input, expect }]. Throws when the file is malformed. */
export function loadCases(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new Error(`parity: invalid case file name ${JSON.stringify(name)}`);
  }
  const path = join(PARITY_DIR, `${name}.json`);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  if (file?.name !== name) throw new Error(`parity: ${path}: "name" is ${JSON.stringify(file?.name)}, expected ${JSON.stringify(name)}`);
  if (!Array.isArray(file.cases)) throw new Error(`parity: ${path}: "cases" is not an array`);
  const seen = new Set();
  return file.cases.map((entry, index) => {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') throw new Error(`parity: ${path}: case ${index} has no string "id"`);
    if (!('input' in entry) || !('expect' in entry)) throw new Error(`parity: ${path}: case ${entry.id} needs "input" and "expect"`);
    if (seen.has(entry.id)) throw new Error(`parity: ${path}: duplicate case id ${entry.id}`);
    seen.add(entry.id);
    return { id: entry.id, input: entry.input, expect: entry.expect };
  });
}

/** Throws an AssertionError naming the file and the case id unless `actual` deep-equals the case's `expect`. */
export function assertCase(parityCase, actual, name = '') {
  try {
    assert.deepStrictEqual(actual, parityCase.expect);
  } catch (error) {
    error.message = `parity${name ? ` ${name}` : ''} case ${parityCase.id}: ${error.message}`;
    throw error;
  }
}
