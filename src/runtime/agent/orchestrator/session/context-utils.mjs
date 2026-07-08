import { isOffloadedToolResultText } from './tool-result-offload.mjs';
import { createHash } from 'node:crypto';
import { isAgentOwner } from '../agent-owner.mjs';

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
export function estimateTokens(text) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    let weighted = 0;
    for (const ch of s) weighted += codePointTokenWeight(ch.codePointAt(0));
    const asciiFloor = s.length / 4; // never below the legacy chars/4 lower bound
    return Math.ceil(Math.max(weighted, asciiFloor) * TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
}
export function messageEstimateText(m) {
    if (!m || typeof m !== 'object') return '';
    let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        try { text += `\n${JSON.stringify(m.toolCalls)}`; }
        catch { text += `\n[${m.toolCalls.length} tool calls]`; }
    }
    // Anthropic adaptive-thinking blocks round-trip verbatim (thinking text +
    // signature / redacted data) and are re-sent on tool-continuation turns, so
    // they consume real input tokens. Count them or trim/compact undercounts.
    if (m.role === 'assistant' && Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length) {
        try { text += `\n${JSON.stringify(m.thinkingBlocks)}`; }
        catch { text += `\n[${m.thinkingBlocks.length} thinking blocks]`; }
    }
    if (m.role === 'tool' && m.toolCallId) text += `\n${m.toolCallId}`;
    return text;
}
export function estimateMessageTokens(m) {
    return estimateTokens(messageEstimateText(m)) + 4;
}
export function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export const DEFAULT_COMPACTION_BUFFER_TOKENS = 0;
export const DEFAULT_COMPACTION_BUFFER_RATIO = 0.1;
export const MAX_COMPACTION_BUFFER_RATIO = 0.25;
export const DEFAULT_COMPACTION_KEEP_TOKENS = 8_000;
const LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO = 0.1;

export function positiveTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function envTokenInt(name) {
    return positiveTokenInt(process.env[name]);
}

export function normalizeCompactionBufferRatio(value, fallback = DEFAULT_COMPACTION_BUFFER_RATIO) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n > 1 ? n / 100 : n;
    return fallback;
}

// Percent-named inputs (bufferPercent / bufferPct / *_BUFFER_PERCENT) carry a
// PERCENT: 1 means 1% (0.01). Ratio-named inputs (bufferRatio / bufferFraction)
// carry a fraction: 0.01 means 1%, and a legacy value > 1 is read as a percent.
export function resolveBufferRatioCandidate(percentInputs = [], ratioInputs = []) {
    for (const raw of percentInputs) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.min(1, n / 100);
    }
    for (const raw of ratioInputs) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n > 1 ? n / 100 : n;
    }
    return null;
}

