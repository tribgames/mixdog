import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatProvider } from './openai-compat.mjs';

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('a 403 from the models endpoint rejects listModels instead of returning an empty list', async () => {
  const provider = new OpenAICompatProvider('xai', { apiKey: 'k', preconnect: false });
  await withFetch(
    async () => new Response('forbidden', { status: 403 }),
    async () => {
      await assert.rejects(provider.listModels(), (error) => {
        assert.equal(error.status, 403);
        return true;
      });
    }
  );
});

test('a successful models response still lists the models', async () => {
  const provider = new OpenAICompatProvider('xai', { apiKey: 'k', preconnect: false });
  await withFetch(
    async () => Response.json({ data: [{ id: 'grok-test-model' }] }),
    async () => {
      const models = await provider.listModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ['grok-test-model']
      );
    }
  );
});
