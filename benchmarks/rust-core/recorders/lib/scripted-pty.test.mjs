import assert from 'node:assert/strict';
import test from 'node:test';
import { takeChunks } from './scripted-pty.mjs';

test('each ended chunk is one data event whatever the pipe joined or split', () => {
  const events = [];
  let pending = '';
  for (const piece of ['one\r\ntwo\r\n\x1esp', 'l', 'it\x1e\x1elast\x1eun']) {
    const { chunks, rest } = takeChunks(pending + piece);
    pending = rest;
    events.push(...chunks);
  }
  assert.deepEqual(events, ['one\r\ntwo\r\n', 'split', 'last']);
  assert.equal(pending, 'un');
});
