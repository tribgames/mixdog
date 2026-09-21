import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStatus } from './context-status.mjs';

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
