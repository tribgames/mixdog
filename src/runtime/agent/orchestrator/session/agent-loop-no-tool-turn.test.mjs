// Behavioral coverage for the no-tool-turn recovery ladders and the assistant
// echo payloads, driven through the public agentLoop entry point (see
// ./loop/no-tool-turn.mjs and ./loop/assistant-commit.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';

const MAX_OUTPUT_EXHAUSTED_NOTICE =
  '[mixdog-runtime] The model hit its output limit and the response stayed truncated after 3 recovery attempts.';

function leadSession(extra = {}) {
  return {
    id: 'no-tool-turn-test',
    owner: 'cli',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    ...extra,
  };
}

// Replays `script` per send; the last entry repeats for every further send so a
// runaway guard can be observed without hardcoding the cap in the fixture.
// `escalated` (number|null) is what the provider offers as a higher one-shot
// max_tokens; `state.requests` records what each send was asked for.
function scriptedProvider(script, { escalated = null } = {}) {
  const state = { sends: 0, requests: [] };
  return {
    state,
    escalatedMaxTokens: () => escalated,
    async send(messages, _model, _tools, sendOpts) {
      state.requests.push({ override: sendOpts?.maxOutputTokensOverride, messageCount: messages.length });
      state.sends += 1;
      const entry = script[Math.min(state.sends, script.length) - 1];
      return typeof entry === 'function' ? entry(state.sends) : entry;
    },
  };
}

function run(provider, messages, opts = {}) {
  return agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: leadSession(),
    sessionId: 'no-tool-turn-test',
    ...opts,
  });
}

test('max-output ladder resumes three times, then seals the aggregate with the exhausted notice', async () => {
  const messages = [{ role: 'user', content: 'write' }];
  const surfaced = [];
  const provider = scriptedProvider([(send) => ({ content: `part${send}`, toolCalls: [], stopReason: 'length' })]);
  const result = await run(provider, messages, { onAssistantText: (text) => surfaced.push(text) });
  assert.equal(provider.state.sends, 4);
  assert.equal(result.maxOutputRecoveryAttempts, 3);
  assert.equal(result.historyContent, `part4\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`);
  assert.equal(result.content, `part1part2part3part4\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`);
  assert.equal(result.terminationReason, 'truncated');
  assert.deepEqual(surfaced, ['part1', 'part2', 'part3', 'part4']);
  const resumePrompts = messages.filter((message) => message.meta?.source === 'max-output-recovery');
  assert.deepEqual(
    resumePrompts.map((message) => message.meta.attempt),
    [1, 2, 3]
  );
});

test('a recovered max-output turn keeps every partial in the caller aggregate but not in history', async () => {
  const messages = [{ role: 'user', content: 'write' }];
  const provider = scriptedProvider([
    { content: 'part1', toolCalls: [], stopReason: 'length' },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 2);
  assert.equal(result.content, 'part1done');
  assert.equal(result.historyContent, 'done');
  assert.equal(result.maxOutputRecoveryAttempts, 1);
  assert.equal(messages.filter((message) => message.meta?.source === 'max-output-recovery').length, 1);
});

const emptyCut = { content: '', toolCalls: [], stopReason: 'max_tokens' };

test('an empty max_tokens turn escalates once with no nudge, then resumes three times at normal max_tokens', async () => {
  const messages = [{ role: 'user', content: 'think hard' }];
  const provider = scriptedProvider([emptyCut], { escalated: 128_000 });
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 5);
  const { requests } = provider.state;
  assert.deepEqual(
    requests.map((request) => request.override),
    [undefined, 128_000, undefined, undefined, undefined]
  );
  // The escalated re-send carries the same transcript: no message was added.
  assert.equal(requests[1].messageCount, requests[0].messageCount);
  // Every later send differs from its predecessor (a resume prompt each time).
  assert.deepEqual(
    requests.slice(2).map((request) => request.messageCount),
    [requests[0].messageCount + 1, requests[0].messageCount + 2, requests[0].messageCount + 3]
  );
  const prompts = messages.filter((message) => message.meta?.source === 'max-output-recovery');
  assert.equal(prompts.length, 3);
  assert.match(prompts[0].content, /Output token limit hit/);
  assert.match(prompts[0].content, /smaller pieces/);
  assert.equal(messages.some((message) => String(message.content).includes('Empty truncated continuation')), false);
  // Exhaustion ends the turn with a visible notice, not a silent stop.
  assert.equal(result.terminationReason, 'truncated');
  assert.equal(result.content, MAX_OUTPUT_EXHAUSTED_NOTICE);
  assert.equal(result.maxOutputRecoveryAttempts, 3);
});

