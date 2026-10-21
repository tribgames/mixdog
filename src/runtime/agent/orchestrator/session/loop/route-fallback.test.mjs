import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let active;
let routeOptions;
const initialized = [];
const provider = {
  name: 'second',
  getCachedModelInfo: () => ({ contextWindow: 200000, effectiveContextWindowPercent: 80 }),
};
mock.module('../../providers/registry.mjs', {
  namedExports: {
    getProvider: () => provider,
    initProviders: async (config) => initialized.push(config),
  },
});
mock.module('../../config.mjs', {
  namedExports: {
    loadConfig: () => ({ providers: { second: { enabled: true } } }),
  },
});
mock.module('../manager/session-lifecycle.mjs', {
  namedExports: {
    updateSessionRoute: (_id, route, options) => {
      routeOptions = options;
      return Object.assign(active, route, { tools: ['new-tool'], providerState: undefined });
    },
  },
});
mock.module('../../providers/wire-route.mjs', {
  namedExports: {
    pinSessionWireRoute: async (session) => {
      session.wireRoute = { wire: 'new' };
    },
  },
});
mock.module('../../providers/effort-configuration.mjs', {
  namedExports: {
    prepareTurnEffortConfiguration: (session) => ({ effort: session.effort }),
  },
});
mock.module('../manager/ask-turn-loop-options.mjs', {
  namedExports: {
    buildRequestSendOptions: ({ session }) => ({
      providerState: session.providerState,
      session,
      fast: session.fast,
      effort: session.effort,
      modelParameters: session.modelParameters,
    }),
  },
});
const { advanceAgentRoute } = await import('./route-fallback.mjs');

function state() {
  active = {
    id: 'test',
    agent: 'worker',
    provider: 'first',
    model: 'a',
    messages: [{ role: 'user', content: 'work' }],
    routeFallbacks: [{ provider: 'second', model: 'b', effort: 'low', modelParameters: { mode: 'x' } }],
  };
  return {
    sessionRef: active,
    sessionId: active.id,
    messages: [...active.messages],
    toolCallsTotal: 0,
    cacheBreakTraceKeys: new Set(['old']),
    opts: { onTextDelta() {} },
    throwIfAborted() {},
    transportRetriesUsed: 2,
    transportRetryMax: 2,
  };
}

test('a rejected first request switches once and rebuilds request state without replaying a task', async () => {
  const current = state();
  const callback = current.opts.onTextDelta;
  assert.equal(await advanceAgentRoute(current, { status: 429 }), true);
  // The registry gets the providers map itself, with the next provider switched on.
  assert.equal(initialized.at(-1)?.second?.enabled, true);
  assert.equal(current.provider, provider);
  assert.equal(current.model, 'b');
  assert.equal(current.sessionRef.routeFallbackIndex, 1);
  assert.deepEqual(current.tools, ['new-tool']);
  assert.deepEqual(current.opts.modelParameters, { mode: 'x' });
  assert.equal(current.opts.effort, 'low');
  assert.equal(current.opts.onTextDelta, callback);
  assert.equal(current.cacheBreakTraceKeys.size, 0);
  assert.equal(await advanceAgentRoute(current, { status: 429 }), false);
});

test('a request that streamed output or started a tool call, or was cancelled or untyped, never switches', async () => {
  for (const error of [
    { status: 429, liveTextEmitted: true },
    { status: 429, partialContent: 'half an answer' },
    { status: 429, toolCallsStarted: true },
    { status: 429, toolCallsDispatched: 1 },
    { status: 429, pendingToolUse: true },
    new Error('unknown'),
  ]) {
    const current = state();
    const before = initialized.length;
    assert.equal(await advanceAgentRoute(current, error), false);
    assert.equal(initialized.length, before);
  }
  const cancelled = state();
  cancelled.signal = AbortSignal.abort();
  assert.equal(await advanceAgentRoute(cancelled, { status: 429 }), false);
});

