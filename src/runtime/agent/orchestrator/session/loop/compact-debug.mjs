// Compaction debug/diagnostic helpers extracted from loop.mjs.
import { summarizeContextMessages } from '../context-utils.mjs';

export function estimateMessagesTokensSafe(messages) {
    // summarizeContextMessages is the fingerprint-validated cached form of
    // estimateMessagesTokens (same per-message estimator, accumulated on the
    // live array). The uncached sum cost ~30ms per call on a long session and
    // ran on EVERY pre-send iteration; the cached path is ~1ms warm.
    try { return summarizeContextMessages(messages).estimatedTokens; }
    catch { return null; }
}

export function compactDebugEnabled() {
    return String(process.env.MIXDOG_COMPACT_DEBUG || '').trim() === '1';
}

export function compactDiagnosticError(err) {
    if (!err) return null;
    const text = String(err?.message || err);
    return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

export function compactByteLength(text) {
    try { return Buffer.byteLength(String(text || ''), 'utf8'); }
    catch { return String(text || '').length; }
}

export function compactDebugLog(scope, details = {}) {
    if (!compactDebugEnabled()) return;
    try { process.stderr.write(`[compact] ${scope} ${JSON.stringify(details)}\n`); }
    catch { /* best-effort diagnostics only */ }
}
