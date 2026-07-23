import { isOffloadedToolResultText } from './tool-result-offload.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    isFinalizedProviderRequestTools,
    providerNativeToolPrefixCount,
} from '../../../../session-runtime/provider-request-tools.mjs';
import { contentFileDescriptors, contentImageDescriptors, contentToText } from '../providers/media-normalization.mjs';
export {
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    DEFAULT_MAIN_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    positiveTokenInt,
    normalizeCompactionBufferRatio,
    resolveBufferRatioCandidate,
    resolveCompactBufferRatio,
    resolveMainCompactBufferRatio,
    compactionBufferTokensForBoundary,
    isPersistedZeroBufferTelemetry,
    isLegacyDefaultBufferTelemetry,
    compactBufferConfigForBoundary,
    resolveCompactBufferTokens,
    resolveMainCompactBufferTokens,
    resolveCompactTriggerTokens,
    resolveSessionCompactPolicy,
} from './context-compaction-policy.mjs';

// ---------------------------------------------------------------------------
// Token estimation: real o200k_base BPE (tiktoken) + per-provider calibration.
//
// estimateTokens() encodes the provider-visible text projection with the real
// o200k_base BPE (tiktoken, same approach as mainstream agent UIs), so
// estimates track actual billing instead of a weighted-chars heuristic that
// diverged -25%..+60% depending on script and provider. The residual
// provider-specific gap between an o200k count and billed prompt tokens is
// reconciled by providerTokenCalibration(): measured on prefix-verified live
// sessions, OpenAI billing matches o200k directly (median ratio 1.00) while
// Anthropic bills the identical projection at ~1.7x o200k (Claude tokenizer +
// wire framing, median 1.71). Calibration is applied at the provider-aware
// aggregation boundary (compaction pressure / context gauge), never inside
// the provider-agnostic per-message memo.
//
// The previous conservative Unicode-weight heuristic is retained verbatim as
// legacyEstimateTokens(), used only when the tiktoken WASM cannot be loaded
// (stripped installs / exotic platforms) so estimation degrades safely.
//
// MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER (default 1.0, clamped 1.0..2.0)
// still lets operators dial extra headroom without code changes; the
// provider-usage baseline remains the primary pressure source when aligned.
function readSafetyMultiplier() {
    const raw = Number(process.env.MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
    if (Number.isFinite(raw)) return Math.min(2.0, Math.max(1.0, raw));
    return 1.0;
}
const TOKEN_ESTIMATE_SAFETY_MULTIPLIER = readSafetyMultiplier();

// Lazy singleton o200k_base encoder. createRequire keeps the load dynamic for
// bundlers (TUI esbuild) and lets a missing/broken WASM fall back cleanly.
const _requireForTokenizer = createRequire(import.meta.url);
let _bpeEncoder; // undefined = not attempted, null = unavailable
function bpeEncoder() {
    if (_bpeEncoder !== undefined) return _bpeEncoder;
    try {
        const { Tiktoken } = _requireForTokenizer('tiktoken/lite');
        const o200k = _requireForTokenizer('tiktoken/encoders/o200k_base.json');
        _bpeEncoder = new Tiktoken(o200k.bpe_ranks, o200k.special_tokens, o200k.pat_str);
    } catch {
        _bpeEncoder = null;
    }
    return _bpeEncoder;
}

// Compaction budget loops re-estimate overlapping transcript slices; identical
// large strings (tool results, system blocks) would re-encode every pass.
// Hash-keyed LRU absorbs the repeats.
const TOKEN_COUNT_CACHE_MIN_CHARS = 512;
const TOKEN_COUNT_CACHE_MAX_ENTRIES = 1_024;
const tokenCountCache = new Map();
// BPE merge cost is quadratic in WORD length, not text length: a degenerate
// single-word run ('p'.repeat(250k), base64/minified blobs) forms one giant
// pat_str word and encode() spins for minutes while the event loop is blocked
// (observed live via inspector: compact-smoke hung inside tiktoken encode).
// Encoding fixed-size slices caps the worst-case word at the chunk size, so
// cost stays linear. Chunk cuts snap back to the nearest whitespace so the
// next slice starts at a natural ` word` boundary — o200k tokenizes that
// identically to the unsliced text, keeping estimates EXACT for prose
// (compact-smoke asserts est === real o200k count). Only a whitespace-free
// degenerate run falls back to a hard cut (±1 token per boundary, safely
// inside the estimate's safety multiplier). Hard cuts avoid splitting a
// surrogate pair so sliced emoji/CJK-ext code points still encode cleanly.
const BPE_ENCODE_CHUNK_CHARS = 4_096;
const BPE_CHUNK_BOUNDARY_SCAN = 512;
function bpeEncodeCount(enc, s) {
    if (s.length <= BPE_ENCODE_CHUNK_CHARS) return enc.encode(s, undefined, []).length;
    let total = 0;
    let i = 0;
    while (i < s.length) {
        let end = Math.min(s.length, i + BPE_ENCODE_CHUNK_CHARS);
        if (end < s.length) {
            // Prefer cutting BEFORE a whitespace run: the next chunk then
            // starts with ` word`, which o200k merges exactly as it would
            // mid-text. Scan a bounded window so degenerate inputs stay O(1).
            let ws = -1;
            const scanFloor = Math.max(i + 1, end - BPE_CHUNK_BOUNDARY_SCAN);
            for (let j = end - 1; j >= scanFloor; j -= 1) {
                const c = s.charCodeAt(j);
                if (c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09) { ws = j; break; }
            }
            if (ws > i) {
                end = ws; // next chunk starts at the whitespace
            } else {
                const last = s.charCodeAt(end - 1);
                if (last >= 0xD800 && last <= 0xDBFF) end += 1;
            }
        }
        total += enc.encode(s.slice(i, end), undefined, []).length;
        i = end;
    }
    return total;
}
function bpeTokenCount(enc, s) {
    if (s.length < TOKEN_COUNT_CACHE_MIN_CHARS) return bpeEncodeCount(enc, s);
    const key = `${s.length}:${createHash('sha1').update(s).digest('base64')}`;
    const hit = tokenCountCache.get(key);
    if (hit !== undefined) {
        tokenCountCache.delete(key);
        tokenCountCache.set(key, hit);
        return hit;
    }
    const count = bpeEncodeCount(enc, s);
    if (tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX_ENTRIES) {
        tokenCountCache.delete(tokenCountCache.keys().next().value);
    }
    tokenCountCache.set(key, count);
    return count;
}

// Billed-prompt / o200k-estimate ratio per provider family, measured against
// prefix-signature-verified provider baselines from real sessions (opaque
// signature/encrypted payloads excluded from the projection — see
// stripOpaquePayloads). Env overrides let a deployment recalibrate without a
// code change; values are clamped to a plausible band.
function calibrationEnv(name) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.min(3, Math.max(0.25, n)) : null;
}
export function providerTokenCalibration(provider) {
    const p = String(provider || '').toLowerCase();
    if (p.startsWith('anthropic')) return calibrationEnv('MIXDOG_TOKEN_CALIBRATION_ANTHROPIC') ?? 1.7;
    if (p.startsWith('gemini') || p.startsWith('google')) return calibrationEnv('MIXDOG_TOKEN_CALIBRATION_GEMINI') ?? 1.15;
    return calibrationEnv('MIXDOG_TOKEN_CALIBRATION_DEFAULT') ?? 1.0;
}
// Claude Code parity (services/tokenEstimation.ts): images/documents count a
// flat 2000 tokens when dimensions are unknown — the conservative constant CC
// shares with microCompact's IMAGE_MAX_TOKEN_SIZE. Known dimensions may only
// RAISE the allowance via Anthropic's real vision formula (w*h/750), capped at
// the 2000x2000 resize ceiling (5333 tokens).
export const IMAGE_VISUAL_TOKEN_ALLOWANCE = 2_000;
const IMAGE_MAX_TOKEN_ALLOWANCE = 5_333;

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

