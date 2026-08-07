import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateDoneCategories,
  aggregateToolCategoryEntries,
  displayToolName,
  formatAggregateHeader,
} from '../src/runtime/shared/tool-surface.mjs';

const mixedPatch = `*** Begin Patch
*** Add File: added.txt
+new
*** Delete File: deleted.txt
*** Update File: changed.txt
@@
-before
+after
*** End Patch`;

test('mixed apply_patch operations retain separate aggregate actions', () => {
  const args = { patch: mixedPatch };
  const entries = aggregateToolCategoryEntries('apply_patch', args, 'Patch');
  assert.deepEqual(
    entries.map(({ active, done, count }) => ({ active, done, count })),
    [
      { active: 'Creating', done: 'Created', count: 1 },
      { active: 'Deleting', done: 'Deleted', count: 1 },
      { active: 'Editing', done: 'Edited', count: 1 },
    ],
  );
  assert.equal(displayToolName('apply_patch', args), 'Change');

  const categories = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
  assert.equal(
    formatAggregateHeader(categories, { order: entries.map((entry) => entry.key) }),
    'Created 1 file, Deleted 1 file, Edited 1 file',
  );
  assert.deepEqual(
    Object.values(aggregateDoneCategories([{ name: 'apply_patch', args, category: 'Patch' }]))
      .map(({ done, count }) => ({ done, count })),
    [
      { done: 'Created', count: 1 },
      { done: 'Deleted', count: 1 },
      { done: 'Edited', count: 1 },
    ],
  );
});
