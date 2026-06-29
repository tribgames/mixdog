import { isOffloadedToolResultText } from './tool-result-offload.mjs';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Conservative, Unicode-aware token estimator.
//
// This is a SAFETY estimator, NOT exact tokenizer parity. We cannot run the
// provider's real BPE tokenizer here (no network, no bundled vocab), so the
// goal is to never UNDERcount: a transcript the estimator says "fits" must
// genuinely fit the model context once compaction has run. The legacy chars/4
// heuristic badly undercounts Korean/CJK/kana/emoji and dense JSON/tool-call
// payloads (which BPE often splits into >=1 token per character or per byte),
// so a "fits" verdict was optimistic exactly where it mattered most.
//
// Strategy: weight each code point by how expensive it tends to be under a
// modern BPE tokenizer (cl100k/o200k-class), then take the MAX of that weighted
// sum and the chars/4 ASCII lower bound, then apply a small safety multiplier.
// Weights deliberately lean high (overcount) for CJK/Hangul/emoji.
//
// MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER (default 1.1, clamped 1.0..2.0) lets
// operators dial extra headroom without code changes.
function readSafetyMultiplier() {
    const raw = Number(process.env.MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
    if (Number.isFinite(raw)) return Math.min(2.0, Math.max(1.0, raw));
    return 1.1;
}
const TOKEN_ESTIMATE_SAFETY_MULTIPLIER = readSafetyMultiplier();

// Per-code-point token-cost weight. Tuned to overcount, not match exactly.
function codePointTokenWeight(cp) {
    // ASCII (latin letters, digits, punctuation, whitespace, control): the one
    // region where chars/4 is roughly right — keep the cheap 0.25/char cost.
    if (cp < 0x80) return 0.25;
    // Hangul syllables + Jamo + compatibility Jamo. Korean is the worst case
    // for chars/4: a single syllable frequently costs 1.5–3 BPE tokens, and
    // rarer syllables fall back to multi-byte splits. Weight high for safety.
    if (cp >= 0xAC00 && cp <= 0xD7A3) return 1.5;
    if (cp >= 0x1100 && cp <= 0x11FF) return 1.5;
    if (cp >= 0x3130 && cp <= 0x318F) return 1.5;
    if (cp >= 0xA960 && cp <= 0xA97F) return 1.5;
    if (cp >= 0xD7B0 && cp <= 0xD7FF) return 1.5;
    // Hiragana / Katakana / Katakana phonetic extensions.
    if (cp >= 0x3040 && cp <= 0x30FF) return 1.2;
    if (cp >= 0x31F0 && cp <= 0x31FF) return 1.2;
    // CJK unified ideographs (incl. Ext A) + compatibility ideographs.
    if (cp >= 0x3400 && cp <= 0x4DBF) return 1.2;
    if (cp >= 0x4E00 && cp <= 0x9FFF) return 1.2;
    if (cp >= 0xF900 && cp <= 0xFAFF) return 1.2;
    // CJK Extension B and beyond (supplementary ideographic plane).
    if (cp >= 0x20000 && cp <= 0x2FA1F) return 1.2;
    // Emoji / pictographs / dingbats / symbols — these explode under BPE
    // (surrogate pairs, ZWJ sequences, variation selectors), so weight highest.
    if (cp >= 0x2600 && cp <= 0x27BF) return 2.0;
    if (cp >= 0x1F000 && cp <= 0x1FAFF) return 2.0;
    if (cp >= 0x2190 && cp <= 0x21FF) return 1.5; // arrows
    if (cp >= 0x2300 && cp <= 0x23FF) return 1.5; // technical symbols
    // Latin-1 supplement / extended latin / IPA — pricier than ASCII (often a
    // token per accented char) but cheaper than CJK.
    if (cp < 0x0400) return 0.6;
    // Everything else non-ASCII (Cyrillic, Greek, Arabic, Hebrew, Thai, …):
    // multi-byte UTF-8, typically ~0.5–1 token/char. Stay conservative.
    return 0.8;
}

// Conservative Unicode-aware token estimate. Iterates by code point (so
// surrogate-pair emoji are scored once, at the high emoji weight), takes the
// max of the weighted sum and the chars/4 ASCII floor, then applies the safety
// multiplier. Always overcounts relative to chars/4 for non-ASCII text.
function estimateTokens(text) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    let weighted = 0;
    for (const ch of s) weighted += codePointTokenWeight(ch.codePointAt(0));
    const asciiFloor = s.length / 4; // never below the legacy chars/4 lower bound
    return Math.ceil(Math.max(weighted, asciiFloor) * TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
}
function messageEstimateText(m) {
    if (!m || typeof m !== 'object') return '';
    let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        try { text += `\n${JSON.stringify(m.toolCalls)}`; }
        catch { text += `\n[${m.toolCalls.length} tool calls]`; }
    }
    if (m.role === 'tool' && m.toolCallId) text += `\n${m.toolCallId}`;
    return text;
}
function estimateMessageTokens(m) {
    return estimateTokens(messageEstimateText(m)) + 4;
}
export function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// Per-request overhead the provider injects that never appears in the
// `messages` array: function-calling preamble + system-prompt framing the
// provider wraps around the request. The chars/4 message estimate misses all
// of it, so a "fits" verdict computed from messages alone is optimistic.
const REQUEST_OVERHEAD_TOKENS = 512;