test('a usage limit after tools ran mid-turn continues the same turn on the next model', async () => {
  const current = chainState();
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'anthropic-sig' };
  const toolTurn = [
    { role: 'user', content: 'work' },
    {
      role: 'assistant',
      content: 'reading',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' }, thoughtSignature: 'sig' }],
      thinkingBlocks: [thinking],
      reasoningItems: [{ id: 'rs_1', encrypted_content: 'enc' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'file body' },
  ];
  // The committed history is only the prompt; the live turn holds the work.
  current.sessionRef.messages = [toolTurn[0]];
  current.messages = toolTurn;
  current.toolCallsTotal = 1;
  current.response = { content: 'reading', toolCalls: toolTurn[1].toolCalls };
  assert.equal(await advanceAgentRoute(current, quotaError()), true);
  assert.equal(current.sessionRef.model, 'claude-opus-5-5');
  // Same array (the loop and liveTurnMessages share it), every message kept:
  // the next request answers after the tool result instead of re-asking.
  assert.equal(current.messages, toolTurn);
  assert.equal(current.sessionRef.liveTurnMessages, toolTurn);
  assert.deepEqual(
    current.messages.map((m) => m.role),
    ['user', 'assistant', 'tool']
  );
  assert.equal(current.messages.at(-1).content, 'file body');
  assert.deepEqual(current.messages[1].toolCalls, [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }]);
  assert.equal(current.messages[1].content, 'reading');
  for (const field of ['thinkingBlocks', 'reasoningItems']) assert.equal(field in current.messages[1], false);
  // Only the switch was recorded: no tool counter moved, no tool message added.
  assert.equal(current.toolCallsTotal, 1);
  assert.deepEqual(
    current.stages.filter(([stage]) => stage === 'notice').map(([, d]) => d.message),
    ['GPT-6.1-Sol usage limit reached — switched to Claude Opus 5.5.']
  );
});

test('historical assistant and tool messages do not block an unanswered fresh turn', async () => {
  const current = state();
  current.messages.unshift(
    { role: 'assistant', content: 'earlier reply' },
    { role: 'tool', content: 'earlier result' }
  );
  current.sessionRef.messages = [...current.messages];
  assert.equal(await advanceAgentRoute(current, { status: 429 }), true);
  assert.equal(current.model, 'b');
});

const quotaError = () =>
  Object.assign(new Error('OpenAI OAuth WS: The usage limit has been reached'), {
    code: 'usage_limit_reached',
    responseFailed: { type: 'response.failed' },
    sawResponseCreated: true,
  });

function chainState() {
  const current = state();
  Object.assign(current.sessionRef, { provider: 'openai-oauth', model: 'gpt-6.1-sol' });
  current.sessionRef.routeFallbacks = [
    { provider: 'anthropic-oauth', model: 'claude-opus-5-5' },
    { provider: 'antigravity', model: 'gemini-4-argon', effort: 'high' },
  ];
  current.stages = [];
  current.opts.onStageChange = (stage, detail) => current.stages.push([stage, detail]);
  return current;
}

test('a usage-limit refusal on the first model runs the request on the second and says so', async () => {
  const current = chainState();
  assert.equal(await advanceAgentRoute(current, quotaError()), true);
  assert.equal(current.model, 'claude-opus-5-5');
  const notices = current.stages.filter(([stage]) => stage === 'notice');
  assert.deepEqual(notices, [
    ['notice', { tone: 'info', message: 'GPT-6.1-Sol usage limit reached — switched to Claude Opus 5.5.' }],
  ]);
  assert.deepEqual(
    current.sessionRef.routeFallbackFailures.map(({ model, kind }) => [model, kind]),
    [['gpt-6.1-sol', 'quota_exhausted']]
  );
});

test('when every model fails the final error keeps its kind and lists each model and reason', async () => {
  const current = chainState();
  assert.equal(await advanceAgentRoute(current, quotaError()), true);
  assert.equal(await advanceAgentRoute(current, Object.assign(new Error('Overloaded'), { status: 529 })), true);
  const last = Object.assign(new Error('denied'), { status: 403 });
  assert.equal(await advanceAgentRoute(current, last), false);
  assert.deepEqual(
    last.routeFallbackAttempts.map(({ model, kind }) => [model, kind]),
    [
      ['gpt-6.1-sol', 'quota_exhausted'],
      ['claude-opus-5-5', 'overloaded'],
      ['gemini-4-argon', 'permission'],
    ]
  );
  assert.match(
    last.message,
    /^denied\nEvery model in the fallback chain failed — GPT-6\.1-Sol: Provider usage limit reached\.; Claude Opus 5\.5: Provider is busy at capacity\.; Gemini 4 Argon: Access denied by the provider\.$/
  );
});

