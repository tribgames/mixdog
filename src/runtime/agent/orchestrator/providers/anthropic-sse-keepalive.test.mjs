import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSSEStream } from './anthropic-sse.mjs';

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const ping = frame({ type: 'ping' });
const start = frame({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } });
const blockStart = (index, content_block) => frame({ type: 'content_block_start', index, content_block });
const blockDelta = (index, delta) => frame({ type: 'content_block_delta', index, delta });
const blockStop = (index) => frame({ type: 'content_block_stop', index });
const messageDelta = frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
const stop = frame({ type: 'message_stop' });

async function run(...frames) {
  const kinds = [];
  const result = await parseSSEStream(
    new Response(frames.join(''), { status: 200 }),
    new AbortController().signal,
    () => {},
    (kind) => kinds.push(kind),
    null,
    {},
    null,
    null,
    {}
  );
  return { result, kinds };
}

test('a ping event is reported as a keepalive, never as semantic progress', async () => {
  const { kinds } = await run(ping, start, ping, ping, messageDelta, stop);
  assert.equal(kinds.filter((kind) => kind === 'keepalive').length, 3);
  assert.deepEqual(
    kinds.filter((kind) => kind === 'semantic'),
    ['semantic']
  );
});

test('a tool input streamed in fine-grained pieces assembles into the call arguments', async () => {
  const { result } = await run(
    start,
    blockStart(0, { type: 'tool_use', id: 'tu_1', name: 'write', input: {} }),
    blockDelta(0, { type: 'input_json_delta', partial_json: '{"path":"a.md",' }),
    ping,
    blockDelta(0, { type: 'input_json_delta', partial_json: '"content":"hi"}' }),
    blockStop(0),
    messageDelta,
    stop
  );
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.md', content: 'hi' });
});

test('a truncated tool input at stop is still an invalid-args call, not a dropped one', async () => {
  const { result } = await run(
    start,
    blockStart(0, { type: 'tool_use', id: 'tu_1', name: 'write', input: {} }),
    blockDelta(0, { type: 'input_json_delta', partial_json: '{"path":"a.md","content":"unfin' }),
    blockStop(0),
    messageDelta,
    stop
  );
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'tu_1');
  assert.notDeepEqual(result.toolCalls[0].arguments, { path: 'a.md', content: 'unfin' });
});
