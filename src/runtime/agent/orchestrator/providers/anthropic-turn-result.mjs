/**
 * anthropic-turn-result.mjs — usage accounting and the caller-visible result
 * of one finished API-key Anthropic turn: the token split Anthropic reports
 * (input excludes cache read/write, so promptTokens adds them back), the
 * agent-trace usage emit, and the projection of the parsed turn — text, tool
 * calls, stop reason, verbatim thinking and native server-tool blocks,
 * provider replay/metadata — the loop consumes.
 *
 * Shared by the streaming success path and the non-streaming fallback so both
 * account for usage identically.
 */
import { traceAgentUsage } from '../agent-trace.mjs';

/**
 * @param {object} parseResult  the assembled turn (streaming or normalized non-streaming)
 * @param {object} ctx
 * @param {string} ctx.provider  provider instance name, as recorded in the usage trace
 * @param {string} ctx.useModel  requested model (fallback when the turn reports none)
 * @param {object} ctx.opts  send options (session/iteration/requestKind)
 */
export function buildAnthropicTurnResult(parseResult, { provider, useModel, opts }) {
  const usageRaw = parseResult.usage?.raw || null;
  const input = parseResult.usage?.inputTokens || 0;
  const cacheRead = parseResult.usage?.cachedTokens || 0;
  const cacheWrite = parseResult.usage?.cacheWriteTokens || 0;
  const output = parseResult.usage?.outputTokens || 0;
  const promptTokens = parseResult.usage?.promptTokens ?? input + cacheRead + cacheWrite;
  const liveModel = parseResult.model || useModel;

  if (usageRaw || input || output || cacheRead || cacheWrite) {
    traceAgentUsage({
      sessionId: opts.sessionId || opts.session?.id || null,
      iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      promptTokens,
      model: liveModel,
      modelDisplay: liveModel,
      responseId: null,
      rawUsage: usageRaw,
      provider,
      requestKind: opts.requestKind || null,
      // Anthropic usage is additive at this inner transport
      // boundary, even when OpenCode Go supplies the provider id.
      inputTokensInclusive: false,
    });
  }

  return {
    content: parseResult.content || '',
    model: liveModel,
    toolCalls: parseResult.toolCalls,
    stopReason: parseResult.stopReason || null,
    hasThinkingContent: !!parseResult.hasThinkingContent,
    contentBlockTypes: Array.isArray(parseResult.contentBlockTypes) ? parseResult.contentBlockTypes : [],
    // Round-trip adaptive-thinking blocks (verbatim thinking +
    // signature) so the loop can store them and replay them before
    // tool_use on the next turn. Matches anthropic-oauth's return.
    thinkingBlocks:
      Array.isArray(parseResult.thinkingBlocks) && parseResult.thinkingBlocks.length
        ? parseResult.thinkingBlocks
        : undefined,
    // Ordered NATIVE server-tool blocks (server_tool_use +
    // *_tool_result) exist ONLY in this verbatim list — they are
    // never dispatched as client tool calls and cannot be rebuilt
    // from content/toolCalls/thinkingBlocks. Dropping them here
    // broke `pause_turn` continuations on the API-key path (the
    // OAuth provider returns the parse result as-is). Absent for
    // ordinary turns, so nothing else changes.
    assistantBlocks:
      Array.isArray(parseResult.assistantBlocks) && parseResult.assistantBlocks.length
        ? parseResult.assistantBlocks
        : undefined,
    ...(parseResult.providerReplay ? { providerReplay: parseResult.providerReplay } : {}),
    ...(parseResult.providerMetadata && typeof parseResult.providerMetadata === 'object'
      ? { providerMetadata: parseResult.providerMetadata }
      : {}),
    usage: {
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      ...(parseResult.usage?.cacheWrite1hTokens ? { cacheWrite1hTokens: parseResult.usage.cacheWrite1hTokens } : {}),
      promptTokens,
    },
  };
}
