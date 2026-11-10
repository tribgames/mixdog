import assert from 'node:assert/strict';
import test from 'node:test';
import { frameAndParseSse, frameSseRegion } from './sse-framing.mjs';

test('data and event lines frame with or without the optional space after the colon', () => {
  const { frames, currentEvent } = frameSseRegion('event:a\ndata:{"n":1}\n\nevent: b\ndata: {"n":2}\n\n');
  assert.deepEqual(frames, [
    { name: 'a', data: '{"n":1}' },
    { name: 'b', data: '{"n":2}' },
  ]);
  assert.equal(currentEvent, 'b');
});

test('comments, blank data and other fields are still dropped', () => {
  const { frames } = frameSseRegion(': ping\nid: 7\ndata:\ndata: \nretry: 5\ndata:x\n');
  assert.deepEqual(frames, [{ name: '', data: 'x' }]);
});

test('a spaceless data line parses into an event', () => {
  const { events } = frameAndParseSse('data:{"ok":true}\n');
  assert.deepEqual(events, [{ name: '', value: { ok: true } }]);
});
