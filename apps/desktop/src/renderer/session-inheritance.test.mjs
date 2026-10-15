import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleApi } from '../../../../src/session-runtime/lifecycle-api.mjs';
import { restoreTranscriptItems } from '../../../../src/tui/session/session-api-ext.mjs';

test('successful inheritance restores its boundary', async () => {
  const source = {
    id: 'source',
    provider: 'anthropic-oauth',
    model: 'claude-fable-5-1',
    messages: [
      { role: 'user', content: 'Continue my work.' },
      {
        role: 'assistant',
        content: 'Previous answer.',
        meta: {
          transcript: {
            provider: 'anthropic-oauth',
            modelId: 'claude-fable-5-1',
          },
        },
      },
    ],
  };
  const original = structuredClone(source);
  const target = {
    id: 'heir',
    provider: 'openai-oauth',
    model: 'gpt-6-astra',
    contextWindow: 200_000,
    compactBoundaryTokens: 200_000,
    compaction: { auto: true },
    tools: [],
    messages: [{ role: 'system', content: 'Target instructions.' }],
  };
  let persisted;
  const api = createLifecycleApi({
    getSession: () => target,
    mgr: { getSession: () => source },
    invalidateContextStatusCache() {},
    saveSession: (session) => {
      persisted = JSON.parse(JSON.stringify(session));
    },
  });
  await api.inheritFrom(source.id);
  assert.deepEqual(source, original);
  assert.deepEqual(
    target.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'system', content: 'Target instructions.' },
      ...source.messages.map(({ role, content }) => ({ role, content })),
    ]
  );
  for (const messages of [target.messages, persisted.messages]) {
    const items = restoreTranscriptItems(messages, { sessionId: target.id });
    assert.equal(items.at(-1).status, 'inherited');
    assert.equal(items.filter((item) => item.status === 'inherited').length, 1);
    assert.equal(items.find((item) => item.kind === 'assistant').modelId, source.model);
    assert.equal(restoreTranscriptItems(messages, { sessionId: target.id, itemLimit: 1 })[0].status, 'inherited');
  }
});

test('rejected inheritance does not persist or display a successful boundary', async () => {
  const target = {
    id: 'heir',
    provider: 'openai',
    model: 'small',
    messages: [],
    contextWindow: 1_000,
    compactBoundaryTokens: 1_000,
    compaction: { auto: true },
    tools: [],
  };
  let saved = false;
  const api = createLifecycleApi({
    getSession: () => target,
    mgr: {
      getSession: () => ({
        id: 'source',
        messages: [{ role: 'user', content: 'Too large for this heir. '.repeat(500) }],
      }),
    },
    invalidateContextStatusCache() {},
    saveSession: () => {
      saved = true;
    },
  });
  await assert.rejects(api.inheritFrom('source'), /full conversation needs/);
  assert.equal(saved, false);
  assert.deepEqual(target.messages, []);
  assert.deepEqual(restoreTranscriptItems(target.messages), []);
});
