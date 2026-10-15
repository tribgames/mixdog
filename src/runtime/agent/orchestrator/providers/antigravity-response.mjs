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
import {
  parseToolCalls,
  emitGeminiToolCalls,
  collectGeminiGroundingSources,
  parseGeminiTextPartMetadata,
} from './gemini-schema.mjs';
import { geminiFinishErrorFields, geminiPolicyFinishCode } from './gemini-error-contract.mjs';

// Pure usageMetadata normalization shared by the success path and a failed
// stream's partialUsage.
export function normalizeAntigravityUsage(um) {
  const inputTokens =
    (um.promptTokenCount || um.prompt_token_count || 0) +
    (um.toolUsePromptTokenCount || um.tool_use_prompt_token_count || 0);
  const cachedTokens = um.cachedContentTokenCount || um.cached_content_token_count || 0;
  const outputTokens =
    (um.candidatesTokenCount || um.candidates_token_count || 0) +
    (um.thoughtsTokenCount || um.thoughts_token_count || 0);
  return { inputTokens, outputTokens, cachedTokens, promptTokens: inputTokens, raw: um };
}

/**
 * @param {object} deps
 * @param {object} deps.response  final unwrapped Gemini-shaped payload
 * @param {ReturnType<import('./antigravity-stream.mjs').createAntigravityStreamCollector>} deps.collector
 * @param {string} deps.useModel  wire model id
 * @param {object} deps.opts  send options (session/iteration/providerState)
 * @param {Function|null} deps.onToolCall  receives the turn's calls after a clean finish
 */
export function finalizeAntigravityTurn({ response, collector, useModel, opts, onToolCall }) {
  const textLeakGuard = collector.leakGuard;
  const candidate = response.candidates?.[0] || null;
  const responseParts = candidate?.content?.parts ?? [];
  const textParts = responseParts.filter((p) => p?.thought !== true && 'text' in p);
  const rawContent = textParts.map((p) => p.text).join('');
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
  let nativeToolCalls = parseToolCalls(responseParts);
  if (textLeakGuard?.enabled) nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
  let toolCalls = nativeToolCalls;
  if (leakedToolCalls.length) {
    toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
  }
  const citations = collectGeminiGroundingSources(candidate);

  const promptBlockReason = response.promptFeedback?.blockReason || null;
  const finishReason =
    collector.terminalFailure || candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
  const normalizedFinish = String(finishReason || '').replace(/^FINISH_REASON_/, '');
  const um = response.usageMetadata || null;
  let usage;
  if (um) {
    usage = normalizeAntigravityUsage(um);
    const { inputTokens, outputTokens, cachedTokens } = usage;
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

  // A MAX_TOKENS cut that still delivered whole native functionCall parts is
  // a tool-use turn: the calls arrived intact, only trailing output was cut.
  // Every other non-STOP finish fails the turn, and so does a cut whose text
  // also leaked a call (that call may be as truncated as the text around it).
  const completeNativeCalls =
    normalizedFinish === 'MAX_TOKENS' &&
    String(candidate?.finishReason || '').replace(/^FINISH_REASON_/, '') === 'MAX_TOKENS' &&
    !leakedToolCalls.length &&
    !!nativeToolCalls?.length &&
    nativeToolCalls.every((call) => typeof call?.name === 'string' && call.name !== '');
  if (finishReason && normalizedFinish !== 'STOP' && !completeNativeCalls) {
    throw Object.assign(new Error(`Antigravity response incomplete: finishReason=${finishReason}`), {
      name: 'ProviderIncompleteError',
      code: geminiPolicyFinishCode(finishReason) || 'PROVIDER_INCOMPLETE',
      providerIncomplete: true,
      finishReason,
      partialContent: content,
      partialToolCalls: toolCalls,
      partialProviderReplay: providerReplay,
      providerMetadata,
      model: useModel,
      rawUsage: response.usageMetadata || null,
      ...(usage ? { partialUsage: usage, partialModel: useModel } : {}),
      ...geminiFinishErrorFields(response),
    });
  }

  // Terminal status first: a failed turn never runs its tool calls.
  textLeakGuard?.releaseDeferredToolCalls();
  emitGeminiToolCalls(nativeToolCalls, onToolCall);

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
