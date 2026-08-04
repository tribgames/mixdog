// Process-local delivered-completion registry.
//
// Purpose: a task-completion body that was already injected into the active TUI
// loop and ACKed (modelVisibleDelivered) must never ALSO be enqueued into — or
// drained from — the session pending queue one turn later. The TUI ack and the
// racing background/fallback enqueue run on different code paths within the SAME
// process, so this in-memory registry lets an enqueue/drain site recognize "this
// completion was already delivered" and skip it.
//
// Recorded keys (either one matching = already delivered):
//   - meta.execution_id (when present)
//   - a hash of the model-visible completion text
//
// Bounded + TTL'd so a long-lived process never accumulates unbounded entries.
// Both record and a matching lookup REFRESH the entry (sliding TTL), so an
// ACKed completion survives across long-idle turns as long as it keeps being
// checked. Headless/API sessions never ack, so the registry stays empty for
// them and marked in-memory completions drain exactly once (behavior unchanged).
//
// Residual risk: with a 6h sliding TTL the only remaining eviction path is the
// bounded-size cap — if MORE than DELIVERED_MAX_ENTRIES distinct completions are
// delivered before an older ACKed key is next checked, that oldest key is
// evicted and its (now un-refreshed) completion could enqueue/drain a second
// time. This requires >512 live completions between a delivery and its drain,
// which is far outside normal single-process interactive use.
import { createHash } from 'node:crypto';

const DELIVERED_TTL_MS = 6 * 60 * 60 * 1000; // 6h, sliding (refreshed on record + hit)
const DELIVERED_MAX_ENTRIES = 512;
// key -> expiresAt (ms). Insertion order = age order (Map guarantee), so the
// oldest key is always the first — used for bounded-size eviction.
const _delivered = new Map();

function hashCompletionText(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    return createHash('sha1').update(value).digest('hex');
}

function execKey(executionId) {
    const id = executionId == null ? '' : String(executionId).trim();
    return id ? `id:${id}` : null;
}

function textKey(text) {
    const h = hashCompletionText(text);
    return h ? `tx:${h}` : null;
}

function pruneExpired(now) {
    for (const [key, expiresAt] of _delivered) {
        if (expiresAt <= now) _delivered.delete(key);
    }
}

function enforceBound() {
    while (_delivered.size > DELIVERED_MAX_ENTRIES) {
        const oldest = _delivered.keys().next().value;
        if (oldest === undefined) break;
        _delivered.delete(oldest);
    }
}

// Record a delivered completion under its execution_id (when present) and its
// model-visible text hash. Both keys point at the same expiry so a later
// enqueue/drain matching EITHER is recognized as already delivered. Re-recording
// an existing key refreshes its expiry (sliding TTL).
export function recordDeliveredCompletion({ executionId, text } = {}) {
    const now = Date.now();
    pruneExpired(now);
    const expiresAt = now + DELIVERED_TTL_MS;
    let recorded = false;
    for (const key of [execKey(executionId), textKey(text)]) {
        if (!key) continue;
        _delivered.delete(key); // re-insert to refresh age order
        _delivered.set(key, expiresAt);
        recorded = true;
    }
    if (recorded) enforceBound();
    return recorded;
}

export function isDeliveredCompletion({ executionId, text } = {}) {
    const now = Date.now();
    const keys = [execKey(executionId), textKey(text)].filter(Boolean);
    let hit = false;
    for (const key of keys) {
        const expiresAt = _delivered.get(key);
        if (expiresAt === undefined) continue;
        if (expiresAt <= now) { _delivered.delete(key); continue; }
        hit = true;
    }
    if (!hit) return false;
    // Sliding refresh: extend every present key (and move it to the age tail) so
    // a long-idle drain that checks it later still recognizes it as delivered.
    const expiresAt = now + DELIVERED_TTL_MS;
    for (const key of keys) {
        if (!_delivered.has(key)) continue;
        _delivered.delete(key);
        _delivered.set(key, expiresAt);
    }
    return true;
}

// One diagnostic stderr line per dedup skip, naming the site
// (mirror/fallback/notify-enqueue/drain) so the actual racing edge is
// empirically confirmable in logs.
export function logDuplicateSkip(site, { executionId, text } = {}) {
    try {
        const id = executionId == null ? '' : String(executionId).trim();
        const h = hashCompletionText(text);
        process.stderr.write(
            `[completion-dedup] skip site=${site}`
            + `${id ? ` execution_id=${id}` : ''}`
            + `${h ? ` hash=${h.slice(0, 12)}` : ''}\n`,
        );
    } catch { /* ignore */ }
}

// Test-only reset hook.
export function _clearDeliveredCompletions() {
    _delivered.clear();
}
