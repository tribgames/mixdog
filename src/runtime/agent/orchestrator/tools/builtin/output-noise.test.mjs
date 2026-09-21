import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGrepFanoutSections } from './lib/grep-output.mjs';
import { sliceReadBodyByLines } from './read-batch.mjs';
import { wrapPatchMutationOutput } from '../patch/mutation-output.mjs';

test('missing path is reported once across patterns, distinct errors stay distinct', () => {
  const error = 'Error: path does not exist: /missing (ENOENT)';
  assert.equal(formatGrepFanoutSections({ dimension: 'pattern', labels: ['a', 'b'], bodies: [error, error] }), error);
  const output = formatGrepFanoutSections({
    dimension: 'pattern',
    labels: ['a', 'b'],
    bodies: [error, 'Error: invalid regex'],
  });
  assert.match(output, /ENOENT/);
  assert.match(output, /invalid regex/);
});

test('read continuation retains exact range and next coordinate without advice', () => {
  const output = sliceReadBodyByLines('1→a\n2→b\n3→c\n[lines 1-3 of 10]', 0, 2);
  assert.equal(output, '1→a\n2→b\n[lines 1-2 of 10; pass offset:3 to continue]');
});

test('mixed pattern failures retain their attribution and order without repeated missing-path text', () => {
  const error = 'Error: path does not exist: /missing (ENOENT)';
  const output = formatGrepFanoutSections({
    dimension: 'pattern',
    labels: ['a', 'b', '[', 'c'],
    bodies: [error, error, 'Error: invalid regex [', 'found.txt:7:c'],
  });
  assert.equal(
    output,
    '# grep patterns:["a","b"]\n' +
      error +
      '\n\n# grep pattern:"["\nError: invalid regex [' +
      '\n\n# grep pattern:"c"\nfound.txt:7:c'
  );
});

test('patch success rows replace redundant engine headings without hiding diagnostics', () => {
  const output = wrapPatchMutationOutput(
    'Applied 1 File (Native)\n  OK Modify a.mjs — +1/-1\nwarning: ambiguous context'
  );
  assert.equal(output, '  OK Modify a.mjs — +1/-1\nwarning: ambiguous context');
  const error = 'Applied 1 File (Native)\n  Error: rejected';
  assert.equal(wrapPatchMutationOutput(error), error);
});
