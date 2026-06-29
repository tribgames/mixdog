import { createHash } from 'node:crypto';
import {
    sanitizeToolPairs,
    dedupToolResultBodies,
    reconcileDedupStubs,
    estimateMessagesTokens,
} from './context-utils.mjs';

export const SUMMARY_PREFIX = 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. You also retain the preserved recent turns that follow.';
// Default trigger sits a buffer below the boundary so auto-compaction fires
// BEFORE the window is full. The effective context window already carves ~10%
// off the raw model window (effectiveContextWindowPercent=90 → boundary), but
// that headroom alone is NOT enough for compaction to run: semantic compact
// re-sends the full transcript as input, so triggering AT the boundary (≈90%
// of raw) pushes the compaction request itself over the window and it fails
// ("summary cannot fit" / context overflow), losing the turn. A 10% buffer
// pulls the trigger to boundary − 10% (≈81% of raw, i.e. 90% of the boundary
// the /context gauge shows), leaving real room for the compaction call.
// Explicit compaction.bufferTokens / bufferPercent still override this default.
export const DEFAULT_COMPACTION_BUFFER_TOKENS = 0;
export const DEFAULT_COMPACTION_BUFFER_RATIO = 0.1;
export const MAX_COMPACTION_BUFFER_RATIO = 0.25;
export const DEFAULT_COMPACTION_KEEP_TOKENS = 8_000;
export const SUMMARY_OUTPUT_TOKENS = 4_096;
// Minimum room the generated summary needs after the mandatory (system +
// preserved tail) cost is accounted for. When the configured target budget is
// smaller than the mandatory cost (e.g. the preserved recent turn carries a
// large tool result), the compaction MUST still proceed: the old head is the
// part being summarized away, so dropping it already shrinks the transcript.
// Refusing with "exceeds budget" here is what surfaced as auto-clear / overflow
// compact failures. Floor the working budget to mandatory + this room instead.
export const COMPACT_SUMMARY_MIN_ROOM_TOKENS = 4_000;

const TOOL_CALL_ARGS_MAX_CHARS = 260;
const TOOL_CALL_FACT_ARGS_MAX_CHARS = 140;
const TOOL_CALLS_MAX = 4;
const TOOL_ARG_STRING_MAX_CHARS = 360;
const TOOL_ARG_ARRAY_MAX_ITEMS = 8;
const TOOL_ARG_MAX_DEPTH = 4;
const SENSITIVE_TOOL_ARG_KEY_RE = /(?:^|[_-])(?:api[_-]?key|authorization|auth|cookie|credential|passwd|password|refresh[_-]?token|secret|token)(?:$|[_-])/i;

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

function normalizeToolArgValue(value, key = '', depth = 0) {
    if (SENSITIVE_TOOL_ARG_KEY_RE.test(String(key || ''))) return '[redacted]';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') return truncateMiddle(value, TOOL_ARG_STRING_MAX_CHARS);
    if (!value || typeof value !== 'object') return value ?? null;
    if (depth >= TOOL_ARG_MAX_DEPTH) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';
    if (Array.isArray(value)) {
        const out = value.slice(0, TOOL_ARG_ARRAY_MAX_ITEMS)
            .map((item, index) => normalizeToolArgValue(item, String(index), depth + 1));
        if (value.length > TOOL_ARG_ARRAY_MAX_ITEMS) out.push(`+${value.length - TOOL_ARG_ARRAY_MAX_ITEMS} more`);
        return out;
    }
    const out = {};
    for (const k of Object.keys(value).sort()) {
        out[k] = normalizeToolArgValue(value[k], k, depth + 1);
    }
    return out;
}

