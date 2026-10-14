import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const events = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const provider = {
  config: {},
  customConfig: { protocol: 'openai-chat' },
  getCachedModelInfo: (id) => ({
    id,
    reasoningLevels: ['low', 'medium', 'high'],
    customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' }, replay: false },
  }),
};
const JUDGE_MS = 80;
const BUILD_MS = 80;

mock.module('../../providers/registry.mjs', {
  namedExports: { ...(await import('../../providers/registry.mjs')), getProvider: () => provider },
});
mock.module('./ask-turn-auto-effort.mjs', {
  namedExports: {
    ...(await import('./ask-turn-auto-effort.mjs')),
    resolveTurnAutoEffort: async () => {
      events.push('judge:start');
      await sleep(JUDGE_MS);
      events.push('judge:end');
      return { effort: 'high', applied: true, mode: 'on', request: 'go', base: 'medium' };
    },
  },
});
mock.module('./ask-turn-prepare.mjs', {
  namedExports: {
    ...(await import('./ask-turn-prepare.mjs')),
    applyTurnContextMeta: () => {},
    traceTurnContext: () => {},
    startProviderPrewarm: (args) => {
      events.push(`prewarm:${args.turnEffort}`);
      return null;
    },
    buildUserTurn: async () => {
      events.push('build:start');
      await sleep(BUILD_MS);
      events.push('build:end');
      const userTurnMessage = { role: 'user', content: 'go', meta: { runtimeUserContext: { prefix: '', suffix: 'x' } } };
      return { historyMessages: [], outgoing: [userTurnMessage], userTurnMessage, explicitPrefetchResult: '' };
    },
  },
});
mock.module('../store.mjs', {
  namedExports: { ...(await import('../store.mjs')), saveSessionAsync: async () => {} },
});

const { prepareAskTurn } = await import('./ask-turn-execute.mjs');

test('turn start overlaps the judgment with buildUserTurn and still stamps the first request with it', async () => {
  const session = {
    provider: 'custom-a',
    model: 'm',
    effort: 'medium',
    messages: [],
    cwd: process.cwd(),
    sessionStartMetaInjected: true,
  };
  const opened = {
    turn: { session },
    runtime: {},
    turnSignal: new AbortController().signal,
    askGeneration: 1,
    checkpoint: { schedule() {} },
    turnToken: 't1',
    startedAt: Date.now(),
    codexTurnId: null,
  };
  const startedAt = performance.now();
  const prepared = await prepareAskTurn({ sessionId: 's1', opened, input: { prompt: 'go' }, transcriptMeta: null });
  const elapsed = performance.now() - startedAt;

  assert.deepEqual(events.slice(0, 3), ['judge:start', 'prewarm:medium', 'build:start']);
  assert.ok(events.indexOf('build:start') < events.indexOf('judge:end'), 'build began before the judgment finished');
  assert.ok(elapsed < JUDGE_MS + BUILD_MS - 30, `overlapped: ${elapsed} ms`);
  assert.equal(prepared.turnEffort, 'high');
  assert.equal(prepared.effortConfiguration.effort, 'high');
  const message = prepared.outgoing[0];
  assert.equal(message.meta.effortConfiguration.effort, 'high');
  assert.deepEqual(Object.keys(message.meta), ['effortConfiguration', 'runtimeUserContext']);
});
