import test from 'node:test';
import { geminiExplicitCacheRefused, markGeminiExplicitCacheRefused } from './gemini-cache.mjs';

test('the server refusing explicit caching turns cache creates off for that model only', () => {
  const refusal = Object.assign(new Error('Gemini cachedContents.create 400: Explicit caching is not supported for models/gemini-9-x.'), { status: 400 });
  assert.equal(markGeminiExplicitCacheRefused('gemini-9-x', new Error('timeout')), false);
  assert.equal(markGeminiExplicitCacheRefused('gemini-9-x', Object.assign(new Error('too small'), { status: 400 })), false);
  assert.equal(geminiExplicitCacheRefused('gemini-9-x'), false);
  assert.equal(markGeminiExplicitCacheRefused('gemini-9-x', refusal), true);
  assert.equal(geminiExplicitCacheRefused('gemini-9-x'), true);
  assert.equal(geminiExplicitCacheRefused('gemini-3.8-flash'), false);
});
import assert from 'node:assert/strict';
import { isGeminiFamilyModel } from './gemini-family.mjs';
import { _geminiCacheMinTokens } from './gemini-cache.mjs';

test('the family check names Gemini ids of any generation and nothing else', () => {
  for (const id of ['gemini-2.5-pro', 'gemini-3-pro', 'gemini-4-argon', 'models/gemini-4-argon', 'gemini-pro-agent', 'gemini-11-x']) {
    assert.equal(isGeminiFamilyModel(id), true, id);
  }
  for (const id of ['claude-opus-5', 'gpt-oss-120b-medium', 'geminibot', 'my-gemini-clone', '', null, undefined]) {
    assert.equal(isGeminiFamilyModel(id), false, String(id));
  }
});

test('the cachedContents floor is one value for every model id', () => {
  const floor = _geminiCacheMinTokens();
  for (const id of ['gemini-2.5-flash', 'gemini-3.1-pro', 'gemini-4-argon', 'gemini-9-x']) {
    assert.equal(_geminiCacheMinTokens(id), floor, id);
  }
  assert.equal(floor, 4096);
});
