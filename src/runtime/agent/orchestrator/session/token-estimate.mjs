// ---------------------------------------------------------------------------
// Token estimation: conservative Unicode-aware heuristic.
//
// Context pressure is anchored on the PROVIDER USAGE BASELINE (the exact
// prompt-token count the provider reports for the previous request); this
// heuristic only prices the DELTA appended since that baseline. That is the
// whole reason an exact local tokenizer is unnecessary here.
//
// Measured on 5,552 real deltas across 40 stored sessions, counted against a
// true o200k encode:
//
//   aggregate bias        +6.5%   (overcounts — the safe direction)
//   delta ratio           p10 0.81   median 1.06   p90 1.39
//   deltas underestimated 35%
//   worst underestimate   2,985 tokens   (1.5% of a 200K window)
//   p99 underestimate       485 tokens
//
// A plain chars/4 rule is NOT adequate: Korean text costs ~2.15x what chars/4
// predicts, and dense base64/JSONL runs cost ~2x. Both are priced explicitly
// below, which is what keeps the aggregate bias positive.
//
// Failure modes are asymmetric on purpose. Overcounting compacts slightly
// early (cheap); undercounting overflows the context window (a failed turn).
// Every weight is therefore tuned to overcount rather than to match exactly.
//
// MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER (default 1.0, clamped 1.0..2.0)
// lets an operator dial extra headroom without a code change.
// ---------------------------------------------------------------------------

import { denseTokenFloor, structuredTokenFloor } from './token-estimate-floors.mjs';

function readSafetyMultiplier() {
    const raw = Number(process.env.MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
    if (Number.isFinite(raw)) return Math.min(2.0, Math.max(1.0, raw));
    return 1.0;
}
const TOKEN_ESTIMATE_SAFETY_MULTIPLIER = readSafetyMultiplier();

/**
 * Extra headroom for totals that are NOT anchored on a provider usage
 * baseline (first request of a session, a prefix-signature mismatch, the turn
 * right after a compaction). Those totals price a whole transcript instead of
 * one delta, so the per-delta error bound above does not apply and the
 * measured p90 ratio (1.39 high / 0.81 low) is the relevant spread.
 */
export const UNCALIBRATED_ESTIMATE_MARGIN = 1.1;

/** Per-code-point token-cost weight. Tuned to overcount, not match exactly. */
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

/**
 * Conservative token estimate for one text projection. Iterates by code point,
 * takes the max of the weighted sum, the chars/4 ASCII floor and the dense-run
 * floors, then applies the safety multiplier.
 */
export function estimateTokens(text) {
    const s = String(text ?? '');
    if (s.length === 0) return 0;
    let weighted = 0;
    for (const ch of s) weighted += codePointTokenWeight(ch.codePointAt(0));
    const denseAsciiFloor = Math.max(denseTokenFloor(s), structuredTokenFloor(s));
    const asciiFloor = s.length / 4; // never below the legacy chars/4 lower bound
    return Math.ceil(Math.max(weighted, asciiFloor, denseAsciiFloor) * TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
}
