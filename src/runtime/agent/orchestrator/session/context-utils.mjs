import { isOffloadedToolResultText } from './tool-result-offload.mjs';
import { createHash } from 'node:crypto';

// Rough token estimate: ~4 chars per token
function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 4);
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
const TOOL_MISSING_STUB = '[Older tool result unavailable after context compaction]';
/**
 * Tool-pair sanitization (Hermes `_sanitize_tool_pairs`):
 *   - Drop `tool` messages whose toolCallId has no surviving assistant tool_call.
 *   - For surviving assistant tool_calls whose results are missing, insert a
 *     stub tool message so the provider doesn't reject the request for
 *     unmatched tool_use_id.
 * Messages ordering is preserved; stubs are inserted immediately after the
 * assistant message so the tool pair sits adjacent.
 */
export function sanitizeToolPairs(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const assistantCallIds = new Set();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
                if (tc && tc.id) assistantCallIds.add(tc.id);
            }
        }
    }
    const toolById = new Map();
    for (const m of messages) {
        if (m.role === 'tool' && m.toolCallId) toolById.set(m.toolCallId, m);
    }
    const filtered = messages.filter(m => {
        if (m.role !== 'tool') return true;
        if (!m.toolCallId) return true;
        return assistantCallIds.has(m.toolCallId);
    });
    const result = [];
    for (const m of filtered) {
        result.push(m);
        if (m.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (const tc of m.toolCalls) {
            if (!tc?.id) continue;
            const existing = toolById.get(tc.id);
            if (existing && filtered.includes(existing)) continue;
            const preserved = existing?.content;
            result.push({
                role: 'tool',
                content: isOffloadedToolResultText(preserved) ? preserved : TOOL_MISSING_STUB,
                toolCallId: tc.id,
            });
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
    for (let i = 0; i < work.length; i++) {
        let m = work[i];
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
        out.push(m);
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const toolUseIds = m.content
            .filter((b) => b?.type === 'tool_use' && b.id)
            .map((b) => b.id);
        if (toolUseIds.length === 0) continue;
        const next = work[i + 1];
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
