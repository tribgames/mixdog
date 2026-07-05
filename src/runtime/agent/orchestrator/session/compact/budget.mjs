// Budget math, tool-output pruning, cycle1 draining, and preserved-fact
// extraction. Extracted verbatim from compact.mjs (behavior-preserving).
import { createHash } from 'node:crypto';
import {
    sanitizeToolPairs,
    dedupToolResultBodies,
    reconcileDedupStubs,
    estimateMessagesTokens,
    DEFAULT_COMPACTION_KEEP_TOKENS,
} from '../context-utils.mjs';
import { extractText, summarizeToolCall, redactRawSecretString, TOOL_CALL_FACT_ARGS_MAX_CHARS } from './text-utils.mjs';

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
const PRUNE_TOOL_OUTPUT_HEAD_CHARS = 1_000;
const PRUNE_TOOL_OUTPUT_TAIL_CHARS = 600;
const PRUNE_TAIL_TURNS = 2;
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;
export const PRESERVED_FACTS_MAX_CHARS = 600;

function preservedFactHints() {
    return String(process.env.MIXDOG_COMPACT_FACT_HINTS || '')
        .split(/[\n,;]+/u)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.toLocaleLowerCase());
}

const PRESERVED_FACT_HINTS = preservedFactHints();

function hasConfiguredPreservedFactHint(text) {
    const lower = String(text || '').toLocaleLowerCase();
    return PRESERVED_FACT_HINTS.some(hint => hint && lower.includes(hint));
}

export function extractPreservedFacts(messages) {
    if (!messages || messages.length === 0) return '';
    const candidates = [];
    const seenSignatures = new Set();
    const add = (prefix, text, score, messageIndex, lineIndex = 0) => {
        const clean = text.replace(/`/g, '').trim();
        if (clean.length < 10) return;
        const sig = clean.slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
        if (seenSignatures.has(sig)) return;
        seenSignatures.add(sig);
        candidates.push({ prefix, text: clean, score, messageIndex, lineIndex });
    };
    const classifyLine = (t) => {
        // Language-neutral structural cues: exact assignments, paths, URLs,
        // symbolic error/constant identifiers, and optional user-configured
        // locale/domain hints. Do not bake human-language keyword lists here.
        if (/[\p{L}\p{N}_$./:-]{2,}\s*=\s*\S+/u.test(t)) return { prefix: '•', score: 100 };
        if (/(?:^|[\s('"`])https?:\/\/[^\s'"`<>]+/iu.test(t)) return { prefix: '•', score: 95 };
        if (/(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~?[\\/][^\s'"`<>]+|[\p{L}\p{N}_$.-]+[\\/][^\s'"`<>]+|[\p{L}\p{N}_$.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|rs|go|py|java|kt|cs|cpp|c|h|hpp|css|html|yml|yaml|toml|lock|sh|ps1)\b)/iu.test(t)) return { prefix: '•', score: 95 };
        if (/\b[A-Z][A-Z0-9_:-]{2,}\b/.test(t)) return { prefix: '•', score: 90 };
        if (hasConfiguredPreservedFactHint(t)) return { prefix: '!', score: 70 };
        return null;
    };
    for (let mi = 0; mi < messages.length; mi += 1) {
        const m = messages[mi];
        const text = extractText(m);
        if (!text) continue;
        const lines = text.split('\n');
        for (let li = 0; li < lines.length; li += 1) {
            const line = lines[li];
            const t = line.trim();
            if (t.length < 10 || t.length > 250) continue;
            const cls = classifyLine(t);
            if (cls) add(cls.prefix, redactRawSecretString(t), cls.score, mi, li);
        }
        if (m?.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
                const name = tc?.function?.name || tc?.name || '';
                if (name) {
                    const summary = summarizeToolCall(tc, TOOL_CALL_FACT_ARGS_MAX_CHARS);
                    const sig = `tool:${summary.slice(0, 160).toLowerCase()}`;
                    if (seenSignatures.has(sig)) continue;
                    seenSignatures.add(sig);
                    candidates.push({ prefix: '•', text: `Tool: ${summary}`, score: 50, messageIndex: mi, lineIndex: Number.MAX_SAFE_INTEGER });
                }
            }
        }
    }
    if (candidates.length === 0) return '';
    candidates.sort((a, b) =>
        (b.score - a.score)
        || (b.messageIndex - a.messageIndex)
        || (b.lineIndex - a.lineIndex)
    );
    let result = '## Preserved Facts\n';
    let kept = 0;
    for (const c of candidates) {
        if (kept >= 25) break;
        let line = `- ${c.prefix} ${c.text}\n`;
        if (result.length + line.length > PRESERVED_FACTS_MAX_CHARS) {
            const room = PRESERVED_FACTS_MAX_CHARS - result.length - 8;
            if (kept === 0 && room > 32) line = `- ${c.prefix} ${c.text.slice(0, room)}…\n`;
            else continue;
        }
        result += line;
        kept += 1;
    }
    return kept > 0 ? result : '';
}

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
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    if (value.length <= maxChars) return value;
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const head = value.slice(0, PRUNE_TOOL_OUTPUT_HEAD_CHARS);
    const tail = value.slice(-PRUNE_TOOL_OUTPUT_TAIL_CHARS);
    return [
        `[mixdog pruned old tool output: ${value.length} chars, sha256:${hash}${toolCallId ? `, tool_use_id=${toolCallId}` : ''}]`,
        head,
        '... [old tool output omitted during worker compaction] ...',
        tail,
    ].join('\n');
}

export function pruneToolOutputs(messages, budgetTokens, opts = {}) {
    const budget = effectiveBudget(budgetTokens, opts);
    let result = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    if (estimateMessagesTokens(result) <= budget) return result;

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
        result[c.index] = {
            ...m,
            content: pruneToolOutputText(m.content, maxChars, m.toolCallId),
            compacted: true,
            compactedKind: 'tool_output_prune',
        };
        if (estimateMessagesTokens(result) <= budget) break;
    }
    return reconcileDedupStubs(result);
}