// Real-BPE token estimate with heuristic fallback. See module header.
export function estimateTokens(text) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    const enc = bpeEncoder();
    if (enc) {
        try {
            return Math.ceil(bpeTokenCount(enc, s) * TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
        } catch { /* corrupt input — degrade to the heuristic below */ }
    }
    return legacyEstimateTokens(s);
}

// Legacy conservative Unicode-aware estimate (fallback only). Iterates by
// code point, takes the max of the weighted sum and the chars/4 ASCII floor,
// then applies the safety multiplier.
function legacyEstimateTokens(s) {
    let weighted = 0;
    for (const ch of s) weighted += codePointTokenWeight(ch.codePointAt(0));
    // Encoded blobs, minified JSON and generated identifiers do not get the
    // word/whitespace merges that make prose approach chars/4. Long printable
    // ASCII runs are commonly 0.5-0.8 tokens/byte; retain a conservative floor
    // for those runs without penalizing ordinary spaced prose.
    let denseAsciiFloor = 0;
    for (const match of s.matchAll(/[\x21-\x7e]{16,}/g)) {
        // Claude Code prices dense JSON/JSONL at chars/2 (bytesPerTokenForFileType);
        // 0.5/char keeps that parity for long unmerged printable runs.
        denseAsciiFloor += match[0].length * 0.5;
    }
    const encodedWords = s.match(/\b(?=[A-Za-z0-9]{8,}\b)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g) || [];
    if (encodedWords.length >= 3) {
        // Encoded/generated identifiers are often wrapped at short columns or
        // separated by spaces. Their individual runs can stay below the long-
        // run threshold while still receiving almost no prose-style BPE merges.
        const encodedChars = encodedWords.reduce((sum, word) => sum + word.length, 0);
        denseAsciiFloor = Math.max(
            denseAsciiFloor,
            (encodedChars * 0.5) + ((s.length - encodedChars) * 0.25),
        );
    }
    const lines = s.split(/\r?\n/).filter(line => line.trim());
    const nonWhitespace = s.match(/\S/g)?.length || 0;
    const structural = s.match(/[\[\]{}":,=<>|\\]/g)?.length || 0;
    const jsonLikeLines = lines.filter(line => /^\s*[\[{].*[\]}],?\s*$/.test(line)).length;
    if (lines.length >= 3 && nonWhitespace > 0
        && (jsonLikeLines >= Math.ceil(lines.length / 2) || structural / nonWhitespace >= 0.12)) {
        // JSONL, compact tables and generated line protocols can consist
        // entirely of short runs while still tokenizing like minified data.
        // chars/2 on the dense payload chars (Claude Code JSON parity).
        denseAsciiFloor = Math.max(denseAsciiFloor, (nonWhitespace * 0.5) + ((s.length - nonWhitespace) * 0.25));
    }
    const asciiFloor = s.length / 4; // never below the legacy chars/4 lower bound
    return Math.ceil(Math.max(weighted, asciiFloor, denseAsciiFloor) * TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
}

// Opaque replay payloads (Anthropic thinking signatures, OpenAI encrypted
// reasoning blobs, redacted data) are long base64-ish strings that are NOT
// billed proportionally to their serialized length — including them made
// estimates swing wildly per turn. Replace them with a fixed marker before
// token counting; calibration factors were measured against this projection.
// Stripping is KEY-SCOPED: only fields that structurally carry opaque replay
// material (signatures / encrypted / redacted / raw data blobs) are eligible,
// so genuine long model text (e.g. Gemini thought text) keeps its real cost.
const OPAQUE_PAYLOAD_KEY_RE = /signature|encrypted|redacted|^data$|^blob$/i;
const OPAQUE_PAYLOAD_RE = /^[A-Za-z0-9+/_=-]{64,}$/;
function stripOpaquePayloads(value, depth = 0, keyHint = '') {
    if (typeof value === 'string') {
        return OPAQUE_PAYLOAD_KEY_RE.test(keyHint) && value.length >= 64 && OPAQUE_PAYLOAD_RE.test(value)
            ? '[opaque]'
            : value;
    }
    if (depth >= 8 || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => stripOpaquePayloads(v, depth + 1, keyHint));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripOpaquePayloads(v, depth + 1, k);
    return out;
}
function nativeBlocksEstimateText(value) {
    const list = Array.isArray(value) ? value : [value];
    return list.map((block) => {
        const images = contentImageDescriptors(block);
        if (images.length) {
            return JSON.stringify(images.map(({ width, height, detail }) => ({
                type: 'image', width, height, detail,
            })));
        }
        try { return JSON.stringify(stripOpaquePayloads(block)); }
        catch { return String(block ?? ''); }
    }).join('\n');
}
function messageEstimateText(m) {
    if (!m || typeof m !== 'object') return '';
    // Multimodal image payloads remain on the live message for provider sends,
    // but their base64/data-url JSON is not text and must not dominate local
    // context estimates. Use the same media-aware text projection for every
    // estimate consumer (live gauge, compaction fallback, and summaries).
    let text = contentToText(m.content, '');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        try { text += `\n${JSON.stringify(m.toolCalls)}`; }
        catch { text += `\n[${m.toolCalls.length} tool calls]`; }
    }
    // Anthropic adaptive-thinking blocks round-trip verbatim (thinking text +
    // signature / redacted data) and are re-sent on tool-continuation turns, so
    // they consume real input tokens. Count them or trim/compact undercounts.
    if (m.role === 'assistant' && Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length) {
        text += `\n${nativeBlocksEstimateText(m.thinkingBlocks)}`;
    }
    // Some provider adapters replay their native assistant representation
    // instead of content/toolCalls. Project it through the media normalizer so
    // text/tool metadata and opaque reasoning are counted without base64 image
    // bytes dominating the estimate.
    if (m.role === 'assistant' && Array.isArray(m.assistantBlocks) && m.assistantBlocks.length) {
        text += `\n${nativeBlocksEstimateText(m.assistantBlocks)}`;
    }
    if (m.role === 'assistant' && Array.isArray(m.reasoningItems) && m.reasoningItems.length) {
        text += `\n${nativeBlocksEstimateText(m.reasoningItems)}`;
    }
    // Provider-scoped replay metadata is never sent to a different provider,
    // but Gemini replays signed thought parts on subsequent Gemini turns.
    const geminiThoughtParts = m.role === 'assistant'
        ? m.providerMetadata?.gemini?.thoughtParts
        : null;
    if (Array.isArray(geminiThoughtParts) && geminiThoughtParts.length) {
        text += `\n${nativeBlocksEstimateText(geminiThoughtParts)}`;
    }
    if (m.role === 'tool' && m.toolCallId) text += `\n${m.toolCallId}`;
    return text;
}
function imageDescriptorAllowance(descriptor) {
    if (descriptor.width && descriptor.height) {
        // Anthropic vision cost: tokens = (width * height) / 750, with images
        // resized down to at most 2000x2000 (5333 tokens) — Claude Code uses
        // the same formula/cap. Caller-supplied dimensions may RAISE the
        // allowance above the unknown-image floor but never lower it (the
        // provider normalizer may not preserve caller metadata).
        const formula = Math.ceil((descriptor.width * descriptor.height) / 750);
        return Math.min(
            IMAGE_MAX_TOKEN_ALLOWANCE,
            Math.max(IMAGE_VISUAL_TOKEN_ALLOWANCE, formula),
        );
    }
    // Unknown-size images: flat conservative allowance (Claude Code parity).
    return IMAGE_VISUAL_TOKEN_ALLOWANCE;
}
function messageImageDescriptors(m) {
    if (!m || typeof m !== 'object') return [];
    return [
        ...contentImageDescriptors(m.content),
        ...(m.role === 'assistant' ? contentImageDescriptors(m.assistantBlocks) : []),
    ];
}
function messageImageAllowance(m) {
    if (!m || typeof m !== 'object') return 0;
    return messageImageDescriptors(m).reduce((sum, descriptor) => sum + imageDescriptorAllowance(descriptor), 0);
}
// Inline document (PDF) allowance: Anthropic bills ~1,500-3,000 tokens per
// page and a typical PDF page is ~50-100KB, so ~bytes/16 with a floor and a
// cap. The base64 payload itself is excluded from text estimates (see
// jsonFallbackFromPart), so this allowance is the document's entire cost.
const FILE_TOKEN_ALLOWANCE_FLOOR = 1_500;
const FILE_MAX_TOKEN_ALLOWANCE = 300_000;
function messageFileAllowance(m) {
    if (!m || typeof m !== 'object') return 0;
    return contentFileDescriptors(m.content).reduce((sum, descriptor) => sum + Math.min(
        FILE_MAX_TOKEN_ALLOWANCE,
        Math.max(FILE_TOKEN_ALLOWANCE_FLOOR, Math.ceil((descriptor.sizeBytes || 0) / 16)),
    ), 0);
}
function estimateMessageTokens(m) {
    return estimateTokens(messageEstimateText(m)) + messageImageAllowance(m) + messageFileAllowance(m) + 4;
}
export function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// Context status is polled while the agent loop mutates and replaces message
// arrays. Keep the accumulated summary on that array, but cheaply validate
// every entry before reusing its contribution. The fingerprint deliberately
// avoids serializing content/blocks on the warm path; it compares the
// references of every estimator-visible string instead.
// Producer invariant: compaction copies message/call objects, transcript repair
// replaces array entries, stored-tool-args replaces `arguments`, and MCP reload
// replaces tool descriptors; settled nested non-string payloads are not mutated
// in place without replacing their containing reference.
const contextMessageMemo = new WeakMap();
const contextTranscriptMemo = new WeakMap();

function contextValueFingerprint(value) {
    return {
        value,
        snapshot: typeof value === 'string'
            ? value
            : `${nativeBlocksEstimateText(value)}\0${JSON.stringify(contentImageDescriptors(value))}`,
    };
}

function contextMessageFingerprint(message) {
    if (!message || typeof message !== 'object') {
        return {
            role: undefined,
            content: contextValueFingerprint(''),
            toolCalls: contextValueFingerprint(null),
            thinkingBlocks: contextValueFingerprint(null),
            assistantBlocks: contextValueFingerprint(null),
            reasoningItems: contextValueFingerprint(null),
            providerMetadata: contextValueFingerprint(null),
            toolCallId: null,
        };
    }
    return {
        role: message.role,
        content: contextValueFingerprint(message.content),
        toolCalls: contextValueFingerprint(message.toolCalls),
        thinkingBlocks: contextValueFingerprint(message.thinkingBlocks),
        assistantBlocks: contextValueFingerprint(message.assistantBlocks),
        reasoningItems: contextValueFingerprint(message.reasoningItems),
        providerMetadata: contextValueFingerprint(message.providerMetadata),
        toolCallId: message?.toolCallId || null,
    };
}

function sameContextValueFingerprint(a, b) {
    return !!a && !!b && a.value === b.value && a.snapshot === b.snapshot;
}

function sameContextMessageFingerprint(a, b) {
    return !!a && a.role === b.role
        && sameContextValueFingerprint(a.content, b.content)
        && sameContextValueFingerprint(a.toolCalls, b.toolCalls)
        && sameContextValueFingerprint(a.thinkingBlocks, b.thinkingBlocks)
        && sameContextValueFingerprint(a.assistantBlocks, b.assistantBlocks)
        && sameContextValueFingerprint(a.reasoningItems, b.reasoningItems)
        && sameContextValueFingerprint(a.providerMetadata, b.providerMetadata)
        && a.toolCallId === b.toolCallId;
}

function contextMessageContribution(message) {
    const fingerprint = contextMessageFingerprint(message);
    if (message && typeof message === 'object') {
        const cached = contextMessageMemo.get(message);
        if (cached && sameContextMessageFingerprint(cached.fingerprint, fingerprint)) return cached.contribution;
    }
    const role = ['system', 'user', 'assistant', 'tool'].includes(fingerprint.role) ? fingerprint.role : 'other';
    const text = messageEstimateText(message);
    const tokens = estimateTokens(text) + messageImageAllowance(message) + 4;
    const contribution = {
        role,
        tokens,
        reminderBuckets: null,
        systemWorkflowTokens: 0,
        toolCallCount: 0,
        toolCallTokens: 0,
        toolResultCount: role === 'tool' ? 1 : 0,
        toolResultTokens: role === 'tool' ? tokens : 0,
    };
    if (role === 'user' && String(text || '').trim().startsWith('<system-reminder>')) {
        const buckets = { tokens: contribution.tokens, otherTokens: contribution.tokens };
        let sectionTokens = 0;
        for (const section of splitMarkdownSections(stripSystemReminder(text))) {
            const bucket = reminderSectionBucket(section);
            const sectionTokenCount = estimateTokens(section);
            buckets[bucket] = (buckets[bucket] || 0) + sectionTokenCount;
            sectionTokens += sectionTokenCount;
        }
        buckets.otherTokens = Math.max(0, contribution.tokens - sectionTokens);
        contribution.reminderBuckets = buckets;
    }
    if (role === 'system') {
        for (const section of splitMarkdownSections(text)) {
            if (reminderSectionBucket(section) === 'workflow') {
                contribution.systemWorkflowTokens += estimateTokens(section);
            }
        }
    }
    if (fingerprint.role === 'assistant' && Array.isArray(message?.toolCalls) && message.toolCalls.length) {
        contribution.toolCallCount = message.toolCalls.length;
        try { contribution.toolCallTokens = estimateTokens(JSON.stringify(message.toolCalls)); }
        catch { contribution.toolCallTokens = estimateTokens(`[${message.toolCalls.length} tool calls]`); }
    }
    if (message && typeof message === 'object') {
        contextMessageMemo.set(message, { fingerprint, contribution });
    }
    return contribution;
}

function emptyContextSummaryState() {
    return {
        rows: {
            system: { count: 0, tokens: 0 },
            user: { count: 0, tokens: 0 },
            assistant: { count: 0, tokens: 0 },
            tool: { count: 0, tokens: 0 },
            other: { count: 0, tokens: 0 },
        },
        semantic: {
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
        },
        estimatedTokens: 0,
        toolCallCount: 0,
        toolCallTokens: 0,
        toolResultCount: 0,
        toolResultTokens: 0,
    };
}

function applyContextMessageContribution(state, contribution, direction) {
    const { role, tokens } = contribution;
    state.estimatedTokens += direction * tokens;
    state.rows[role].count += direction;
    state.rows[role].tokens += direction * tokens;
    if (role === 'system') {
        state.semantic.system.count += direction;
        state.semantic.system.tokens += direction * (tokens - contribution.systemWorkflowTokens);
        state.semantic.workflow.tokens += direction * contribution.systemWorkflowTokens;
    } else if (role === 'user') {
        if (contribution.reminderBuckets) {
            state.semantic.reminders.count += direction;
            state.semantic.reminders.tokens += direction * contribution.reminderBuckets.tokens;
            state.semantic.reminders.otherTokens += direction * contribution.reminderBuckets.otherTokens;
            for (const bucket of ['workflow', 'memory', 'workspace', 'environment', 'other']) {
                state.semantic[bucket].tokens += direction * (contribution.reminderBuckets[bucket] || 0);
            }
        } else {
            state.semantic.chat.count += direction;
            state.semantic.chat.tokens += direction * tokens;
        }
    } else if (role === 'assistant') {
        state.semantic.assistant.count += direction;
        state.semantic.assistant.tokens += direction * tokens;
    } else if (role === 'tool') {
        state.semantic.toolResults.count += direction;
        state.semantic.toolResults.tokens += direction * tokens;
    }
    state.toolCallCount += direction * contribution.toolCallCount;
    state.toolCallTokens += direction * contribution.toolCallTokens;
    state.toolResultCount += direction * contribution.toolResultCount;
    state.toolResultTokens += direction * contribution.toolResultTokens;
}

function contextSummaryResult(state, count) {
    return {
        count,
        estimatedTokens: state.estimatedTokens,
        roles: Object.fromEntries(Object.entries(state.rows).map(([role, row]) => [role, { ...row }])),
        semantic: Object.fromEntries(Object.entries(state.semantic).map(([name, row]) => [name, { ...row }])),
        toolCallCount: state.toolCallCount,
        toolCallTokens: state.toolCallTokens,
        toolResultCount: state.toolResultCount,
        toolResultTokens: state.toolResultTokens,
    };
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
    if (!Array.isArray(messages)) return contextSummaryResult(emptyContextSummaryState(), 0);
    let cached = contextTranscriptMemo.get(messages);
    if (!cached || messages.length < cached.count) {
        cached = { count: 0, contributions: [], state: emptyContextSummaryState(), revision: 0, result: null };
        contextTranscriptMemo.set(messages, cached);
    }
    let changed = cached.result === null;
    for (let index = 0; index < messages.length; index += 1) {
        const previous = cached.contributions[index];
        const contribution = contextMessageContribution(messages[index]);
        if (previous === contribution) continue;
        if (previous) applyContextMessageContribution(cached.state, previous, -1);
        cached.contributions[index] = contribution;
        applyContextMessageContribution(cached.state, contribution, 1);
        cached.revision += 1;
        changed = true;
    }
    cached.contributions.length = messages.length;
    cached.count = messages.length;
    if (!changed && cached.result) return cached.result;
    cached.result = contextSummaryResult(cached.state, messages.length);
    return cached.result;
}

// A stable warm-cache generation for consumers that cache a derived view of
// the whole transcript. summarizeContextMessages() must run first so mutations
// to any entry, not merely the tail, advance the generation.
export function contextMessagesRevision(messages) {
    if (!Array.isArray(messages)) return 0;
    summarizeContextMessages(messages);
    return contextTranscriptMemo.get(messages)?.revision || 0;
}

export function summarizeContextMessagesAtRevision(messages, revision) {
    if (Array.isArray(messages)) {
        const cached = contextTranscriptMemo.get(messages);
        if (cached
            && cached.count === messages.length
            && cached.revision === revision
            && cached.result) return cached.result;
    }
    return summarizeContextMessages(messages);
}

// Hash only estimator/provider-visible projections. In particular, images
// contribute their visual count but never their raw data-url/base64 bytes.
const contextMessagesSignatureMemo = new WeakMap();
const CONTEXT_SIGNATURE_COUNTS_MAX = 4;

export function contextMessagesSignature(messages, count = messages?.length) {
    const list = Array.isArray(messages) ? messages : [];
    const end = Math.max(0, Math.min(list.length, Number.isInteger(count) ? count : list.length));
    let contributions = null;
    let signatures = null;
    if (Array.isArray(messages)) {
        summarizeContextMessages(messages);
        contributions = contextTranscriptMemo.get(messages)?.contributions.slice(0, end) || [];
        signatures = contextMessagesSignatureMemo.get(messages);
        const previous = signatures?.get(end);
        if (previous && previous.contributions.length === contributions.length) {
            let unchanged = true;
            for (let index = 0; index < contributions.length; index += 1) {
                if (previous.contributions[index] !== contributions[index]) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                signatures.delete(end);
                signatures.set(end, previous);
                return previous.signature;
            }
        }
    }
    const hash = createHash('sha256');
    for (let index = 0; index < end; index += 1) {
        const message = list[index];
        hash.update(JSON.stringify([
            message?.role || '',
            message?.toolCallId || '',
            messageEstimateText(message),
            messageImageAllowance(message),
            messageImageDescriptors(message),
        ]));
        hash.update('\0');
    }
    const signature = hash.digest('hex');
    if (Array.isArray(messages)) {
        signatures ||= new Map();
        if (signatures.has(end)) signatures.delete(end);
        signatures.set(end, { contributions, signature });
        while (signatures.size > CONTEXT_SIGNATURE_COUNTS_MAX) {
            const oldest = signatures.keys().next().value;
            if (oldest === undefined) break;
            signatures.delete(oldest);
        }
        contextMessagesSignatureMemo.set(messages, signatures);
    }
    return signature;
}

const toolSchemaAnalysisMemo = new WeakMap();

function serializeToolSchemas(tools) {
    const list = Array.isArray(tools) ? tools : [];
    const nativePrefixCount = providerNativeToolPrefixCount(list);
    try {
        return JSON.stringify(list.map((tool, index) => {
            if (index < nativePrefixCount) {
                return tool;
            }
            const wireTool = {
                name: tool?.name,
                description: tool?.description,
                input_schema: tool?.inputSchema ?? tool?.input_schema ?? tool?.parameters ?? tool?.schema,
            };
            if (tool?.deferLoading === true || tool?.defer_loading === true) wireTool.defer_loading = true;
            return wireTool;
        }));
    }
    catch { return list.map(t => String(t?.name ?? '')).join(''); }
}

export function toolSchemaSignature(tools) {
    return analyzeToolSchemas(tools).signature;
}

function analyzeToolSchemas(tools) {
    const list = Array.isArray(tools) ? tools : [];
    const cached = Array.isArray(tools) ? toolSchemaAnalysisMemo.get(tools) : null;
    if (cached && isFinalizedProviderRequestTools(tools)) return cached;
    const text = serializeToolSchemas(list);
    const signature = createHash('sha256').update(text).digest('hex');
    if (cached?.signature === signature) return cached;
    const analysis = { signature, tokens: estimateTokens(text) };
    if (Array.isArray(tools)) toolSchemaAnalysisMemo.set(tools, analysis);
    return analysis;
}

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
    return analyzeToolSchemas(tools).tokens;
}

/**
 * Total request-side bytes the caller should reserve out of the context window
 * before compaction. Only serialized tool schemas are counted; providers do
 * not expose a stable framing cost, so no synthetic fixed allowance is added.
 */
export function estimateRequestReserveTokens(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return estimateToolSchemaTokens(tools);
    return analyzeToolSchemas(tools).tokens;
}

/**
 * Live/current context numerator SSOT: transcript estimate + request reserve.
 * Provider-reported usage is excluded (secondary metadata only).
 * Empty / no-activity transcript returns 0 so fresh sessions do not show
 * reserve-only phantom usage.
 *
 * @param {unknown[]} messages
 * @param {unknown[]|number} toolsOrReserve tool list or precomputed reserve tokens
 * @param {{ messageCount?: number, estimatedMessageTokens?: number, provider?: string }} [opts]
 */
export function estimateTranscriptContextUsage(messages, toolsOrReserve, opts = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const count = Number.isFinite(Number(opts.messageCount)) ? Number(opts.messageCount) : list.length;
    if (count <= 0 || list.length === 0) return 0;
    const messageTokens = Number.isFinite(Number(opts.estimatedMessageTokens))
        ? Number(opts.estimatedMessageTokens)
        : summarizeContextMessages(list).estimatedTokens;
    const reserve = typeof toolsOrReserve === 'number' && Number.isFinite(toolsOrReserve)
        ? Math.max(0, toolsOrReserve)
        : estimateRequestReserveTokens(toolsOrReserve);
    // Provider-aware calibration reconciles the o200k estimate with actual
    // billing (see providerTokenCalibration). No provider → neutral 1.0.
    return Math.round((messageTokens + reserve) * providerTokenCalibration(opts.provider));
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
