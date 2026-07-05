// Text/token/message helpers and secret redaction for compaction. Extracted
// verbatim from compact.mjs (behavior-preserving).
import { createHash } from 'node:crypto';
import { estimateMessagesTokens } from '../context-utils.mjs';

const TOOL_ARG_STRING_MAX_CHARS = 360;
const TOOL_ARG_ARRAY_MAX_ITEMS = 8;
const TOOL_ARG_MAX_DEPTH = 4;
export const TOOL_CALL_ARGS_MAX_CHARS = 260;
export const TOOL_CALL_FACT_ARGS_MAX_CHARS = 140;
export const TOOL_CALLS_MAX = 4;
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
// camelCase variants (case-SENSITIVE, deliberately not /i): a capitalized
// sensitive word CLOSING the key — `accessToken`, `authToken`, `bearerToken`,
// `sessionSecret`, `myPassword`. Bounded so plural/compound counters
// (`tokens`, `maxOutputTokens`, `budgetTokens`) do NOT match.
const SENSITIVE_TOOL_ARG_KEY_CAMEL_WORD = '(?:Api[_-]?Key|Authorization|Auth|Cookie|Credential|Passwd|Password|Refresh[_-]?Token|Secret|Token)';
const SENSITIVE_TOOL_ARG_KEY_CAMEL_RE = new RegExp(`[a-z0-9]${SENSITIVE_TOOL_ARG_KEY_CAMEL_WORD}s?$`);
function isSensitiveToolArgKey(key) {
    const k = String(key || '');
    return SENSITIVE_TOOL_ARG_KEY_RE.test(k) || SENSITIVE_TOOL_ARG_KEY_CAMEL_RE.test(k);
}
const SENSITIVE_RAW_KEY_RES = [
    new RegExp(`((?:^|[\\s,{(?&])["']?${SENSITIVE_TOOL_ARG_KEY_FULL}["']?\\s*[:=]\\s*)`, 'gi'),
    // Case-sensitive camelCase raw keys (`accessToken=...`, `myAuthToken: ...`).
    new RegExp(`((?:^|[\\s,{(?&])["']?[A-Za-z0-9_-]*[a-z0-9]${SENSITIVE_TOOL_ARG_KEY_CAMEL_WORD}["']?\\s*[:=]\\s*)`, 'g'),
];

// Redact `key: value` / `key=value` secret pairs inside a raw (non-JSON)
// string. Consumes the WHOLE value after the key — spaces, `Bearer `/`Basic `
// scheme words, quoted values with internal spaces, and `;`-separated cookie
// pairs — so no secret fragment survives. Kept local to compact-core to avoid a
// cross-module dependency on the memory lib; logic matches session-ingest's
// redactRawArgString.
export function redactRawSecretString(text) {
    let value = String(text ?? '');
    if (!value) return value;
    for (const keyRe of SENSITIVE_RAW_KEY_RES) {
        keyRe.lastIndex = 0;
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
                // Header-style `key: value` may carry scheme words and spaces
                // (`authorization: Bearer abc.def`) — consume the whole value so
                // no fragment survives. KV-style `key=value` stops at whitespace
                // so space-separated trailing keys (`token=abc fileName=x`) are
                // preserved.
                const headerStyle = /:\s*$/.test(match[0]);
                const stopRe = headerStyle ? /[,)}\n]/ : /[,)}\s]/;
                while (i < value.length && !stopRe.test(value[i])) i += 1;
            }
            out += '[redacted]';
            last = i;
            keyRe.lastIndex = i;
        }
        out += value.slice(last);
        value = out;
    }
    return value;
}

export function sha16(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function roleCounts(messages) {
    const counts = new Map();
    for (const m of messages) counts.set(m?.role || 'unknown', (counts.get(m?.role || 'unknown') || 0) + 1);
    return [...counts.entries()].map(([role, count]) => `${role}:${count}`).join(', ');
}

export function extractText(m) {
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

export function truncateMiddle(text, maxChars) {
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    if (maxChars <= 0 || value.length === 0) return '';
    if (value.length <= maxChars) return value;
    if (maxChars <= 8) return value.slice(0, maxChars);
    const head = Math.ceil((maxChars - 5) / 2);
    const tail = Math.floor((maxChars - 5) / 2);
    return `${value.slice(0, head)} … ${value.slice(value.length - tail)}`;
}

function normalizeToolArgValue(value, key = '', depth = 0) {
    if (isSensitiveToolArgKey(key)) return '[redacted]';
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

export function summarizeToolCall(tc, maxArgChars = TOOL_CALL_ARGS_MAX_CHARS) {
    const name = tc?.name || tc?.function?.name || tc?.id || '?';
    const args = toolCallArgsText(tc, maxArgChars);
    return args ? `${name}(${args})` : name;
}

export function toolCallArgBudget(perMessageChars) {
    const chars = Number(perMessageChars);
    if (!Number.isFinite(chars) || chars <= 0) return 0;
    return Math.min(TOOL_CALL_ARGS_MAX_CHARS, Math.max(32, Math.floor(chars * 0.5)));
}

export function toolCallSummary(m, maxArgChars = TOOL_CALL_ARGS_MAX_CHARS) {
    if (!Array.isArray(m?.toolCalls) || m.toolCalls.length === 0) return '';
    const calls = m.toolCalls
        .slice(0, TOOL_CALLS_MAX)
        .map(tc => summarizeToolCall(tc, maxArgChars));
    if (m.toolCalls.length > TOOL_CALLS_MAX) calls.push(`+${m.toolCalls.length - TOOL_CALLS_MAX} more`);
    return ` tool_calls=${calls.join(';')}`;
}

export function toolResultId(m) {
    return m?.role === 'tool' && m.toolCallId ? ` tool_result=${m.toolCallId}` : '';
}

export function safeEstimateMessagesTokens(messages) {
    try { return estimateMessagesTokens(messages); }
    catch { return null; }
}

export function textByteLength(text) {
    try { return Buffer.byteLength(String(text || ''), 'utf8'); }
    catch { return String(text || '').length; }
}

export function messageContentHasMarker(m, marker) {
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

// --- Verbatim redaction for messages kept through compaction ---------------

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
    if (isSensitiveToolArgKey(key)) {
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
