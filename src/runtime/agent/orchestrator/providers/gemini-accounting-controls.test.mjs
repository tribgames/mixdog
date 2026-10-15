import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiThinkingConfig } from './gemini-thinking.mjs';
import { buildGeminiRequest } from './gemini-request-body.mjs';
import { normalizeGeminiUsage } from './gemini-response.mjs';
import { normalizeAntigravityUsage } from './antigravity-response.mjs';
import { geminiExplicitCacheMinTokens, geminiExplicitCacheRefused } from './gemini-cache.mjs';

test('Gemini 2.5 maps effort to thinkingBudget and rejects thinkingLevel and out-of-range budgets', () => {
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-flash', { effort: 'high' }), { thinkingBudget: 24576 });
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro', { effort: 'minimal' }), { thinkingBudget: 128 });
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: 32768 }), { thinkingBudget: 32768 });
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-flash', { thinkingBudget: 0 }), { thinkingBudget: 0 });
  assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: -1 }), { thinkingBudget: -1 });
  assert.throws(() => geminiThinkingConfig('gemini-2.5-flash', { thinkingLevel: 'low' }), /does not support thinkingLevel/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: 0 }), /cannot disable/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: 100 }), /128–32768/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: 32769 }), /128–32768/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-flash', { thinkingBudget: 24577 }), /0–24576/);
  assert.throws(() => geminiThinkingConfig('gemini-2.5-flash-lite', { thinkingBudget: 100 }), /512–24576/);
});

test('buildGeminiRequest forwards supported controls, rejects the rest, and is unchanged without them', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(buildGeminiRequest(messages, 'gemini-3.1-pro', [], {}).generationConfig, {
    thinkingConfig: { includeThoughts: true },
  });
  assert.deepEqual(buildGeminiRequest(messages, 'gemini-3.1-pro', [], { effort: 'low' }).generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
  });
  const withControls = buildGeminiRequest(messages, 'gemini-3.1-pro', [], { maxOutputTokens: 2048, temperature: 0.3 });
  assert.deepEqual(withControls.generationConfig, {
    thinkingConfig: { includeThoughts: true },
    maxOutputTokens: 2048,
    temperature: 0.3,
  });
  assert.throws(() => buildGeminiRequest(messages, 'gemini-3.1-pro', [], { maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.throws(() => buildGeminiRequest(messages, 'gemini-3.1-pro', [], { temperature: 5 }), /temperature/);
  assert.throws(() => buildGeminiRequest(messages, 'gemini-3.1-pro', [], { safetySettings: 'BLOCK_NONE' }), /safetySettings/);
});

test('usage includes toolUsePromptTokenCount without double-counting cached or thought tokens', () => {
  const um = {
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    toolUsePromptTokenCount: 25,
    thoughtsTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 140,
  };
  const { resolvedUsage } = normalizeGeminiUsage(um, {}, null);
  assert.equal(resolvedUsage.inputTokens, 125);
  assert.equal(resolvedUsage.promptTokens, 125);
  assert.equal(resolvedUsage.outputTokens, 15);
  assert.equal(resolvedUsage.cachedTokens, 40);
  assert.equal(resolvedUsage.inputTokens + resolvedUsage.outputTokens, 140);
  const ag = normalizeAntigravityUsage(um);
  assert.equal(ag.inputTokens, 125);
  assert.equal(ag.outputTokens, 15);
  assert.equal(ag.cachedTokens, 40);
});

test('explicit caching is per-model: Gemini 4+ excluded, documented minimums applied', () => {
  assert.equal(geminiExplicitCacheMinTokens('gemini-4-argon'), null);
  assert.equal(geminiExplicitCacheRefused('models/gemini-4-argon'), true);
  assert.equal(geminiExplicitCacheMinTokens('gemini-3.1-pro'), 4096);
  assert.equal(geminiExplicitCacheMinTokens('gemini-2.5-flash'), 2048);
  assert.equal(geminiExplicitCacheRefused('gemini-3.1-pro'), false);
});
