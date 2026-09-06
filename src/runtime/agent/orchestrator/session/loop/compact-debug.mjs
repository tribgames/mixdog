// Compaction debug/diagnostic helpers extracted from loop.mjs.
import { summarizeContextMessages } from '../context-utils.mjs';

export { compactDebugEnabled, compactDebugLog } from '../compact/constants.mjs';

export function estimateMessagesTokensSafe(messages) {
    // summarizeContextMessages is the fingerprint-validated cached form of
    // estimateMessagesTokens (same per-message estimator, accumulated on the
    // live array). The uncached sum cost ~30ms per call on a long session and
    // ran on EVERY pre-send iteration; the cached path is ~1ms warm.
    try { return summarizeContextMessages(messages).estimatedTokens; }
    catch { return null; }
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
