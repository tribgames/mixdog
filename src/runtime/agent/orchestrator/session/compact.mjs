import { createHash } from 'node:crypto';
import {
    sanitizeToolPairs,
    dedupToolResultBodies,
    reconcileDedupStubs,
    estimateMessagesTokens,
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    normalizeCompactionBufferRatio,
    compactionBufferTokensForBoundary,
} from './context-utils.mjs';

export const SUMMARY_PREFIX = 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. You also retain the preserved recent turns that follow.';
// Default auto-compact trigger sits below the effective compact boundary by a
// compaction buffer (10% of boundary, capped at MAX_COMPACTION_BUFFER_RATIO).
// That headroom lets semantic compact run before the transcript is already at the
// hard limit (zero buffer caused overflow_failed with no room to summarize).
// Operators may still set compaction.bufferTokens / bufferPercent / bufferRatio,
// to tune headroom. Telemetry-persisted bufferTokens/bufferRatio of zero is not
// operator config; loop/manager strip it and reapply this default (see
// compactBufferConfigForBoundary).
export {
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    normalizeCompactionBufferRatio,
    compactionBufferTokensForBoundary,
};
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
// Word alternation for raw-string (non-JSON) secret redaction. Mirrors the
// keys in SENSITIVE_TOOL_ARG_KEY_RE and the session-ingest redactor so a raw
// tool-call argument string like `authorization: Bearer abc.def` or
// `password="abc def"` never reaches preserved facts or the compaction prompt.
const SENSITIVE_TOOL_ARG_KEY_WORD = '(?:api[_-]?key|authorization|auth|cookie|credential|passwd|password|refresh[_-]?token|secret|token)';
// Full key matcher: the sensitive WORD may carry a prefix and/or suffix segment
// joined by `_`/`-` so prefixed variants like `access_token`, `access-token`,
// `x-api-key`, and `bearer_token` are matched as whole keys (not just the bare
// word at key start). Prefix/suffix are bounded by a `_`/`-` separator so the
// word stays at an identifier boundary.
const SENSITIVE_TOOL_ARG_KEY_FULL = `(?:[A-Za-z0-9_-]*[_-])?${SENSITIVE_TOOL_ARG_KEY_WORD}(?:[_-][A-Za-z0-9_-]*)?`;

// Redact `key: value` / `key=value` secret pairs inside a raw (non-JSON)
// string. Consumes the WHOLE value after the key — spaces, `Bearer `/`Basic `
// scheme words, quoted values with internal spaces, and `;`-separated cookie
// pairs — so no secret fragment survives. Kept local to compact-core to avoid a
// cross-module dependency on the memory lib; logic matches session-ingest's
// redactRawArgString.
function redactRawSecretString(text) {
    const value = String(text ?? '');
    if (!value) return value;
    const keyRe = new RegExp(`((?:^|[\\s,{(])["']?${SENSITIVE_TOOL_ARG_KEY_FULL}["']?\\s*[:=]\\s*)`, 'gi');
    let out = '';
    let last = 0;
    let match;
    while ((match = keyRe.exec(value)) !== null) {
        const prefixEnd = match.index + match[0].length;
        out += value.slice(last, prefixEnd);
        let i = prefixEnd;
        const quote = value[i] === '"' || value[i] === "'" ? value[i] : '';
        if (quote) {
            i += 1;
            while (i < value.length && value[i] !== quote) i += 1;
            if (i < value.length) i += 1; // include closing quote
        } else {
            while (i < value.length && !/[,)}\n]/.test(value[i])) i += 1;
        }
        out += '[redacted]';
        last = i;
        keyRe.lastIndex = i;
    }
    out += value.slice(last);
    return out;
}

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
    // Defense-in-depth: a non-sensitive KEY can still carry a secret embedded
    // in its string VALUE (e.g. a freeform `headers` string). Redact raw
    // key:value secret pairs before truncating.
    if (typeof value === 'string') return truncateMiddle(redactRawSecretString(value), TOOL_ARG_STRING_MAX_CHARS);
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
        // Non-JSON raw string: redact secret key:value pairs before truncating
        // so toolCallSummary / preserved facts / compaction prompt metadata
        // never leak `authorization: Bearer ...`, passwords, cookies, tokens.
        return truncateMiddle(redactRawSecretString(text), TOOL_ARG_STRING_MAX_CHARS);
    }
    try {
        return JSON.stringify(normalizeToolArgValue(value));
    } catch {
        return truncateMiddle(redactRawSecretString(String(value || '')), TOOL_ARG_STRING_MAX_CHARS);
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

// A compact summary message is a synthetic role:'user' message carrying the
// SUMMARY_PREFIX anchor. It is NOT a real user turn: it must be excluded from
// real user-turn boundary calculations and treated as merge input, otherwise
// an old summary can sit in the preserved tail as a live user message,
// duplicate, or fail to merge across repeated compaction.
function isSummaryMessage(m) {
    return m?.role === 'user'
        && typeof m.content === 'string'
        && m.content.startsWith(SUMMARY_PREFIX);
}

function isProtectedContextUserMessage(m) {
    if (m?.role !== 'user' || typeof m.content !== 'string') return false;
    return m.content.trimStart().startsWith('<system-reminder>');
}

// An injected Skill-body user message (the general newMessages channel carries
// the full SKILL.md body as a role:'user' message after the Skill tool_result).
// Like isSummaryMessage / isProtectedContextUserMessage, it is detected by
// content prefix (the `<skill>` envelope from buildSkillResultEnvelope) so the
// check survives even if the synthetic `meta` field is dropped during a tail
// rebuild. It is NOT the human's latest prompt and must be excluded from
// "latest human request" selection (deriveCurrentRequest /
// buildRecallFastTrackQuery). The `meta:'skill'` marker is also honoured.
function isInjectedSkillBodyMessage(m) {
    if (m?.role !== 'user') return false;
    if (m.meta === 'skill') return true;
    return typeof m.content === 'string' && m.content.trimStart().startsWith('<skill>');
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

// Redaction-ONLY recursive walk for tool-call argument VALUES kept verbatim
// through compaction. Unlike normalizeToolArgValue (which is for prompt-side
// summaries and truncates/summarizes/key-sorts), this preserves shape exactly:
//   - sensitive KEY  -> '[redacted]'
//   - string value   -> redactRawSecretString(value)  (no truncation/middle-cut)
//   - array          -> same length, items walked in order (no slicing/caps)
//   - object         -> same keys in INSERTION order (no sorting/depth caps)
//   - other primitive (number/boolean/bigint/null) -> returned unchanged
// Returns { value, changed } so callers can preserve byte-exact input when the
// walk altered nothing. Only sensitive-key values and embedded raw secret pairs
// inside strings are altered; everything else is structure identical.
function redactToolArgValueOnly(value, key = '') {
    if (SENSITIVE_TOOL_ARG_KEY_RE.test(String(key || ''))) {
        return { value: '[redacted]', changed: value !== '[redacted]' };
    }
    if (value == null) return { value, changed: false };
    if (typeof value === 'string') {
        const redacted = redactRawSecretString(value);
        return { value: redacted, changed: redacted !== value };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const r = redactToolArgValueOnly(item, '');
            if (r.changed) changed = true;
            return r.value;
        });
        return { value: changed ? out : value, changed };
    }
    if (typeof value === 'object') {
        let changed = false;
        const out = {};
        for (const k of Object.keys(value)) {
            const r = redactToolArgValueOnly(value[k], k);
            if (r.changed) changed = true;
            out[k] = r.value;
        }
        return { value: changed ? out : value, changed };
    }
    return { value, changed: false };
}

