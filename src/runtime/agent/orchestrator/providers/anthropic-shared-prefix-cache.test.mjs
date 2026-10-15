// A cache-sharing fork (a /btw side question) re-sends an earlier request's
// messages plus a suffix. Its message breakpoint must stay where the earlier
// request put it, so the fork reads that entry and writes none for the suffix.
import assert from 'node:assert/strict';
import test from 'node:test';

import { _buildRequestBodyForCacheSmoke } from './anthropic-oauth.mjs';
import { buildAnthropicApiRequest } from './anthropic-api-request.mjs';

const MODEL = 'claude-sonnet-4-5';
const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];

// A mid-turn request: it ends with a tool result.
const PREFIX = [
  { role: 'system', content: 'You are the Lead.' },
  { role: 'user', content: 'Refactor the parser.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
  { role: 'tool', toolCallId: 'call_1', content: 'export function parse() {}' },
];
const SUFFIX = [
  { role: 'assistant', content: 'Now editing.', toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'b' } }] },
  { role: 'tool', toolCallId: 'call_2', content: 'handled by the main task' },
  { role: 'user', content: '<side-question>Where is parse?</side-question>', meta: { source: 'steering' } },
];

function markedPositions(messages) {
  const marks = [];
  messages.forEach((message, index) => {
    (Array.isArray(message.content) ? message.content : []).forEach((block, blockIndex) => {
      if (block?.cache_control) marks.push([index, blockIndex]);
    });
  });
  return marks;
}

const builders = {
  'anthropic-oauth': async (messages, opts) => _buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, opts),
  anthropic: async (messages, opts) =>
    (
      await buildAnthropicApiRequest({
        name: 'anthropic',
        config: {},
        messages,
        useModel: MODEL,
        tools: TOOLS,
        opts,
        fastModeLatched: false,
      })
    ).params,
};

for (const [name, build] of Object.entries(builders)) {
  test(`${name}: a fork keeps the saved request's message breakpoint and writes none on its suffix`, async () => {
    const original = await build(PREFIX, {});
    const [[markIndex, markBlock]] = markedPositions(original.messages);
    assert.equal(markIndex, original.messages.length - 1, 'the saved request marks its own tail');

    const fork = await build([...PREFIX, ...SUFFIX], { sharedCachePrefixCount: PREFIX.length });
    assert.deepEqual(markedPositions(fork.messages), [[markIndex, markBlock]]);
    // Byte-identical shared prefix (marker included), system blocks and tools.
    assert.deepEqual(fork.messages.slice(0, markIndex + 1), original.messages);
    assert.deepEqual(fork.system, original.system);
    assert.deepEqual(fork.tools, original.tools);
    assert.ok(fork.messages.length > original.messages.length);
  });

  test(`${name}: an ordinary request still marks its tail`, async () => {
    const body = await build([...PREFIX, ...SUFFIX], {});
    const marks = markedPositions(body.messages);
    assert.deepEqual(marks.at(-1)?.[0], body.messages.length - 1);
  });

  test(`${name}: a fork whose prefix is not in the request writes no message breakpoint`, async () => {
    const fork = await build([...PREFIX, ...SUFFIX], { sharedCachePrefixCount: PREFIX.length + SUFFIX.length + 1 });
    assert.deepEqual(markedPositions(fork.messages), []);
  });

  test(`${name}: the breakpoint stays on the shared prefix after a JSON round-trip of request and options`, async () => {
    const original = await build(PREFIX, {});
    const [[markIndex, markBlock]] = markedPositions(original.messages);
    const wire = JSON.parse(JSON.stringify({ messages: [...PREFIX, ...SUFFIX], opts: { sharedCachePrefixCount: PREFIX.length } }));
    const fork = await build(wire.messages, wire.opts);
    assert.deepEqual(markedPositions(fork.messages), [[markIndex, markBlock]]);
    assert.deepEqual(fork.messages.slice(0, markIndex + 1), original.messages);
  });
}
