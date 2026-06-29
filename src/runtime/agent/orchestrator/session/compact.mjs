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
    return summarySchemaScore(summary) === REQUIRED_SUMMARY_SECTIONS.length;
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
        if (m?.role === 'user' && !isProtectedContextUserMessage(m)) {
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
        const line = rawLine.replace(/\s+$/, '');
        if (/^##\s+/.test(line) && !/^###\s+/.test(line)) {
            current = line.trim();
            if (!map.has(current)) map.set(current, []);
            continue;
        }
        if (current) map.get(current).push(line);
    }
    return map;
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
        const firstHeading = raw.search(/(^|\n)##\s+/);
        preamble = firstHeading === -1 ? raw : raw.slice(0, firstHeading);
        preamble = preamble.trim();
    }
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
        if (body) {
            out.push(...body);
            continue;
        }
        if (section.anchor === '## Goal') {
            out.push(goal ? `- ${goal}` : '- (none)');
        } else if (section.anchor === '## Critical Context') {
            // Route any unstructured preamble into Critical Context so a fully
            // freeform provider blob is retained in the structured output.
            const preambleLines = preamble
                ? preamble.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('-') ? l : `- ${l}`))
                : null;
            out.push(...(preambleLines || ['- (none)']));
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
    const baseSanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    // No-op fast path: if the original sanitized transcript already fits and we
    // are not forced, return it UNCHANGED (no preserved-tail redaction applied)
    // to keep prior no-compaction semantics.
    if (estimateMessagesTokens(baseSanitized) <= budget && opts.force !== true) {
        return { messages: baseSanitized, usage: null, semantic: false };
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
    return {
        messages: result,
        usage: response?.usage || null,
        providerState: response?.providerState,
        semantic: true,
        compactType: COMPACT_TYPE_SEMANTIC,
        summary,
        summaryRepaired: enforced.repaired === true,
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

function truncateTailToCap(messages, cap) {
    const out = messages.slice();
    // Truncate older string-content messages first (oldest → newest), keeping
    // the newest message whole as long as possible.
    for (let i = 0; i < out.length - 1 && estimateMessagesTokens(out) > cap; i += 1) {
        const m = out[i];
        if (!m || typeof m.content !== 'string' || !m.content) continue;
        const over = estimateMessagesTokens(out) - cap;
        const target = Math.max(0, m.content.length - over * RECALL_TAIL_CHARS_PER_TOKEN);
        out[i] = { ...m, content: truncateMiddle(m.content, target) };
    }
    // Single oversized newest message: truncate it against the leftover room.
    if (estimateMessagesTokens(out) > cap && out.length > 0) {
        const last = out.length - 1;
        const m = out[last];
        if (m && typeof m.content === 'string') {
            const used = estimateMessagesTokens(out.slice(0, last));
            const room = Math.max(0, cap - used);
            out[last] = { ...m, content: truncateMiddle(m.content, room * RECALL_TAIL_CHARS_PER_TOKEN) };
        }
    }
    return out;
}

// Kept name as the type-2 tail anchor; behavior now preserves whole structured
// turns (all roles) rather than only role=user messages.
function selectRecallTailUserMessages(tail, opts = {}) {
    const msgs = (Array.isArray(tail) ? tail : []).filter(Boolean);
    if (msgs.length === 0) return [];
    const maxTurns = Math.max(1, Number(opts.maxUsers) || RECALL_TAIL_USER_MAX);
    const cap = Math.max(1, Number(opts.tokenCap) || RECALL_TAIL_TOKEN_CAP);
    const turns = splitTailIntoTurns(msgs);
    if (turns.length === 0) return [];
    // Keep the newest `maxTurns` turns, preserving role order within each turn.
    let kept = turns.slice(-maxTurns);
    if (estimateMessagesTokens(kept.flat()) <= cap) return kept.flat();
    // Over cap: drop whole oldest kept turns while more than one remains.
    while (kept.length > 1) {
        kept = kept.slice(1);
        if (estimateMessagesTokens(kept.flat()) <= cap) return kept.flat();
    }
    // Single newest turn still over cap: middle-truncate its messages to fit.
    return truncateTailToCap(kept.flat(), cap);
}

function _recallFastTrackCompactMessages(messages, budgetTokens, opts = {}) {
    let budget = effectiveBudget(budgetTokens, opts);
    const baseSanitized = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs(messages)));
    // No-op fast path: if the original sanitized transcript already fits and we
    // are not forced, return it UNCHANGED (no preserved-tail redaction applied)
    // to keep prior no-compaction semantics.
    if (estimateMessagesTokens(baseSanitized) <= budget && opts.force !== true) {
        return { messages: baseSanitized, recallFastTrack: false };
    }
    // Compaction will proceed: redact sensitive tool-call argument VALUES up
    // front so the preserved tail seen by selectRecallTailUserMessages
    // (cap/truncation decisions) and the final emitted messages are the SAME
    // redacted data. Redaction is shape-preserving, so tool-pair structure
    // stays provider-valid.
    const sanitized = redactToolCallSecretsInMessages(baseSanitized);

    const selected = selectCompactionWindow(sanitized, budget, opts);
    // Recall fast-track (type 2). The chunked recall text carries the older
    // history; the preserved tail keeps the most recent STRUCTURED turns
    // verbatim (user + assistant/tool/system/developer that follow), so recent
    // assistant reasoning, tool_calls, and tool_results are not dropped.
    // Result shape: system rules → structured chunk summary → recent turns.
    // Because the chunk is the history anchor, an empty head is fine as long as
    // we have recall text to emit.
    //
    // Tail policy: keep the most recent RECALL_TAIL_USER_MAX (2) turns. If they
    // exceed RECALL_TAIL_TOKEN_CAP (8k), drop whole oldest turns then
    // middle-truncate the oldest surviving messages so the set fits the cap.
    // selected.system / selected.tail already carry redacted tool-call args
    // (sanitized was redacted before window selection), so tail selection and
    // the emitted result both operate on the redacted preserved tail.
    const safeSystem = selected.system;
    const recallTail = selectRecallTailUserMessages(selected.tail);
    if (selected.head.length === 0 && !selected.previousSummary
        && !(String(opts.recallText || '').trim() || opts.allowEmptyRecall === true)) {
        throw new Error('recallFastTrackCompactMessages: no compactable prior history before preserved tail');
    }

    const mandatory = reconcileDedupStubs(dedupToolResultBodies(sanitizeToolPairs([...safeSystem, ...recallTail])));
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

    let result = sanitizeToolPairs([...safeSystem, summaryMessage, ...recallTail]);
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