function stableToolArgJson(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return '';
        if (/^[\[{]/.test(text)) {
            try { return JSON.stringify(normalizeToolArgValue(JSON.parse(text))); } catch { /* keep raw */ }
        }
        return truncateMiddle(text, TOOL_ARG_STRING_MAX_CHARS);
    }
    try {
        return JSON.stringify(normalizeToolArgValue(value));
    } catch {
        return truncateMiddle(String(value || ''), TOOL_ARG_STRING_MAX_CHARS);
    }
}

function toolCallArgsText(tc, maxChars = TOOL_CALL_ARGS_MAX_CHARS) {
    if (!(maxChars > 0)) return '';
    const raw = tc?.arguments ?? tc?.function?.arguments;
    const text = stableToolArgJson(raw);
    return text ? truncateMiddle(text, maxChars) : '';
}

function summarizeToolCall(tc, maxArgChars = TOOL_CALL_ARGS_MAX_CHARS) {
    const name = tc?.name || tc?.function?.name || tc?.id || '?';
    const args = toolCallArgsText(tc, maxArgChars);
    return args ? `${name}(${args})` : name;
}

function toolCallArgBudget(perMessageChars) {
    const chars = Number(perMessageChars);
    if (!Number.isFinite(chars) || chars <= 0) return 0;
    return Math.min(TOOL_CALL_ARGS_MAX_CHARS, Math.max(32, Math.floor(chars * 0.5)));
}

function toolCallSummary(m, maxArgChars = TOOL_CALL_ARGS_MAX_CHARS) {
    if (!Array.isArray(m?.toolCalls) || m.toolCalls.length === 0) return '';
    const calls = m.toolCalls
        .slice(0, TOOL_CALLS_MAX)
        .map(tc => summarizeToolCall(tc, maxArgChars));
    if (m.toolCalls.length > TOOL_CALLS_MAX) calls.push(`+${m.toolCalls.length - TOOL_CALLS_MAX} more`);
    return ` tool_calls=${calls.join(';')}`;
}

function toolResultId(m) {
    return m?.role === 'tool' && m.toolCallId ? ` tool_result=${m.toolCallId}` : '';
}

function compactHeader(oldHistory) {
    const encoded = JSON.stringify(oldHistory ?? []);
    return [
        SUMMARY_PREFIX,
        `messages=${oldHistory.length} sha256=${sha16(encoded)} roles=${roleCounts(oldHistory) || 'none'}`,
    ];
}

function makeSummaryMessage(content) {
    return { role: 'user', content };
}

function isProtectedContextUserMessage(m) {
    if (m?.role !== 'user' || typeof m.content !== 'string') return false;
    return m.content.trimStart().startsWith('<system-reminder>');
}

function isProtectedContextAckMessage(m) {
    return m?.role === 'assistant'
        && typeof m.content === 'string'
        && m.content.trim() === '.'
        && !Array.isArray(m.toolCalls);
}

function splitProtectedContext(messages) {
    const protectedPrefix = [];
    const conversation = [];
    let prefixMode = true;
    let previousWasProtectedContext = false;
    for (const m of messages || []) {
        if (m?.role === 'system') {
            protectedPrefix.push(m);
            previousWasProtectedContext = false;
            continue;
        }
        if (prefixMode && isProtectedContextUserMessage(m)) {
            protectedPrefix.push(m);
            previousWasProtectedContext = true;
            continue;
        }
        if (prefixMode && previousWasProtectedContext && isProtectedContextAckMessage(m)) {
            protectedPrefix.push(m);
            previousWasProtectedContext = false;
            continue;
        }
        prefixMode = false;
        previousWasProtectedContext = false;
        conversation.push(m);
    }
    return { protectedPrefix, conversation };
}

export function normalizeCompactionBufferRatio(value, fallback = DEFAULT_COMPACTION_BUFFER_RATIO) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n > 1 ? n / 100 : n;
    return fallback;
}

export function compactionBufferTokensForBoundary(boundaryTokens, opts = {}) {
    const boundary = Math.max(0, Math.floor(Number(boundaryTokens) || 0));
    const explicit = Math.max(0, Math.floor(Number(opts.explicitTokens) || 0));
    if (!boundary) return explicit;
    const maxRatio = normalizeCompactionBufferRatio(opts.maxRatio, MAX_COMPACTION_BUFFER_RATIO);
    const cap = Math.max(0, Math.floor(boundary * maxRatio));
    if (explicit > 0) return Math.max(0, Math.min(explicit, cap));
    const ratio = normalizeCompactionBufferRatio(opts.ratio, DEFAULT_COMPACTION_BUFFER_RATIO);
    return Math.max(0, Math.min(Math.floor(boundary * ratio), cap));
}