test('no escalation is attempted when the provider has no higher limit', async () => {
  const messages = [{ role: 'user', content: 'think hard' }];
  const provider = scriptedProvider([emptyCut], { escalated: null });
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 4);
  assert.deepEqual(
    provider.state.requests.map((request) => request.override),
    [undefined, undefined, undefined, undefined]
  );
  assert.deepEqual(
    provider.state.requests.map((request) => request.messageCount),
    [1, 2, 3, 4]
  );
  assert.equal(result.terminationReason, 'truncated');
  assert.equal(result.content, MAX_OUTPUT_EXHAUSTED_NOTICE);
});

test('a truncated turn with text follows the same rule: escalate without keeping the partial, then resume', async () => {
  const messages = [{ role: 'user', content: 'write' }];
  const provider = scriptedProvider(
    [
      { content: 'part1', toolCalls: [], stopReason: 'max_tokens' },
      { content: 'part2', toolCalls: [], stopReason: 'max_tokens' },
      { content: 'done', toolCalls: [], stopReason: 'end_turn' },
    ],
    { escalated: 128_000 }
  );
  const result = await run(provider, messages);
  assert.deepEqual(
    provider.state.requests.map((request) => [request.override, request.messageCount]),
    [
      [undefined, 1],
      [128_000, 1],
      [undefined, 3],
    ]
  );
  assert.equal(result.content, 'part2done');
  assert.equal(result.historyContent, 'done');
  assert.equal(result.terminationReason, undefined);
});

test('a tool-call turn is progress: the escalation and the three resumes are available again', async () => {
  const provider = scriptedProvider(
    [
      emptyCut,
      emptyCut,
      { content: '', toolCalls: [{ id: 'c1', name: 'definitely_missing_no_tool_turn_tool', arguments: {} }] },
      emptyCut,
    ],
    { escalated: 128_000 }
  );
  const result = await run(provider, [{ role: 'user', content: 'go' }]);
  // cut, escalated cut, one resume that ends in a tool call (progress), then a
  // full fresh ladder: cut, escalated cut, 3 resumes, exhausted.
  assert.equal(provider.state.sends, 3 + 5);
  assert.deepEqual(
    provider.state.requests.map((request) => request.override),
    [undefined, 128_000, undefined, undefined, 128_000, undefined, undefined, undefined]
  );
  assert.equal(result.terminationReason, 'truncated');
});

