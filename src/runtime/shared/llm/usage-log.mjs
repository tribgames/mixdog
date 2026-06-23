/**
 * Unified LLM usage logger.
 *
 * Phase 2: Routes via appendBridgeTrace (HTTP buffer to memory-service)
 * instead of writing directly to bridge-trace.jsonl.
 *
 * Signature unchanged — callers are unaffected.
 */

import { appendBridgeTrace } from '../../agent/orchestrator/bridge-trace.mjs';

/**
 * Append a usage entry to the trace store.
 *
 * @param {object} entry — usage record
 * @param {object} opts
 * @param {boolean} [opts.maintenance=false] — flag record as maintenance-origin
 *
 * Entry schema:
 *   ts, preset, model, provider, mode, duration,
 *   profileId, sessionId,
 *   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *   prefixHash, costUsd
 */
const _missingProviderWarned = new Set();
function warnMissingProviderOnce(key) {
    if (_missingProviderWarned.has(key)) return;
    _missingProviderWarned.add(key);
    try {
        process.stderr.write(`[usage-log] provider missing on usage entry (model=${key}). audit the caller.\n`);
    } catch { /* logging only */ }
}

export function logLlmCall(entry, opts = {}) {
    try {
        if (!entry.provider) warnMissingProviderOnce(entry.model || '?');
        appendBridgeTrace({
            ts: entry.ts || Date.now(),
            kind: 'usage',
            ...entry,
            payload: entry.payload ?? {},
            maintenanceLog: opts.maintenance === true ? true : undefined,
        });
    } catch {
        // Never let logging break the caller.
    }
}
