import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { MixdogLocalProvider } from './mixdog-local.mjs';
import { toLocalProviderMessages } from './mixdog-local-wire.mjs';

test('local normalization preserves instruction text and conversation without mutating session history', () => {
  const history = [
    { role: 'system', content: 'base', cacheTier: 'tier1' },
    { role: 'system', content: [{ type: 'text', text: 'profile' }], cacheTier: 'tier2' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'runtime instructions' },
    { role: 'assistant', content: 'reply' },
  ];
  const saved = structuredClone(history);
  assert.deepEqual(toLocalProviderMessages(history), [
    { role: 'system', content: 'base\n\nprofile\n\nruntime instructions' },
    history[2], history[4],
  ]);
  assert.deepEqual(history, saved);
  assert.throws(() => toLocalProviderMessages([
    { role: 'system', content: [{ type: 'image_url', image_url: { url: 'not-text' } }] },
  ]), /text only/);
});

test('local provider streams a tool call and consumes its result with a strict single-system endpoint', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const invalid = body.messages.some((message, index) => message.role === 'system' && index !== 0);
    if (invalid) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'System message must be at the beginning.' } }));
      return;
    }
    const followup = body.messages.at(-1).role === 'tool';
    const delta = followup ? { content: 'The result is 42.' } : {
      tool_calls: [{ index: 0, id: 'call_local', type: 'function', function: { name: 'lookup', arguments: '{"key":"answer"}' } }],
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({
      id: 'local-response', model: body.model,
      choices: [{ index: 0, delta, finish_reason: followup ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const seenSignals = [];
  const provider = new MixdogLocalProvider({}, {
    ensureServer: async (_model, { signal }) => {
      seenSignals.push(signal);
      return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-key' };
    },
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const messages = ['base', 'profile', 'workflow', 'environment'].map((content) => ({ role: 'system', content }));
  messages.push({ role: 'user', content: 'Look up the answer.' });
  const tools = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
  const dispatched = [];
  try {
    const first = await provider.send(messages, 'test-local', tools, { signal, onToolCall: (call) => dispatched.push(call) });
    assert.equal(first.toolCalls.length, 1);
    assert.equal(dispatched.length, 1);
    assert.equal(first.toolCalls[0].name, 'lookup');
    assert.deepEqual(first.toolCalls[0].arguments, { key: 'answer' });
    messages.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls });
    messages.push({ role: 'tool', toolCallId: first.toolCalls[0].id, content: '42' });
    const second = await provider.send(messages, 'test-local', tools, { signal });
    assert.equal(second.content, 'The result is 42.');
    assert.equal(second.stopReason, 'stop');
    assert.equal(requests.length, 2);
    // The request queue hands the server a request-scoped signal derived from
    // the caller's, so aborting the caller aborts every server wait it began.
    assert.equal(seenSignals.length, 2);
    assert.ok(seenSignals.every((seen) => seen instanceof AbortSignal && !seen.aborted));
    controller.abort();
    assert.ok(seenSignals.every((seen) => seen.aborted));
    assert.equal(requests[1].messages.at(-1).tool_call_id, 'call_local');
    assert.equal(requests[1].messages[0].content, 'base\n\nprofile\n\nworkflow\n\nenvironment');
    assert.equal(messages.filter((message) => message.role === 'system').length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cancelled local sends never start a model server', async () => {
  const provider = new MixdogLocalProvider({}, { ensureServer: () => assert.fail('must not start') });
  await assert.rejects(provider.send([], 'test', [], {
    signal: AbortSignal.abort(new Error('cancelled')),
  }), /cancelled/);
});