// Anchor-independent tool-output prune (loop overflow safety net).
//
// pruneToolOutputs protects the most-recent tailTurns of USER-anchored history,
// so a single-turn transcript with no user boundary yields protectFrom=0 and
// prunes nothing. This variant needs no user anchor: it middle-truncates the
// OLDEST oversized tool_result bodies first, walking forward, until the
// transcript fits the budget. The newest tool_result is truncated last (and
// only if still necessary) so fresh state is preserved as long as possible.
// Structure/pairing is preserved (only string content shrinks), and the result
// is re-reconciled so tool pairing stays provider-valid.
export function pruneToolOutputsUnanchored(messages, budgetTokens, opts = {}) {
    const budget = effectiveBudget(budgetTokens, opts);
    let result = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    if (estimateMessagesTokens(result) <= budget) return result;

    const maxChars = Math.max(256, Number(opts?.maxToolOutputChars) || PRUNE_TOOL_OUTPUT_MAX_CHARS);
    // Oldest -> newest so recent tool output survives longest. No user-turn
    // protection: every oversized tool_result is a candidate.
    for (let i = 0; i < result.length; i += 1) {
        const m = result[i];
        if (m?.role !== 'tool' || typeof m.content !== 'string') continue;
        if (m.content.length <= maxChars) continue;
        result[i] = {
            ...m,
            content: pruneToolOutputText(m.content, maxChars, m.toolCallId),
            compacted: true,
            compactedKind: 'tool_output_prune',
        };
        if (estimateMessagesTokens(result) <= budget) break;
    }
    return reconcileDedupStubs(result);
}

export function preserveRecentBudget(budget, opts = {}) {
    const maxForBudget = Math.max(1, Math.floor(Number(budget || 0) * 0.8));
    const explicit = Number(opts.preserveRecentTokens ?? opts.keepTokens);
    if (Number.isFinite(explicit) && explicit > 0) {
        return Math.max(1, Math.min(Math.floor(explicit), maxForBudget));
    }
    return Math.max(
        1,
        Math.min(
            DEFAULT_COMPACTION_KEEP_TOKENS,
            Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(budget * 0.25)),
            maxForBudget,
        ),
    );
}
