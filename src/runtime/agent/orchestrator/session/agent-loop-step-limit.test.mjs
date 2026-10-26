// No cap on how long a turn may run: a model that keeps calling failing tools,
// or the same successful call with the same result, is not stopped or told to
// reply by the runtime (only an explicit turnLimits cap, turn-limits.mjs, does).
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentLoop } from './agent-loop.mjs';

const ROUNDS = 45;

async function run(id, reply) {
  let sends = 0;
  const provider = {
    async send() {
      sends += 1;
      return reply(sends);
    },
  };
  const ref = { id, owner: 'agent', agent: 'worker', contextWindow: 200_000, compaction: { auto: false } };
  const messages = [{ role: 'user', content: 'go' }];
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: ref,
    sessionId: id,
    onToolResult(message) {
      if (message.role === 'tool' && id === 'sess-uncapped-replay') {
        message.toolKind = 'normal';
        message.content = 'same output';
      }
    },
  });
  return { sends, result, messages };
}

const call = (n) => ({
  content: `step ${n}`,
  toolCalls: [{ id: `c${n}`, name: 'probe', arguments: { path: 'a.txt' } }],
});
const finalTurn = { content: 'final answer', toolCalls: [], stopReason: 'end_turn' };

for (const id of ['sess-uncapped-failing', 'sess-uncapped-replay']) {
  test(`${id}: ${ROUNDS} rounds with no new result run to the model's own final answer`, async () => {
    const { sends, result, messages } = await run(id, (n) => (n <= ROUNDS ? call(n) : finalTurn));
    assert.equal(sends, ROUNDS + 1);
    assert.equal(result.content, 'final answer');
    assert.equal(messages.filter((m) => m.meta?.source === 'turn-limit').length, 0);
  });
}
