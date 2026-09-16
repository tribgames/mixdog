import assert from 'node:assert/strict';
import test from 'node:test';

import { heapCapMb, withHeapCap } from './heap-cap.mjs';

test('memory and session-runtime stay capped; daemon defaults to V8 own sizing', () => {
  // Memory runtime 259MB peak, session-runtime shares the daemon's transcripts.
  // Daemon no longer carries a fixed 768MB ceiling; MIXDOG_DAEMON_HEAP_MB still
  // applies a cap when set.
  assert.equal(heapCapMb('daemon', {}), 0);
  assert.equal(heapCapMb('memory', {}), 512);
  assert.equal(heapCapMb('session-runtime', {}), 768);
  assert.deepEqual(withHeapCap('memory', [], {}), ['--max-old-space-size=512']);
  assert.deepEqual(withHeapCap('session-runtime', ['--require', 'x'], {}), [
    '--require',
    'x',
    '--max-old-space-size=768',
  ]);
});

test('an unrecognised role is left to V8 entirely', () => {
  assert.equal(heapCapMb('not-a-role', {}), 0);
  assert.deepEqual(withHeapCap('not-a-role', ['--require', 'x'], {}), ['--require', 'x']);
});

test('the daemon default injects no old-space flag and keeps caller flags', () => {
  assert.deepEqual(withHeapCap('daemon', ['--require', 'preload.cjs'], {}), ['--require', 'preload.cjs']);
});

test('an env override replaces the default', () => {
  assert.deepEqual(withHeapCap('memory', [], { MIXDOG_MEMORY_HEAP_MB: '1024' }), ['--max-old-space-size=1024']);
});

test('an explicit daemon heap override is injected without dropping caller flags', () => {
  assert.deepEqual(withHeapCap('daemon', ['--require', 'preload.cjs'], { MIXDOG_DAEMON_HEAP_MB: '2048' }), [
    '--require',
    'preload.cjs',
    '--max-old-space-size=2048',
  ]);
});

test('zero restores V8 own sizing, so a bad cap can be switched off', () => {
  assert.equal(heapCapMb('daemon', { MIXDOG_DAEMON_HEAP_MB: '0' }), 0);
  assert.deepEqual(withHeapCap('daemon', ['--require', 'x'], { MIXDOG_DAEMON_HEAP_MB: '0' }), ['--require', 'x']);
});

test('a cap the caller already chose is never doubled', () => {
  assert.deepEqual(withHeapCap('daemon', ['--max-old-space-size=256'], {}), ['--max-old-space-size=256']);
  assert.deepEqual(withHeapCap('daemon', ['--max-old-space-size=256'], { MIXDOG_DAEMON_HEAP_MB: '2048' }), [
    '--max-old-space-size=256',
  ]);
});

test('a malformed override keeps the default rather than removing the cap', () => {
  for (const bad of ['abc', '-5', '   ']) {
    assert.deepEqual(
      withHeapCap('session-runtime', [], { MIXDOG_SESSION_RUNTIME_HEAP_MB: bad }),
      ['--max-old-space-size=768'],
      `override ${JSON.stringify(bad)} must not disable the cap`
    );
    assert.deepEqual(
      withHeapCap('daemon', [], { MIXDOG_DAEMON_HEAP_MB: bad }),
      [],
      `override ${JSON.stringify(bad)} must keep the daemon's uncapped default`
    );
  }
});

test('the caller execArgv array is never mutated', () => {
  const base = ['--require', 'x'];
  withHeapCap('daemon', base, {});
  assert.deepEqual(base, ['--require', 'x']);
});
