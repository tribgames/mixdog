import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserRefSet } from './ref-recovery.ts';
import { diffSnapshotElements } from './snapshot-diff.ts';

test('state ordering and refreshed refs are not changes, while focus and values remain visible', () => {
  const elements = [
    { ref: 'old1', role: 'textbox', name: 'Email', value: 'a', states: ['required', 'focused'] },
    { ref: 'old2', role: 'button', name: 'Save', states: [] },
    { ref: 'old3', role: 'textbox', name: 'Name', value: 'before' },
  ];
  const previous = createBrowserRefSet({ elements });
  const next = [
    { ...elements[0], ref: 'new1', states: ['focused', 'required'] },
    { ...elements[1], ref: 'new2', states: ['focused'] },
    { ...elements[2], ref: 'new3', value: 'after' },
  ];
  const diff = diffSnapshotElements(next, previous);
  assert.deepEqual(diff, { changed: [next[1], next[2]], unchanged: 1, gone: 0 });
});

test('duplicate semantic controls preserve multiplicity and true removals remain reported', () => {
  const elements = [
    { ref: 'old1', role: 'button', name: 'Item', states: ['disabled'] },
    { ref: 'old2', role: 'button', name: 'Item', states: [] },
    { ref: 'old3', role: 'button', name: 'Removed', states: [] },
  ];
  const previous = createBrowserRefSet({ elements });
  const next = [{ ...elements[1], ref: 'new1' }, { role: 'button', name: 'Added', ref: 'new2' }];
  assert.deepEqual(diffSnapshotElements(next, previous), { changed: [next[1]], unchanged: 1, gone: 2 });
});
