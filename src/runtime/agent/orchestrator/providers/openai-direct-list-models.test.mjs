import assert from 'node:assert/strict';
import test from 'node:test';

import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { OpenAIDirectProvider } from './openai-ws.mjs';

test('the public model list request rides the shared LLM dispatcher', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: false, status: 500 };
  });
  const provider = new OpenAIDirectProvider({ apiKey: 'sk-test' });
  assert.deepEqual(await provider.listModels(), []);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].options.dispatcher, getLlmDispatcher());
});
