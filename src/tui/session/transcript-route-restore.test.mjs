import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTranscriptRouteMetadata,
  persistedAssistantTranscriptMetadata,
  persistedUserTranscriptMetadata,
} from '../../runtime/shared/transcript-metadata.mjs';
import { restoreTranscriptItems } from './session-api-ext.mjs';

test('live route identity survives user and assistant persistence and transcript restoration', () => {
  const session = { provider: 'anthropic-oauth', model: 'claude-fable-5-1' };
  const selected = { provider: 'openai-oauth', model: 'gpt-6-astra', workflow: { name: 'Solo' } };
  const metadata = createTranscriptRouteMetadata(session, selected, 10);
  const messages = [
    { role: 'user', content: 'Continue.', meta: { transcript: persistedUserTranscriptMetadata(metadata) } },
    { role: 'assistant', content: 'Done.', meta: { transcript: persistedAssistantTranscriptMetadata(metadata, 20) } },
  ];
  const items = restoreTranscriptItems(JSON.parse(JSON.stringify(messages)), { sessionId: 'route-roundtrip' });
  assert.deepEqual(items.map(({ kind, modelId, model, provider, agent }) => ({
    kind, modelId, model, provider, agent,
  })), ['user', 'assistant'].map((kind) => ({
    kind,
    modelId: 'claude-fable-5-1',
    model: 'Claude Fable 5.1',
    provider: 'anthropic-oauth',
    agent: 'Solo',
  })));
  assert.equal(items[0].at, 10);
  assert.equal(items[1].at, 20);
});

test('a reserved session records its selected model before a live session exists', () => {
  assert.deepEqual(createTranscriptRouteMetadata(null, {
    provider: 'gemini', model: 'gemini-3-pro', workflow: { id: 'solo' },
  }, 1), {
    at: 1, modelId: 'gemini-3-pro', model: 'Gemini 3 Pro', provider: 'gemini', agent: 'solo',
  });
});

test('restoring old display-only records does not invent a historical model ID', () => {
  const legacy = { at: 1, model: 'Claude Fable 5.1', provider: 'anthropic-oauth' };
  const items = restoreTranscriptItems([
    { role: 'assistant', content: 'Old answer.', meta: { transcript: legacy } },
    { role: 'assistant', content: 'Unknown ID.', meta: { transcript: { ...legacy, modelId: 123 } } },
  ], { sessionId: 'legacy-route' });
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.model, legacy.model);
    assert.equal(Object.hasOwn(item, 'modelId'), false);
  }
});
