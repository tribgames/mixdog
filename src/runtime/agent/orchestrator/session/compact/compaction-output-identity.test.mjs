// Primed token estimates over a real-shaped transcript.
import assert from 'node:assert/strict';
import test from 'node:test';

const contextUtils = await import('../context-utils.mjs');
const { withRuntimeUserContext } = await import('../runtime-user-context.mjs');

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'compaction',
  'transcript',
  'archive',
  'budget',
  'token',
  'session',
  'daemon',
  'estimate',
  'message',
  'tool',
  'result',
  'header',
  'summary',
  'slice',
  'stall',
  'src/runtime/loop.mjs',
  '컴팩트',
  '세션',
  '토큰',
  '메시지',
  '요약',
  '도구',
  '결과',
  '예산',
  '😀',
  'naïve',
];

function words(rand, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(' ');
}

function resultBody(rand, chars) {
  const lines = [];
  let size = 0;
  for (let line = 0; size < chars; line += 1) {
    const text =
      rand() < 0.2
        ? `${String(line).padStart(4)}\t${'QUJD'.repeat(12 + Math.floor(rand() * 20))}`
        : `${String(line).padStart(4)}\t${words(rand, 6 + Math.floor(rand() * 10))}`;
    lines.push(text);
    size += text.length + 1;
  }
  return lines.join(rand() < 0.3 ? '\r\n' : '\n');
}

function transcript({ seed, turns, bigResults }) {
  const rand = rng(seed);
  const messages = [
    { role: 'system', content: '# Rules\n- keep going\n# Active Workflow\n- default', cacheTier: 'stable' },
    { role: 'user', content: '<system-reminder>\n# Workspace\ncwd C:/Project/demo\n</system-reminder>' },
    { role: 'assistant', content: '.' },
  ];
  let call = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      role: 'user',
      content: `${words(rand, 20 + Math.floor(rand() * 60))}${turn % 5 === 0 ? '\r\nsecond line\r\n' : ''}`,
      meta: { source: 'user', submissionIds: [`sub-${seed}-${turn}`] },
    });
    const steps = 1 + Math.floor(rand() * 3);
    for (let step = 0; step < steps; step += 1) {
      const id = `toolu_${seed}_${call}`;
      call += 1;
      const args =
        rand() < 0.2
          ? { command: `curl -H "authorization: Bearer secret${call}" https://example.test`, token: 'abc' }
          : { path: `src/file-${call}.mjs`, pattern: words(rand, 3) };
      const name = ['read', 'grep', 'shell'][Math.floor(rand() * 3)];
      messages.push({
        role: 'assistant',
        content: rand() < 0.5 ? words(rand, 15) : '',
        createdAt: 1_700_000_000_000 + call,
        meta: { transcript: { agent: 'main', at: 1_700_000_000_000 + call, model: 'identity-model' } },
        toolCalls: [{ id, name, arguments: rand() < 0.3 ? JSON.stringify(args) : args }],
        providerReplay: {
          provider: 'anthropic-oauth',
          accountId: 'acct',
          version: 1,
          items: [
            { type: 'thinking', thinking: words(rand, 25), signature: `sig${'A'.repeat(40)}` },
            { type: 'text', text: words(rand, 8) },
            { type: 'tool_use', id, name, input: { name } },
          ],
        },
      });
      const body = resultBody(rand, bigResults && rand() < 0.3 ? 20_000 : 200 + Math.floor(rand() * 3_000));
      const result = {
        role: 'tool',
        toolCallId: id,
        toolKind: 'normal',
        content: rand() < 0.1 ? { content: [{ type: 'text', text: body }] } : body,
        toolTiming: { dispatchStartedAt: 1, executionStartedAt: 2, executionCompletedAt: 3 },
      };
      if (rand() < 0.25) result.uiDiff = '--- a\n+++ b\n@@\n-x\n+y';
      messages.push(result);
    }
    messages.push({ role: 'assistant', content: words(rand, 30 + Math.floor(rand() * 80)) });
  }
  const last = messages.findLastIndex((message) => message.role === 'user');
  messages[last] = withRuntimeUserContext(messages[last], {
    suffix: '\n\n<system-reminder>\n# Current Time\nLocal: 2026-09-23 16:21:44\n</system-reminder>',
  });
  return messages;
}

test('primed estimates equal cold estimates', async () => {
  const cold = transcript({ seed: 41, turns: 40, bigResults: true });
  const primed = structuredClone(cold);
  await contextUtils.primeMessageEstimates(primed);
  assert.equal(contextUtils.estimateMessagesTokens(primed), contextUtils.estimateMessagesTokens(structuredClone(cold)));
  assert.deepEqual(
    contextUtils.summarizeContextMessages(primed),
    contextUtils.summarizeContextMessages(structuredClone(cold))
  );
});
