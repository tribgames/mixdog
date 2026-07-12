// provider.send wrapper with stall/overflow recovery, extracted from
// agent-loop.mjs. Returns { action } so the loop keeps control of the
// while-loop: proceed carries the response, retry signals a reactive
// context-overflow compact retry (caller re-enters the pre-send compact
// pass), and unrecoverable errors throw. Behavior identical to the inline
// try/catch it replaced.
import { appendAgentTrace } from '../agent-trace.mjs';
import { isContextOverflowError } from '../providers/retry-classifier.mjs';
import { resolveWorkerCompactPolicy } from './loop/compact-policy.mjs';
import { agentContextOverflowError } from './loop/context-overflow.mjs';
import { estimateMessagesTokensSafe } from './loop/compact-debug.mjs';
import { isOutputLimitStopReason } from './loop/termination.mjs';

function normalizedIncompleteUsage(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const inputTokens = Number(raw.promptTokenCount ?? raw.prompt_token_count ?? raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0;
    const candidateTokens = Number(raw.candidatesTokenCount ?? raw.candidates_token_count ?? 0) || 0;
    const thoughtTokens = Number(raw.thoughtsTokenCount ?? raw.thoughts_token_count ?? 0) || 0;
    const outputFallback = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
    const cachedTokens = Number(raw.cachedContentTokenCount ?? raw.cached_content_token_count ?? raw.cached_tokens ?? 0) || 0;
    return {
        inputTokens,
        outputTokens: candidateTokens + thoughtTokens || outputFallback,
        cachedTokens,
        cacheWriteTokens: 0,
        promptTokens: inputTokens,
        raw,
    };
}

export async function sendWithRecovery(ctx) {
    const {
        provider, messages, model, sendTools, tools, opts,
        sessionId, sessionRef, nextIteration, contextOverflowRetryUsed,
    } = ctx;
    let response;
        try {
            response = await provider.send(messages, model, sendTools.length ? sendTools : undefined, opts);
        } catch (sendErr) {
            // Gemini REST/SDK reports MAX_TOKENS by throwing a typed
            // ProviderIncompleteError after preserving the streamed candidate.
            // Normalize only that exact, safe no-tool output-limit shape into a
            // regular truncated response; all moderation/OTHER/tool-bearing and
            // unrelated errors continue through their existing error paths.
            if (
                sendErr?.providerIncomplete === true
                && sendErr.code === 'PROVIDER_INCOMPLETE'
                && isOutputLimitStopReason(sendErr.finishReason)
                && typeof sendErr.partialContent === 'string'
                && sendErr.partialContent.trim().length > 0
                && sendErr.pendingToolUse !== true
                && sendErr.emittedToolCall !== true
                && !(Array.isArray(sendErr.partialToolCalls) && sendErr.partialToolCalls.length > 0)
            ) {
                response = {
                    content: sendErr.partialContent,
                    model: sendErr.model || model,
                    toolCalls: undefined,
                    usage: normalizedIncompleteUsage(sendErr.rawUsage),
                    stopReason: sendErr.finishReason,
                    truncated: true,
                    providerState: opts.providerState,
                    providerIncompleteRecovery: true,
                };
                return { action: 'proceed', response };
            } else
            // Partial-final recovery (owner-notify fix): the recurring "worker
            // finished but the task hung / no result delivered" case is a FINAL,
            // no-tool summary stream that wedges (ping-only) AFTER all real tool
            // work completed in earlier iterations. The provider attaches its
            // partial stream state to the StreamStalledError. When the stall
            // carries streamed assistant text, has NO pending tool_use, and did
            // NOT emit a tool call this iteration, accept the partial as a
            // successful terminal response (deliver the summary we have) instead
            // of throwing — which would strand/notify-as-failure a turn whose
            // work actually succeeded. A stall WITH a pending/emitted tool call
            // is NOT recoverable (a tool whose input never completed must never
            // look done) and falls through to the normal error path.
            if (
                sendErr?.streamStalled === true
                && sendErr.pendingToolUse !== true
                // NOT gated on unsafeToRetry: live-text stalls stamp
                // unsafeToRetry=true (replay would double-render), but
                // ACCEPTING the already-streamed partial is exactly the safe
                // move (CC rule). Only an emitted tool call blocks acceptance.
                && sendErr.emittedToolCall !== true
                && typeof sendErr.partialContent === 'string'
                && sendErr.partialContent.trim().length > 0
                && !(Array.isArray(sendErr.partialToolCalls) && sendErr.partialToolCalls.length > 0)
            ) {
                try {
                    process.stderr.write(
                        `[loop] final stream stalled with partial text (sess=${sessionId || 'unknown'} `
                        + `iter=${nextIteration} len=${sendErr.partialContent.length}); `
                        + `accepting as partial-final success\n`,
                    );
                } catch { /* best-effort */ }
                response = {
                    content: sendErr.partialContent,
                    model: sendErr.partialModel || model,
                    toolCalls: undefined,
                    usage: sendErr.partialUsage || undefined,
                    stopReason: sendErr.partialStopReason || 'end_turn',
                    hasThinkingContent: sendErr.partialHasThinking === true,
                    partialFinal: true,
                };
            } else
            // Partial tool-call recovery (agent-hang fix): a stream that stalls
            // AFTER fully-parsed tool calls were emitted used to lose the whole
            // turn — unsafeToRetry blocks the mid-stream replay (correct: a
            // replay would re-run side-effecting tools) and the old code threw,
            // discarding tool work that had ALREADY completed via eager dispatch.
            // But the parsed calls are complete (pendingToolUse false ⇒ no
            // half-streamed tool input), so instead of replaying the request we
            // accept the partial as a normal tool-call turn and fall through to
            // the standard execution path: eager-dispatched (read-only) calls
            // resolve from the pending map without re-running, side-effecting
            // calls were never started during streaming and execute exactly
            // once. providerState stays undefined so the next iteration resends
            // a full frame on a fresh stream.
            if (
                sendErr?.streamStalled === true
                && sendErr.pendingToolUse !== true
                && Array.isArray(sendErr.partialToolCalls)
                && sendErr.partialToolCalls.length > 0
            ) {
                try {
                    process.stderr.write(
                        `[loop] stream stalled after ${sendErr.partialToolCalls.length} complete tool call(s) `
                        + `(sess=${sessionId || 'unknown'} iter=${nextIteration}); `
                        + `recovering as tool-call turn instead of failing\n`,
                    );
                } catch { /* best-effort */ }
                try {
                    appendAgentTrace({
                        kind: 'stall_tool_recovery',
                        sessionId: sessionId || null,
                        iteration: nextIteration,
                        toolCalls: sendErr.partialToolCalls.length,
                        partialContentLen: typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0,
                    });
                } catch { /* best-effort */ }
                response = {
                    content: typeof sendErr.partialContent === 'string' ? sendErr.partialContent : '',
                    model: sendErr.partialModel || model,
                    toolCalls: sendErr.partialToolCalls.slice(),
                    usage: sendErr.partialUsage || undefined,
                    stopReason: 'tool_use',
                    hasThinkingContent: sendErr.partialHasThinking === true,
                    partialToolRecovery: true,
                };
            } else
            // Context-window-exceeded is a deterministic refusal from the API.
            // Recover context overflow reactively by compacting and retrying
            // in the same active turn. MixDog's proactive estimator can miss a
            // provider-specific overhead spike, so do one reactive retry by
            // marking the live session over-threshold and looping back through
            // the normal pre-send auto-compact path. If compaction/retry still
            // fails, surface the overflow normally.
            if (
                !isContextOverflowError(sendErr)
                || !(sessionRef && typeof sessionRef.contextWindow === 'number')
            ) {
                throw sendErr;
            }
            const compactPolicyForRetry = resolveWorkerCompactPolicy(sessionRef, sendTools.length ? sendTools : tools);
            if (!contextOverflowRetryUsed && compactPolicyForRetry?.auto) {
                // Mark the next pre-send compact as REACTIVE (driven by a
                // provider overflow refusal) rather than the normal proactive
                // pressure trigger, so the compact event/telemetry the loop
                // emits on the retry is distinguishable downstream.
                opts.onToolCall = undefined;
                try {
                    process.stderr.write(
                        `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                        `reactive compact retry messages=${messages.length}\n`,
                    );
                } catch { /* best-effort */ }
                return { action: 'retry' };
            }
            try {
                process.stderr.write(
                    `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                    `surfacing overflow after reactive compact retry messages=${messages.length}\n`,
                );
            } catch { /* best-effort */ }
            throw agentContextOverflowError({
                stage: 'send',
                sessionId,
                sessionRef,
                model,
                budgetTokens: sessionRef.contextWindow,
                reserveTokens: compactPolicyForRetry?.reserveTokens,
                messageTokensEst: estimateMessagesTokensSafe(messages),
            }, sendErr);
        }
    return { action: 'proceed', response };
}
