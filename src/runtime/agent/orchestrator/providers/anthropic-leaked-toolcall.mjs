/**
 * Leaked tool-call recovery for the shared Anthropic SSE parser.
 *
 * Opus (via OAuth) and, less often, the API model sometimes emit a tool
 * call as plain text tags inside `text_delta` (e.g. `<function_calls>`,
 * `<invoke name="...">`, `<invoke ...>`, or a stray prefix like
 * `course<invoke ...>`) instead of a native `tool_use` content block. Left
 * alone those tags stream to the TUI as assistant prose and the tool never
 * runs.
 *
 * `scanLeakedToolCalls` is the boundary-gated scanner the parser feeds its
 * rolling text window. Unlike hermes-agent's strip-only port (which only
 * DROPS the call), this recovers a real call: it suppresses the tags from
 * the visible stream AND returns a synthesizable `{ name, arguments }` when
 * the leaked payload parses to a KNOWN tool. Unknown / unparseable / prose
 * `<function>` mentions are flushed as ordinary text so no user-visible
 * content is ever lost.
 */

import { traceHash, stableTraceStringify } from './trace-utils.mjs';

// Opener strings (lowercased) used only for partial-tail hold detection —
// so a sentinel split across text_delta chunk boundaries is still caught.
const OPENERS = [
    '<function_calls',
    '<invoke',
    '<function',            // Gemma-style; name= is gated at match time
];
// OpenAI harmony / gpt-oss channel-syntax openers. Only consulted when a
// caller opts in via `{ harmony: true }` (OpenAI-family stream parsers) so the
// Anthropic path — and its regression tests — are byte-for-byte unaffected.
const HARMONY_OPENERS = [
    '<|channel|>',
    '<|start|>',
];
const LONGEST_OPENER = Math.max(
    ...OPENERS.map((o) => o.length),
    ...HARMONY_OPENERS.map((o) => o.length),
);

// First *definite* leaked-tool-call sentinel. The bare `<function` opener is
// boundary-gated to require a `name=` attribute so prose like
// "Use <function> in JavaScript" is never treated as a call.
// NOTE (Fix 3): a real leak ALWAYS carries the leading `<` bracket
// (`<invoke ...>`, `<invoke ...>`, `<function_calls>`); the model never
// emits a bare `antml:invoke` token without it. The old bare-`antml:` opener
// therefore only ever matched ordinary prose that mentions the literal string,
// and — because `matchCompleteBlockAt` has no bare form — it forced the scanner
// to HOLD from that token to end of stream. Removed: only bracketed forms are
// sentinels now, so prose containing "antml:invoke" mid-sentence streams
// promptly and is never recovered.
const SENTINEL_RE = /<(?:antml:)?function_calls\b|<(?:antml:)?invoke\b|<(?:antml:)?function\b[^>]*\bname\s*=/i;

// Harmony channel-syntax sentinel: the `<|channel|>` (optionally preceded by a
// `<|start|>` role token) that frames a gpt-oss tool call. Only whether it is a
// *tool* call is decided at block-match time (recipient `to=functions.NAME`).
const HARMONY_SENTINEL_RE = /<\|(?:channel|start)\|>/i;
// Terminator of a harmony message. A tool call ends with `<|call|>`; ordinary
// channel content ends with `<|end|>` / `<|return|>` — all three close a block
// so benign channel text flushes promptly instead of stalling to stream end.
const HARMONY_TERMINATOR_RE = /<\|call\|>|<\|end\|>|<\|return\|>/i;
const HARMONY_RECIPIENT_RE = /to=functions\.([A-Za-z0-9_.\-]+)/i;
const HARMONY_MESSAGE_RE = /<\|message\|>/i;

function firstSentinelIndex(s, harmony) {
    const m = SENTINEL_RE.exec(s);
    let idx = m ? m.index : -1;
    if (harmony) {
        const hm = HARMONY_SENTINEL_RE.exec(s);
        if (hm && (idx === -1 || hm.index < idx)) idx = hm.index;
    }
    return idx;
}

function isPrefixOfAnyOpener(tail, harmony) {
    const t = tail.toLowerCase();
    if (OPENERS.some((o) => o.startsWith(t))) return true;
    return harmony ? HARMONY_OPENERS.some((o) => o.startsWith(t)) : false;
}

