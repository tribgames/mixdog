import assert from 'node:assert/strict';
import test from 'node:test';
import { Virtualizer } from '@tanstack/virtual-core';
import { prependedRowsShift } from './transcript-prepend-anchor.ts';

// Laid-out rows carry measured sizes; freshly prepended rows start from the
// estimate until their own measurement lands.
function core(keys, sizes) {
  const virtualizer = new Virtualizer({
    count: keys.length,
    getScrollElement: () => null,
    estimateSize: () => 60,
    getItemKey: (index) => keys[index],
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  keys.forEach((key, index) => {
    virtualizer.getMeasurements();
    if (sizes[key] !== undefined) virtualizer.resizeItem(index, sizes[key]);
  });
  return virtualizer;
}

function relayout(virtualizer, keys) {
  virtualizer.setOptions({ ...virtualizer.options, count: keys.length, getItemKey: (index) => keys[index] });
}

function shiftFor(previousKeys, virtualizer, keys) {
  return prependedRowsShift({
    previousKeys,
    indexOfKey: (key) => keys.indexOf(key),
    startOf: (index) => virtualizer.getMeasurements()[index]?.start,
    sizeOfKey: (key) => virtualizer.itemSizeCache.get(key) ?? 60,
    paddingStart: virtualizer.options.paddingStart ?? 0,
  });
}

test('an older page prepended above the reader shifts the offset by exactly its height', () => {
  const sizes = { h0: 120, h1: 40, h2: 300, r0: 80, r1: 200, r2: 90, r3: 50 };
  const before = ['r0', 'r1', 'r2', 'r3'];
  const virtualizer = core(before, sizes);
  const readerOffset = 230; // inside r1 (80..280)
  const anchorBefore = virtualizer.getMeasurements()[1];
  const after = ['h0', 'h1', 'h2', ...before];
  relayout(virtualizer, after);
  const shift = shiftFor(before, virtualizer, after);
  assert.equal(shift, 180, 'three prepended rows at the 60px estimate');
  const anchorAfter = virtualizer.getMeasurements()[after.indexOf('r1')];
  // The row under the reader keeps its on-screen position.
  assert.equal(readerOffset + shift - anchorAfter.start, readerOffset - anchorBefore.start);
});

test('appends, streaming updates and unchanged heads never move the reader', () => {
  const keys = ['a', 'b', 'c'];
  const virtualizer = core(keys, {});
  const appended = [...keys, 'd'];
  relayout(virtualizer, appended);
  assert.equal(shiftFor(keys, virtualizer, appended), 0);
});

test('a regrouped first row falls back to the next surviving row', () => {
  const sizes = { g0: 100, a: 70, b: 30 };
  const before = ['g0', 'a', 'b'];
  const virtualizer = core(before, sizes);
  // g0 merged with older rows into g1: a now starts after h0 + g1 (two 60px
  // estimates) = 120; it started at 100, so the reader moves by 20.
  const after = ['h0', 'g1', 'a', 'b'];
  relayout(virtualizer, after);
  assert.equal(shiftFor(before, virtualizer, after), 20);
});

test('a replaced history with no surviving row leaves the offset alone', () => {
  const before = ['x', 'y'];
  const virtualizer = core(before, {});
  const after = ['p', 'q', 'r'];
  relayout(virtualizer, after);
  assert.equal(shiftFor(before, virtualizer, after), 0);
});
