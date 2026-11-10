import assert from 'node:assert/strict';
import test from 'node:test';

import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { fetchApiUsageSnapshot } from './api-usage.mjs';

test('usage probes ride the shared LLM dispatcher', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: false, status: 500, text: async () => '' };
  });
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  });
  await assert.rejects(fetchApiUsageSnapshot('deepseek', { force: true }), /usage fetch failed \(500\)/);
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
  assert.equal(calls[0].options.dispatcher, getLlmDispatcher());
});
