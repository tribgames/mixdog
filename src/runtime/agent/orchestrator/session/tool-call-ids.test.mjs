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
      if (sends <= 2)
        return { content: '', toolCalls: [{ id: 'call_1', name: 'definitely_missing_dup_id_tool', arguments: {} }] };
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

const call = (id) => ({ id, name: 't', arguments: {} });
const turn = (...ids) => [
  { role: 'assistant', content: '', toolCalls: ids.map(call) },
  ...ids.map((id) => ({ role: 'tool', toolCallId: id, content: 'r' })),
];
const withHistory = (...ids) => [{ role: 'user', content: 'x' }, ...turn(...ids)];
const idsOf = (calls) => calls.map((c) => c.id);
const assertUnique = (ids) => assert.equal(new Set(ids).size, ids.length, `ids must be unique: ${ids}`);

test('resolver: only ids the history already carries are renamed, consistently within a round', () => {
  const resolve = createToolCallIdResolver([...withHistory('a'), ...turn('a-2')]);
  const streamed = call('a');
  assert.equal(resolve(streamed).id, 'a-3');
  assert.equal(resolve(streamed).id, 'a-3', 'the same call object resolves again to the same id');
  const [final] = resolve.all([call('a')]);
  assert.equal(final.id, 'a-3', 'the final-batch copy of the streamed call');
  assert.equal(resolve(call('b')).id, 'b');
  assert.equal(resolve({ name: 't', arguments: {} }).id, undefined);
});

test('resolver: history {a}, batch {a, a-2} yields two distinct ids', () => {
  const batch = [call('a'), call('a-2')];
  createToolCallIdResolver(withHistory('a')).all(batch);
  assert.deepEqual(idsOf(batch), ['a-3', 'a-2'], 'the unclaimed a-2 keeps its id, the clash moves past it');
});

test('resolver: batch {a-2, a} in either order stays distinct', () => {
  const batch = [call('a-2'), call('a')];
  createToolCallIdResolver(withHistory('a')).all(batch);
  assert.deepEqual(idsOf(batch), ['a-2', 'a-3']);
  const noHistory = [call('a-2'), call('a')];
  createToolCallIdResolver([{ role: 'user', content: 'x' }]).all(noHistory);
  assert.deepEqual(idsOf(noHistory), ['a-2', 'a']);
});

test('resolver: batch {a, a} gets two distinct ids, with and without history', () => {
  const fresh = [call('a'), call('a')];
  createToolCallIdResolver([{ role: 'user', content: 'x' }]).all(fresh);
  assert.deepEqual(idsOf(fresh), ['a', 'a-2']);
  const clash = [call('a'), call('a')];
  createToolCallIdResolver(withHistory('a')).all(clash);
  assert.deepEqual(idsOf(clash), ['a-2', 'a-3']);
});

test('resolver: streamed calls (clones) and the final batch agree and stay distinct', () => {
  const resolve = createToolCallIdResolver(withHistory('a'));
  const streamed = [resolve(call('a')), resolve(call('a-2')), resolve(call('a'))];
  assertUnique(idsOf(streamed));
  const final = [call('a'), call('a-2'), call('a')];
  resolve.all(final);
  assert.deepEqual(idsOf(final), idsOf(streamed), 'result pairing follows the streamed ids');
  assertUnique(idsOf(final));
  assert.ok(!idsOf(final).includes('a'), 'the id the history holds is never reused');
});

test('resolver: a streamed object that is also in the final batch keeps its renamed id', () => {
  const resolve = createToolCallIdResolver(withHistory('a'));
  const shared = resolve(call('a'));
  const other = call('a');
  const batch = [shared, other];
  resolve.all(batch);
  assert.equal(batch[0].id, shared.id);
  assertUnique(idsOf(batch));
});

test('resolver: repeated rounds that all answer the same id never collide', () => {
  const messages = [{ role: 'user', content: 'x' }];
  const seen = [];
  for (let round = 0; round < 5; round += 1) {
    const batch = [call('call_1'), call('call_1')];
    createToolCallIdResolver(messages).all(batch);
    seen.push(...idsOf(batch));
    messages.push(...turn(...idsOf(batch)));
  }
  assertUnique(seen);
  assert.equal(seen.length, 10);
  const streamedRounds = [{ role: 'user', content: 'x' }];
  const streamedSeen = [];
  for (let round = 0; round < 5; round += 1) {
    const resolve = createToolCallIdResolver(streamedRounds);
    const batch = [resolve(call('call_1')), resolve(call('call_1-2'))];
    resolve.all([call('call_1'), call('call_1-2')]);
    streamedSeen.push(...idsOf(batch));
    streamedRounds.push(...turn(...idsOf(batch)));
  }
  assertUnique(streamedSeen);
});