test('one refusal is retried with a policy reminder and its partial text is preserved', async () => {
  const messages = [{ role: 'user', content: 'ask' }];
  const provider = scriptedProvider([
    { content: 'partial narration', toolCalls: [], stopReason: 'refusal' },
    { content: 'safe answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 2);
  assert.equal(result.content, 'partial narrationsafe answer');
  assert.equal(result.historyContent, 'safe answer');
  assert.equal(result.terminationReason, undefined);
  const recovery = messages.filter((message) => message.meta?.source === 'refusal-recovery');
  assert.equal(recovery.length, 1);
  assert.match(recovery[0].content, /safety classifier/);
});

test('a refusal that survives the retry ends the loop as a refusal termination', async () => {
  const provider = scriptedProvider([{ content: '', toolCalls: [], stopReason: 'refusal' }]);
  const result = await run(provider, [{ role: 'user', content: 'ask' }]);
  assert.equal(provider.state.sends, 2);
  assert.equal(result.terminationReason, 'refusal');
});

test('text-only provider continuations are capped and the last text becomes the final answer', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([{ content: 'seg', toolCalls: [], endTurn: false }]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 9);
  assert.equal(result.providerContinuations, 8);
  assert.equal(result.content, 'seg'.repeat(9));
  assert.equal(result.historyContent, 'seg');
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 8);
});

test('empty turns are nudged three times before an explicit empty termination', async () => {
  const messages = [{ role: 'user', content: 'go' }];
  const provider = scriptedProvider([{ content: '', toolCalls: [], stopReason: 'end_turn' }]);
  const result = await run(provider, messages);
  assert.equal(provider.state.sends, 4);
  assert.equal(result.terminationReason, 'empty');
  const nudges = messages.filter(
    (message) => typeof message.content === 'string' && message.content.startsWith('[mixdog-runtime] Empty response')
  );
  assert.equal(nudges.length, 3);
  assert.match(nudges[0].content, /\(1\/3\)/);
  assert.match(nudges[2].content, /\(3\/3\)/);
});

test('an executed tool batch reseals the text aggregate and resets the continuation budget', async () => {
  const provider = scriptedProvider([
    { content: 'mid-turn note', toolCalls: [], endTurn: false },
    {
      content: '',
      toolCalls: [{ id: 'c1', name: 'definitely_missing_no_tool_turn_tool', arguments: {} }],
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, [{ role: 'user', content: 'go' }]);
  assert.equal(provider.state.sends, 3);
  assert.equal(result.providerContinuations, 1);
  // The UI sealed its row at the tool boundary: the pre-tool segment must not
  // be re-prepended to the terminal answer.
  assert.equal(result.content, 'done');
  assert.equal(result.historyContent, undefined);
});

test('a message sent while the final text streams is read right after it, inside the same turn', async () => {
  const messages = [{ role: 'user', content: 'explain' }];
  const pending = [];
  const steered = [];
  const provider = scriptedProvider([
    () => {
      // The user sends while this text streams: it waits in the host queue.
      pending.push({ id: 'sub-1', content: 'add a one-line summary', submittedAt: Date.now() });
      return { content: 'first answer', toolCalls: [], stopReason: 'end_turn' };
    },
    { content: 'summary added', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const result = await run(provider, messages, {
    drainSteering: (_sessionId, options) => {
      steered.push(options.stage);
      return pending.splice(0);
    },
    onSteerMessage: () => {},
  });
  assert.equal(provider.state.sends, 2, 'one agentLoop call answers both: the turn continued');
  assert.ok(steered.includes('terminal'), 'delivered at the boundary after the streamed message');
  const roles = messages.map((message) => [message.role, message.meta?.source ?? '', message.content]);
  assert.deepEqual(roles.slice(1, 3), [
    ['assistant', '', 'first answer'],
    ['user', 'steering', 'add a one-line summary'],
  ]);
  assert.deepEqual(messages[2].meta.submissionIds, ['sub-1']);
  assert.equal(result.historyContent ?? result.content, 'summary added');
});

test('tool-call and continuation turns echo provider replay payloads under one precedence rule', async () => {
  const thinkingBlocks = [{ type: 'thinking', thinking: 'weigh options', signature: 'sig-1' }];
  const committed = [];
  const provider = scriptedProvider([
    {
      content: '',
      thinkingBlocks,
      assistantBlocks: [
        ...thinkingBlocks,
        { type: 'tool_use', id: 'c1', name: 'definitely_missing_echo_tool', input: {} },
      ],
      toolCalls: [{ id: 'c1', name: 'definitely_missing_echo_tool', arguments: {} }],
    },
    { content: 'mid', toolCalls: [], thinkingBlocks, endTurn: false },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  await run(provider, [{ role: 'user', content: 'go' }], {
    onAssistantMessageCommitted: (message) => committed.push(message),
  });
  assert.equal(provider.state.sends, 3);
  // Tool-call turn: ordered blocks win, so the flattened copy is dropped.
  assert.equal(committed[0].assistantBlocks?.length, 2);
  assert.equal(committed[0].thinkingBlocks, undefined);
  assert.equal(committed[0].toolCalls?.[0]?.name, 'definitely_missing_echo_tool');
  // Continuation turn: no ordered blocks, so the signed thinking replay is
  // stored verbatim for the resumed turn.
  assert.deepEqual(committed[1].thinkingBlocks, thinkingBlocks);
  assert.equal(committed[1].assistantBlocks, undefined);
  assert.equal(committed[1].content, 'mid');
});