/**
 * Estimate the token cost of the tool/function schemas a provider appends to
 * the request body. These are NOT part of `messages` (they're a separate
 * argument to provider.send), so estimateMessagesTokens() ignores them
 * entirely — a transcript that "fits" by message tokens can still overflow
 * once N tool schemas are serialized into the same request. Best-effort
 * chars/4 over the JSON-serialized definitions.
 */
export function estimateToolSchemaTokens(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return 0;
    let text = '';
    try { text = JSON.stringify(tools); }
    catch { text = tools.map(t => String(t?.name ?? '')).join(''); }
    return estimateTokens(text);
}

/**
 * Total headroom the caller should reserve out of the context window before
 * compaction: tool-schema bytes + fixed request framing overhead. Pass this as
 * `opts.reserveTokens` so semantic/recall compaction budgets account for
 * request-side bytes the message estimate cannot see.
 */
export function estimateRequestReserveTokens(tools) {
    return estimateToolSchemaTokens(tools) + REQUEST_OVERHEAD_TOKENS;
}

/**
 * Live/current context numerator SSOT: transcript estimate + request reserve.
 * Provider-reported usage is excluded (secondary metadata only).
 * Empty / no-activity transcript returns 0 so fresh sessions do not show
 * reserve-only phantom usage.
 *
 * @param {unknown[]} messages
 * @param {unknown[]|number} toolsOrReserve tool list or precomputed reserve tokens
 * @param {{ messageCount?: number }} [opts]
 */
export function estimateTranscriptContextUsage(messages, toolsOrReserve, opts = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const count = Number.isFinite(Number(opts.messageCount)) ? Number(opts.messageCount) : list.length;
    if (count <= 0 || list.length === 0) return 0;
    const messageTokens = estimateMessagesTokens(list);
    const reserve = typeof toolsOrReserve === 'number' && Number.isFinite(toolsOrReserve)
        ? Math.max(0, toolsOrReserve)
        : estimateRequestReserveTokens(toolsOrReserve);
    return messageTokens + reserve;
}

const TOOL_MISSING_STUB = '[Older tool result unavailable after context compaction]';
function collectAssistantToolCallIds(message) {
    if (!message || message.role !== 'assistant') return [];
    const ids = [];
    const seen = new Set();
    const add = (id) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    if (Array.isArray(message.toolCalls)) {
        for (const tc of message.toolCalls) add(tc?.id);
    }
    const blocksFrom = (blocks) => {
        if (!Array.isArray(blocks)) return;
        for (const b of blocks) {
            if (b?.type === 'tool_use' && b.id) add(b.id);
        }
    };
    blocksFrom(message.assistantBlocks);
    blocksFrom(message.content);
    return ids;
}
/**
 * Tool-pair sanitization (unmatched tool_use / tool_result repair):
 *   - Drop malformed `tool` messages without toolCallId.
 *   - Drop `tool` messages whose toolCallId has no surviving assistant tool_call.
 *   - For each surviving assistant tool_call, reattach the matching `tool`
 *     message (if any) immediately after that assistant; duplicate ids prefer
 *     the contiguous post-assistant block, then later matches, then earlier.
 *   - For tool_calls with no matching result, insert a stub tool message so
 *     the provider doesn't reject the request for unmatched tool_use_id.
 * Non-tool message order is preserved; tool results are not duplicated.
 */
