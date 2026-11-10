import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSSEStream } from './anthropic-sse.mjs';

const MESSAGE_START = 'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{}}}\n\n';
const ERROR_FRAME = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';

function run(body, options) {
  const response = new Response(body, { status: 200 });
  return parseSSEStream(response, new AbortController().signal, () => {}, null, null, {}, null, null, options);
}

test('the API-key provider labels SSE errors with its own name', async () => {
  await assert.rejects(run(ERROR_FRAME, { labels: { display: 'Anthropic', tag: 'anthropic' } }), (err) => {
    assert.match(err.message, /^Anthropic SSE error overloaded_error: busy$/);
    return true;
  });
  await assert.rejects(run(MESSAGE_START, { labels: { display: 'Anthropic', tag: 'anthropic' } }), (err) => {
    assert.match(err.message, /^Anthropic SSE stream truncated/);
    return true;
  });
});

test('the OAuth provider keeps its label by default', async () => {
  await assert.rejects(run(ERROR_FRAME), /Anthropic OAuth SSE error overloaded_error: busy/);
  await assert.rejects(run(MESSAGE_START), /Anthropic OAuth SSE stream truncated/);
});
