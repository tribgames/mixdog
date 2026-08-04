/**
 * Authoritative top-level lifecycle read (`id` / `closed` / `generation`) for
 * a serialized session JSON document.
 *
 * ONE verdict, no fallbacks. Every caller of this module makes a destructive
 * or ownership-deciding choice (drop a save, delete a file, close a session,
 * deliver cross-process input), so the module answers with exactly two
 * outcomes:
 *
 *   • a lifecycle record — the document is a single, complete, well-formed
 *     JSON object whose top-level lifecycle fields are unambiguous;
 *   • LIFECYCLE_SCAN_CONFLICT — "unreadable": ANY doubt at all.
 *
 * There is deliberately no third "couldn't tell, parse it yourself" state.
 * The previous incarnation was a hand-rolled depth-1 tokenizer that returned
 * `null` for everything it did not positively confirm and let each caller
 * fall back to `JSON.parse` — which silently resolves duplicate keys
 * LAST-WINS, so a record like `{"id":"mine",…,"id":"other"}` (or a malformed
 * separator the scanner refused) was accepted as this session's own state by
 * the very code paths the scanner existed to protect. The fallback WAS the
 * vulnerability. It is gone.
 *
 * Strategy (simplification over more parser patches):
 *   1. strict full `JSON.parse` — the only validator. It rejects truncation,
 *      missing/trailing commas, missing colons, trailing garbage after the
 *      root object, and any non-object root, with no bespoke grammar of ours
 *      to get subtly wrong;
 *   2. an explicit top-level duplicate-key walk, because `JSON.parse` alone
 *      is last-wins and cannot report that a key appeared twice. ANY repeated
 *      top-level key is a conflict — not just the lifecycle three: consumers
 *      of this record RESERIALIZE it (the tombstone/detach barriers rewrite
 *      the whole document) and ACT on other top-level fields (`status`,
 *      `updatedAt`, `owner`, `messages` drive sweep maturity, blank-scratch
 *      reaping and transcript reads), so a last-wins `status`/`updatedAt`
 *      would silently decide a delete or a rewrite. The walk runs on a
 *      document ALREADY proven well-formed by step 1, so it only counts
 *      depth-1 keys (skipping nested objects/arrays/strings by bracket
 *      depth) and never has to double as a validator;
 *   3. type validation of the three lifecycle fields. Our writer only ever
 *      emits a non-empty string `id`, a boolean `closed` and a numeric
 *      `generation`; anything else present under those names is not a record
 *      we can speak for → unreadable.
 *
 * Duplicate detection is type- and order-independent by construction: the
 * walk counts key OCCURRENCES before any value is interpreted, so
 * `{"id":7,"id":"sess_a"}` (non-string first) and `{"closed":false,
 * "closed":true}` conflict exactly like the string-first case.
 *
 * NESTED duplicates stay compatible on purpose: a duplicate key inside
 * `messages[i].content` (a pasted JSON blob, a tool result) is message DATA.
 * It is skipped by bracket depth, is never an ownership or action input, and
 * the whole nested value is reserialized verbatim by JSON.stringify from the
 * parsed document — the last-wins resolution there cannot move a lifecycle,
 * sweep or delete decision.
 *
 * The parsed document is returned alongside the lifecycle fields (`doc`) so
 * consumers that need the whole record (the sweep reads owner/status/
 * timestamps/messages) reuse THIS parse instead of parsing again — a second
 * parse would be both slower and a second, divergent authority.
 */

// Single authoritative rejection marker: ambiguous OR malformed OR
// wrong-typed. Frozen and deliberately carrying no `id`/`closed`/`generation`
// so a lenient consumer that forgets the check still reads nothing usable.
export const LIFECYCLE_SCAN_CONFLICT = Object.freeze({ conflict: 'unreadable' });

/** True for the rejection marker (and for anything that isn't a record). */
export function isLifecycleUnreadable(result) {
    return !result || typeof result !== 'object' || result.conflict !== undefined;
}

