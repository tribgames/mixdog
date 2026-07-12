// Loop termination-reason classification, extracted from loop.mjs.
// Pure function over the final response + loop-end flags. No behavior change:
// the classification ladder is verbatim from the tail of agentLoop.
import { HIDDEN_AGENT_NAMES } from './hidden-agents.mjs';

// Stop reasons that signal the turn was cut short mid-synthesis. This broad set
// retains the pre-existing EMPTY-turn nudge semantics for provider pauses and
// unknown Gemini stops; only OUTPUT_LIMIT_STOP_REASONS below is eligible for
// non-empty continuation recovery.
export const INCOMPLETE_STOP_REASONS = new Set([
    'pause_turn', 'max_tokens', 'length', 'MAX_TOKENS', 'OTHER',
]);

// True provider output ceilings. pause_turn is a provider-controlled pause and
// Gemini OTHER is intentionally opaque; neither is safe to treat as a token-cap
// continuation. Compare case-insensitively so provider spelling variants do not
// create a second policy.
export const OUTPUT_LIMIT_STOP_REASONS = new Set([
    'length', 'max_tokens', 'max_output_tokens',
]);

export function isOutputLimitStopReason(reason) {
    return typeof reason === 'string'
        && OUTPUT_LIMIT_STOP_REASONS.has(reason.trim().toLowerCase());
}

// Classify WHY the loop ended so agent-tool can promote an empty/abnormal
// finish to an explicit Lead-facing error instead of a silent empty
// "completed". Determine "has content" exactly the way the no-tool-call
// branch in agentLoop does (trimmed string content, or any reasoning content).
export function classifyTerminationReason(response, {
    terminatedByCap,
    sessionAgent,
} = {}) {
    const _finalHasContent = (typeof response?.content === 'string' && response.content.trim().length > 0)
        || (typeof response?.reasoningContent === 'string' && response.reasoningContent.trim().length > 0);
    const _finalStopReason = response?.stopReason ?? response?.stop_reason ?? null;
    const _finalIncompleteStop = _finalStopReason && INCOMPLETE_STOP_REASONS.has(_finalStopReason);
    const _finalOutputLimitStop = isOutputLimitStopReason(_finalStopReason);
    const _finalIsHidden = HIDDEN_AGENT_NAMES.has(sessionAgent);
    if (terminatedByCap) {
        // Real problem regardless of hidden/public: the loop never terminated
        // on its own contract.
        return 'iteration_cap';
    }
    if (_finalOutputLimitStop || (!_finalHasContent && _finalIncompleteStop)) {
        // Exhausted token-cap recovery is abnormal even with preserved partial
        // text. pause_turn/OTHER retain their prior non-empty completion
        // semantics, while their empty forms remain abnormal.
        return 'truncated';
    }
    if (!_finalHasContent && !_finalIsHidden) {
        // Empty terminal turn. Only public agents violate their contract by
        // finishing empty — hidden agents (explorer/cycle/…) legitimately emit
        // text-only/empty terminal turns per their own role contract, so leave
        // terminationReason undefined for them.
        return 'empty';
    }
    return undefined;
}
