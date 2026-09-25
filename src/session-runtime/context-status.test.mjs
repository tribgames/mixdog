import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextState } from '../tui/session/context-state.mjs';
import { contextStatusForSession, createContextStatus } from './context-status.mjs';

const emptyUsage = {
  reasoningUsage: null,
  lastInputTokens: 0,
  lastUncachedInputTokens: 0,
  lastOutputTokens: 0,
  lastCachedReadTokens: 0,
  lastCacheWriteTokens: 0,
  lastContextTokens: 0,
  totalInputTokens: 0,
  totalUncachedInputTokens: 0,
  totalOutputTokens: 0,
  totalCachedReadTokens: 0,
  totalCacheWriteTokens: 0,
};

for (const [name, session] of [
  ['no session', null],
  ['empty conversation', { id: 'empty', messages: [], tools: [] }],
  [
    'prepared system context',
    {
      id: 'prepared',
      messages: [{ role: 'system', content: 'Prepared instructions, not yet sent.' }],
      tools: [],
      ...Object.fromEntries(Object.keys(emptyUsage).map((key) => [key, 123])),
    },
  ],
]) {
  test(`new task reports zero usage with ${name}`, () => {
    const api = createContextStatus({
      getSession: () => session,
      getRoute: () => ({ provider: 'openai', model: 'test', contextWindow: 10000 }),
      getCurrentCwd: () => process.cwd(),
      getMode: () => 'default',
    });
    for (const options of [undefined, { inspect: true }]) {
      const status = api.contextStatus(options);
      assert.equal(status.usedSource, 'empty');
      assert.equal(status.usedTokens, 0);
      assert.equal(status.freeTokens, 10000);
      assert.deepEqual(status.usage, emptyUsage);
    }
    const first = api.contextStatus();
    first.usage.lastInputTokens = 999;
    assert.deepEqual(api.contextStatus().usage, emptyUsage);
  });
}

test('a stats pulse after one appended message meters only that message and matches a fresh status', () => {
  const reads = new Map();
  const counted = (id, text) => {
    reads.set(id, 0);
    return [
      {
        type: 'text',
        get text() {
          reads.set(id, reads.get(id) + 1);
          return text;
        },
      },
    ];
  };
  const walked = () => [...reads].filter(([, count]) => count > 0).map(([id]) => id);
  const resetReads = () => {
    for (const id of reads.keys()) reads.set(id, 0);
  };
  const session = {
    id: 'pulse',
    provider: 'openai',
    model: 'test',
    contextWindow: 100000,
    cwd: process.cwd(),
    tools: [{ name: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: counted('answer', 'answer '.repeat(30)) },
      { role: 'tool', toolCallId: 'c1', content: counted('result', 'body '.repeat(80)) },
      { role: 'user', content: 'again' },
    ],
  };
  const api = createContextStatus({
    getSession: () => session,
    getRoute: () => ({ provider: session.provider, model: session.model, contextWindow: session.contextWindow }),
    getCurrentCwd: () => session.cwd,
    getMode: () => 'default',
  });
  let state = { stats: {} };
  const { syncContextStats } = createContextState({
    runtime: { contextStatus: api.contextStatus, session },
    getState: () => state,
    updateState: (patch) => {
      state = { ...state, ...patch };
    },
    getPendingSessionReset: () => false,
    getVisibleGoal: () => null,
  });
  const tick = () => syncContextStats({ allowEstimated: true });
  const fresh = () => contextStatusForSession(structuredClone(session), { getMode: () => 'default' });

  tick();
  resetReads();
  session.messages.push({ role: 'assistant', content: counted('in-place', 'reply '.repeat(20)) });
  const grown = tick();
  assert.deepEqual(walked(), ['in-place']);
  assert.deepEqual(grown, fresh());

  session.messages.push({ role: 'user', content: 'ack' });
  tick();
  resetReads();
  session.messages = [...session.messages, { role: 'assistant', content: counted('replaced', 'final '.repeat(20)) }];
  const replaced = tick();
  assert.deepEqual(walked(), ['replaced']);
  assert.deepEqual(replaced, fresh());
  assert.ok(replaced.usedTokens > grown.usedTokens);
});
