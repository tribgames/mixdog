import assert from 'node:assert/strict';
import test from 'node:test';
import { capMarker, formatCapSize, windowMarker } from './tool-output-marker.mjs';

test('window markers say which slice was requested and where it continues', () => {
  assert.equal(windowMarker({ from: 5, to: 27, total: 90, nextOffset: 28 }), '[lines 5-27 of 90; offset:28 for more]');
  assert.equal(windowMarker({ from: 5, to: 90, total: 90 }), '[lines 5-90 of 90]');
  assert.equal(
    windowMarker({ unit: 'chars', from: 0, to: 10, total: 30, nextOffset: 10, offsetKey: 'startIndex' }),
    '[chars 0-10 of 30; startIndex:10 for more]'
  );
  assert.equal(
    windowMarker({ from: 1, to: 5, total: 20, nextOffset: 6, capBytes: 512 }),
    '[lines 1-5 of 20; output capped at 512 bytes; offset:6 for more]'
  );
});

test('cap markers always carry a continuation and name the full output path when one exists', () => {
  assert.equal(formatCapSize(5 * 1024), '5 KB');
  assert.equal(formatCapSize(1536), '1.5 KB');
  assert.equal(
    capMarker({ limit: 5 * 1024, shown: '63 match row(s) shown', nextOffset: 63 }),
    '[output capped at 5 KB; 63 match row(s) shown; offset:63 for more]'
  );
  assert.equal(capMarker({ limit: 1024, cursor: 'abc' }), '[output capped at 1 KB; cursor:abc for more]');
  // No offset or cursor: narrowing advice is supplied, never omitted.
  assert.match(capMarker({ limit: 1024 }), /^\[output capped at 1 KB; narrow: .+\]$/);
  assert.equal(
    capMarker({ limit: '500 rows', narrow: 'narrow the path', fullPath: 'C:/tmp/out.txt' }),
    '[output capped at 500 rows; narrow: narrow the path; full output: C:/tmp/out.txt]'
  );
});
