import assert from 'node:assert/strict';
import test from 'node:test';

import { __cursorModelInternals } from './cursor.mjs';

const { responseSseEvents } = __cursorModelInternals;

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('a malformed data frame is skipped and the well-formed frames around it are yielded', async () => {
  const events = [];
  const body = 'data: {"n":1}\n\ndata: {not json\n\ndata: {"n":2}\n\ndata: [DONE]\n\n';
  for await (const event of responseSseEvents(sseResponse(body), null)) events.push(event);
  assert.deepEqual(events, [{ n: 1 }, { n: 2 }]);
});
