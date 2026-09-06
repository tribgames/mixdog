// Budget math, tool-output pruning, cycle1 draining, and preserved-fact
// extraction. Extracted verbatim from compact.mjs (behavior-preserving).
import { sanitizeToolPairs, dedupToolResultBodies, reconcileDedupStubs, estimateMessagesTokens, estimateMessageTokens } from '../context-utils.mjs';
import { compactOffloadedToolResultText } from '../tool-result-offload.mjs';

// Floor for the reserve-adjusted compact budget. When the tool-schema/request
// reserve rivals the whole budget (huge agent tool surfaces), subtracting the
// full reserve could leave a degenerate target; keep enough room to attempt a
// summary and let the final fit check decide. Logged as degraded because a
// floored budget can still overflow on the next send.
const MIN_EFFECTIVE_COMPACT_BUDGET_TOKENS = 1024;
export function effectiveBudget(budgetTokens, opts) {
    if (!(budgetTokens > 0)) throw new Error('compact: budgetTokens must be > 0');
    const reserve = Number(opts?.reserveTokens) || 0;
    if (reserve <= 0) return budgetTokens;
    // Subtract the FULL reserve so an accepted compact actually fits next to
    // the request reserve on the following send. The previous 50%-of-budget cap
    // under-reserved large tool surfaces (agent sessions): a compact could be
    // "accepted" at budget/2 while the true remaining room was smaller, then
    // overflow immediately on the next request.
    const remaining = budgetTokens - reserve;
    if (remaining >= MIN_EFFECTIVE_COMPACT_BUDGET_TOKENS) return remaining;
    const floored = Math.max(1, Math.min(budgetTokens, MIN_EFFECTIVE_COMPACT_BUDGET_TOKENS));
    try { process.stderr.write(`[compact] degraded budget: reserve=${reserve} leaves ${remaining} of budget=${budgetTokens}; flooring to ${floored}\n`); } catch { /* best-effort */ }
    return floored;
}

const PRUNE_TOOL_OUTPUT_MAX_CHARS = 2_000;
const PRUNE_TAIL_TURNS = 2;

function protectedTailStart(messages, tailTurns = PRUNE_TAIL_TURNS) {
    let seenUsers = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role !== 'user') continue;
        seenUsers += 1;
        if (seenUsers >= tailTurns) return i;
    }
    return 0;
}

function pruneToolOutputText(text, maxChars, toolCallId) {
    const value = String(text ?? '');
    if (value.length <= maxChars) return value;
    return compactOffloadedToolResultText(value);
}

export function pruneToolOutputs(messages, budgetTokens, opts = {}) {
    const budget = effectiveBudget(budgetTokens, opts);
    let result = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    // Running total with per-message deltas: the estimator is additive, so
    // replacing one message shifts the total by exactly that message's delta.
    // Re-estimating the WHOLE transcript after every pruned message was
    // O(candidates × transcript) and measured ~1.25s on a 2.5MB session.
    // Keep the same running-total shape during pruning.
    let total = estimateMessagesTokens(result);
    if (total <= budget) return result;

    const maxChars = Math.max(256, Number(opts?.maxToolOutputChars) || PRUNE_TOOL_OUTPUT_MAX_CHARS);
    const protectFrom = protectedTailStart(result, Number(opts?.tailTurns) || PRUNE_TAIL_TURNS);
    const candidates = [];
    for (let i = 0; i < protectFrom; i += 1) {
        const m = result[i];
        if (m?.role !== 'tool' || typeof m.content !== 'string') continue;
        if (m.content.length <= maxChars) continue;
        candidates.push({ index: i, length: m.content.length });
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const c of candidates) {
        const m = result[c.index];
        const content = pruneToolOutputText(m.content, maxChars, m.toolCallId);
        if (content === m.content) continue;
        const pruned = {
            ...m,
            content,
            compacted: true,
            compactedKind: 'tool_output_prune',
        };
        total += estimateMessageTokens(pruned) - estimateMessageTokens(m);
        result[c.index] = pruned;
        if (total <= budget) break;
    }
    return reconcileDedupStubs(result);
}

// Anchor-independent artifact-preview prune (loop overflow safety net).
//
// pruneToolOutputs protects the most-recent tailTurns of USER-anchored history,
// so a single-turn transcript with no user boundary yields protectFrom=0 and
// prunes nothing. This variant needs no user anchor, but may compact only
// artifact-backed previews; raw tool output is never destructively shortened.
export function pruneToolOutputsUnanchored(messages, budgetTokens, opts = {}) {
    const budget = effectiveBudget(budgetTokens, opts);
    let result = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    let total = estimateMessagesTokens(result);
    if (total <= budget) return result;

    const maxChars = Math.max(256, Number(opts?.maxToolOutputChars) || PRUNE_TOOL_OUTPUT_MAX_CHARS);
    // Oldest -> newest so recent tool output survives longest. No user-turn
    // protection: every oversized tool_result is a candidate.
    for (let i = 0; i < result.length; i += 1) {
        const m = result[i];
        if (m?.role !== 'tool' || typeof m.content !== 'string') continue;
        if (m.content.length <= maxChars) continue;
        const content = pruneToolOutputText(m.content, maxChars, m.toolCallId);
        if (content === m.content) continue;
        const pruned = {
            ...m,
            content,
            compacted: true,
            compactedKind: 'tool_output_prune',
        };
        total += estimateMessageTokens(pruned) - estimateMessageTokens(m);
        result[i] = pruned;
        if (total <= budget) break;
    }
    return reconcileDedupStubs(result);
}
