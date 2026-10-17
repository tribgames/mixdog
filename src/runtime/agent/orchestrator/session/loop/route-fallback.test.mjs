import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let active;
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
    updateSessionRoute: (_id, route) => Object.assign(active, route, { tools: ['new-tool'], providerState: undefined }),
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

test('committed work and cancelled or uncertain requests never initialize a fallback provider', async () => {
  for (const variant of ['assistant', 'tool', 'abort', 'unknown']) {
    const current = state();
    if (variant === 'assistant') current.response = { content: 'done' };
    if (variant === 'tool') current.toolCallsTotal = 1;
    if (variant === 'abort') current.signal = AbortSignal.abort();
    const before = initialized.length;
    assert.equal(
      await advanceAgentRoute(current, variant === 'unknown' ? new Error('unknown') : { status: 429 }),
      false
    );
    assert.equal(initialized.length, before);
  }
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
