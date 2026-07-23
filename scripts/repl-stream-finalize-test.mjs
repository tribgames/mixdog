import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStreamFinalPatch } from '../src/ui/stream-finalize.mjs';

test('terminal finalization rewrites only changed logical rows', () => {
  const patch = buildStreamFinalPatch(
    'plain line\n**bold** line\nuntouched',
    'plain line\n\u001b[1mbold\u001b[22m line\nuntouched',
    { columns: 80 },
  );
  assert.ok(patch);
  assert.equal(patch.changedRows, 1);
  assert.equal((patch.output.match(/\x1b\[2K/g) || []).length, 1);
  assert.match(patch.output, /\x1b\[1mbold\x1b\[22m line/);
});

test('terminal finalization skips output when final text is already identical', () => {
  const patch = buildStreamFinalPatch('same\ntext', 'same\ntext', { columns: 80 });
  assert.deepEqual(patch, { output: '', changedRows: 0, totalRows: 2 });
});

test('terminal finalization falls back for row-count changes and wrapping', () => {
  assert.equal(buildStreamFinalPatch('one', 'one\ntwo', { columns: 80 }), null);
  assert.equal(buildStreamFinalPatch('12345678', '12345678', { columns: 8 }), null);
});
