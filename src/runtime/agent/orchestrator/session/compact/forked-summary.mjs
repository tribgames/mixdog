// The conversation summary as a cache-sharing fork of the session's latest
// provider request: the same provider, model, system prompt, tools, send
// options and message prefix, with the summary instruction appended as the
// final user turn. The provider's prompt cache serves the whole prefix, so
// the request pays cache-read prices for the context instead of sending a
// separate text-only transcript uncached.
//
// The fork is skipped (and the isolated summary request runs instead) when
// there is no settled request to fork, the summary route is a different
// provider or model (a cache is never shared across them), or the fork would
// not fit the window. A fork that fails, answers with a tool call or returns
// no text falls back the same way; cancellation and timeout propagate.
import { estimateMessagesTokens, estimateRequestReserveTokens, providerTokenCalibration } from '../context-utils.mjs';
import { disposeTransportScope, forkTransportScope } from '../../providers/transport-scope.mjs';
import { buildForkedRequest } from '../request-fork.mjs';
import { compactionForkRequest } from '../side-question-store.mjs';
import { HANDOFF_TIMEOUT_MAX_MS, SUMMARY_OUTPUT_TOKENS } from './constants.mjs';
import { enforceCompactSummarySchema, extractResponseText, forkedCompactionPrompt } from './summary.mjs';

const FORK_TOOL_STUB = 'Result omitted from this summary request; the call and its result are kept after the summary.';

function forkSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(Number(timeoutMs) > 0 ? Math.floor(timeoutMs) : HANDOFF_TIMEOUT_MAX_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function forkUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    cachedTokens: Number(usage.cachedTokens) || 0,
    cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
  };
}

// Why the fork cannot run on this route, or null when it can.
function forkSkipReason(request, route) {
  if (!request) return 'no_settled_request';
  const sameProvider = request.provider === route.provider || request.provider?.name === route.providerName;
  if (!sameProvider || request.model !== route.model) return 'different_route';
  return null;
}

/**
 * Summarize `conversationInput`'s history through a fork of the session's
 * latest request on `route`. Returns `{ generated }` in the shape of
 * generateFreshHandoffSummary's result, or `{ fallback }` naming why the
 * isolated request must run instead.
 */
export async function summarizeOnSharedPrefix({ sessionId, route, conversationInput, signal, timeoutMs }) {
  const request = compactionForkRequest(sessionId);
  const skip = forkSkipReason(request, route);
  if (skip) return { fallback: skip };
  const startedAt = Date.now();
  const { messages, opts } = buildForkedRequest(request, forkedCompactionPrompt(), FORK_TOOL_STUB);
  const promptTokens = estimateMessagesTokens(messages) + estimateRequestReserveTokens(request.tools);
  const window = Math.floor(Number(route.contextWindow) / providerTokenCalibration(route.providerName));
  if (!(promptTokens + SUMMARY_OUTPUT_TOKENS <= window)) return { fallback: 'window' };
  const requestSignal = forkSignal(signal, timeoutMs);
  // The fork keeps the session id (prompt-cache routing) on its own transport
  // scope: no pooled socket or response chain of the main session is touched.
  const transportScope = forkTransportScope(sessionId, 'compact');
  let response;
  try {
    response = await route.provider.send(messages, request.model, request.tools.length ? request.tools : undefined, {
      ...opts,
      transportScope,
      admissionOwner: sessionId,
      signal: requestSignal,
    });
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason ?? error;
    return { fallback: 'error', error };
  } finally {
    disposeTransportScope(transportScope, route.provider);
  }
  requestSignal.throwIfAborted();
  const usage = forkUsage(response?.usage);
  if (response?.toolCalls?.length) return { fallback: 'tool_call', usage };
  const raw = extractResponseText(response);
  if (!raw) return { fallback: 'empty', usage };
  const enforced = enforceCompactSummarySchema(raw, { head: conversationInput, tail: [] });
  return {
    generated: {
      summary: enforced.summary,
      summaryRepaired: enforced.repaired === true,
      usage,
      handoffGenerated: true,
      diagnostics: {
        mode: 'shared-prefix',
        calls: 1,
        sharedPrefixMessages: request.messages.length,
        promptTokens,
        summaryChars: enforced.summary.length,
        rawSummaryChars: raw.length,
        summaryRepaired: enforced.repaired === true,
        durationMs: Date.now() - startedAt,
      },
    },
  };
}