// Redact sensitive values inside a single tool-call arguments payload while
// preserving its original shape (string stays a string, object stays an
// object) so the provider-valid tool_call structure is not broken. Used to
// scrub messages that survive compaction VERBATIM (preserved tail / mandatory
// context), where prompt-side redaction does not apply. Redaction-only — no
// truncation, summarization, key sorting, or depth/array caps.
function redactToolCallArgumentsValue(rawArgs) {
    if (rawArgs == null) return rawArgs;
    if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (/^[\[{]/.test(trimmed)) {
            try {
                // Parse, redaction-only walk; only reserialize when the walk
                // actually changed a sensitive value. When nothing changed,
                // return the ORIGINAL string byte-exact (no JSON re-formatting).
                const { value, changed } = redactToolArgValueOnly(JSON.parse(trimmed));
                return changed ? JSON.stringify(value) : rawArgs;
            } catch { /* fall through to raw redaction */ }
        }
        return redactRawSecretString(rawArgs);
    }
    if (typeof rawArgs === 'object') {
        try {
            const { value, changed } = redactToolArgValueOnly(rawArgs);
            return changed ? value : rawArgs;
        } catch { return rawArgs; }
    }
    return rawArgs;
}

// Return a copy of a message with sensitive tool-call argument values redacted,
// keeping role / content / toolCallId / tool names+ids and non-sensitive args
// intact. Non-tool-bearing messages are returned unchanged (same reference).
function redactMessageToolCallSecrets(m) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.toolCalls) || m.toolCalls.length === 0) {
        return m;
    }
    let changed = false;
    const toolCalls = m.toolCalls.map((tc) => {
        if (!tc || typeof tc !== 'object') return tc;
        const out = { ...tc };
        if ('arguments' in tc && tc.arguments != null) {
            const redacted = redactToolCallArgumentsValue(tc.arguments);
            if (redacted !== tc.arguments) { out.arguments = redacted; changed = true; }
        }
        if (tc.function && typeof tc.function === 'object' && tc.function.arguments != null) {
            const redacted = redactToolCallArgumentsValue(tc.function.arguments);
            if (redacted !== tc.function.arguments) {
                out.function = { ...tc.function, arguments: redacted };
                changed = true;
            }
        }
        return out;
    });
    if (!changed) return m;
    return { ...m, toolCalls };
}

// Scrub an array of messages that are kept verbatim through compaction so a
// recent assistant tool call carrying a secret (e.g. `authorization: Bearer
// ...`) cannot survive into the returned compacted transcript. Only assistant
// toolCalls argument VALUES are touched; structure/order/pairing is preserved.
export function redactToolCallSecretsInMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => redactMessageToolCallSecrets(m));
}

export function effectiveBudget(budgetTokens, opts) {
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
    // Recall fast-track aliases. `replace(/_/g,'-')` above already folds
    // snake_case (fast_track -> fast-track), but list both dash/no-dash forms
    // explicitly so callers passing either spelling resolve deterministically.
    if (raw === '2' || raw === 'type2' || raw === 'type-2' || raw === 'recall' || raw === 'recall-fast' || raw === 'recall-fasttrack' || raw === 'recall-fast-track' || raw === 'fasttrack' || raw === 'fast-track') {
        return COMPACT_TYPE_RECALL_FASTTRACK;
    }
    // Unknown / unrecognized value: fall back to the caller-provided default
    // (semantic by default). Callers that need to detect an unknown value
    // should compare the input against COMPACT_TYPES before normalizing.
    return fallback;
}

export function compactTypeIsSemantic(value) {
    return normalizeCompactType(value) === COMPACT_TYPE_SEMANTIC;
}

export function compactTypeIsRecallFastTrack(value) {
    return normalizeCompactType(value) === COMPACT_TYPE_RECALL_FASTTRACK;
}

function compactDebugEnabled() {
    return String(process.env.MIXDOG_COMPACT_DEBUG || '').trim() === '1';
}

function compactDebugLog(scope, details = {}) {
    if (!compactDebugEnabled()) return;
    try {
        process.stderr.write(`[compact] ${scope} ${JSON.stringify(details)}\n`);
    } catch { /* best-effort diagnostics only */ }
}

function safeEstimateMessagesTokens(messages) {
    try { return estimateMessagesTokens(messages); }
    catch { return null; }
}

function textByteLength(text) {
    try { return Buffer.byteLength(String(text || ''), 'utf8'); }
    catch { return String(text || '').length; }
}

function messageContentHasMarker(m, marker) {
    if (!m || !marker) return false;
    if (typeof m.content === 'string') return m.content.includes(marker);
    if (Array.isArray(m.content)) {
        return m.content.some((part) => {
            if (!part || typeof part !== 'object') return false;
            return String(part.text || part.content || '').includes(marker);
        });
    }
    return false;
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

function indexLiveTurns(live) {
    const turns = splitTailIntoTurns(live);
    const indexed = [];
    let scan = 0;
    for (const messages of turns) {
        while (scan < live.length && live[scan] !== messages[0]) scan += 1;
        const start = scan;
        const end = start + messages.length;
        indexed.push({ start, end, messages });
        scan = end;
    }
    return indexed;
}

function splitTurnStartIndexForBudget(turn, budget) {
    const { start, end, messages } = turn;
    for (let i = 0; i < messages.length; i += 1) {
        const suffixStart = start + i;
        const suffix = messages.slice(i);
        if (suffix.length > 0 && estimateMessagesTokens(suffix) <= budget) {
            return suffixStart;
        }
    }
    return end;
}

function splitLiveCompactionContext(messages) {
    const sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const { protectedPrefix, conversation: nonSystem } = splitProtectedContext(sanitized);
    let previousSummary = null;
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
        if (isSummaryMessage(nonSystem[i])) {
            previousSummary = nonSystem[i].content;
            break;
        }
    }
    const live = nonSystem.filter((m) => !isSummaryMessage(m));
    return { system: protectedPrefix, live, previousSummary, sanitized };
}

// A tail may begin ONLY at an index that is not a tool result: a tool result
// must stay paired with the assistant tool_call that precedes it, so it can
// never be the first message of the preserved tail. Every other role (user /
// assistant / developer / ...) is a valid tail boundary. This replaces the old
// "the tail must begin at a real user turn" rule, which threw whenever the
// recent window carried no user message (single-turn agent sessions whose tail
// is assistant/tool only).
function findValidCutIndices(live) {
    const out = [];
    for (let i = 0; i < live.length; i += 1) {
        if (live[i]?.role === 'tool') continue;
        out.push(i);
    }
    return out;
}