export function sanitizeToolPairs(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const assistantCallIds = new Set();
    for (const m of messages) {
        for (const id of collectAssistantToolCallIds(m)) assistantCallIds.add(id);
    }
    const pickToolResultForAssistant = (assistantIdx, toolCallId) => {
        let i = assistantIdx + 1;
        while (i < messages.length && messages[i]?.role === 'tool') {
            const tm = messages[i];
            if (tm.toolCallId === toolCallId) return tm;
            i += 1;
        }
        let afterBlock = assistantIdx + 1;
        while (afterBlock < messages.length && messages[afterBlock]?.role === 'tool') afterBlock += 1;
        for (let j = afterBlock; j < messages.length; j += 1) {
            const tm = messages[j];
            if (tm?.role === 'tool' && tm.toolCallId === toolCallId) return tm;
        }
        for (let j = 0; j < assistantIdx; j += 1) {
            const tm = messages[j];
            if (tm?.role === 'tool' && tm.toolCallId === toolCallId) return tm;
        }
        return null;
    };
    const placedToolIds = new Set();
    const result = [];
    for (let idx = 0; idx < messages.length; idx += 1) {
        const m = messages[idx];
        if (m.role === 'tool') {
            if (!m.toolCallId) continue;
            if (!assistantCallIds.has(m.toolCallId)) continue;
            if (placedToolIds.has(m.toolCallId)) continue;
            continue;
        }
        result.push(m);
        if (m.role !== 'assistant') continue;
        const callIds = collectAssistantToolCallIds(m);
        if (callIds.length === 0) continue;
        for (const callId of callIds) {
            if (placedToolIds.has(callId)) continue;
            const existing = pickToolResultForAssistant(idx, callId);
            if (existing) {
                result.push(existing);
                placedToolIds.add(callId);
                continue;
            }
            result.push({
                role: 'tool',
                content: TOOL_MISSING_STUB,
                toolCallId: callId,
            });
            placedToolIds.add(callId);
        }
    }
    return result;
}

// Minimum body size to consider for hash-based dedup. Small results are
// cheap to re-deliver and short strings often collide on trivial content
// like "ok" or "done", so deduplicate only non-trivial bodies.
const DEDUP_MIN_BYTES = 512;

/**
 * Replace duplicate tool-result bodies (2nd+ occurrence of the same content
 * hash) with a compact reference stub. Hash-based dedup avoids re-delivering
 * large identical results (e.g. the same grep output called twice) while
 * keeping the first occurrence intact so the model still has the body.
 *
 * Skip conditions (structural — not heuristic prefix sniffing):
 *   - m.toolKind !== 'normal' (and defined): cache-hit / error / ref messages
 *     carry a structured kind annotation set by loop.mjs; skip them.
 *   - No toolKind (undefined): legacy or intra-turn-dedup stubs — apply dedup
 *     (backward compatible; the dedup body IS the meaningful result).
 *   - content.length < DEDUP_MIN_BYTES: structural cost optimization.
 *   - isOffloadedToolResultText(content): body is on disk, not inline.
 */
export function dedupToolResultBodies(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const seenHash = new Map(); // hash -> first toolCallId
    return messages.map((m) => {
        if (m?.role !== 'tool' || typeof m.content !== 'string') return m;
        const content = m.content;
        if (content.length < DEDUP_MIN_BYTES) return m;
        if (isOffloadedToolResultText(content)) return m;
        // Structural kind-based skip: non-normal kinds are already stubs/refs —
        // deduping them would nest stubs inside stubs and confuse the model.
        if (m.toolKind !== undefined && m.toolKind !== 'normal') return m;
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
        const first = seenHash.get(hash);
        if (!first) {
            seenHash.set(hash, m.toolCallId || '?');
            return m;
        }
        const stub = `[duplicate-of tool_use_id=${first}] body identical to result of ${first} (sha256 prefix matches; ${content.length} bytes elided).`;
        return { ...m, content: stub };
    });
}

// Match the head of dedupToolResultBodies' stub body so we can detect whether
// the referenced first-occurrence tool_use_id is still present after later
// drop passes (safety loop, sanitize). Any stub pointing at an id no longer
// in the message stream is reconciled back to TOOL_MISSING_STUB so the model
// never sees `[duplicate-of call_X]` with no call_X.
const DEDUP_STUB_HEAD_RE = /^\[duplicate-of tool_use_id=([^\]]+)\]/;
export function reconcileDedupStubs(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const presentIds = new Set();
    for (const m of messages) {
        if (m?.role === 'tool' && m.toolCallId) presentIds.add(m.toolCallId);
    }
    return messages.map((m) => {
        if (m?.role !== 'tool' || typeof m.content !== 'string') return m;
        const match = DEDUP_STUB_HEAD_RE.exec(m.content);
        if (!match) return m;
        if (presentIds.has(match[1])) return m;
        return { ...m, content: TOOL_MISSING_STUB };
    });
}

