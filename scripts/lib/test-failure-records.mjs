// Structured failure records for the run-level failure summary.
//
// Node keeps ownership of diagnostics, totals and exit status; this only
// records "which test failed, in which file" as one JSON line each, so the
// runner can name every failure after all other output even when the run log
// was filtered (scripts/lib/run-node-tests.mjs).
//
// It rides the existing summary reporter instead of adding a third node:test
// reporter: a third reporter pushes the shared TestsStream past its listener
// cap and every run would start with a MaxListenersExceededWarning.
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

export const FAILURE_RECORDS_ENV = 'MIXDOG_TEST_FAILURE_RECORDS';

// Ancestor names are tracked per file: node:test runs files concurrently, so
// one flat stack would mix their nestings.
export function failureRecord(event, stacks) {
  const file = event.data?.file ? relative(process.cwd(), String(event.data.file)).replaceAll('\\', '/') : '';
  if (event.type === 'test:start') {
    const stack = stacks.get(file) ?? [];
    stack.length = event.data.nesting;
    stack[event.data.nesting] = event.data.name;
    stacks.set(file, stack);
    return null;
  }
  if (event.type !== 'test:fail') return null;
  // A failing todo does not fail the run, and a suite reports its children's
  // failures as its own; only the leaves that decide the exit status belong
  // in the summary.
  if (event.data.todo) return null;
  if (event.data.details?.error?.failureType === 'subtestsFailed') return null;
  const ancestors = (stacks.get(file) ?? []).slice(0, event.data.nesting);
  return { file, name: [...ancestors, event.data.name].join(' > ') };
}

// The runner sets FAILURE_RECORDS_ENV to a per-spawn JSONL path. Without it
// nothing is recorded, so a direct `node --test` run is unaffected.
export function createFailureRecorder(path = process.env[FAILURE_RECORDS_ENV]) {
  if (!path) return () => {};
  const stacks = new Map();
  return (event) => {
    const record = failureRecord(event, stacks);
    if (record) appendFileSync(path, `${JSON.stringify(record)}\n`);
  };
}
