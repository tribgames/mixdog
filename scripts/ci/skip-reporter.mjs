import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendPart } from './receipt.mjs';

// A `node --test` reporter that appends to the receipt named by its URL's `out` query one terminal record per reported test and suite
// (scripts/ci/receipt.mjs, scripts/ci/coverage/evidence.mjs): the full identity (file, the suites above it, its own name), the status,
// and for a skip or todo its reason text. A suite's event is kept: a skipped suite is a suite observation (its children are never
// reported) that no exception covers, never a pass.
// The synthetic event node emits for a file that registers nothing (named by its path) is not a case and is dropped. The runner adds this
// beside its own reporters and closes the receipt; it yields nothing. Files are repository-relative, whatever package the lane runs from.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function recordOf(data, type, ancestors, root = ROOT) {
  const { skip, todo, name, file, details } = data;
  const relativeFile = relative(root, file).split(sep).join('/');
  const suite = details?.type === 'suite';
  const reason = skip || todo;
  const reasonText = typeof reason === 'string' ? reason : '';
  const record = {
    kind: suite ? 'suite' : 'case',
    id: [suite ? 'node-suite' : 'node', relativeFile, ...ancestors, name],
  };
  if (type === 'test:fail') record.status = details?.error?.failureType === 'cancelledByParent' ? 'cancelled' : 'fail';
  else if (skip) record.status = 'skip';
  else if (todo) record.status = 'todo';
  else record.status = 'pass';
  if (record.status === 'skip' || record.status === 'todo') record.reasonText = reasonText;
  return record;
}

export default async function* skipReporter(source) {
  const target = new URL(import.meta.url).searchParams.get('out');
  // The suites above the event being reported, per file: node reports a test's start before its children's and its result after, in
  // tree order, so the names at the shallower nesting levels are its ancestors.
  const stacks = new Map();
  // One part per event, not one at the end: a run with --test-force-exit ends the process before a reporter's last line would run.
  for await (const event of source) {
    if (event.type === 'test:start' && event.data.file) {
      const stack = stacks.get(event.data.file) ?? [];
      stack.length = event.data.nesting;
      stack[event.data.nesting] = event.data.name;
      stacks.set(event.data.file, stack);
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, file, nesting } = event.data;
    if (!file || (nesting === 0 && name === file)) continue;
    appendPart(target, { records: [recordOf(event.data, event.type, (stacks.get(file) ?? []).slice(0, nesting))] });
  }
}