function isWs(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

// Advances past a JSON string literal starting at raw[i] === '"'.
// Escape handling only needs to skip exactly one char after each `\` — even
// for `\u0041`-style escapes the trailing hex digits can never be `"` or `\`,
// so a naive 2-char skip never misses the real closing quote.
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

// Advances past one JSON value. Objects/arrays are skipped by string-aware
// bracket-depth counting — never descended into, never allocated.
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

/**
 * True when EVERY depth-1 key occurs exactly once.
 *
 * PRECONDITION: `raw` already parsed cleanly as a JSON object (see
 * readTopLevelLifecycleRecord). That is what lets this be a counter rather
 * than a validator: separator/grammar correctness was already decided by
 * JSON.parse. Returns false on ANY repeated top-level key, or when the walk
 * cannot complete (which cannot happen for a well-formed document — treated
 * as unreadable rather than assumed unique).
 */
function hasUniqueTopLevelKeys(raw) {
    // A Set (not an object) so a document key named `constructor`/`__proto__`
    // is counted as data, never as an inherited property.
    const seen = new Set();
    const len = raw.length;
    let i = 0;
    while (i < len && isWs(raw[i])) i++;
    if (raw[i] !== '{') return false;
    i++;
    while (i < len) {
        while (i < len && isWs(raw[i])) i++;
        if (i >= len) return false;
        if (raw[i] === '}') return true;
        if (raw[i] === ',') { i++; continue; }
        if (raw[i] !== '"') return false;
        const keyStart = i;
        i = skipString(raw, i);
        let key;
        try { key = JSON.parse(raw.slice(keyStart, i)); } catch { return false; }
        while (i < len && isWs(raw[i])) i++;
        if (raw[i] !== ':') return false;
        i++;
        while (i < len && isWs(raw[i])) i++;
        if (i >= len) return false;
        // Recorded BEFORE the value is looked at, so a duplicate is detected
        // regardless of the value types or which copy comes first.
        if (seen.has(key)) return false;
        seen.add(key);
        i = skipValue(raw, i);
    }
    return false;
}

/**
 * Read `raw` as a session record.
 * Returns LIFECYCLE_SCAN_CONFLICT (unreadable) or
 * `{ doc, id, closed, generation }` where each lifecycle field is `undefined`
 * when the document simply does not carry it (legacy records predate them).
 */
export function readTopLevelLifecycleRecord(raw) {
    if (typeof raw !== 'string') return LIFECYCLE_SCAN_CONFLICT;
    let doc;
    // Strict and complete: trailing bytes, truncation, missing/trailing
    // commas and every other separator fault are rejected here.
    try { doc = JSON.parse(raw); } catch { return LIFECYCLE_SCAN_CONFLICT; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return LIFECYCLE_SCAN_CONFLICT;
    // JSON.parse is last-wins for duplicate keys; this is where that is caught
    // — for EVERY top-level key, since consumers reserialize and act on the
    // whole record, not only on the lifecycle three.
    if (!hasUniqueTopLevelKeys(raw)) return LIFECYCLE_SCAN_CONFLICT;
    const has = (key) => Object.prototype.hasOwnProperty.call(doc, key);
    const record = { doc, id: undefined, closed: undefined, generation: undefined };
    if (has('id')) {
        // Identity we cannot positively confirm is worse than no identity: a
        // consumer must not read an empty/non-string id as "probably ours".
        if (typeof doc.id !== 'string' || !doc.id) return LIFECYCLE_SCAN_CONFLICT;
        record.id = doc.id;
    }
    if (has('closed')) {
        if (typeof doc.closed !== 'boolean') return LIFECYCLE_SCAN_CONFLICT;
        record.closed = doc.closed;
    }
    if (has('generation')) {
        if (typeof doc.generation !== 'number' || !Number.isFinite(doc.generation)) return LIFECYCLE_SCAN_CONFLICT;
        record.generation = doc.generation;
    }
    return record;
}

/**
 * Lifecycle fields only (no parsed document) for callers that consult nothing
 * else. Same two outcomes: the fields present at top level, or
 * LIFECYCLE_SCAN_CONFLICT.
 */
export function scanTopLevelLifecycle(raw) {
    const record = readTopLevelLifecycleRecord(raw);
    if (isLifecycleUnreadable(record)) return LIFECYCLE_SCAN_CONFLICT;
    const out = {};
    if (record.id !== undefined) out.id = record.id;
    if (record.closed !== undefined) out.closed = record.closed;
    if (record.generation !== undefined) out.generation = record.generation;
    return out;
}
