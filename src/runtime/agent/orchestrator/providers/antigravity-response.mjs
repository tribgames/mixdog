/**
 * antigravity-response.mjs — the caller-visible result of one finished
 * Antigravity turn: leak-scrubbed assistant text, the ordered replay parts,
 * native plus text-recovered tool calls, grounding citations, the
 * terminal-finishReason verdict that becomes a typed ProviderIncompleteError
 * carrying the partial turn, and the usage accounting (promptTokenCount is
 * already the total, cached tokens included).
 */
import { traceAgentUsage } from '../agent-trace.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { parseToolCalls, collectGeminiGroundingSources, parseGeminiTextPartMetadata } from './gemini-schema.mjs';

/**
 * @param {object} deps
 * @param {object} deps.response  final unwrapped Gemini-shaped payload
 * @param {ReturnType<import('./antigravity-stream.mjs').createAntigravityStreamCollector>} deps.collector
 * @param {string} deps.useModel  wire model id
 * @param {object} deps.opts  send options (session/iteration/providerState)
 * @param {Function|null} deps.onToolCall  set when calls were streamed live
 */
export function finalizeAntigravityTurn({ response, collector, useModel, opts, onToolCall }) {
  const textLeakGuard = collector.leakGuard;
  const candidate = response.candidates?.[0] || null;
  const responseParts = candidate?.content?.parts ?? [];
  const textParts = responseParts.filter((p) => p?.thought !== true && 'text' in p);
  const rawContent = textParts.map((p) => ('text' in p ? p.text : '')).join('');
  const providerMetadata = parseGeminiTextPartMetadata(responseParts);
  const content = textLeakGuard?.enabled ? textLeakGuard.scrubAssistantText(rawContent) : rawContent;
  const leakedToolCalls = textLeakGuard?.getLeakedToolCalls() ?? [];
  const providerReplay = createProviderReplay(
    'antigravity',
    leakedToolCalls.length || rawContent !== content ? [] : responseParts
  );
  // Thought signatures are only valid for the model family that minted
  // them; the request builder consults this when the route changes.
  if (providerReplay) providerReplay.requestContext = { model: useModel };
  let nativeToolCalls;
  if (!onToolCall) nativeToolCalls = parseToolCalls(responseParts);
  else if (collector.streamedNativeToolCalls.length) nativeToolCalls = collector.streamedNativeToolCalls;
  if (!onToolCall && textLeakGuard?.enabled) nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
  let toolCalls = nativeToolCalls;
  if (leakedToolCalls.length) {
    toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
  }
  const citations = collectGeminiGroundingSources(candidate);

  const promptBlockReason = response.promptFeedback?.blockReason || null;
  const finishReason =
    collector.terminalFailure || candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
  const normalizedFinish = String(finishReason || '').replace(/^FINISH_REASON_/, '');
  if (finishReason && normalizedFinish !== 'STOP') {
    throw Object.assign(new Error(`Antigravity response incomplete: finishReason=${finishReason}`), {
      name: 'ProviderIncompleteError',
      code: 'PROVIDER_INCOMPLETE',
      providerIncomplete: true,
      finishReason,
      partialContent: content,
      partialToolCalls: toolCalls,
      partialProviderReplay: providerReplay,
      providerMetadata,
      model: useModel,
      rawUsage: response.usageMetadata || null,
      ...(collector.emittedToolCount ? { emittedToolCall: true, unsafeToRetry: true } : {}),
    });
  }

  const um = response.usageMetadata || null;
  let usage;
  if (um) {
    const inputTokens = um.promptTokenCount || um.prompt_token_count || 0;
    const cachedTokens = um.cachedContentTokenCount || um.cached_content_token_count || 0;
    const outputTokens =
      (um.candidatesTokenCount || um.candidates_token_count || 0) +
      (um.thoughtsTokenCount || um.thoughts_token_count || 0);
    usage = { inputTokens, outputTokens, cachedTokens, promptTokens: inputTokens, raw: um };
    traceAgentUsage({
      sessionId: opts.sessionId || opts.session?.id || null,
      iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      promptTokens: inputTokens,
      model: useModel,
      modelDisplay: useModel,
      rawUsage: um,
      provider: 'antigravity-oauth',
    });
  }

  return {
    content,
    model: useModel,
    toolCalls,
    citations: citations.length ? citations : undefined,
    providerReplay,
    providerMetadata,
    providerState: opts.providerState,
    usage,
  };
}