function effectiveBudget(budgetTokens, opts) {
    if (!(budgetTokens > 0)) throw new Error('compact: budgetTokens must be > 0');
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
const PRESERVED_FACTS_MAX_CHARS = 600;

export const COMPACT_TYPE_SEMANTIC = 'semantic';
export const COMPACT_TYPE_RECALL_FASTTRACK = 'recall-fasttrack';
export const DEFAULT_COMPACT_TYPE = COMPACT_TYPE_SEMANTIC;
export const COMPACT_TYPES = Object.freeze([
    COMPACT_TYPE_SEMANTIC,
    COMPACT_TYPE_RECALL_FASTTRACK,
]);

export function normalizeCompactType(value, fallback = DEFAULT_COMPACT_TYPE) {
    const raw = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
    if (!raw) return fallback;
    if (raw === '1' || raw === 'type1' || raw === 'type-1' || raw === 'bench1' || raw === 'bench-1' || raw === 'semantic' || raw === 'summary') {
        return COMPACT_TYPE_SEMANTIC;
    }
    if (raw === '2' || raw === 'type2' || raw === 'type-2' || raw === 'recall' || raw === 'recall-fast' || raw === 'recall-fasttrack' || raw === 'recall-fast-track' || raw === 'fasttrack') {
        return COMPACT_TYPE_RECALL_FASTTRACK;
    }
    return fallback;
}

export function compactTypeIsSemantic(value) {
    return normalizeCompactType(value) === COMPACT_TYPE_SEMANTIC;
}

export function compactTypeIsRecallFastTrack(value) {
    return normalizeCompactType(value) === COMPACT_TYPE_RECALL_FASTTRACK;
}

// Count raw (unchunked) pending rows still present in a dump_session_roots
// payload. recall-fasttrack must keep cycle1-chunking until this reaches 0 so
// the injected root is the chunked summary, not the raw transcript tail.
export function countRawPendingRows(dumpText) {
    const text = String(dumpText || '');
    const matches = text.match(/(?:^|\n)# raw_pending\s+\d+\s+id=/gi);
    return matches ? matches.length : 0;
}

// Drain a single session's cycle1 in fixed window×concurrency units, looping
// until no raw rows remain (or a pass stops making progress / the deadline
// elapses). This replaces the previous single-pass cycle1 so large sessions
// get fully chunked before their root is injected into the compacted context.
export async function drainSessionCycle1(runTool, { sessionId, cycleArgs = {}, dumpArgs, maxPasses = 0, deadlineMs = 0 } = {}) {
    if (typeof runTool !== 'function') throw new Error('drainSessionCycle1: runTool is required');
    if (!sessionId) throw new Error('drainSessionCycle1: sessionId is required');
    if (!dumpArgs) throw new Error('drainSessionCycle1: dumpArgs is required');
    const startedAt = Date.now();
    const hardPasses = Math.max(1, Number(maxPasses) || 50);
    const lines = [];
    let recallText = await runTool('memory', dumpArgs);
    let rawRemaining = countRawPendingRows(recallText);
    let pass = 0;
    while (rawRemaining > 0 && pass < hardPasses) {
        if (deadlineMs > 0 && (Date.now() - startedAt) >= deadlineMs) break;
        pass += 1;
        const passDeadline = deadlineMs > 0
            ? Math.max(1, deadlineMs - (Date.now() - startedAt))
            : 0;
        let passText = '';
        try {
            passText = await runTool('memory', {
                action: 'cycle1',
                sessionId,
                ...cycleArgs,
                ...(passDeadline > 0 ? { _callerDeadlineMs: passDeadline } : {}),
            });
        } catch (err) {
            lines.push(`cycle1 pass=${pass} error=${err?.message || err}`);
            break;
        }
        if (passText) lines.push(`cycle1 pass=${pass}: ${String(passText).trim()}`);
        recallText = await runTool('memory', dumpArgs);
        const nextRaw = countRawPendingRows(recallText);
        // No forward progress (raw not shrinking) — stop instead of spinning.
        if (nextRaw >= rawRemaining) {
            rawRemaining = nextRaw;
            break;
        }
        rawRemaining = nextRaw;
    }
    return {
        recallText,
        cycle1Text: lines.join('\n'),
        passes: pass,
        rawRemaining,
    };
}

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

function extractPreservedFacts(messages) {
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
            if (cls) add(cls.prefix, t, cls.score, mi, li);
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
    const { protectedPrefix, conversation: nonSystem } = splitProtectedContext(sanitized);
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
    const preservedFacts = extractPreservedFacts(head.slice(headStart));
    return {
        system: protectedPrefix,
        head: head.slice(headStart),
        tail,
        previousSummary,
        originalHead: head,
        preservedFacts,
    };
}

function transcriptLineForCompaction(m, index, perMessageChars) {
    const role = m?.role || 'unknown';
    const text = truncateMiddle(extractText(m).trim(), perMessageChars);
    const meta = `${toolCallSummary(m, toolCallArgBudget(perMessageChars))}${toolResultId(m)}`;
    if (!text) return `${index + 1}. ${role}${meta}`;
    return `${index + 1}. ${role}${meta}:\n${text}`;
}

function buildCompactionPrompt({ head, previousSummary, preservedFacts }, perMessageChars) {
    const lines = [
        previousSummary
            ? 'Update the anchored summary below using the conversation history that follows. Preserve still-true details, remove stale details, and merge in the new facts.'
            : 'Create a new anchored summary from the conversation history below.',
        SUMMARY_TEMPLATE,
    ];
    if (previousSummary) {
        lines.push('', '<previous-summary>', previousSummary, '</previous-summary>');
    }
    if (preservedFacts) {
        lines.push('', '<preserved-facts>', preservedFacts, '</preserved-facts>');
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
    const tryFit = (withFacts) => {
        const inp = withFacts ? input : { ...input, preservedFacts: null };
        const minimal = buildCompactionPrompt(inp, 0);
        const baseMessages = [
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: minimal },
        ];
        if (estimateMessagesTokens(baseMessages) > targetTokens) return null;

        let maxText = 0;
        for (const m of input.head) maxText = Math.max(maxText, extractText(m).length);
        let lo = 0;
        let hi = Math.min(COMPACTION_INPUT_MAX_CHARS, Math.max(maxText, 0));
        let best = minimal;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = buildCompactionPrompt(inp, mid);
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
    };
    if (input.preservedFacts) {
        const withFacts = tryFit(true);
        if (withFacts && estimateMessagesTokens([
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: withFacts },
        ]) <= targetTokens) return withFacts;
    }
    return tryFit(false);
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

function makeSemanticSummaryMessage(oldHistory, summary, semanticMeta = {}, preservedFacts = '') {
    const header = compactHeader(oldHistory);
    header.push(`compact_type=${COMPACT_TYPE_SEMANTIC}`);
    header.push(`semantic=true provider=${semanticMeta.provider || 'unknown'} model=${semanticMeta.model || 'unknown'}`);
    const facts = String(preservedFacts || '').trim();
    const body = String(summary || '').trim();
    const parts = [header.join('\n')];
    if (facts) parts.push(facts);
    if (body) parts.push(body);
    return makeSummaryMessage(parts.join('\n\n'));
}

export function buildRecallFastTrackQuery(messages, opts = {}) {
    const maxChars = Math.max(200, Number(opts.maxChars) || 2_000);
    const hints = String(opts.hints || 'current task decisions constraints file paths changed files verification failures next steps').trim();
    let latestUser = '';
    const recent = [];
    const input = Array.isArray(messages) ? messages : [];
    for (let i = input.length - 1; i >= 0; i -= 1) {
        const m = input[i];
        const text = extractText(m).trim();
        if (!text) continue;
        if (recent.length < 6) recent.unshift(text);
        if (!latestUser && m?.role === 'user' && !isProtectedContextUserMessage(m)) {
            latestUser = text;
        }
        if (latestUser && recent.length >= 6) break;
    }
    const parts = [latestUser, hints, recent.join('\n')]
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    return truncateMiddle([...new Set(parts)].join('\n'), maxChars);
}

function fitSemanticSummaryMessage(oldHistory, summary, remainingTokens, semanticMeta, preservedFacts = '') {
    const tryFit = (factsText) => {
        const minimal = makeSemanticSummaryMessage(oldHistory, '', semanticMeta, factsText);
        if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
        const text = String(summary || '').trim();
        if (!text) return minimal;
        let lo = 0;
        let hi = text.length;
        let best = minimal;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = makeSemanticSummaryMessage(oldHistory, text.slice(0, mid), semanticMeta, factsText);
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    };
    if (preservedFacts) {
        const withFacts = tryFit(preservedFacts);
        if (withFacts) return withFacts;
    }
    return tryFit('');
}

// Recall fast-track (compact type 2) does no LLM summarization — it just emits
// the chunked history in order. Keep the message clean: the mandatory anchor
// header (so selectCompactionWindow / clear-preserve / TUI can recognize the
// compact message) plus the chunk text itself. No "Preserved Facts" extraction,
// no "Recall Fast-Track Context" heading, no "(no recall hits)" filler.
function makeRecallFastTrackSummaryMessage(oldHistory, recallText, recallMeta = {}) {
    const header = compactHeader(oldHistory);
    header.push(`compact_type=${COMPACT_TYPE_RECALL_FASTTRACK} source=recall-fasttrack query_sha=${recallMeta.querySha || 'none'}`);
    const recall = String(recallText || '').trim();
    const parts = [header.join('\n')];
    if (recall) parts.push(recall);
    return makeSummaryMessage(parts.join('\n\n'));
}

function fitRecallFastTrackSummaryMessage(oldHistory, recallText, remainingTokens, recallMeta = {}) {
    const minimal = makeRecallFastTrackSummaryMessage(oldHistory, '', recallMeta);
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
    const text = String(recallText || '').trim();
    if (!text) return minimal;
    let lo = 0;
    let hi = text.length;
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = makeRecallFastTrackSummaryMessage(oldHistory, text.slice(0, mid), recallMeta);
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
    let budget = effectiveBudget(budgetTokens, opts);
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    if (estimateMessagesTokens(sanitized) <= budget && opts.force !== true) {
        return { messages: sanitized, usage: null, semantic: false };
    }

    const selected = selectCompactionWindow(sanitized, budget, opts);
    if (selected.head.length === 0 && !selected.previousSummary) {
        throw new Error('semanticCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...selected.system, ...selected.tail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    // The preserved tail is kept verbatim and the head is replaced by a much
    // smaller summary, so the compacted result is always smaller than the
    // input regardless of how the configured target budget compares to the
    // mandatory cost. When the budget cannot even hold what we must keep, raise
    // it to fit (mandatory + summary room) rather than refusing — a refusal
    // here was the source of auto-clear / overflow compact failures.
    if (mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS > budget) {
        budget = mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS;
    }

    const callBudget = Math.max(1, Math.floor((opts.compactionInputBudgetTokens || budget) * COMPACTION_PROMPT_HEADROOM));
    const prompt = fitCompactionPrompt(selected, callBudget);
    if (!prompt) {
        throw new Error(`semanticCompactMessages: compaction prompt cannot fit call budget=${callBudget}`);
    }
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
        onToolResult: undefined,
        onTextDelta: undefined,
        onReasoningDelta: undefined,
        onUsageDelta: undefined,
        onStreamDelta: undefined,
        onStageChange: undefined,
        drainSteering: undefined,
        onSteerMessage: undefined,
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
    const summaryMessage = fitSemanticSummaryMessage(oldHistory, summary, budget - mandatoryCost, semanticMeta, selected.preservedFacts);
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
        compactType: COMPACT_TYPE_SEMANTIC,
        summary,
    };
}

export function recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    return _recallFastTrackCompactMessages(messages, budgetTokens, opts);
}

// Option B tail policy for recall fast-track (type 2): keep the most recent
// RECALL_TAIL_USER_MAX user messages verbatim; if their combined token cost
// exceeds RECALL_TAIL_TOKEN_CAP, keep the newest whole and middle-truncate the
// older one(s) so the kept set fits the cap. Assistant/tool turns never enter
// the tail — the chunk summary already carries that history.
const RECALL_TAIL_USER_MAX = 2;
const RECALL_TAIL_TOKEN_CAP = DEFAULT_COMPACTION_KEEP_TOKENS; // 8k
// Rough chars-per-token used only to size a truncation target; the real fit is
// re-checked with estimateMessagesTokens below.
const RECALL_TAIL_CHARS_PER_TOKEN = 4;

function selectRecallTailUserMessages(tail, opts = {}) {
    const users = (Array.isArray(tail) ? tail : []).filter((m) => m?.role === 'user');
    const max = Math.max(1, Number(opts.maxUsers) || RECALL_TAIL_USER_MAX);
    const cap = Math.max(1, Number(opts.tokenCap) || RECALL_TAIL_TOKEN_CAP);
    // Take the newest `max` user messages, oldest-first for output order.
    const recent = users.slice(-max);
    if (recent.length === 0) return [];
    if (estimateMessagesTokens(recent) <= cap) return recent;
    // Over cap: always keep the newest whole, then add older ones (newest-first)
    // only while they fit; truncate the first one that would overflow.
    const newestFirst = recent.slice().reverse();
    const kept = [];
    let used = 0;
    for (let i = 0; i < newestFirst.length; i += 1) {
        const m = newestFirst[i];
        const cost = estimateMessagesTokens([m]);
        if (used + cost <= cap) { kept.push(m); used += cost; continue; }
        const room = cap - used;
        if (room > 0 && typeof m.content === 'string') {
            const truncated = truncateMiddle(m.content, Math.max(0, room * RECALL_TAIL_CHARS_PER_TOKEN));
            if (truncated) kept.push({ ...m, content: truncated });
        }
        break;
    }
    return kept.reverse();
}

function _recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    let budget = effectiveBudget(budgetTokens, opts);
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    if (estimateMessagesTokens(sanitized) <= budget && opts.force !== true) {
        return { messages: sanitized, recallFastTrack: false };
    }

    const selected = selectCompactionWindow(sanitized, budget, opts);
    // Recall fast-track (type 2, toy mode): keep it dead simple. The chunked
    // recall text already carries the history, so the preserved tail is reduced
    // to the recent USER messages only (openai-oauth-style) — assistant turns and tool
    // outputs are dropped from the tail. Result shape: system rules → chunk
    // summary → recent user messages. Because the chunk is the history anchor,
    // an empty head is fine as long as we have recall text to emit.
    //
    // Tail policy (option B): keep the most recent RECALL_TAIL_USER_MAX (2) user
    // messages. If those two together exceed RECALL_TAIL_TOKEN_CAP (8k), keep the
    // newest whole and truncate the older one so the pair fits the cap.
    const recallTail = selectRecallTailUserMessages(selected.tail);
    if (selected.head.length === 0 && !selected.previousSummary
        && !(String(opts.recallText || '').trim() || opts.allowEmptyRecall === true)) {
        throw new Error('recallFastTrackCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...selected.system, ...recallTail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    // See semanticCompactMessages: replacing the head with a compact summary
    // always shrinks the transcript, so a budget below the mandatory (system +
    // preserved tail) cost must lift the budget to fit rather than refuse.
    // Refusing here previously surfaced as auto-clear / overflow failures.
    if (mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS > budget) {
        budget = mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS;
    }

    const recallText = String(opts.recallText || '').trim();
    if (!recallText && opts.allowEmptyRecall !== true) {
        throw new Error('recallFastTrackCompactMessages: recall text is empty');
    }
    const oldHistory = selected.originalHead;
    const recallMeta = {
        querySha: opts.querySha || null,
    };
    const summaryMessage = fitRecallFastTrackSummaryMessage(oldHistory, recallText, budget - mandatoryCost, recallMeta);
    if (!summaryMessage) {
        throw new Error(`recallFastTrackCompactMessages: summary cannot fit remaining budget=${budget - mandatoryCost}`);
    }

    let result = sanitizeToolPairs([...selected.system, summaryMessage, ...recallTail]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`recallFastTrackCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    return {
        messages: result,
        recallFastTrack: true,
        compactType: COMPACT_TYPE_RECALL_FASTTRACK,
        query: opts.query || '',
    };
}
