/**
 * Interpretation of a completed Gemini response: candidate text/tool-call
 * extraction after the text-leak guard, the finishReason completeness
 * contract, usage normalization (with the cache-token resolution and its
 * usage trace) and the provider result shape the agent loop consumes.
 *
 * Wire contract: `candidates`, `content.parts`, `thought`, `finishReason`
 * (including the legacy `FINISH_REASON_` prefix), `promptFeedback.blockReason`
 * and every `usageMetadata` field name (camelCase SDK + snake_case REST
 * aliases) are Gemini's own keys and are read verbatim.
 */
import { traceAgentUsage } from '../agent-trace.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { collectGeminiGroundingSources, parseGeminiTextPartMetadata, parseToolCalls } from './gemini-schema.mjs';
import { _resolveGeminiCacheUsage } from './gemini-cache.mjs';
import { traceGeminiCache } from './gemini-cache-policy.mjs';

// Candidate text and tool calls after the text-leak guard: leaked
// (text-embedded) tool calls are appended to the native ones and empty the
// provider replay.
export function parseGeminiCandidate(response, textLeakGuard) {
  const candidate = response.candidates?.[0] || null;
  const responseParts = candidate?.content?.parts ?? [];
  const textParts = responseParts.filter((p) => p?.thought !== true && 'text' in p);
  const rawContent = textParts.map((p) => p.text).join('');
  const providerMetadata = parseGeminiTextPartMetadata(responseParts);
  const content = textLeakGuard?.enabled ? textLeakGuard.scrubAssistantText(rawContent) : rawContent;
  const leakedToolCalls = textLeakGuard?.getLeakedToolCalls() ?? [];
  const providerReplay = createProviderReplay('gemini', leakedToolCalls.length ? [] : responseParts);
  let nativeToolCalls = parseToolCalls(responseParts);
  if (textLeakGuard?.enabled) {
    nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
  }
  let toolCalls = nativeToolCalls;
  if (leakedToolCalls.length) {
    toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
  }
  return {
    candidate,
    content,
    providerMetadata,
    providerReplay,
    nativeToolCalls,
    toolCalls,
    citations: collectGeminiGroundingSources(candidate),
  };
}

// Inspect candidate.finishReason — Gemini reports terminal status here.
// Only STOP (and the legacy "FINISH_REASON_STOP") plus tool/function-call
// paths represent a fully delivered turn. MAX_TOKENS / SAFETY / RECITATION /
// OTHER all mean the candidate was cut off before the model finished, and
// surfacing the partial text as final would silently accept a truncated
// answer. Those become a typed provider-incomplete error so the loop can
// decide whether to retry, nudge, or surface to the user. Missing
// finishReason (still streaming / unknown) is left alone — existing success
// paths for genuinely complete responses keep working. Newly-added
// safety/image/tool/malformed reasons are incomplete by default instead of
// silently accepting partial or empty output.
export function geminiIncompleteError(response, parsed, useModel, usage = null) {
  const promptBlockReason = response.promptFeedback?.blockReason || null;
  const finishReason = parsed.candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
  const normalizedFinishReason = String(finishReason || '').replace(/^FINISH_REASON_/, '');
  if (!finishReason || normalizedFinishReason === 'STOP') return null;
  return Object.assign(new Error(`Gemini response incomplete: finishReason=${finishReason}`), {
    name: 'ProviderIncompleteError',
    code: 'PROVIDER_INCOMPLETE',
    providerIncomplete: true,
    finishReason,
    partialContent: parsed.content,
    partialToolCalls: parsed.toolCalls,
    partialProviderReplay: parsed.providerReplay,
    providerMetadata: parsed.providerMetadata,
    model: useModel,
    rawUsage: response.usageMetadata || null,
    ...(usage ? { partialUsage: usage, partialModel: useModel } : {}),
  });
}

// Normalized usage from usageMetadata. cachedTokens is only what this
// response reported; the cache-size fallback stays a diagnostic of the
// cache trace and never enters accounting.
// Pure normalization shared by the success path and a failed stream's
// partialUsage (no trace side effects).
export function normalizeGeminiUsage(um, opts, cachedContent) {
  const cache = _resolveGeminiCacheUsage({
    usageMetadata: um,
    cachedContent,
    providerState: opts.providerState,
  });
  const { inputTokens, reportedCachedTokens } = cache;
  const cachedTokens = inputTokens > 0 ? Math.min(reportedCachedTokens, inputTokens) : reportedCachedTokens;
  const outputTokens =
    (um.candidatesTokenCount || um.candidates_token_count || 0) +
    (um.thoughtsTokenCount || um.thoughts_token_count || 0);
  const resolvedUsage = {
    inputTokens,
    outputTokens,
    cachedTokens,
    raw: um,
    // Gemini promptTokenCount is total (cachedContentTokenCount is a
    // subset). Alias the resolver's normalized total directly.
    promptTokens: inputTokens,
  };
  return { resolvedUsage, cache };
}

/** failureUsage option for the Gemini stream consumers. */
export function geminiFailureUsage(opts, cachedContent, useModel) {
  return {
    model: useModel,
    normalize: (um) => normalizeGeminiUsage(um, opts || {}, cachedContent).resolvedUsage,
  };
}

export function resolveGeminiUsage(response, opts, cachedContent, useModel) {
  const um = response.usageMetadata || null;
  if (!um) return null;
  const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
  const { resolvedUsage, cache } = normalizeGeminiUsage(um, opts, cachedContent);
  const { inputTokens, reportedCachedTokens, cachedFallbackTokens, cachedTokens, cacheTokenSource } = cache;
  if (cachedContent && inputTokens > 0 && cachedTokens <= 0) {
    traceGeminiCache(opts, iteration, 'gemini_cache_anomaly', {
      reason: 'cached_content_attached_but_zero_cached_tokens',
      inputTokens,
      reportedCachedTokens,
      cachedFallbackTokens,
      cacheTokenSource,
      cacheName: opts.providerState?.gemini?.cacheName || null,
      cachePrefixContentCount: opts.providerState?.gemini?.cachePrefixContentCount ?? null,
    });
  }
  traceAgentUsage({
    sessionId: opts.sessionId || opts.session?.id || null,
    iteration,
    inputTokens: resolvedUsage.inputTokens,
    outputTokens: resolvedUsage.outputTokens,
    cachedTokens: resolvedUsage.cachedTokens,
    cacheWriteTokens: 0,
    promptTokens: resolvedUsage.promptTokens,
    model: useModel,
    modelDisplay: useModel,
    rawUsage: um,
    provider: 'gemini',
  });
  return resolvedUsage;
}

export function geminiSendResult(parsed, useModel, opts, resolvedUsage) {
  return {
    content: parsed.content,
    model: useModel,
    toolCalls: parsed.toolCalls,
    citations: parsed.citations.length ? parsed.citations : undefined,
    providerReplay: parsed.providerReplay,
    providerMetadata: parsed.providerMetadata,
    providerState: opts.providerState,
    // Use the same normalized usage object traceAgentUsage recorded,
    // including snake_case SDK aliases and cache-create fallback.
    usage: resolvedUsage || undefined,
  };
}
