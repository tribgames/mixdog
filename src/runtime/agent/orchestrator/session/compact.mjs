import { createHash } from 'node:crypto';
import {
    sanitizeToolPairs,
    dedupToolResultBodies,
    reconcileDedupStubs,
    estimateMessagesTokens,
} from './context-utils.mjs';

export const SUMMARY_PREFIX = 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. You also retain the preserved recent turns that follow.';
export const DEFAULT_COMPACTION_BUFFER_TOKENS = 20_000;
export const DEFAULT_COMPACTION_KEEP_TOKENS = 8_000;
export const SUMMARY_OUTPUT_TOKENS = 4_096;

function sha16(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function roleCounts(messages) {
    const counts = new Map();
    for (const m of messages) counts.set(m?.role || 'unknown', (counts.get(m?.role || 'unknown') || 0) + 1);
    return [...counts.entries()].map(([role, count]) => `${role}:${count}`).join(', ');
}

function extractText(m) {
    if (!m || typeof m !== 'object') return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
        return m.content
            .map((item) => {
                if (!item || typeof item !== 'object') return '';
                if (typeof item.text === 'string') return item.text;
                if (typeof item.content === 'string') return item.content;
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    try { return JSON.stringify(m.content ?? ''); } catch { return ''; }
}

function truncateMiddle(text, maxChars) {
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    if (maxChars <= 0 || value.length === 0) return '';
    if (value.length <= maxChars) return value;
    if (maxChars <= 8) return value.slice(0, maxChars);
    const head = Math.ceil((maxChars - 5) / 2);
    const tail = Math.floor((maxChars - 5) / 2);
    return `${value.slice(0, head)} … ${value.slice(value.length - tail)}`;
}

function toolCallNames(m) {
    if (!Array.isArray(m?.toolCalls) || m.toolCalls.length === 0) return '';
    const names = m.toolCalls.map((tc) => tc?.name || tc?.function?.name || tc?.id || '?');
    return ` tool_calls=${names.join(',')}`;
}

function toolResultId(m) {
    return m?.role === 'tool' && m.toolCallId ? ` tool_result=${m.toolCallId}` : '';
}

function lineForMessage(m, index, perMessageChars) {
    const role = m?.role || 'unknown';
    const text = truncateMiddle(extractText(m).trim(), perMessageChars);
    const meta = `${toolCallNames(m)}${toolResultId(m)}`;
    return text
        ? `${index + 1}. ${role}${meta}: ${text}`
        : `${index + 1}. ${role}${meta}`;
}

function compactHeader(oldHistory) {
    const encoded = JSON.stringify(oldHistory ?? []);
    return [
        SUMMARY_PREFIX,
        `messages=${oldHistory.length} sha256=${sha16(encoded)} roles=${roleCounts(oldHistory) || 'none'}`,
    ];
}

function buildSummaryContent(oldHistory, perMessageChars) {
    const lines = compactHeader(oldHistory);
    if (oldHistory.length > 0) {
        lines.push('timeline:');
        for (let i = 0; i < oldHistory.length; i += 1) {
            lines.push(lineForMessage(oldHistory[i], i, perMessageChars));
        }
    }
    return lines.join('\n');
}

function makeSummaryMessage(content) {
    return { role: 'user', content };
}

function fitSummaryMessage(oldHistory, remainingTokens) {
    const minimal = makeSummaryMessage(compactHeader(oldHistory).join('\n'));
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;

    let maxText = 0;
    for (const m of oldHistory) maxText = Math.max(maxText, extractText(m).length);

    let lo = 0;
    let hi = Math.max(maxText, 0);
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = makeSummaryMessage(buildSummaryContent(oldHistory, mid));
        if (estimateMessagesTokens([candidate]) <= remainingTokens) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

function currentTurnStart(nonSystem) {
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
        if (nonSystem[i]?.role === 'user') return i;
    }
    return -1;
}

function effectiveBudget(budgetTokens, opts) {
    if (!(budgetTokens > 0)) throw new Error('compactMessages: budgetTokens must be > 0');
    const reserve = Number(opts?.reserveTokens) || 0;
    if (reserve <= 0) return budgetTokens;
    const effectiveReserve = Math.min(reserve, Math.floor(budgetTokens * 0.5));
    return Math.max(1, budgetTokens - effectiveReserve);
}

const PRUNE_TOOL_OUTPUT_MAX_CHARS = 2_000;
const PRUNE_TOOL_OUTPUT_HEAD_CHARS = 1_000;
const PRUNE_TOOL_OUTPUT_TAIL_CHARS = 600;
const PRUNE_TAIL_TURNS = 2;
const DEFAULT_TAIL_TURNS = 2;
const MIN_PRESERVE_RECENT_TOKENS = 2_000;
const COMPACTION_INPUT_MAX_CHARS = 2_000;
const COMPACTION_PROMPT_HEADROOM = 0.85;
const COMPACTION_SYSTEM_PROMPT = [
    'You are an anchored context summarization assistant for coding sessions.',
    '',
    'Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.',
    '',
    'If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.',
    '',
    'Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.',
    '',
    'Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.',
].join('\n');
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Use the same language as the active user thread when it is clear.
- Do not mention the summary process or that context was compacted.`;

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

function preserveRecentBudget(budget, opts = {}) {
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

function userIndexes(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i]?.role === 'user') out.push(i);
    }
    return out;
}

function selectCompactionWindow(messages, budget, opts = {}) {
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const system = sanitized.filter(m => m?.role === 'system');
    const nonSystem = sanitized.filter(m => m?.role !== 'system');
    const users = userIndexes(nonSystem);
    if (!users.length) throw new Error('semanticCompactMessages: no user turn to preserve');

    const tailTurns = Math.max(1, Number(opts.tailTurns) || DEFAULT_TAIL_TURNS);
    const recentBudget = preserveRecentBudget(budget, opts);
    let tailStart = users[users.length - 1];
    for (let u = users.length - 2, kept = 1; u >= 0 && kept < tailTurns; u -= 1) {
        const candidateStart = users[u];
        const candidateTail = nonSystem.slice(candidateStart);
        if (estimateMessagesTokens(candidateTail) > recentBudget) break;
        tailStart = candidateStart;
        kept += 1;
    }

    const head = nonSystem.slice(0, tailStart);
    const tail = nonSystem.slice(tailStart);
    let previousSummary = null;
    let headStart = 0;
    for (let i = head.length - 1; i >= 0; i -= 1) {
        const m = head[i];
        if (m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)) {
            previousSummary = m.content;
            headStart = i + 1;
            break;
        }
    }
    return {
        system,
        head: head.slice(headStart),
        tail,
        previousSummary,
        originalHead: head,
    };
}

function transcriptLineForCompaction(m, index, perMessageChars) {
    const role = m?.role || 'unknown';
    const text = truncateMiddle(extractText(m).trim(), perMessageChars);
    const meta = `${toolCallNames(m)}${toolResultId(m)}`;
    if (!text) return `${index + 1}. ${role}${meta}`;
    return `${index + 1}. ${role}${meta}:\n${text}`;
}

function buildCompactionPrompt({ head, previousSummary }, perMessageChars) {
    const lines = [
        previousSummary
            ? 'Update the anchored summary below using the conversation history that follows. Preserve still-true details, remove stale details, and merge in the new facts.'
            : 'Create a new anchored summary from the conversation history below.',
        SUMMARY_TEMPLATE,
    ];
    if (previousSummary) {
        lines.push('', '<previous-summary>', previousSummary, '</previous-summary>');
    }
    lines.push('', '<conversation-history>');
    if (head.length === 0) {
        lines.push('[No additional older messages before the preserved recent tail.]');
    } else {
        for (let i = 0; i < head.length; i += 1) {
            lines.push(transcriptLineForCompaction(head[i], i, perMessageChars));
        }
    }
    lines.push('</conversation-history>');
    return lines.join('\n');
}

function fitCompactionPrompt(input, targetTokens) {
    const minimal = buildCompactionPrompt(input, 0);
    const baseMessages = [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: minimal },
    ];
    if (estimateMessagesTokens(baseMessages) > targetTokens) return minimal;

    let maxText = 0;
    for (const m of input.head) maxText = Math.max(maxText, extractText(m).length);
    let lo = 0;
    let hi = Math.min(COMPACTION_INPUT_MAX_CHARS, Math.max(maxText, 0));
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = buildCompactionPrompt(input, mid);
        const candidateMessages = [
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: candidate },
        ];
        if (estimateMessagesTokens(candidateMessages) <= targetTokens) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

function extractResponseText(response) {
    if (!response) return '';
    if (typeof response.content === 'string') return response.content.trim();
    if (Array.isArray(response.content)) {
        return response.content
            .map((item) => {
                if (typeof item === 'string') return item;
                if (typeof item?.text === 'string') return item.text;
                if (typeof item?.content === 'string') return item.content;
                return '';
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    return '';
}

function makeSemanticSummaryMessage(oldHistory, summary, semanticMeta = {}) {
    const header = compactHeader(oldHistory);
    header.push(`semantic=true provider=${semanticMeta.provider || 'unknown'} model=${semanticMeta.model || 'unknown'}`);
    const body = String(summary || '').trim();
    return makeSummaryMessage(body ? `${header.join('\n')}\n\n${body}` : header.join('\n'));
}

function fitSemanticSummaryMessage(oldHistory, summary, remainingTokens, semanticMeta) {
    const minimal = makeSemanticSummaryMessage(oldHistory, '', semanticMeta);
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
    const text = String(summary || '').trim();
    if (!text) return minimal;
    let lo = 0;
    let hi = text.length;
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = makeSemanticSummaryMessage(oldHistory, text.slice(0, mid), semanticMeta);
        if (estimateMessagesTokens([candidate]) <= remainingTokens) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

function combinedSignal(parent, timeoutMs) {
    const ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) return parent || undefined;
    const timeout = AbortSignal.timeout(Math.floor(ms));
    if (parent && typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout]);
    return timeout;
}

export async function semanticCompactMessages(provider, messages, model, budgetTokens, opts = {}) {
    if (!provider || typeof provider.send !== 'function') {
        throw new Error('semanticCompactMessages: provider.send is required');
    }
    const budget = effectiveBudget(budgetTokens, opts);
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    if (opts.force !== true && estimateMessagesTokens(sanitized) <= budget) {
        return { messages: sanitized, usage: null, semantic: false };
    }

    const selected = selectCompactionWindow(sanitized, budget, opts);
    if (selected.head.length === 0 && !selected.previousSummary) {
        throw new Error('semanticCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...selected.system, ...selected.tail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    if (mandatoryCost > budget) {
        throw new Error(`semanticCompactMessages: system+preserved tail exceeds budget=${budget} (base=${mandatoryCost})`);
    }

    const callBudget = Math.max(1, Math.floor((opts.compactionInputBudgetTokens || budget) * COMPACTION_PROMPT_HEADROOM));
    const prompt = fitCompactionPrompt(selected, callBudget);
    const compactModel = model;
    const sendOpts = {
        ...(opts.sendOpts || {}),
        thinkingBudgetTokens: undefined,
        xaiReasoningEffort: undefined,
        reasoningEffort: undefined,
        effort: 'low',
        fast: opts.fast ?? opts.sendOpts?.fast ?? true,
        maxOutputTokens: opts.maxOutputTokens || SUMMARY_OUTPUT_TOKENS,
        providerState: undefined,
        onToolCall: undefined,
        onStreamDelta: undefined,
        onStageChange: undefined,
        remoteCompact: false,
        signal: combinedSignal(opts.signal || opts.sendOpts?.signal || null, opts.timeoutMs || 30_000),
    };
    if (opts.sessionId) sendOpts.sessionId = `${opts.sessionId}:compact`;
    if (opts.promptCacheKey || opts.sendOpts?.promptCacheKey) {
        sendOpts.promptCacheKey = `${opts.promptCacheKey || opts.sendOpts.promptCacheKey}:compact`;
    }
    if (opts.providerCacheKey || opts.sendOpts?.providerCacheKey) {
        sendOpts.providerCacheKey = `${opts.providerCacheKey || opts.sendOpts.providerCacheKey}:compact`;
    }

    const response = await provider.send([
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ], compactModel, undefined, sendOpts);
    const summary = extractResponseText(response);
    if (!summary) throw new Error('semanticCompactMessages: compaction agent returned empty summary');

    const oldHistory = selected.originalHead;
    const semanticMeta = {
        provider: opts.providerName || provider.name || null,
        model: compactModel,
    };
    const summaryMessage = fitSemanticSummaryMessage(oldHistory, summary, budget - mandatoryCost, semanticMeta);
    if (!summaryMessage) {
        throw new Error(`semanticCompactMessages: summary cannot fit remaining budget=${budget - mandatoryCost}`);
    }

    let result = sanitizeToolPairs([...selected.system, summaryMessage, ...selected.tail]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`semanticCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    return {
        messages: result,
        usage: response?.usage || null,
        providerState: response?.providerState,
        semantic: true,
        summary,
    };
}

export function compactMessages(messages, budgetTokens, opts = {}) {
    const budget = effectiveBudget(budgetTokens, opts);
    const sanitized = sanitizeToolPairs(messages);
    if (opts.force !== true && estimateMessagesTokens(sanitized) <= budget) return reconcileDedupStubs(sanitized);

    const system = sanitized.filter(m => m?.role === 'system');
    const nonSystem = sanitized.filter(m => m?.role !== 'system');
    const turnStart = currentTurnStart(nonSystem);
    if (turnStart <= 0) {
        throw new Error(`compactMessages: no compactable prior history before current turn (budget=${budget})`);
    }

    const oldHistory = nonSystem.slice(0, turnStart);
    const currentTurn = nonSystem.slice(turnStart);
    let mandatory = sanitizeToolPairs([...system, ...currentTurn]);
    mandatory = reconcileDedupStubs(dedupToolResultBodies(mandatory));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    if (mandatoryCost > budget) {
        throw new Error(`compactMessages: mandatory system+current turn exceeds budget=${budget} (base=${mandatoryCost})`);
    }

    const summary = fitSummaryMessage(oldHistory, budget - mandatoryCost);
    if (!summary) {
        throw new Error(`compactMessages: compact summary cannot fit remaining budget=${budget - mandatoryCost}`);
    }

    let result = sanitizeToolPairs([...system, summary, ...currentTurn]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`compactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    return result;
}

// Split the assistant/tool portion of a single user turn into ordered
// groups. Each group starts at an assistant message and absorbs the tool
// results that follow it, so a group is the atomic unit we can drop or
// prune without orphaning a tool_use/tool_result pair.
function splitTurnGroups(messages) {
    const groups = [];
    let current = null;
    for (const m of messages) {
        if (m?.role === 'assistant') {
            if (current) groups.push(current);
            current = [m];
        } else {
            if (!current) current = [];
            current.push(m);
        }
    }
    if (current) groups.push(current);
    return groups;
}

/**
 * Active-turn fallback compaction (bridge/worker only).
 *
 * compactMessages/semanticCompactMessages treat the ENTIRE current turn as
 * mandatory, so a hidden worker with one user turn plus many assistant/tool
 * iterations throws overflow even when older same-turn tool outputs could be
 * safely shrunk. This narrow fallback shrinks the current turn itself while
 * preserving, in priority order:
 *   - all system messages,
 *   - the original task user message (the turn's first user message),
 *   - the latest assistant/tool group(s),
 *   - valid tool_use/tool_result pairing (via sanitizeToolPairs).
 *
 * Older prior history (before the current turn) is condensed to a best-effort
 * summary when it still fits the remaining budget, otherwise dropped — it has
 * already been superseded by completed turns. It NEVER silently drops the task
 * user message or the latest group: if system + task user + the fully-pruned
 * latest group still cannot fit, it throws so the caller surfaces overflow.
 */
export function compactActiveTurn(messages, budgetTokens, opts = {}) {
    const budget = effectiveBudget(budgetTokens, opts);
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const system = sanitized.filter(m => m?.role === 'system');
    const nonSystem = sanitized.filter(m => m?.role !== 'system');
    const turnStart = currentTurnStart(nonSystem);
    if (turnStart < 0) {
        throw new Error(`compactActiveTurn: no current user turn to preserve (budget=${budget})`);
    }

    const oldHistory = nonSystem.slice(0, turnStart);
    const currentTurn = nonSystem.slice(turnStart);
    const userMsg = currentTurn[0];
    const groups = splitTurnGroups(currentTurn.slice(1));
    const minGroups = Math.max(1, Number(opts.minActiveTurnGroups) || 1);
    const maxChars = Math.max(256, Number(opts.maxToolOutputChars) || PRUNE_TOOL_OUTPUT_MAX_CHARS);

    const pruneToolMsg = (m) => (
        m?.role === 'tool' && typeof m.content === 'string' && m.content.length > maxChars
            ? {
                ...m,
                content: pruneToolOutputText(m.content, maxChars, m.toolCallId),
                compacted: true,
                compactedKind: 'active_turn_tool_prune',
            }
            : m
    );

    // pruneMode: 'older' prunes every group except the latest; 'all' prunes
    // every kept group (last resort before declaring overflow).
    const buildTurnMsgs = (keptGroups, pruneMode) => {
        const out = [userMsg];
        for (let gi = 0; gi < keptGroups.length; gi += 1) {
            const isLatest = gi === keptGroups.length - 1;
            const prune = pruneMode === 'all' || (pruneMode === 'older' && !isLatest);
            for (const m of keptGroups[gi]) out.push(prune ? pruneToolMsg(m) : m);
        }
        return out;
    };

    const finalize = (turnMsgs) => {
        let base = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...system, ...turnMsgs])));
        if (oldHistory.length) {
            const baseCost = estimateMessagesTokens(base);
            if (baseCost < budget) {
                const summary = fitSummaryMessage(oldHistory, budget - baseCost);
                if (summary) {
                    base = reconcileDedupStubs(
                        dedupToolResultBodies(sanitizeToolPairs([...system, summary, ...turnMsgs])),
                    );
                }
            }
        }
        return base;
    };

    const maxDrop = Math.max(0, groups.length - minGroups);
    for (let drop = 0; drop <= maxDrop; drop += 1) {
        const kept = groups.slice(drop);
        for (const mode of ['older', 'all']) {
            const candidate = finalize(buildTurnMsgs(kept, mode));
            if (estimateMessagesTokens(candidate) <= budget) return candidate;
        }
    }

    const floor = finalize(buildTurnMsgs(groups.slice(-minGroups), 'all'));
    throw new Error(
        `compactActiveTurn: system+task user+latest turn group exceeds budget=${budget} ` +
        `(floor=${estimateMessagesTokens(floor)})`,
    );
}