test('a chain that stops early says where and why instead of "every model failed"', async () => {
  const current = chainState();
  current.provider = { name: 'first', getCachedModelInfo: () => ({ contextWindow: 100000 }) };
  assert.equal(await advanceAgentRoute(current, quotaError()), true);
  // Opus (now current) overflows; Argon's window is no larger, so the chain stops.
  const overflow = Object.assign(new Error('too long'), { status: 400, code: 'context_length_exceeded' });
  assert.equal(await advanceAgentRoute(current, overflow), false);
  assert.doesNotMatch(overflow.message, /Every model/);
  assert.match(
    overflow.message,
    /Fallback chain stopped before Gemini 4 Argon \(its context window is not larger\) — tried GPT-6\.1-Sol: Provider usage limit reached\.; Claude Opus 5\.5: /
  );
  assert.deepEqual(overflow.routeFallbackStoppedBefore, { provider: 'antigravity', model: 'gemini-4-argon' });
});

test('a switch marks the saved turn as switched and closes the left model usage share', async () => {
  const current = chainState();
  current.sessionRef.activeTurnCheckpoint = { version: 1, turnToken: 't', startedAt: 1 };
  current.lastUsage = { inputTokens: 10, outputTokens: 2 };
  assert.equal(await advanceAgentRoute(current, quotaError()), true);
  assert.equal(current.sessionRef.activeTurnCheckpoint.routeChanged, true);
  assert.deepEqual(current.routeUsageHops, [
    { provider: 'openai-oauth', model: 'gpt-6.1-sol', usage: { inputTokens: 10, outputTokens: 2 } },
  ]);
});

test('a request that would fail the same on any model stays on its model', async () => {
  for (const error of [
    Object.assign(new Error('too big'), { status: 413 }),
    Object.assign(new Error("Invalid schema for function 'x'"), { status: 400, code: 'invalid_request_error' }),
    Object.assign(new Error('refused'), { status: 400, code: 'content_policy_violation' }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
  ]) {
    const current = chainState();
    const before = initialized.length;
    assert.equal(await advanceAgentRoute(current, error), false, error.message);
    assert.equal(current.sessionRef.model, 'gpt-6.1-sol');
    assert.equal(current.sessionRef.routeFallbackIndex, undefined);
    assert.equal(initialized.length, before);
    assert.equal(error.routeFallbackAttempts, undefined);
  }
});

test('a context overflow moves only to a model with a larger window', async () => {
  const overflow = () => Object.assign(new Error('too long'), { status: 400, code: 'context_length_exceeded' });
  const smaller = chainState();
  smaller.provider = { name: 'first', getCachedModelInfo: () => ({ contextWindow: 400000 }) };
  assert.equal(await advanceAgentRoute(smaller, overflow()), false);
  const larger = chainState();
  larger.provider = { name: 'first', getCachedModelInfo: () => ({ contextWindow: 100000 }) };
  assert.equal(await advanceAgentRoute(larger, overflow()), true);
});

test('a route without fallbacks (Lead, bots) keeps its behavior', async () => {
  const current = chainState();
  current.sessionRef.routeFallbacks = undefined;
  const error = quotaError();
  assert.equal(await advanceAgentRoute(current, error), false);
  assert.equal(error.routeFallbackAttempts, undefined);
});

test('fallback resolves its own selected context before route recomputation', async () => {
  for (const selection of [
    { contextTokens: 48000, expected: 48000 },
    { contextPercent: 40, expected: 200000 },
  ]) {
    const current = state();
    const { expected, ...fields } = selection;
    Object.assign(current.sessionRef.routeFallbacks[0], fields);
    current.sessionRef.selectedContextWindow = 900000;
    assert.equal(await advanceAgentRoute(current, { status: 429 }), true);
    assert.equal(current.sessionRef.selectedContextWindow, expected);
  }
});

test('the fallback changes the live turn object in place (it hands it to the route update)', async () => {
  const current = state();
  const live = current.sessionRef;
  assert.equal(await advanceAgentRoute(current, { status: 429 }), true);
  assert.equal(routeOptions.session, live);
  assert.equal(routeOptions.crossProvider, true);
  assert.equal(current.sessionRef, live);
});

test('a Lead-class session (agent "lead") advances on a usage limit like an agent; without fallbacks it stays', async () => {
  const lead = state();
  lead.sessionRef.agent = 'lead';
  assert.equal(await advanceAgentRoute(lead, { status: 429 }), true);
  assert.equal(lead.model, 'b');
  assert.equal(lead.sessionRef.routeFallbackIndex, 1);
  const plain = state();
  plain.sessionRef.agent = 'lead';
  plain.sessionRef.routeFallbacks = undefined;
  assert.equal(await advanceAgentRoute(plain, { status: 429 }), false);
  assert.equal(plain.model, undefined);
});
