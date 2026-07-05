/**
 * Cheap, bounded top-level-only scan for the `closed`/`generation`
 * lifecycle fields in a serialized session JSON document — a substitute
 * for JSON.parse on the session-store save-guard hot path.
 *
 * Why not JSON.parse: `generation` is a top-level field on every persisted
 * session (added by _ensureLifecycleFields on first save), so a raw
 * substring pre-check (`raw.includes('"generation"')`) is true for nearly
 * every guarded write — paying full-parse-and-allocate cost (building the
 * entire messages array, unescaping every string) on the hot path even
 * though only two scalar fields are ever consulted.
 *
 * Why not a regex-only check: a stored message body can itself contain the
 * literal text `{"closed":true}` (a tool result, a pasted JSON blob, an
 * assistant-authored snippet) inside `messages[i].content`. A substring or
 * naively-anchored regex cannot tell that occurrence apart from the real
 * top-level lifecycle field, so it is spoofable. This scanner walks the raw
 * text as a real (bracket-depth + string-escape aware) tokenizer, but only
 * *interprets* key/value pairs at depth 1 (directly inside the root
 * object); every nested object/array/string value — including the entire
 * `messages` array — is skipped by depth counting alone, never allocated
 * or parsed. That keeps it both spoof-proof (nested `"closed"` can never be
 * mistaken for the top-level one) and cheap (no JS object/array/string
 * allocation for content we don't care about).
 *
 * Returns `{ closed, generation }` (either key absent if the field wasn't
 * present at depth 1) or `null` if `raw` is not a well-formed top-level
 * JSON object (caller should treat that the same as a parse failure).
 *
 * Scope contract: this is not a general JSON validator. `raw` is always our
 * own JSON.stringify output (or truncated/concatenated fragments thereof
 * from partial writes) — never hand-authored or third-party JSON. It is
 * only responsible for detecting the failure modes a writer like ours can
 * actually produce: mid-write truncation, nested-field spoofing, mismatched
 * brackets, and trailing garbage from a botched/partial write. It does NOT
 * validate separator-level well-formedness (missing/trailing commas,
 * missing colons beyond the one check above, etc.) since JSON.stringify
 * cannot emit those — a well-formed prefix is assumed between structural
 * checks. Anything the scanner doesn't positively confirm returns `null`,
 * and the caller falls back to `JSON.parse` for the definitive answer.
 */

function isWs(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

// True iff raw[i..] is nothing but whitespace to EOF. Enforces the "single
// complete root JSON object" contract: trailing garbage after the root `}`
// (e.g. a concatenated second document, or corruption) must not be silently
// accepted as if `raw` were exactly one well-formed object.
function isTrailingWhitespaceOnly(raw, i) {
    const len = raw.length;
    while (i < len) {
        if (!isWs(raw[i])) return false;
        i++;
    }
    return true;
}

// Advances past a JSON string literal starting at raw[i] === '"'.
// Escape handling only needs to skip exactly one char after each `\` —
// even for `\u0041`-style escapes, the trailing hex digits can never be
// `"` or `\`, so a naive 2-char skip never misses the real closing quote.
function skipString(raw, i) {
    const len = raw.length;
    i++; // opening quote
    while (i < len) {
        const ch = raw[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') return i + 1;
        i++;
    }
    return i;
}

// Advances past one JSON value (string/object/array/number/true/false/null)
// starting at raw[i]. Objects/arrays are skipped via universal bracket-depth
// counting (any `{`/`[` opens, any `}`/`]` closes) with string-awareness so
// braces inside string content never perturb the count — never descends
// into the structure to interpret its keys.
function skipValue(raw, i) {
    const len = raw.length;
    const c = raw[i];
    if (c === '"') return skipString(raw, i);
    if (c === '{' || c === '[') {
        let depth = 1;
        i++;
        while (i < len && depth > 0) {
            const ch = raw[i];
            if (ch === '"') { i = skipString(raw, i); continue; }
            if (ch === '{' || ch === '[') depth++;
            else if (ch === '}' || ch === ']') depth--;
            i++;
        }
        return i;
    }
    // number / true / false / null — run to the next structural delimiter.
    while (i < len && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']' && !isWs(raw[i])) i++;
    return i;
}

export function scanTopLevelLifecycle(raw) {
    const len = raw.length;
    let i = 0;
    while (i < len && isWs(raw[i])) i++;
    if (raw[i] !== '{') return null;
    i++;
    const result = {};
    let found = 0;
    while (i < len) {
        while (i < len && isWs(raw[i])) i++;
        if (i >= len) return null;
        if (raw[i] === '}') {
            i++;
            return isTrailingWhitespaceOnly(raw, i) ? result : null;
        }
        if (raw[i] === ',') { i++; continue; }
        if (raw[i] !== '"') return null;
        const keyStart = i;
        i = skipString(raw, i);
        let key;
        try { key = JSON.parse(raw.slice(keyStart, i)); } catch { return null; }
        while (i < len && isWs(raw[i])) i++;
        if (raw[i] !== ':') return null;
        i++;
        while (i < len && isWs(raw[i])) i++;
        if (i >= len) return null;
        if (key === 'closed' || key === 'generation') {
            const valStart = i;
            i = skipValue(raw, i);
            try { result[key] = JSON.parse(raw.slice(valStart, i)); } catch { return null; }
            found++;
            // Both lifecycle fields resolved. We no longer need to interpret
            // further keys, but we MUST still confirm the root object is not
            // truncated (e.g. a session file cut off mid-write as
            // `{"closed":true,"generation":1,"messages":[`) before trusting
            // `result` — otherwise a truncated-but-field-bearing prefix would
            // be treated as well-formed. Finish with a cheap depth-only walk
            // (no key/value JSON.parse) to the matching close of the root
            // object; only return `result` once that close is actually
            // reached before EOF.
            if (found === 2) {
                // Track exact bracket types (not just depth) so a mismatched
                // pair anywhere — including the root itself, e.g. malformed
                // `{"closed":true,"generation":1]` closing the root object
                // with `]` instead of `}` — is rejected rather than silently
                // accepted because *a* bracket happened to bring the count to
                // zero. `stack[0]` is always '}' (the root object we opened
                // at function entry); the walk must consume exactly that to
                // finish, and any closer that doesn't match the innermost
                // opener is a structural error.
                const stack = ['}'];
                while (i < len) {
                    const ch = raw[i];
                    if (ch === '"') { i = skipString(raw, i); continue; }
                    if (ch === '{') { stack.push('}'); i++; continue; }
                    if (ch === '[') { stack.push(']'); i++; continue; }
                    if (ch === '}' || ch === ']') {
                        if (stack.pop() !== ch) return null; // mismatched bracket pair
                        i++;
                        if (stack.length === 0) {
                            // Root object closed with '}' — only trust it if
                            // nothing but whitespace follows to EOF.
                            return isTrailingWhitespaceOnly(raw, i) ? result : null;
                        }
                        continue;
                    }
                    i++;
                }
                return null; // ran off the end (or hit EOF) before the root object closed: truncated
            }
        } else {
            i = skipValue(raw, i);
        }
    }
    return null; // ran off the end without a closing '}': malformed/truncated
}