/**
 * Final-mile pairing for Anthropic API content arrays. Operates on the
 * already-converted format (role: assistant|user|system, content: block[])
 * — the mixdog-internal sanitizeToolPairs only sees toolCalls/toolCallId
 * fields and misses cases where tool_use blocks were pushed directly into
 * content (streaming chunk inserts, salvage paths, etc.). Without this
 * pass, an unmatched tool_use can reach the provider and trigger
 * `messages.N: tool_use ids were found without tool_result blocks
 * immediately after`.
 */
export function sanitizeAnthropicContentPairs(messages) {
    if (!Array.isArray(messages)) return messages;
    const work = messages.slice();
    const out = [];
    let pendingToolUseIds = new Set();
    const stripOrphanToolResults = (userMsg, allowedIds) => {
        if (userMsg?.role !== 'user' || !Array.isArray(userMsg.content)) return userMsg;
        const hasToolResults = userMsg.content.some((b) => b?.type === 'tool_result');
        if (!hasToolResults) return userMsg;
        const filtered = userMsg.content.filter((b) => {
            if (b?.type !== 'tool_result') return true;
            if (!b.tool_use_id) return false;
            return allowedIds.size > 0 && allowedIds.has(b.tool_use_id);
        });
        if (filtered.length === userMsg.content.length) return userMsg;
        return { ...userMsg, content: filtered };
    };
    for (let i = 0; i < work.length; i++) {
        let m = work[i];
        if (m?.role === 'user' && Array.isArray(m.content)) {
            const hadToolResults = m.content.some((b) => b?.type === 'tool_result');
            m = stripOrphanToolResults(m, pendingToolUseIds);
            work[i] = m;
            if (hadToolResults) pendingToolUseIds = new Set();
        }
        // Drop tool_use blocks without an id from assistant messages — these
        // come from partial streaming chunks that never finalised, and the
        // provider rejects them as `tool_use ids were found without
        // tool_result blocks` even though no id was actually emitted.
        if (m?.role === 'assistant' && Array.isArray(m.content)) {
            const cleaned = m.content.filter(
                (b) => !(b?.type === 'tool_use' && !b.id),
            );
            if (cleaned.length !== m.content.length) {
                m = { ...m, content: cleaned };
                work[i] = m;
            }
        }
        if (m?.role === 'user' && Array.isArray(m.content) && m.content.length === 0) continue;
        out.push(m);
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const toolUseIds = m.content
            .filter((b) => b?.type === 'tool_use' && b.id)
            .map((b) => b.id);
        if (toolUseIds.length === 0) {
            pendingToolUseIds = new Set();
            continue;
        }
        pendingToolUseIds = new Set(toolUseIds);
        let next = work[i + 1];
        if (next?.role === 'user' && Array.isArray(next.content)) {
            next = stripOrphanToolResults(next, pendingToolUseIds);
            work[i + 1] = next;
        }
        const nextResultIds = (next?.role === 'user' && Array.isArray(next.content))
            ? new Set(
                next.content
                    .filter((b) => b?.type === 'tool_result' && b.tool_use_id)
                    .map((b) => b.tool_use_id),
            )
            : new Set();
        const missing = toolUseIds.filter((id) => !nextResultIds.has(id));
        const stubs = missing.map((id) => ({
            type: 'tool_result',
            tool_use_id: id,
            content: '[tool_result missing — recovered by sanitizeAnthropicContentPairs]',
            is_error: true,
        }));
        if (next?.role === 'user' && Array.isArray(next.content)) {
            // Anthropic requires tool_result blocks to lead the user message
            // when responding to a prior tool_use. Reorder even when no stub
            // was needed; a matching tool_result after text still triggers the
            // same `tool_use ids ... without tool_result blocks immediately
            // after` rejection.
            const existingResults = next.content.filter((b) => b?.type === 'tool_result');
            const nonResults = next.content.filter((b) => b?.type !== 'tool_result');
            const reordered = [...stubs, ...existingResults, ...nonResults];
            const changed = missing.length > 0 || reordered.some((b, idx) => b !== next.content[idx]);
            if (changed) work[i + 1] = { ...next, content: reordered };
        } else {
            if (missing.length === 0) continue;
            out.push({ role: 'user', content: stubs });
        }
    }
    return out;
}