// --- Markdown code-fence / inline-code tracking (Fix 1) --------------------
// A leaked tool-call tag written INSIDE a fenced code block (``` … ``` or
// ~~~ … ~~~) or an inline code span (`…`) is a documentation example, not a
// real call — it must stream as visible text, never be recovered/executed.
// Because the scanner runs on a rolling buffer, the fence state is tracked as
// a small struct threaded across chunks (a fence opened in one delta and
// closed in a later one persists). `advanceFenceState` folds a text slice into
// the state; `isInCode` reports whether a position sits inside code.
function initialFenceState() {
    return { fenceChar: null, fenceLen: 0, inlineLen: 0, atLineStart: true };
}
function isInCode(s) {
    return !!s && (s.fenceChar !== null || s.inlineLen > 0);
}
// Fold `text` into fence state and return the new state (input not mutated).
// Fenced blocks (``` / ~~~ at line start, length ≥ 3) persist across lines
// until a closing fence of the same char (length ≥ opener) at line start.
// Inline spans (backtick run not opening a fence) are line-local: reset at
// newline so a stray unmatched backtick in prose cannot poison later lines
// (which would wrongly suppress a genuine leaked call).
function advanceFenceState(state, text) {
    let { fenceChar, fenceLen, inlineLen, atLineStart } = state || initialFenceState();
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '`' || ch === '~') {
            let j = i;
            while (j < text.length && text[j] === ch) j++;
            const runLen = j - i;
            if (fenceChar) {
                if (ch === fenceChar && atLineStart && runLen >= fenceLen) {
                    fenceChar = null; fenceLen = 0;
                }
            } else if (inlineLen) {
                if (ch === '`' && runLen === inlineLen) inlineLen = 0;
            } else if (atLineStart && runLen >= 3) {
                fenceChar = ch; fenceLen = runLen;
            } else if (ch === '`') {
                inlineLen = runLen;
            }
            atLineStart = false;
            i = j;
            continue;
        }
        if (ch === '\n') {
            atLineStart = true;
            inlineLen = 0; // inline spans do not cross lines here
            i++;
            continue;
        }
        if (atLineStart && (ch === ' ' || ch === '\t')) { i++; continue; }
        atLineStart = false;
        i++;
    }
    return { fenceChar, fenceLen, inlineLen, atLineStart };
}

// Index from which the tail of `s` could be the *start* of a sentinel that
// has not fully arrived yet. Everything before it is safe to flush now;
// from it onward must be held for the next chunk. Returns s.length when
// nothing needs holding (normal text streams promptly).
function partialTailIndex(s, harmony) {
    const start = Math.max(0, s.length - LONGEST_OPENER);
    for (let i = start; i < s.length; i++) {
        if (isPrefixOfAnyOpener(s.slice(i), harmony)) return i;
    }
    return s.length;
}

// Coerce a leaked `<parameter>` value. apply_patch-style raw bodies and plain
// strings pass through verbatim; JSON-looking scalars/objects are parsed so
// the synthesized arguments match a native tool_use input shape.
function coerceValue(raw) {
    const trimmed = raw.trim();
    if (trimmed === '') return raw;
    const first = trimmed[0];
    if ('{[0123456789tfn"-'.includes(first)) {
        try { return JSON.parse(trimmed); } catch { /* fall through to raw */ }
    }
    return raw;
}

function parseParams(text) {
    const out = {};
    const re = /<(?:antml:)?parameter\b[^>]*\bname\s*=\s*["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/(?:antml:)?parameter\s*>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        out[m[1]] = coerceValue(m[2]);
    }
    return out;
}

function parseInvoke(text) {
    const nameM = /<(?:antml:)?invoke\b[^>]*\bname\s*=\s*["']?([^"'>\s]+)["']?/i.exec(text);
    if (!nameM) return null;
    return { name: nameM[1], arguments: parseParams(text) };
}

// Match a COMPLETE harmony channel block starting at `idx` (which points at a
// `<|channel|>` or `<|start|>` token). Returns `{ end, call }` where `call` is
// `{ name, arguments }` when the block is a `to=functions.NAME` tool call, or
// null when it is ordinary channel content (flushed as visible text). Returns
// null (undecided → caller holds) until a terminator token has arrived.
function matchCompleteHarmonyBlockAt(s, idx) {
    const rest = s.slice(idx);
    if (!/^<\|(?:channel|start)\|>/i.test(rest)) return null;
    const termM = HARMONY_TERMINATOR_RE.exec(rest);
    if (!termM) return null;
    const end = idx + termM.index + termM[0].length;
    const block = rest.slice(0, termM.index);
    const recM = HARMONY_RECIPIENT_RE.exec(block);
    if (!recM) return { end, call: null };
    const msgM = HARMONY_MESSAGE_RE.exec(block);
    let args = {};
    if (msgM) {
        const raw = block.slice(msgM.index + msgM[0].length).trim();
        if (raw) {
            const coerced = coerceValue(raw);
            if (coerced && typeof coerced === 'object' && !Array.isArray(coerced)) args = coerced;
        }
    }
    return { end, call: { name: recM[1], arguments: args } };
}

