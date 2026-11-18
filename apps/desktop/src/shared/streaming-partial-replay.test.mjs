// The desktop's partial-append step: when its main process sends a session's state to its renderer (ipc-state-bridge.ts
// `sendSessionState` -> state-delta.ts `partialAppend` -> `streamingPartialSuffix`), a growing unfinished line goes as the text
// appended to the one before, else as the whole partial.
import assert from 'node:assert/strict';
import test from 'node:test';
import { streamingPartialSuffix } from './streaming-partial.ts';

const partial = (text, extra = {}) => ({ id: 'a1', from: 0, text, ...extra });

test('the suffix is what the later partial appends to the earlier one of the same line', () => {
  assert.equal(streamingPartialSuffix(partial('hel'), partial('hello')), 'lo');
  assert.equal(streamingPartialSuffix(partial(''), partial('hi')), 'hi');
  assert.equal(streamingPartialSuffix(partial('x', { from: 4 }), partial('xyz', { from: 4 })), 'yz');
});

test('no suffix when the text did not grow from the earlier one', () => {
  assert.equal(streamingPartialSuffix(partial('hello'), partial('hello')), null);
  assert.equal(streamingPartialSuffix(partial('hello'), partial('hel')), null);
  assert.equal(streamingPartialSuffix(partial('hello'), partial('jello world')), null);
});

test('no suffix when the line is another row, offset or identity', () => {
  assert.equal(streamingPartialSuffix(partial('a'), partial('ab', { id: 'a2' })), null);
  assert.equal(streamingPartialSuffix(partial('a'), partial('ab', { from: 1 })), null);
  assert.equal(streamingPartialSuffix(partial('a', { tail: { id: 'a1' } }), partial('ab')), null);
});

test('no suffix when either side is not a record with a text', () => {
  assert.equal(streamingPartialSuffix(null, partial('a')), null);
  assert.equal(streamingPartialSuffix(partial('a'), undefined), null);
  assert.equal(streamingPartialSuffix([], partial('a')), null);
  assert.equal(streamingPartialSuffix({ id: 'a1' }, partial('a')), null);
  assert.equal(streamingPartialSuffix(partial('a'), { id: 'a1', from: 0, text: 5 }), null);
});