// User-anchored path (unchanged behaviour): keep up to tailTurns recent turns
// bounded by recentBudget, splitting the newest turn's suffix when it alone is
// too large. Preserved verbatim so Lead / normal sessions with real user turns
// compact exactly as before.
function selectTailStartByTurns(live, recentBudget, tailTurns, previousSummary, opts) {
    const indexedTurns = indexLiveTurns(live);
    if (indexedTurns.length === 0) return live.length;

    let tailStartIdx = live.length;
    let keptTurns = 0;

    for (let t = indexedTurns.length - 1; t >= 0; t -= 1) {
        if (keptTurns >= tailTurns) break;
        const turn = indexedTurns[t];
        const tailFromTurn = live.slice(turn.start);
        if (keptTurns === 0) {
            if (estimateMessagesTokens(tailFromTurn) <= recentBudget) {
                tailStartIdx = turn.start;
                keptTurns += 1;
                continue;
            }
            const splitIdx = splitTurnStartIndexForBudget(turn, recentBudget);
            if (splitIdx < turn.end) {
                tailStartIdx = splitIdx;
                keptTurns += 1;
                break;
            }
            // Newest turn has no fitting suffix: keep entire live transcript in head for summarization.
            tailStartIdx = live.length;
            keptTurns = 0;
            break;
        }
        const candidateStart = turn.start;
        const candidateTail = live.slice(candidateStart);
        if (estimateMessagesTokens(candidateTail) <= recentBudget) {
            tailStartIdx = candidateStart;
            keptTurns += 1;
            continue;
        }
        break;
    }

    if (opts.force === true && !previousSummary && tailStartIdx <= 0) {
        if (indexedTurns.length >= 2) {
            tailStartIdx = indexedTurns[1].start;
        } else if (indexedTurns.length === 1) {
            const onlyTurn = indexedTurns[0];
            const splitIdx = splitTurnStartIndexForBudget(onlyTurn, recentBudget);
            if (splitIdx > onlyTurn.start && splitIdx < onlyTurn.end) {
                tailStartIdx = splitIdx;
            } else if (onlyTurn.end > onlyTurn.start + 1) {
                tailStartIdx = onlyTurn.start + 1;
            }
        }
    }
    return tailStartIdx;
}

// No-user path: pick the tail boundary from valid cut points. Walk newest ->
// oldest, growing the tail across valid cut points while its suffix still fits
// recentBudget, and stop before it overflows. Never anchors on a user turn, so
// an assistant/tool-only single-turn transcript still yields a head to
// summarize and a paired tail to keep.
function selectTailStartByCutPoint(live, recentBudget, previousSummary) {
    const validCuts = findValidCutIndices(live);
    if (validCuts.length === 0) return live.length; // degenerate: only tool results

    let chosen = null;
    for (let k = validCuts.length - 1; k >= 0; k -= 1) {
        const idx = validCuts[k];
        if (estimateMessagesTokens(live.slice(idx)) <= recentBudget) {
            chosen = idx; // fits — try to grow the tail toward an older cut
            continue;
        }
        break; // this cut overflows recentBudget; keep the previous (newer) choice
    }

    if (chosen === null) {
        // Even the newest valid cut's suffix exceeds recentBudget (a single huge
        // message run). Keep the minimal tail from the newest valid cut so a head
        // remains to summarize; if that cut is at index 0 there is nothing to
        // split off, so keep everything in the head instead. The oversized tail
        // is tolerated downstream (mandatory-cost budget raise) rather than
        // throwing.
        const newestCut = validCuts[validCuts.length - 1];
        return newestCut > 0 ? newestCut : live.length;
    }

    if (chosen <= 0) {
        // Whole transcript would become the tail => nothing to compact. With no
        // prior summary to build on, pull the tail start forward to the next
        // valid cut so the leading message(s) become the compactable head.
        if (!previousSummary && validCuts.length >= 2) return validCuts[1];
        // Only ONE valid cut (or a leading tool run before it) and no prior
        // summary: there is no older cut to pull forward to. Returning 0 would
        // make the whole transcript the tail with an empty head, and
        // semanticCompactMessages throws on head.length===0 && !previousSummary.
        // Keep everything in the HEAD instead (empty tail) so a head remains to
        // summarize; an empty tail is valid downstream (mandatory = system+tail).
        if (!previousSummary && validCuts.length < 2) return live.length;
        return chosen;
    }
    return chosen;
}