// Try to match a COMPLETE leaked block starting at `idx`. Returns
// `{ end, call }` where `end` is the index in `s` just past the block and
// `call` is `{ name, arguments }` (or null when the block is well-formed XML
// but carries no parseable invoke). Returns null when the block has not
// finished arriving yet (caller holds and waits for more chunks).
function matchCompleteBlockAt(s, idx, harmony) {
    const rest = s.slice(idx);

    // Harmony channel syntax (opt-in). Routed first because its opener token
    // (`<|...|>`) never collides with the XML `<function...>` families below.
    if (harmony && /^<\|(?:channel|start)\|>/i.test(rest)) {
        return matchCompleteHarmonyBlockAt(s, idx);
    }

    // <function_calls> ... </function_calls> wrapper
    const wm = /^<(?:antml:)?function_calls\b[^>]*>/i.exec(rest);
    if (wm) {
        const cm = /<\/(?:antml:)?function_calls\s*>/i.exec(rest);
        if (!cm) return null;
        const end = idx + cm.index + cm[0].length;
        const inner = rest.slice(wm[0].length, cm.index);
        return { end, call: parseInvoke(inner) };
    }

    // <invoke ...> ... </invoke>
    const im = /^<(?:antml:)?invoke\b[^>]*>/i.exec(rest);
    if (im) {
        const cm = /<\/(?:antml:)?invoke\s*>/i.exec(rest);
        if (!cm) return null;
        const blockText = rest.slice(0, cm.index + cm[0].length);
        return { end: idx + blockText.length, call: parseInvoke(blockText) };
    }

    // <function name="..."> ... </function>  (Gemma-style)
    const fm = /^<(?:antml:)?function\b[^>]*\bname\s*=\s*["']?([^"'>\s]+)["']?[^>]*>/i.exec(rest);
    if (fm) {
        const cm = /<\/(?:antml:)?function\s*>/i.exec(rest);
        if (!cm) return null;
        const end = idx + cm.index + cm[0].length;
        const inner = rest.slice(fm[0].length, cm.index);
        return { end, call: fm[1] ? { name: fm[1], arguments: parseParams(inner) } : null };
    }

    // Sentinel matched (e.g. bare `antml:invoke` with no `<`) but no complete
    // block form — leave undecided so the caller holds (or flushes on final).
    return null;
}

/**
 * Scan a rolling text window for leaked tool-call syntax.
 *
 * @param {string} buffer  Held-back text window.
 * @param {object} opts
 * @param {(name:string)=>boolean} opts.isKnownTool  Validates the recovered
 *        tool name against the tools available to this request.
 * @param {boolean} opts.final  True on stream end: flush everything, never
 *        hold (legitimate text is never lost).
 * @param {boolean} [opts.harmony]  Opt-in (OpenAI-family callers only): also
 *        recognize gpt-oss/harmony `<|channel|>...to=functions.NAME...<|call|>`
 *        tool syntax. Off by default so the Anthropic path is unaffected.
 * @param {object} [opts.fenceState]  Running markdown fence/inline-code state
 *        from the previous chunk (Fix 1). A fence opened in an earlier delta and
 *        closed in a later one is respected because `fence` reflects the state
 *        as-of the start of `buffer`. Omit for single-shot use.
 * @returns {{ emit:string, calls:Array<{name:string,arguments:object}>, rest:string, fenceState:object }}
 *          `emit` = text safe to forward now, `calls` = recovered known-tool
 *          calls to synthesize/dispatch, `rest` = text to keep buffered,
 *          `fenceState` = markdown state as-of the start of `rest` (thread it
 *          back in on the next call).
 */