export function resolveCompactBufferRatio(cfg = {}) {
    const resolved = resolveBufferRatioCandidate(
        [cfg.bufferPercent, cfg.bufferPct, process.env.MIXDOG_AGENT_COMPACT_BUFFER_PERCENT],
        [cfg.bufferRatio, cfg.bufferFraction, process.env.MIXDOG_AGENT_COMPACT_BUFFER_RATIO],
    );
    return normalizeCompactionBufferRatio(resolved, DEFAULT_COMPACTION_BUFFER_RATIO);
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

export function isPersistedZeroBufferTelemetry(cfg = {}, boundaryTokens = 0) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return false;
    if (envTokenInt('MIXDOG_AGENT_COMPACT_BUFFER_TOKENS')) return false;
    for (const envName of ['MIXDOG_AGENT_COMPACT_BUFFER_PERCENT', 'MIXDOG_AGENT_COMPACT_BUFFER_RATIO']) {
        const n = Number(process.env[envName]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    for (const key of ['bufferPercent', 'bufferPct', 'bufferFraction']) {
        const n = Number(cfg?.[key]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    const ratio = Number(cfg?.bufferRatio);
    if (Number.isFinite(ratio) && ratio > 0) return false;
    const explicitTokens = Number(cfg?.bufferTokens ?? cfg?.buffer);
    if (!Number.isFinite(explicitTokens) || explicitTokens !== 0) return false;
    return true;
}

export function isLegacyDefaultBufferTelemetry(cfg = {}, boundaryTokens = 0) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return false;
    if (envTokenInt('MIXDOG_AGENT_COMPACT_BUFFER_TOKENS')) return false;
    for (const envName of ['MIXDOG_AGENT_COMPACT_BUFFER_PERCENT', 'MIXDOG_AGENT_COMPACT_BUFFER_RATIO']) {
        const n = Number(process.env[envName]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    // Percent/fraction-named fields are operator config. Legacy/default
    // telemetry persisted bufferTokens + bufferRatio after a check/compact pass.
    for (const key of ['bufferPercent', 'bufferPct', 'bufferFraction']) {
        const n = Number(cfg?.[key]);
        if (Number.isFinite(n) && n > 0) return false;
    }
    const explicitTokens = positiveTokenInt(cfg?.bufferTokens ?? cfg?.buffer);
    const ratio = Number(cfg?.bufferRatio);
    if (!explicitTokens || !Number.isFinite(ratio) || Math.abs(ratio - LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO) > 1e-9) return false;
    const expectedTokens = Math.floor(boundary * LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO);
    const cfgBoundary = positiveTokenInt(cfg?.boundaryTokens);
    const cfgTrigger = positiveTokenInt(cfg?.triggerTokens);
    return explicitTokens === expectedTokens
        || (cfgBoundary === boundary && cfgTrigger > 0 && explicitTokens === Math.max(0, boundary - cfgTrigger));
}

export function compactBufferConfigForBoundary(cfg = {}, boundaryTokens = 0) {
    const base = cfg || {};
    if (!isLegacyDefaultBufferTelemetry(base, boundaryTokens)
        && !isPersistedZeroBufferTelemetry(base, boundaryTokens)) {
        return base;
    }
    return {
        ...base,
        bufferTokens: null,
        buffer: null,
        bufferRatio: null,
    };
}

export function resolveCompactBufferTokens(boundaryTokens, cfg = {}, opts = {}) {
    const boundary = positiveTokenInt(boundaryTokens);
    const effectiveCfg = compactBufferConfigForBoundary(cfg, boundary);
    const configured = positiveTokenInt(effectiveCfg.bufferTokens ?? effectiveCfg.buffer)
        || envTokenInt('MIXDOG_AGENT_COMPACT_BUFFER_TOKENS')
        || 0;
    if (!boundary) return configured || positiveTokenInt(opts.defaultTokens) || DEFAULT_COMPACTION_BUFFER_TOKENS;
    return compactionBufferTokensForBoundary(boundary, {
        explicitTokens: configured,
        ratio: resolveCompactBufferRatio(effectiveCfg),
        maxRatio: opts.maxRatio ?? MAX_COMPACTION_BUFFER_RATIO,
    });
}

export function resolveCompactTriggerTokens(sessionOrConfig = {}, boundaryTokens = 0) {
    return resolveSessionCompactPolicy(sessionOrConfig, boundaryTokens).triggerTokens;
}

// Single source of truth for per-session compaction policy math. Manager
// (compactTriggerForSession), the turn loop (resolveWorkerCompactPolicy), and
// the /context gauge all derive their trigger/buffer from here so the numbers
// never diverge. Rules:
//   - a truly-explicit sub-boundary auto-compact limit always wins
//     (trigger = limit) for every session type;
//   - agent-owned semantic sessions otherwise keep the default early-trigger
//     buffer (config-driven, default 10% -> compact at 90% of the boundary);
//   - main/user recall-fasttrack sessions have NO default buffer and compact on
//     the boundary itself (100%).
// Returns the sanitized explicit limit (null when absent/legacy full-window)
// plus triggerTokens / bufferTokens / bufferRatio for the given boundary.
export function resolveSessionCompactPolicy(sessionOrConfig = {}, boundaryTokens = 0) {
    const cfg = sessionOrConfig?.compaction || sessionOrConfig || {};
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) {
        return {
            autoCompactTokenLimit: null,
            triggerTokens: null,
            bufferTokens: 0,
            bufferRatio: resolveCompactBufferRatio(cfg),
        };
    }
    const rawLimit = positiveTokenInt(sessionOrConfig?.autoCompactTokenLimit ?? cfg?.autoCompactTokenLimit);
    const explicitLimit = rawLimit && rawLimit < boundary ? rawLimit : null;
    let triggerTokens;
    if (explicitLimit) {
        triggerTokens = explicitLimit;
    } else if (isAgentOwner(sessionOrConfig)) {
        triggerTokens = Math.max(1, boundary - resolveCompactBufferTokens(boundary, cfg));
    } else {
        triggerTokens = boundary;
    }
    const bufferTokens = Math.max(0, boundary - triggerTokens);
    const bufferRatio = bufferTokens / boundary;
    return { autoCompactTokenLimit: explicitLimit, triggerTokens, bufferTokens, bufferRatio };
}

function stripSystemReminder(text) {
    return String(text || '')
        .replace(/^\s*<system-reminder>\s*/i, '')
        .replace(/\s*<\/system-reminder>\s*$/i, '')
        .trim();
}

function splitMarkdownSections(text) {
    const sections = [];
    let current = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (/^#\s+/.test(line) && current.length) {
            const body = current.join('\n').trim();
            if (body) sections.push(body);
            current = [line];
        } else {
            current.push(line);
        }
    }
    const tail = current.join('\n').trim();
    if (tail) sections.push(tail);
    return sections;
}

function reminderSectionBucket(section) {
    const heading = String(section.match(/^#\s+([^\n]+)/)?.[1] || '').trim().toLowerCase();
    if (heading.includes('core memory')) return 'memory';
    if (heading.includes('active workflow') || heading.includes('available agents') || heading.includes('workflow')) return 'workflow';
    if (heading.includes('workspace')) return 'workspace';
    if (heading.includes('environment')) return 'environment';
    return 'other';
}

export function summarizeContextMessages(messages) {
    const rows = {
        system: { count: 0, tokens: 0 },
        user: { count: 0, tokens: 0 },
        assistant: { count: 0, tokens: 0 },
        tool: { count: 0, tokens: 0 },
        other: { count: 0, tokens: 0 },
    };
    const semantic = {
        system: { count: 0, tokens: 0 },
        chat: { count: 0, tokens: 0 },
        assistant: { count: 0, tokens: 0 },
        toolResults: { count: 0, tokens: 0 },
        reminders: { count: 0, tokens: 0, otherTokens: 0 },
        workflow: { tokens: 0 },
        memory: { tokens: 0 },
        workspace: { tokens: 0 },
        environment: { tokens: 0 },
        other: { tokens: 0 },
    };
    let toolCallCount = 0;
    let toolCallTokens = 0;
    let toolResultCount = 0;
    let toolResultTokens = 0;
    for (const message of messages || []) {
        const role = rows[message?.role] ? message.role : 'other';
        const text = messageEstimateText(message);
        const tokens = estimateMessageTokens(message);
        rows[role].count += 1;
        rows[role].tokens += tokens;
        if (role === 'system') {
            semantic.system.count += 1;
            semantic.system.tokens += tokens;
        } else if (role === 'user') {
            if (String(text || '').trim().startsWith('<system-reminder>')) {
                semantic.reminders.count += 1;
                semantic.reminders.tokens += tokens;
                let sectionTokens = 0;
                for (const section of splitMarkdownSections(stripSystemReminder(text))) {
                    const bucket = reminderSectionBucket(section);
                    const sectionTokenCount = estimateTokens(section);
                    semantic[bucket].tokens += sectionTokenCount;
                    sectionTokens += sectionTokenCount;
                }
                semantic.reminders.otherTokens += Math.max(0, tokens - sectionTokens);
            } else {
                semantic.chat.count += 1;
                semantic.chat.tokens += tokens;
            }
        } else if (role === 'assistant') {
            semantic.assistant.count += 1;
            semantic.assistant.tokens += tokens;
        } else if (role === 'tool') {
            semantic.toolResults.count += 1;
            semantic.toolResults.tokens += tokens;
        }
        if (message?.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
            toolCallCount += message.toolCalls.length;
            try { toolCallTokens += estimateTokens(JSON.stringify(message.toolCalls)); }
            catch { toolCallTokens += estimateTokens(`[${message.toolCalls.length} tool calls]`); }
        }
        if (message?.role === 'tool') {
            toolResultCount += 1;
            toolResultTokens += tokens;
        }
    }
    return {
        count: Array.isArray(messages) ? messages.length : 0,
        estimatedTokens: Array.isArray(messages) ? estimateMessagesTokens(messages) : 0,
        roles: rows,
        semantic,
        toolCallCount,
        toolCallTokens,
        toolResultCount,
        toolResultTokens,
    };
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

/**
 * Fold a plain user text turn into the trailing tool_result block of the
 * previous user message (first-party client parity: merge user content
 * blocks into the trailing tool_result). Any sibling text after a
 * tool_result renders as `</function_results>\n\nHuman:<...>` on the
 * Anthropic wire; repeated mid-conversation this teaches the model to emit
 * 3-token empty end_turn completions (upstream A/B sai-20260310-161901:
 * 92% → 0% after smooshing). Observed in mixdog as the empty-turn nudge
 * livelock: each contract nudge was pushed as its own user turn right after
 * a tool_result turn, reinforcing the empty-completion pattern.
 *
 * Returns true when the text was folded (caller must NOT push the message);
 * false when the message must keep its own turn (no tool_result tail,
 * tool_reference result, or non-text content such as images).
 */
export function foldUserTextIntoToolResultTail(result, content) {
    const last = result[result.length - 1];
    if (last?.role !== 'user' || !Array.isArray(last.content) || last.content.length === 0) return false;
    const tail = last.content[last.content.length - 1];
    if (tail?.type !== 'tool_result') return false;
    // tool_reference results must keep their exact shape — leave as sibling.
    if (Array.isArray(tail.content) && tail.content.some((b) => b?.type === 'tool_reference')) return false;
    // Only fold pure text (string or all-text blocks). Images/documents keep
    // their own user turn.
    let texts;
    if (typeof content === 'string') {
        texts = content.trim() ? [content.trim()] : [];
    } else if (Array.isArray(content) && content.every((b) => b?.type === 'text' && typeof b.text === 'string')) {
        texts = content.map((b) => b.text.trim()).filter(Boolean);
    } else {
        return false;
    }
    if (texts.length === 0) return true; // empty text turn — drop it entirely
    const joined = texts.join('\n\n');
    if (typeof tail.content === 'string') {
        last.content[last.content.length - 1] = {
            ...tail,
            content: tail.content.trim() ? `${tail.content}\n\n${joined}` : joined,
        };
        return true;
    }
    if (Array.isArray(tail.content)) {
        const blocks = tail.content.slice();
        const prev = blocks[blocks.length - 1];
        if (prev?.type === 'text' && typeof prev.text === 'string') {
            blocks[blocks.length - 1] = { ...prev, text: `${prev.text}\n\n${joined}` };
        } else {
            blocks.push({ type: 'text', text: joined });
        }
        last.content[last.content.length - 1] = { ...tail, content: blocks };
        return true;
    }
    return false;
}
