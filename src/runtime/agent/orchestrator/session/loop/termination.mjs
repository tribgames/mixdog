// Loop termination-reason classification, extracted from loop.mjs.
// Pure function over the final response + loop-end flags. No behavior change:
// the classification ladder is verbatim from the tail of agentLoop.
import { HIDDEN_AGENT_NAMES } from './hidden-agents.mjs';

// Stop reasons that signal the turn was cut short mid-synthesis (token cap,
// provider pause). Empty content + one of these reasons means the worker
// was not done. Covers Anthropic (pause_turn, max_tokens), OpenAI (length),
// Gemini (MAX_TOKENS, OTHER), and case variants.
export const INCOMPLETE_STOP_REASONS = new Set([
    'pause_turn', 'max_tokens', 'length', 'MAX_TOKENS', 'OTHER',
]);

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
    const _finalIsHidden = HIDDEN_AGENT_NAMES.has(sessionAgent);
    if (terminatedByCap) {
        // Real problem regardless of hidden/public: the loop never terminated
        // on its own contract.
        return 'iteration_cap';
    }
    if (!_finalHasContent && _finalIncompleteStop) {
        // Cut short mid-synthesis (token cap / provider pause). Real problem
        // for hidden agents too.
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