export function scanLeakedToolCalls(buffer, { isKnownTool, final, harmony = false, fenceState = null }) {
    let emit = '';
    const calls = [];
    const buf = buffer;
    let pos = 0;
    // Fix 1: fence state advances over EVERY consumed character in raw order,
    // so `isInCode` at a sentinel reflects the running markdown context —
    // including a fence opened in an earlier chunk (caller threads fenceState).
    let fence = fenceState || initialFenceState();
    const consume = (to, asText) => {
        fence = advanceFenceState(fence, buf.slice(pos, to));
        if (asText) emit += buf.slice(pos, to);
        pos = to;
    };

    while (pos < buf.length) {
        const rel = firstSentinelIndex(buf.slice(pos), harmony);
        if (rel === -1) {
            if (final) { consume(buf.length, true); }
            else {
                const hold = partialTailIndex(buf.slice(pos), harmony);
                consume(pos + hold, true);
            }
            break;
        }
        const idx = pos + rel;
        // Plain text before the sentinel always streams as visible text.
        consume(idx, true);
        const inCode = isInCode(fence);
        const block = matchCompleteBlockAt(buf, idx, harmony);
        if (!block) {
            // Opener present but block not fully arrived.
            if (final) { consume(buf.length, true); break; }
            if (inCode) {
                // Inside a code fence / inline span: this can never become a
                // real recovered call — emit the opener char and keep scanning
                // instead of holding it (and the rest of the doc) to stream end.
                consume(idx + 1, true);
                continue;
            }
            // Outside code: hold from the opener for the next chunk.
            break;
        }
        const { end, call } = block;
        if (!inCode && call && call.name && isKnownTool(call.name)) {
            // Recovered a real, known tool call OUTSIDE any code fence:
            // suppress the tags from the visible stream and synthesize it.
            consume(end, false);
            calls.push({ name: call.name, arguments: call.arguments || {} });
            continue;
        }
        // In code, unknown tool, or no parseable invoke: keep the block as
        // ordinary visible text and continue scanning past it.
        consume(end, true);
    }

    return { emit, calls, rest: buf.slice(pos), fenceState: fence };
}

/**
 * Stateful convenience wrapper around `scanLeakedToolCalls` for the streaming
 * parsers. Holds the minimal rolling text window across chunk boundaries and
 * exposes `push(delta)` / `flush()` that return the visible text safe to
 * forward now plus any recovered known-tool calls. The Anthropic parser keeps
 * its own inline wiring; this factory is shared by the OpenAI-family stream
 * parsers so each only wires provider-specific call synthesis + dispatch.
 *
 * @param {object} opts
 * @param {Set<string>|string[]} opts.knownToolNames  Tools offered this request.
 * @param {boolean} [opts.harmony]  Opt-in gpt-oss/harmony channel detection.
 * @returns {{ enabled:boolean, push:(delta:string, final?:boolean)=>{text:string,calls:Array<{name:string,arguments:object}>}, flush:()=>{text:string,calls:Array<{name:string,arguments:object}>} }}
 */
export function createLeakGuard({ knownToolNames, harmony = false } = {}) {
    const known = knownToolNames instanceof Set
        ? knownToolNames
        : new Set(Array.isArray(knownToolNames) ? knownToolNames : []);
    const enabled = known.size > 0;
    const isKnownTool = (name) => known.has(name);
    let buffer = '';
    // Running markdown fence/inline-code state threaded across chunks (Fix 1).
    let fence = initialFenceState();
    const run = (delta, final) => {
        if (!enabled) return { text: delta || '', calls: [] };
        buffer += delta || '';
        if (!buffer && !final) return { text: '', calls: [] };
        const { emit, calls, rest, fenceState } = scanLeakedToolCalls(buffer, { isKnownTool, final, harmony, fenceState: fence });
        buffer = rest;
        fence = fenceState;
        return { text: emit, calls };
    };
    return {
        enabled,
        push: (delta, final = false) => run(delta, final),
        flush: () => run('', true),
    };
}

/**
 * Shared name+args fingerprint dedupe for tool calls (Fix 2). The leak guard
 * dispatches a synthesized call the instant it is recovered from text; the
 * native tool_use / tool_calls path can later surface the SAME call. Without a
 * cross-path guard both fire and a side-effecting tool double-executes. This
 * factory holds a per-stream Set of dispatched fingerprints (name + stably
 * stringified args) — call `shouldDispatch(name, args)` before EITHER a
 * synthetic or a native dispatch: it returns false (skip) when an identical
 * fingerprint already fired. Mirrors gemini.mjs's dedupe so all providers
 * behave identically.
 */
export function toolCallFingerprint(name, args) {
    let a = args;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) a = {};
    return traceHash(stableTraceStringify({ name: name || '', args: a }));
}
export function createToolCallDedupe() {
    const seen = new Set();
    return {
        // True the first time this (name,args) fingerprint is seen; false on
        // any later identical call (synthetic-then-native or vice-versa).
        shouldDispatch(name, args) {
            const fp = toolCallFingerprint(name, args);
            if (seen.has(fp)) return false;
            seen.add(fp);
            return true;
        },
        has(name, args) { return seen.has(toolCallFingerprint(name, args)); },
    };
}

// Exposed for focused unit tests.
export const _internals = {
    firstSentinelIndex,
    partialTailIndex,
    matchCompleteBlockAt,
    parseInvoke,
};
