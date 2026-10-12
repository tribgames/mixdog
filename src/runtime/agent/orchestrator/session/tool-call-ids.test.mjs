import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import { createToolCallIdResolver } from './loop/tool-call-ids.mjs';

function session() {
  return {
    id: 'dup-tool-call-id-test',
    owner: 'agent',
    agent: 'worker',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
  };
}

test('a provider that reuses a tool call id across turns still gets every result back', async () => {
  // Local and OpenAI-compatible servers answer `call_1` on every turn. The
  // pairing repair used to drop the second turn as a duplicate with no result,
  // so the model never saw the result and asked again, forever.
  const s = session();
  const requests = [];
  let sends = 0;
  const provider = {
    async send(messages) {
      sends += 1;
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (sends > 6) return { content: 'runaway', toolCalls: [], stopReason: 'end_turn' };
      if (sends <= 2) return { content: '', toolCalls: [{ id: 'call_1', name: 'definitely_missing_dup_id_tool', arguments: {} }] };
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const results = [];
  const result = await agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [], null, process.cwd(), {
    session: s,
    sessionId: s.id,
    onToolResult: (message) => results.push(message.toolCallId),
  });
  assert.equal(result.content, 'done');
  assert.equal(sends, 3, 'one request per turn, no re-asking');
  const last = requests.at(-1);
  const calls = last.filter((m) => m.role === 'assistant').flatMap((m) => (m.toolCalls || []).map((c) => c.id));
  const answered = last.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  assert.equal(new Set(calls).size, 2, 'the two calls carry distinct ids');
  assert.deepEqual(answered.sort(), [...calls].sort(), 'each call has its own result');
  assert.deepEqual([...new Set(results)].sort(), [...calls].sort());
});

test('resolver: only ids the history already carries are renamed, consistently within a round', () => {
  const history = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'a', content: 'r' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a-2', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'a-2', content: 'r' },
  ];
  const resolve = createToolCallIdResolver(history);
  const streamed = resolve({ id: 'a', name: 't', arguments: {} });
  assert.equal(streamed.id, 'a-3');
  assert.equal(resolve({ id: 'a', name: 't', arguments: {} }).id, 'a-3', 'the same call in the final response');
  assert.equal(resolve({ id: 'b', name: 't', arguments: {} }).id, 'b');
  assert.equal(resolve({ name: 't', arguments: {} }).id, undefined);
});