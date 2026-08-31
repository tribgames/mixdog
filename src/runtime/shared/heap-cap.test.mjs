import assert from 'node:assert/strict';
import test from 'node:test';

import { heapCapMb, withHeapCap } from './heap-cap.mjs';

test('every long-lived role is capped above its measured peak', () => {
  // daemon peak heapUsed 268MB, memory runtime 259MB — each cap leaves room
  // for a spike without letting V8 sprawl toward the 4GB default.
  assert.equal(heapCapMb('daemon', {}), 768);
  assert.equal(heapCapMb('memory', {}), 512);
  assert.equal(heapCapMb('session-runtime', {}), 768);
});

test('an unrecognised role is left to V8 entirely', () => {
  assert.equal(heapCapMb('not-a-role', {}), 0);
  assert.deepEqual(withHeapCap('not-a-role', ['--require', 'x'], {}), ['--require', 'x']);
});

test('the cap joins execArgv without dropping flags the caller needs', () => {
  assert.deepEqual(
    withHeapCap('daemon', ['--require', 'preload.cjs'], {}),
    ['--require', 'preload.cjs', '--max-old-space-size=768'],
  );
});

test('an env override replaces the default', () => {
  assert.deepEqual(
    withHeapCap('memory', [], { MIXDOG_MEMORY_HEAP_MB: '1024' }),
    ['--max-old-space-size=1024'],
  );
});

test('zero restores V8 own sizing, so a bad cap can be switched off', () => {
  assert.equal(heapCapMb('daemon', { MIXDOG_DAEMON_HEAP_MB: '0' }), 0);
  assert.deepEqual(withHeapCap('daemon', ['--require', 'x'], { MIXDOG_DAEMON_HEAP_MB: '0' }), ['--require', 'x']);
});

test('a cap the caller already chose is never doubled', () => {
  assert.deepEqual(
    withHeapCap('daemon', ['--max-old-space-size=256'], {}),
    ['--max-old-space-size=256'],
  );
});

test('a malformed override keeps the default rather than removing the cap', () => {
  for (const bad of ['abc', '-5', '   ']) {
    assert.deepEqual(
      withHeapCap('daemon', [], { MIXDOG_DAEMON_HEAP_MB: bad }),
      ['--max-old-space-size=768'],
      `override ${JSON.stringify(bad)} must not disable the cap`,
    );
  }
});

test('the caller execArgv array is never mutated', () => {
  const base = ['--require', 'x'];
  withHeapCap('daemon', base, {});
  assert.deepEqual(base, ['--require', 'x']);
});