function selectCompactionWindow(messages, budget, opts = {}) {
    const { system, live, previousSummary } = splitLiveCompactionContext(messages);
    const tailTurns = Math.max(1, Number(opts.tailTurns) || DEFAULT_TAIL_TURNS);
    const recentBudget = preserveRecentBudget(budget, opts);

    const tailStartIdx = userIndexes(live).length
        ? selectTailStartByTurns(live, recentBudget, tailTurns, previousSummary, opts)
        : selectTailStartByCutPoint(live, recentBudget, previousSummary);

    const head = live.slice(0, tailStartIdx);
    let tail = live.slice(tailStartIdx);
    // sanitizeToolPairs/dedup/reconcile repairs any orphan tool_result the cut
    // may have left; because valid cut points never start on a tool result, an
    // assistant tool_call and its trailing tool_results always land on the same
    // side of the boundary, so pairing stays provider-valid.
    tail = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(tail)));

    // Only a genuinely empty live window is unrecoverable. Absence of a user
    // turn in the tail is no longer an error.
    if (!head.length && !tail.length) {
        throw new Error('semanticCompactMessages: nothing to compact (empty live window)');
    }

    const preservedFacts = extractPreservedFacts(head);
    const originalHead = head;
    return {
        system,
        head,
        tail,
        previousSummary,
        originalHead,
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

function estimateCompactionPromptTokens(input, perMessageChars) {
    const prompt = buildCompactionPrompt(input, perMessageChars);
    return estimateMessagesTokens([
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ]);
}

function previousSummaryBodyForCompactionPrompt(previousSummary) {
    const text = String(previousSummary || '').trim();
    if (!text) return '';
    return stripNestedSummaryHeaderLines(text);
}

function priorSummaryNeedsNormalization(text) {
    const body = String(text || '').trim();
    if (!body) return false;
    if (!/^##\s+/m.test(body)) return true;
    if (!summaryIsSchemaValid(body)) return true;
    return summaryHasUnrecognizedHeadings(body);
}

function normalizePriorSummaryForCompactionPrompt(fullBody) {
    const text = String(fullBody || '').trim();
    if (!text) return '';
    if (!priorSummaryNeedsNormalization(text)) return text;
    return repairSemanticSummary(text, { head: [], tail: [] });
}

// Shrink or drop a prior anchored summary so the compaction provider prompt fits
// the call budget. Unstructured/legacy priors are repaired first; section
// anchors are preserved via truncateSummaryBySections;
// the last resort is omitting <previous-summary> entirely.
function fitPreviousSummaryForCompactionPrompt(input, perMessageChars, targetTokens) {
    if (!input?.previousSummary) return input;
    const fullBody = normalizePriorSummaryForCompactionPrompt(
        previousSummaryBodyForCompactionPrompt(input.previousSummary),
    );
    const withSummary = (summaryText) => {
        const trimmed = String(summaryText || '').trim();
        if (!trimmed) return { ...input, previousSummary: null };
        return { ...input, previousSummary: trimmed };
    };

    if (estimateCompactionPromptTokens(withSummary(fullBody), perMessageChars) <= targetTokens) {
        return withSummary(fullBody);
    }

    if (fullBody) {
        let lo = 0;
        let hi = fullBody.length;
        let bestChars = -1;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const truncated = truncateSummaryBySections(fullBody, mid);
            const candidate = withSummary(truncated);
            if (estimateCompactionPromptTokens(candidate, perMessageChars) <= targetTokens) {
                bestChars = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (bestChars >= 0) {
            return withSummary(truncateSummaryBySections(fullBody, bestChars));
        }
    }

    const minimalPrior = minimalSchemaSummary();
    if (estimateCompactionPromptTokens(withSummary(minimalPrior), perMessageChars) <= targetTokens) {
        return withSummary(minimalPrior);
    }

    const withoutPrior = withSummary(null);
    if (estimateCompactionPromptTokens(withoutPrior, perMessageChars) <= targetTokens) {
        return withoutPrior;
    }

    return null;
}

function fitCompactionPrompt(input, targetTokens) {
    const tryFit = (withFacts) => {
        const baseInp = withFacts ? input : { ...input, preservedFacts: null };

        const fitAt = (perMessageChars) => {
            let inp = baseInp;
            if (estimateCompactionPromptTokens(inp, perMessageChars) > targetTokens) {
                const fitted = fitPreviousSummaryForCompactionPrompt(inp, perMessageChars, targetTokens);
                if (!fitted) return null;
                inp = fitted;
                if (estimateCompactionPromptTokens(inp, perMessageChars) > targetTokens) return null;
            }
            return buildCompactionPrompt(inp, perMessageChars);
        };

        const minimalPrompt = fitAt(0);
        if (!minimalPrompt) return null;

        let maxText = 0;
        for (const m of baseInp.head) maxText = Math.max(maxText, extractText(m).length);
        let lo = 0;
        let hi = Math.min(COMPACTION_INPUT_MAX_CHARS, Math.max(maxText, 0));
        let best = minimalPrompt;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = fitAt(mid);
            if (candidate) {
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
    const fitted = tryFit(false);
    if (fitted) return fitted;

    // Emergency deterministic reduction: even at perMessageChars=0 the prompt can
    // overflow when the head carries a very large NUMBER of messages (each still
    // emits a `N. role` line). Keep only the newest K head messages and collapse
    // the rest into a single `[K older messages omitted]` stub line, binary
    // searching the largest K that fits. This bounds the head by COUNT, not just
    // per-message chars, so a huge-head transcript still yields a minimal prompt
    // instead of null (which surfaced as a hard compaction throw).
    const head = Array.isArray(input.head) ? input.head : [];
    const baseNoFacts = { ...input, preservedFacts: null };
    const buildReduced = (k) => {
        const kept = k > 0 ? head.slice(head.length - k) : [];
        const omitted = head.length - kept.length;
        const stubHead = omitted > 0
            ? [{ role: 'user', content: `[${omitted} older messages omitted]` }, ...kept]
            : kept;
        let inp = { ...baseNoFacts, head: stubHead };
        // Also shrink/drop a prior <previous-summary> (same as the normal fitAt
        // path) — a large prior summary can keep the prompt over budget even at
        // K=0. fitPreviousSummaryForCompactionPrompt is a no-op when there is no
        // previousSummary, so this is safe for the summary-less case.
        if (estimateCompactionPromptTokens(inp, 0) > targetTokens) {
            const fitted = fitPreviousSummaryForCompactionPrompt(inp, 0, targetTokens);
            if (!fitted) return null;
            inp = fitted;
            if (estimateCompactionPromptTokens(inp, 0) > targetTokens) return null;
        }
        return buildCompactionPrompt(inp, 0);
    };
    let lo = 0;
    let hi = head.length;
    let best = null;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = buildReduced(mid);
        if (candidate) { best = candidate; lo = mid + 1; }
        else hi = mid - 1;
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

// Canonical section anchors the semantic summary template (SUMMARY_TEMPLATE)
// must contain. Used for lightweight schema validation of provider output.
const REQUIRED_SUMMARY_SECTIONS = Object.freeze([
    '## Goal',
    '## Constraints',
    '## Progress',
    '## Key Decisions',
    '## Next Steps',
    '## Critical Context',
    '## Relevant Files',
]);

// Collect actual top-level (`## `, not `### `) heading lines from a summary.
// Validation is heading-anchor based (not substring includes) so prose or code
// that merely mentions "## Relevant Files" inside a bullet body cannot satisfy
// a section anchor.
function summaryHeadingLines(summary) {
    const out = [];
    for (const rawLine of String(summary || '').split('\n')) {
        const line = rawLine.trim();
        if (/^##\s+\S/.test(line) && !/^###\s+/.test(line)) out.push(line);
    }
    return out;
}

// An anchor matches a heading when the heading title equals the anchor title or
// extends it at a word/punctuation boundary. This lets `## Constraints &
// Preferences` satisfy the `## Constraints` anchor while NOT letting an
// unrelated `## Goalkeeper` heading satisfy `## Goal`. Requires a real `## `
// heading line (not a substring buried in prose).
function headingMatchesAnchor(heading, anchor) {
    const anchorTitle = anchor.replace(/^##\s+/, '').trim().toLowerCase();
    const headingTitle = heading.replace(/^##\s+/, '').trim().toLowerCase();
    if (headingTitle === anchorTitle) return true;
    if (!headingTitle.startsWith(anchorTitle)) return false;
    // Next char after the anchor title must be a boundary (space or &/punct),
    // not a continuation letter/digit.
    const nextChar = headingTitle.charAt(anchorTitle.length);
    return /[\s&:(-]/.test(nextChar);
}

function summarySchemaScore(summary) {
    const headings = summaryHeadingLines(summary);
    let hits = 0;
    for (const anchor of REQUIRED_SUMMARY_SECTIONS) {
        if (headings.some((h) => headingMatchesAnchor(h, anchor))) hits += 1;
    }
    return hits;
}

// A summary is schema-valid only when EVERY required section anchor is present
// as a real heading. A partial summary (e.g. missing Critical Context /
// Relevant Files) must be repaired rather than injected unchanged.
function summaryIsSchemaValid(summary) {
    if (summarySchemaScore(summary) !== REQUIRED_SUMMARY_SECTIONS.length) return false;
    return !summaryHasUnrecognizedHeadings(summary);
}

function deriveRelevantFilesBullets(head) {
    const seen = new Set();
    const out = [];
    const fileRe = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w$.-]+[\\/])?[\w$.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|rs|go|py|java|kt|cs|cpp|c|h|hpp|css|html|yml|yaml|toml|lock|sh|ps1)\b/gi;
    for (const m of Array.isArray(head) ? head : []) {
        const text = extractText(m);
        if (!text) continue;
        let match;
        while ((match = fileRe.exec(text)) && out.length < 8) {
            const file = match[0];
            const key = file.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(`- ${file}`);
        }
        if (out.length >= 8) break;
    }
    return out;
}

function deriveCurrentRequest(messages) {
    for (let i = (Array.isArray(messages) ? messages.length : 0) - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.role === 'user' && !isProtectedContextUserMessage(m) && !isInjectedSkillBodyMessage(m)) {
            const text = truncateMiddle(extractText(m).trim(), 400);
            if (text) return text;
        }
    }
    return '';
}

// Canonical ordered section headings the structured summary scaffold emits.
// Each `## ` heading maps to one REQUIRED_SUMMARY_SECTIONS anchor; Progress
// additionally carries its three `### ` sub-headings.
const SUMMARY_SECTION_LAYOUT = Object.freeze([
    { heading: '## Goal', anchor: '## Goal' },
    { heading: '## Constraints & Preferences', anchor: '## Constraints' },
    { heading: '## Progress', anchor: '## Progress', sub: ['### Done', '### In Progress', '### Blocked'] },
    { heading: '## Key Decisions', anchor: '## Key Decisions' },
    { heading: '## Next Steps', anchor: '## Next Steps' },
    { heading: '## Critical Context', anchor: '## Critical Context' },
    { heading: '## Relevant Files', anchor: '## Relevant Files' },
]);

// Split a markdown summary into a map of top-level `## ` heading -> body lines.
function parseSummarySections(text) {
    const map = new Map();
    let current = null;
    for (const rawLine of String(text || '').split('\n')) {
        const trimmed = rawLine.trim();
        const line = rawLine.replace(/\s+$/, '');
        if (/^##\s+/.test(trimmed) && !/^###\s+/.test(trimmed)) {
            current = trimmed;
            if (!map.has(current)) map.set(current, []);
            continue;
        }
        if (current) map.get(current).push(line);
    }
    return map;
}

function summarySectionIsRecognized(heading) {
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (headingMatchesAnchor(heading, section.anchor)) return true;
    }
    return false;
}

function summaryHasUnrecognizedHeadings(summary) {
    for (const heading of parseSummarySections(summary).keys()) {
        if (!summarySectionIsRecognized(heading)) return true;
    }
    return false;
}

function summaryLinesToBullets(text) {
    return String(text || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith('-') ? l : `- ${l}`));
}

function unrecognizedSummarySectionText(present) {
    const chunks = [];
    for (const [heading, body] of present) {
        if (summarySectionIsRecognized(heading)) continue;
        const lines = [heading];
        for (const line of body || []) {
            const trimmed = String(line).trim();
            if (trimmed) lines.push(line);
        }
        chunks.push(lines.join('\n'));
    }
    return chunks.join('\n\n').trim();
}

// Deterministic schema repair for a non-empty but malformed/partial semantic
// summary. Preserve every section the provider DID supply (matched by anchor),
// and scaffold the missing required sections so downstream consumers always
// receive the full structured anchored shape. Content that lives outside any
// recognized section is routed into Critical Context so nothing is dropped.
// Lightly backfill Goal / Relevant Files from the transcript when empty.
function repairSemanticSummary(summary, { head = [], tail = [] } = {}) {
    const raw = String(summary || '').trim();
    const present = parseSummarySections(raw);
    // Capture any leading content before the first recognized `## ` heading so
    // an entirely unstructured blob is preserved rather than silently dropped.
    let preamble = '';
    if (raw) {
        const firstHeading = raw.search(/(^|\n)\s*##\s+/);
        preamble = firstHeading === -1 ? raw : raw.slice(0, firstHeading);
        preamble = preamble.trim();
    }
    const orphanText = unrecognizedSummarySectionText(present);
    const extraContextParts = [];
    if (preamble) extraContextParts.push(preamble);
    if (orphanText) extraContextParts.push(orphanText);
    const extraContext = extraContextParts.join('\n\n').trim();
    const bulletize = (lines) => {
        const cleaned = (Array.isArray(lines) ? lines : [])
            .map((l) => String(l).trim())
            .filter(Boolean);
        return cleaned.length ? cleaned : null;
    };
    const findPresent = (anchor) => {
        for (const [heading, body] of present) {
            if (headingMatchesAnchor(heading, anchor)) return body;
        }
        return null;
    };
    const goal = deriveCurrentRequest(tail) || deriveCurrentRequest(head);
    const files = deriveRelevantFilesBullets(head);
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        const body = bulletize(findPresent(section.anchor));
        if (section.sub) {
            // Progress: keep provider sub-bodies when present, else scaffold.
            if (body) {
                out.push(...body);
            } else {
                for (const sub of section.sub) {
                    out.push(sub, '- (none)');
                }
            }
            continue;
        }
        if (section.anchor === '## Critical Context') {
            const ccLines = [];
            if (body) ccLines.push(...body);
            for (const line of summaryLinesToBullets(extraContext)) {
                if (!ccLines.some((existing) => existing.trim() === line.trim())) ccLines.push(line);
            }
            if (ccLines.some((line) => line.trim() !== '- (none)')) {
                const withoutPlaceholder = ccLines.filter((line) => line.trim() !== '- (none)');
                out.push(...(withoutPlaceholder.length ? withoutPlaceholder : ccLines));
            } else {
                out.push(...(ccLines.length ? ccLines : ['- (none)']));
            }
            continue;
        }
        if (body) {
            out.push(...body);
            continue;
        }
        if (section.anchor === '## Goal') {
            out.push(goal ? `- ${goal}` : '- (none)');
        } else if (section.anchor === '## Relevant Files') {
            out.push(...(files.length ? files : ['- (none)']));
        } else {
            out.push('- (none)');
        }
    }
    return out.join('\n');
}

// Validate the provider summary against the required template sections; when it
// is missing ANY required section anchor (fully or partially malformed) repair
// it deterministically so a non-empty-but-broken response is never injected as
// the sole summary. Returns { summary, repaired }.
function enforceSemanticSummarySchema(summary, ctx = {}) {
    const text = String(summary || '').trim();
    if (!text) return { summary: text, repaired: false };
    if (summaryIsSchemaValid(text)) {
        return { summary: text, repaired: false };
    }
    return { summary: repairSemanticSummary(text, ctx), repaired: true };
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
        if (!latestUser && m?.role === 'user' && !isProtectedContextUserMessage(m) && !isInjectedSkillBodyMessage(m)) {
            latestUser = text;
        }
        if (latestUser && recent.length >= 6) break;
    }
    const parts = [latestUser, hints, recent.join('\n')]
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    return truncateMiddle([...new Set(parts)].join('\n'), maxChars);
}

// A headings-only structured summary: every required `## ` (and Progress `### `)
// anchor present with `- (none)` bodies. This is the minimal schema-valid shape
// the fitter can fall back to when token pressure cannot hold real section
// bodies — it still passes summaryIsSchemaValid so the injected message is
// never partial.
function minimalSchemaSummary() {
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        if (section.sub) {
            for (const sub of section.sub) out.push(sub, '- (none)');
        } else {
            out.push('- (none)');
        }
    }
    return out.join('\n');
}

// Section-aware truncation: keep EVERY `## ` heading and Progress `### `
// sub-heading intact, trimming only section bodies to `perSectionChars`. Unlike
// a raw text.slice(0, n) this never drops a trailing required section, so the
// result stays schema-valid (all anchors present) at any budget.
function truncateSummaryBySections(summary, perSectionChars) {
    const sections = parseSummarySections(summary);
    const out = [];
    for (const section of SUMMARY_SECTION_LAYOUT) {
        if (out.length) out.push('');
        out.push(section.heading);
        let body = null;
        for (const [heading, lines] of sections) {
            if (headingMatchesAnchor(heading, section.anchor)) { body = lines; break; }
        }
        const bodyText = (Array.isArray(body) ? body : [])
            .map((l) => String(l).trim())
            .filter(Boolean)
            .join('\n');
        if (!bodyText) {
            if (section.sub) for (const sub of section.sub) out.push(sub, '- (none)');
            else out.push('- (none)');
            continue;
        }
        const trimmed = perSectionChars > 0 ? truncateMiddle(bodyText, perSectionChars) : '';
        if (trimmed) out.push(trimmed);
        else if (section.sub) for (const sub of section.sub) out.push(sub, '- (none)');
        else out.push('- (none)');
    }
    return out.join('\n');
}

// Fit the structured semantic summary into the remaining token budget WITHOUT
// dropping any required section. The incoming `summary` is already schema-valid
// (enforceSemanticSummarySchema ran upstream); here we shrink section bodies via
// section-aware truncation, fall back to a headings-only schema-valid summary,
// and finally revalidate so the injected SUMMARY_PREFIX message always carries
// every required anchor. Returns null only when even the minimal schema-valid
// summary cannot fit (caller throws).
function fitSemanticSummaryMessage(oldHistory, summary, remainingTokens, semanticMeta, preservedFacts = '') {
    const tryFit = (factsText) => {
        const text = String(summary || '').trim();
        // Minimal schema-valid body (headings + "(none)"). If even this does
        // not fit, this facts variant cannot produce a valid message.
        const minimalBody = text ? minimalSchemaSummary() : '';
        const minimal = makeSemanticSummaryMessage(oldHistory, minimalBody, semanticMeta, factsText);
        if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
        if (!text) return minimal;
        // Binary search the per-section body budget; keep all anchors intact.
        let lo = 0;
        let hi = text.length;
        let best = minimal;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const body = truncateSummaryBySections(text, mid);
            const candidate = makeSemanticSummaryMessage(oldHistory, body, semanticMeta, factsText);
            if (estimateMessagesTokens([candidate]) <= remainingTokens && summaryIsSchemaValid(body)) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    };
    let result = null;
    if (preservedFacts) result = tryFit(preservedFacts);
    if (!result) result = tryFit('');
    return result;
}

// Recall fast-track (compact type 2) does no LLM summarization — it just emits
// the chunked history in order. Keep the message clean: the mandatory anchor
// header (so selectCompactionWindow / clear-preserve / TUI can recognize the
// compact message) plus the chunk text itself. No "Preserved Facts" extraction,
// no "Recall Fast-Track Context" heading, no "(no recall hits)" filler.
function makeRecallFastTrackSummaryMessage(oldHistory, recallText, recallMeta = {}) {
    return makeRecallFastTrackSummaryMessageParts(oldHistory, recallText, '', recallMeta);
}

const RECALL_TAIL_TRUNCATION_MARKER = '[... truncated during recall tail preservation ...]';
const RECALL_TAIL_SHORT_TRUNCATION_MARKER = '[truncated]';

const PRIOR_COMPACTED_CONTEXT_OPEN = '<prior-compacted-context>';
const PRIOR_COMPACTED_CONTEXT_CLOSE = '</prior-compacted-context>';

function formatPriorCompactedContextBlock(priorText) {
    const prior = String(priorText || '').trim();
    if (!prior) return '';
    return `${PRIOR_COMPACTED_CONTEXT_OPEN}\n${prior}\n${PRIOR_COMPACTED_CONTEXT_CLOSE}`;
}

function makeRecallFastTrackSummaryMessageParts(oldHistory, recallPart, priorPart, recallMeta = {}) {
    const header = compactHeader(oldHistory);
    header.push(`compact_type=${COMPACT_TYPE_RECALL_FASTTRACK} source=recall-fasttrack query_sha=${recallMeta.querySha || 'none'}`);
    const parts = [header.join('\n')];
    const priorBlock = formatPriorCompactedContextBlock(priorPart);
    if (priorBlock) parts.push(priorBlock);
    const recall = String(recallPart || '').trim();
    if (recall) parts.push(recall);
    return makeSummaryMessage(parts.join('\n\n'));
}

function fitRecallFastTrackSummaryMessage(oldHistory, recallText, remainingTokens, recallMeta = {}, priorPart = '') {
    const recall = String(recallText || '').trim();
    const prior = String(priorPart || '').trim();

    let fittedPrior = prior;
    if (prior) {
        let lo = 0;
        let hi = prior.length;
        let bestPriorLen = 0;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = makeRecallFastTrackSummaryMessageParts(oldHistory, '', prior.slice(0, mid), recallMeta);
            if (estimateMessagesTokens([candidate]) <= remainingTokens) {
                bestPriorLen = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        fittedPrior = prior.slice(0, bestPriorLen);
        if (!fittedPrior && prior) {
            const markerOnly = makeRecallFastTrackSummaryMessageParts(oldHistory, '', RECALL_TAIL_TRUNCATION_MARKER, recallMeta);
            if (estimateMessagesTokens([markerOnly]) <= remainingTokens) {
                fittedPrior = RECALL_TAIL_TRUNCATION_MARKER;
            }
        }
    }

    const minimal = makeRecallFastTrackSummaryMessageParts(oldHistory, '', fittedPrior, recallMeta);
    if (estimateMessagesTokens([minimal]) > remainingTokens) return null;
    if (!recall) return minimal;

    let lo = 0;
    let hi = recall.length;
    let best = minimal;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = makeRecallFastTrackSummaryMessageParts(oldHistory, recall.slice(0, mid), fittedPrior, recallMeta);
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
    const startedAt = Date.now();
    let budget = effectiveBudget(budgetTokens, opts);
    const baseSanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const baseTokens = safeEstimateMessagesTokens(baseSanitized);
    // No-op fast path: if the original sanitized transcript already fits and we
    // are not forced, return it UNCHANGED (no preserved-tail redaction applied)
    // to keep prior no-compaction semantics.
    if (baseTokens != null && baseTokens <= budget && opts.force !== true) {
        return {
            messages: baseSanitized,
            usage: null,
            semantic: false,
            compactType: COMPACT_TYPE_SEMANTIC,
            diagnostics: {
                noOp: true,
                reason: 'fits_budget',
                inputMessages: Array.isArray(messages) ? messages.length : 0,
                baseMessages: baseSanitized.length,
                baseTokens,
                budgetTokens: budget,
                durationMs: Date.now() - startedAt,
            },
        };
    }
    // Compaction will proceed: redact sensitive tool-call argument VALUES before
    // window selection so the preserved tail/system that survive verbatim are
    // measured AND emitted in their redacted form. Head prompt normalizers
    // (toolCallSummary/normalizeToolArgValue) still apply on top for the
    // summarized head. Redaction is shape-preserving, so tool-pair structure
    // stays provider-valid.
    const sanitized = redactToolCallSecretsInMessages(baseSanitized);

    const selected = selectCompactionWindow(sanitized, budget, opts);
    if (selected.head.length === 0 && !selected.previousSummary) {
        throw new Error('semanticCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...selected.system, ...selected.tail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    const originalBudget = budget;
    // The preserved tail is kept verbatim and the head is replaced by a much
    // smaller summary, so the compacted result is always smaller than the
    // input regardless of how the configured target budget compares to the
    // mandatory cost. When the budget cannot even hold what we must keep, raise
    // it to fit (mandatory + summary room) rather than refusing — a refusal
    // here was the source of auto-clear / overflow compact failures.
    if (mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS > budget) {
        budget = mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS;
    }
    const budgetRaisedBy = Math.max(0, budget - originalBudget);

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
    const rawSummary = extractResponseText(response);
    if (!rawSummary) throw new Error('semanticCompactMessages: compaction agent returned empty summary');
    // Lightweight schema enforcement: a non-empty but malformed provider
    // response (missing the required template sections) is deterministically
    // repaired into the structured anchored shape rather than injected blindly.
    const enforced = enforceSemanticSummarySchema(rawSummary, { head: selected.head, tail: selected.tail });
    const summary = enforced.summary;

    const oldHistory = selected.originalHead;
    const semanticMeta = {
        provider: opts.providerName || provider.name || null,
        model: compactModel,
    };
    const summaryMessage = fitSemanticSummaryMessage(oldHistory, summary, budget - mandatoryCost, semanticMeta, selected.preservedFacts);
    if (!summaryMessage) {
        throw new Error(`semanticCompactMessages: summary cannot fit remaining budget=${budget - mandatoryCost}`);
    }

    // selected.system / selected.tail already carry redacted tool-call args
    // (sanitized was redacted before window selection), so the preserved tail
    // is both measured and emitted in redacted form.
    let result = sanitizeToolPairs([...selected.system, summaryMessage, ...selected.tail]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`semanticCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    const diagnostics = {
        noOp: false,
        inputMessages: Array.isArray(messages) ? messages.length : 0,
        baseMessages: baseSanitized.length,
        baseTokens,
        systemMessages: selected.system.length,
        headMessages: selected.head.length,
        originalHeadMessages: selected.originalHead.length,
        tailMessages: selected.tail.length,
        mandatoryMessages: mandatory.length,
        finalMessages: result.length,
        systemTokens: safeEstimateMessagesTokens(selected.system),
        headTokens: safeEstimateMessagesTokens(selected.head),
        tailTokens: safeEstimateMessagesTokens(selected.tail),
        mandatoryCost,
        finalTokens,
        originalBudgetTokens: originalBudget,
        budgetTokens: budget,
        budgetRaised: budgetRaisedBy > 0,
        budgetRaisedBy,
        remainingTokens: budget - mandatoryCost,
        callBudgetTokens: callBudget,
        promptChars: String(prompt || '').length,
        promptBytes: textByteLength(prompt),
        promptTokens: safeEstimateMessagesTokens([
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ]),
        summaryChars: String(summary || '').length,
        rawSummaryChars: String(rawSummary || '').length,
        summaryRepaired: enforced.repaired === true,
        previousSummary: !!selected.previousSummary,
        durationMs: Date.now() - startedAt,
    };
    compactDebugLog('semantic result', diagnostics);
    return {
        messages: result,
        usage: response?.usage || null,
        providerState: response?.providerState,
        semantic: true,
        compactType: COMPACT_TYPE_SEMANTIC,
        summary,
        summaryRepaired: enforced.repaired === true,
        diagnostics,
    };
}

export function recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    return _recallFastTrackCompactMessages(messages, budgetTokens, opts);
}

// Recall fast-track (type 2) tail policy: preserve the most recent turns of the
// live conversation VERBATIM and STRUCTURED, keeping role semantics for
// user / assistant / tool / system / developer instead of collapsing the tail
// to user-only. The chunk summary anchors older history; the preserved tail
// keeps recent assistant reasoning, tool_calls, and tool_results so fresh
// state is not silently dropped.
//
// Turns are anchored on user-role boundaries: each turn = a user message plus
// the assistant/tool/system/developer messages that follow it (a leading run of
// non-user messages before the first user boundary is treated as its own
// partial turn so nothing is lost). We keep the newest RECALL_TAIL_USER_MAX
// turns; if the kept set exceeds RECALL_TAIL_TOKEN_CAP we drop whole oldest
// turns first, then middle-truncate the oldest surviving messages' string
// content so the set fits while leaving the newest message whole.
//
// Partial tool_call/tool_result pairs that truncation might leave behind are
// repaired by sanitizeToolPairs/reconcileDedupStubs in the caller, so pairing
// stays valid even after trimming.
const RECALL_TAIL_USER_MAX = 2;
const RECALL_TAIL_TOKEN_CAP = DEFAULT_COMPACTION_KEEP_TOKENS; // 8k
// Rough chars-per-token used only to size a truncation target; the real fit is
// re-checked with estimateMessagesTokens below.
const RECALL_TAIL_CHARS_PER_TOKEN = 4;

function splitTailIntoTurns(messages) {
    const turns = [];
    let current = null;
    for (const m of messages) {
        if (isSummaryMessage(m)) continue;
        if (m?.role === 'user') {
            if (current) turns.push(current);
            current = [m];
        } else {
            if (!current) current = [];
            current.push(m);
        }
    }
    if (current && current.length) turns.push(current);
    return turns;
}

function truncateMessageForRecallTail(text, maxChars) {
    const marker = RECALL_TAIL_TRUNCATION_MARKER;
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return RECALL_TAIL_SHORT_TRUNCATION_MARKER;
    if (maxChars < marker.length) return RECALL_TAIL_SHORT_TRUNCATION_MARKER;
    const room = maxChars - marker.length;
    const head = Math.ceil(room * 0.35);
    const tailPart = Math.floor(room * 0.65);
    return `${value.slice(0, head)}${marker}${value.slice(value.length - tailPart)}`;
}

function fitRecallUserMessageToCap(userMsg, cap, following = []) {
    const followCost = estimateMessagesTokens(following);
    const room = Math.max(1, cap - followCost);
    const base = { ...userMsg };
    const raw = typeof base.content === 'string' ? base.content : extractText(base);
    if (estimateMessagesTokens([{ ...base, content: raw }]) <= room) return { ...base, content: raw };

    let lo = 0;
    let hi = raw.length;
    let best = truncateMessageForRecallTail(raw, 0);
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidateText = truncateMessageForRecallTail(raw, mid);
        const candidate = { ...base, content: candidateText };
        if (estimateMessagesTokens([candidate]) <= room) {
            best = candidateText;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return { ...base, content: best };
}

function fitSingleRecallTurnToCap(turn, cap) {
    const userIdx = turn.findIndex((m) => m?.role === 'user');
    if (userIdx < 0) {
        return truncateTailToCap(turn, cap);
    }
    const userMsg = turn[userIdx];
    const following = turn.slice(userIdx + 1);
    const fittedUser = fitRecallUserMessageToCap(userMsg, cap, following);
    let out = [fittedUser];
    for (const m of following) {
        const candidate = [...out, m];
        if (estimateMessagesTokens(candidate) <= cap) out.push(m);
    }
    return reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(out)));
}

function truncateTailToCap(messages, cap) {
    const turn = Array.isArray(messages) ? messages : [];
    if (turn.length === 0) return [];
    // No user anchor in this turn: keep the NEWEST messages that fit `cap`,
    // walking backward. (Previously this delegated back to
    // fitSingleRecallTurnToCap, which re-entered here on a no-user turn —
    // infinite mutual recursion. Unreachable while a no-user tail threw upstream;
    // now that a no-user tail is allowed, this path must terminate on its own.)
    let out = [];
    let startIdx = turn.length; // index in `turn` where `out` begins
    for (let i = turn.length - 1; i >= 0; i -= 1) {
        const candidate = [turn[i], ...out];
        if (estimateMessagesTokens(candidate) <= cap) {
            out = candidate;
            startIdx = i;
            continue;
        }
        if (out.length === 0) {
            // Even the newest single message exceeds cap: middle-truncate its
            // string content so at least one message survives.
            const m = turn[i];
            const text = typeof m?.content === 'string' ? m.content : extractText(m);
            const truncated = truncateMessageForRecallTail(text, Math.max(1, cap * RECALL_TAIL_CHARS_PER_TOKEN));
            out = [{ ...m, content: truncated }];
            startIdx = i;
        }
        break;
    }
    // A leading tool_result with no preceding assistant tool_call is an orphan
    // that sanitizeToolPairs drops — which could empty the whole tail. Extend the
    // window backward to swallow the preceding non-tool boundary (the assistant
    // that owns the tool_call), so the pair survives sanitize. Bounded by
    // startIdx so it always terminates.
    while (startIdx > 0 && out[0]?.role === 'tool') {
        startIdx -= 1;
        out = [turn[startIdx], ...out];
    }
    let sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(out)));
    // Final guard: if sanitize still emptied the tail but the turn has a non-tool
    // message, rebuild from the newest non-tool message forward so the tail is
    // never empty when preservable content exists.
    if (sanitized.length === 0) {
        let nt = -1;
        for (let i = turn.length - 1; i >= 0; i -= 1) {
            if (turn[i]?.role !== 'tool') { nt = i; break; }
        }
        if (nt >= 0) {
            sanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(turn.slice(nt))));
        }
    }
    return sanitized;
}

function stripNestedSummaryHeaderLines(text) {
    const lines = String(text ?? '').split('\n');
    const out = [];
    for (const line of lines) {
        if (line.startsWith(SUMMARY_PREFIX)) continue;
        if (/^messages=\d+\s+sha256=/.test(line.trim())) continue;
        out.push(line);
    }
    return out.join('\n').trim();
}

function splitRecallFitInputs(recallText, previousSummary) {
    return {
        recall: String(recallText || '').trim(),
        prior: previousSummary ? stripNestedSummaryHeaderLines(previousSummary) : '',
    };
}

function recallTailStartIndex(live, tail) {
    if (!tail.length) return live.length;
    const first = tail[0];
    const idx = live.indexOf(first);
    if (idx >= 0) return idx;
    return Math.max(0, live.length - tail.length);
}

function selectRecallPreservedTail(live, opts = {}) {
    const msgs = (Array.isArray(live) ? live : []).filter((m) => m && !isSummaryMessage(m));
    if (msgs.length === 0) return { tail: [], head: [], tailStartIdx: 0 };
    const maxTurns = Math.max(1, Number(opts.maxUsers) || RECALL_TAIL_USER_MAX);
    const cap = Math.max(1, Number(opts.tokenCap) || RECALL_TAIL_TOKEN_CAP);
    const turns = splitTailIntoTurns(msgs);
    if (turns.length === 0) return { tail: [], head: msgs, tailStartIdx: 0 };

    let kept = turns.slice(-maxTurns);
    while (kept.length > 1 && estimateMessagesTokens(kept.flat()) > cap) {
        kept = kept.slice(1);
    }

    let tail;
    if (estimateMessagesTokens(kept.flat()) <= cap) {
        tail = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(kept.flat())));
    } else {
        tail = fitSingleRecallTurnToCap(kept[kept.length - 1], cap);
    }

    // A no-user tail is valid: a single-turn agent session may keep only
    // assistant/tool structure recently. Mirror the semantic cut-point model —
    // preserve the recent structured turn(s) verbatim without demanding a user
    // anchor rather than throwing. tool-pairing is already reconciled above.
    const tailStartIdx = recallTailStartIndex(msgs, tail);
    const head = msgs.slice(0, tailStartIdx);
    return { tail, head, tailStartIdx };
}

// Kept name as the type-2 tail anchor; behavior now preserves whole structured
// turns (all roles) rather than only role=user messages.
function selectRecallTailUserMessages(tail, opts = {}) {
    const msgs = (Array.isArray(tail) ? tail : []).filter((m) => m && !isSummaryMessage(m));
    return selectRecallPreservedTail(msgs, opts).tail;
}

function _recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    const startedAt = Date.now();
    let budget = effectiveBudget(budgetTokens, opts);
    const baseSanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    const baseTokens = safeEstimateMessagesTokens(baseSanitized);
    if (baseTokens != null && baseTokens <= budget && opts.force !== true) {
        return {
            messages: baseSanitized,
            recallFastTrack: false,
            compactType: COMPACT_TYPE_RECALL_FASTTRACK,
            query: opts.query || '',
            diagnostics: {
                noOp: true,
                reason: 'fits_budget',
                inputMessages: Array.isArray(messages) ? messages.length : 0,
                baseMessages: baseSanitized.length,
                baseTokens,
                budgetTokens: budget,
                durationMs: Date.now() - startedAt,
            },
        };
    }
    const sanitized = redactToolCallSecretsInMessages(baseSanitized);

    const { system: safeSystem, live, previousSummary } = splitLiveCompactionContext(sanitized);
    const recallTailOpts = {
        maxUsers: opts.recallTailMaxUsers ?? opts.tailTurns ?? RECALL_TAIL_USER_MAX,
        tokenCap: opts.recallTailTokenCap ?? preserveRecentBudget(budget, opts),
    };
    const { tail: recallTail, head: recallHead } = selectRecallPreservedTail(live, recallTailOpts);
    const recallFit = splitRecallFitInputs(opts.recallText, previousSummary);
    if (recallHead.length === 0 && !previousSummary
        && !(recallFit.recall || recallFit.prior || opts.allowEmptyRecall === true)) {
        throw new Error('recallFastTrackCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...safeSystem, ...recallTail])));
    const mandatoryCost = estimateMessagesTokens(mandatory);
    const originalBudget = budget;
    if (mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS > budget) {
        budget = mandatoryCost + COMPACT_SUMMARY_MIN_ROOM_TOKENS;
    }
    const budgetRaisedBy = Math.max(0, budget - originalBudget);

    if (!recallFit.recall && !recallFit.prior && opts.allowEmptyRecall !== true) {
        throw new Error('recallFastTrackCompactMessages: recall text is empty');
    }
    const oldHistory = recallHead;
    const recallMeta = {
        querySha: opts.querySha || null,
    };
    const summaryMessage = fitRecallFastTrackSummaryMessage(
        oldHistory,
        recallFit.recall,
        budget - mandatoryCost,
        recallMeta,
        recallFit.prior,
    );
    if (!summaryMessage) {
        throw new Error(`recallFastTrackCompactMessages: summary cannot fit remaining budget=${budget - mandatoryCost}`);
    }

    let result = sanitizeToolPairs([...safeSystem, summaryMessage, ...recallTail]);
    result = reconcileDedupStubs(dedupToolResultBodies(result));
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budget) {
        throw new Error(`recallFastTrackCompactMessages: compacted result exceeds budget=${budget} (result=${finalTokens})`);
    }
    const summaryContent = String(summaryMessage?.content || '');
    const diagnostics = {
        noOp: false,
        inputMessages: Array.isArray(messages) ? messages.length : 0,
        baseMessages: baseSanitized.length,
        baseTokens,
        systemMessages: safeSystem.length,
        liveMessages: live.length,
        headMessages: recallHead.length,
        tailMessages: recallTail.length,
        mandatoryMessages: mandatory.length,
        finalMessages: result.length,
        systemTokens: safeEstimateMessagesTokens(safeSystem),
        liveTokens: safeEstimateMessagesTokens(live),
        headTokens: safeEstimateMessagesTokens(recallHead),
        tailTokens: safeEstimateMessagesTokens(recallTail),
        mandatoryCost,
        finalTokens,
        originalBudgetTokens: originalBudget,
        budgetTokens: budget,
        budgetRaised: budgetRaisedBy > 0,
        budgetRaisedBy,
        remainingTokens: budget - mandatoryCost,
        recallChars: recallFit.recall.length,
        recallBytes: textByteLength(recallFit.recall),
        priorChars: recallFit.prior.length,
        priorBytes: textByteLength(recallFit.prior),
        summaryMessageChars: summaryContent.length,
        summaryMessageBytes: textByteLength(summaryContent),
        recallEmpty: !recallFit.recall,
        priorEmpty: !recallFit.prior,
        recallTruncatedInSummary: !!recallFit.recall && !summaryContent.includes(recallFit.recall),
        priorTruncatedInSummary: !!recallFit.prior && !summaryContent.includes(recallFit.prior),
        tailTruncated: recallTail.some((m) => messageContentHasMarker(m, RECALL_TAIL_TRUNCATION_MARKER) || messageContentHasMarker(m, RECALL_TAIL_SHORT_TRUNCATION_MARKER)),
        tailOptions: recallTailOpts,
        previousSummary: !!previousSummary,
        durationMs: Date.now() - startedAt,
    };
    compactDebugLog('recall-fasttrack result', diagnostics);
    return {
        messages: result,
        recallFastTrack: true,
        compactType: COMPACT_TYPE_RECALL_FASTTRACK,
        query: opts.query || '',
        diagnostics,
    };
}
