import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiParseToolCalls, _resolveGeminiCacheUsage } from './_shared.mjs';

// The tool-call id is a content hash → assert the `gemini_` prefix, not the exact value.

test('gemini: native functionCall parts → canonical toolCalls (hashed id)', () => {
  const parts = [{ functionCall: { name: 'read', args: { path: 'a' } } }];
  const out = geminiParseToolCalls(parts);
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'read');
  assert.deepEqual(out[0].arguments, { path: 'a' });
  assert.match(out[0].id, /^gemini_/);
});

test('gemini: no functionCall parts → undefined', () => {
  assert.equal(geminiParseToolCalls([{ text: 'hello' }]), undefined);
  assert.equal(geminiParseToolCalls([]), undefined);
});

test('gemini cache usage: official cached token fields are subsets of prompt tokens', () => {
  const direct = _resolveGeminiCacheUsage({
    usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400 },
  });
  assert.deepEqual(
    {
      inputTokens: direct.inputTokens,
      reportedCachedTokens: direct.reportedCachedTokens,
      cachedTokens: direct.cachedTokens,
      cacheTokenSource: direct.cacheTokenSource,
    },
    {
      inputTokens: 1000,
      reportedCachedTokens: 400,
      cachedTokens: 400,
      cacheTokenSource: 'usage_metadata',
    }
  );

  const sdkAlias = _resolveGeminiCacheUsage({
    usageMetadata: { prompt_token_count: 1200, total_cached_tokens: 500 },
  });
  assert.equal(sdkAlias.inputTokens, 1200);
  assert.equal(sdkAlias.reportedCachedTokens, 500);
  assert.equal(sdkAlias.cachedTokens, 500);
  assert.notEqual(sdkAlias.inputTokens, 0, 'snake_case SDK aliases must remain visible to provider return usage');
});

test('gemini cache usage: total fallback excludes candidate and thought output tokens', () => {
  const camelCase = _resolveGeminiCacheUsage({
    usageMetadata: {
      totalTokenCount: 1000,
      candidatesTokenCount: 150,
      thoughtsTokenCount: 50,
    },
  });
  assert.equal(camelCase.inputTokens, 800);

  const snakeCase = _resolveGeminiCacheUsage({
    usageMetadata: {
      total_token_count: 1200,
      candidates_token_count: 175,
      thoughts_token_count: 25,
    },
  });
  assert.equal(snakeCase.inputTokens, 1000);

  const promptWins = _resolveGeminiCacheUsage({
    usageMetadata: {
      promptTokenCount: 900,
      totalTokenCount: 1200,
      candidatesTokenCount: 250,
      thoughtsTokenCount: 50,
    },
  });
  assert.equal(promptWins.inputTokens, 900);

  const explicitZero = _resolveGeminiCacheUsage({
    usageMetadata: {
      prompt_token_count: 0,
      total_token_count: 1200,
      candidates_token_count: 175,
      thoughts_token_count: 25,
    },
  });
  assert.equal(explicitZero.inputTokens, 0);
});

test('gemini cache usage: clamps over-reported cache and falls back only for attached cachedContent', () => {
  const clamped = _resolveGeminiCacheUsage({
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 150 },
  });
  assert.equal(clamped.cachedTokens, 100);

  const fallback = _resolveGeminiCacheUsage({
    usageMetadata: { promptTokenCount: 1000 },
    cachedContent: 'cachedContents/abc',
    providerState: { gemini: { cacheTokenSize: 250 } },
  });
  assert.equal(fallback.cachedTokens, 250);
  assert.equal(fallback.cacheTokenSource, 'cache_create_fallback');

  const noFallbackWithoutAttachment = _resolveGeminiCacheUsage({
    usageMetadata: { promptTokenCount: 1000 },
    providerState: { gemini: { cacheTokenSize: 250 } },
  });
  assert.equal(noFallbackWithoutAttachment.cachedTokens, 0);
  assert.equal(noFallbackWithoutAttachment.cacheTokenSource, 'none');
});

test('gemini cache usage: a reported zero never becomes a cache-create estimate', () => {
  for (const field of [
    'cachedContentTokenCount',
    'cached_content_token_count',
    'totalCachedTokens',
    'total_cached_tokens',
  ]) {
    const result = _resolveGeminiCacheUsage({
      usageMetadata: { promptTokenCount: 100, [field]: 0 },
      cachedContent: 'cachedContents/zero',
      providerState: { gemini: { cacheTokenSize: 80 } },
    });
    assert.equal(result.inputTokens, 100, field);
    assert.equal(result.reportedCachedTokens, 0, field);
    assert.equal(result.cachedTokens, 0, field);
    assert.equal(result.cacheTokenSource, 'usage_metadata', field);
  }
});

test('gemini cache usage: missing fields may fall back, and canonical zero wins over convenience aliases', () => {
  const options = {
    cachedContent: 'cachedContents/fixture',
    providerState: { gemini: { cacheTokenSize: 80 } },
  };
  const absent = _resolveGeminiCacheUsage({
    ...options,
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: null },
  });
  assert.equal(absent.cachedTokens, 80);
  assert.equal(absent.cacheTokenSource, 'cache_create_fallback');
  const explicit = _resolveGeminiCacheUsage({
    ...options,
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 0, totalCachedTokens: 80 },
  });
  assert.equal(explicit.cachedTokens, 0);
  assert.equal(explicit.cacheTokenSource, 'usage_metadata');
});
