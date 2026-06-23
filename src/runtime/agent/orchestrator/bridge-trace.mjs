import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import os from 'os';
import { getPluginData } from './config.mjs';
import { isInclusiveProvider } from '../../shared/llm/cost.mjs';
import { countJsonNextCalls } from './tools/next-call-utils.mjs';

const WARNED_KEYS = new Set();

// ---------------------------------------------------------------------------
// In-memory buffer + HTTP flush to memory-service /admin/trace-record
// ---------------------------------------------------------------------------
let _buffer = [];
const _BUFFER_MAX = 2000;
const _FLUSH_INTERVAL_MS = 5000;
const _FLUSH_BATCH_SIZE = 500;
let _flushTimer = null;
let _serviceUrl = null;
let _flushInFlight = false;
let _localTracePath = null;
let _localTraceBuffer = [];
let _localTraceTimer = null;
const _LOCAL_TRACE_FLUSH_LINES = 100;
const _LOCAL_TRACE_FLUSH_MS = 1000;
const _LOCAL_TRACE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — rotate to .1 above this.

function _rotateLocalTraceIfNeeded(path) {
    try {
        const stat = statSync(path);
        if (stat && stat.size > _LOCAL_TRACE_MAX_BYTES) {
            try { renameSync(path, `${path}.1`); }
            catch (err) {
                warnBridgeOnce('bridge-trace:local-rotate', `[bridge-trace] local rotate failed (${err?.message})`);
            }
        }
    } catch {
        // File missing or unstattable — nothing to rotate.
    }
}

function _resolveLocalTracePath() {
    if (process.env.MIXDOG_BRIDGE_TRACE_LOCAL_DISABLE === '1') return null;
    if (_localTracePath) return _localTracePath;
    try {
        _localTracePath = process.env.MIXDOG_BRIDGE_TRACE_PATH
            || join(getPluginData(), 'history', 'bridge-trace.jsonl');
        // R4 data-at-rest: trace rows may carry tool payloads / prompts;
        // clamp dir to owner-only on POSIX (advisory on Windows).
        mkdirSync(dirname(_localTracePath), { recursive: true, mode: 0o700 });
        return _localTracePath;
    } catch {
        return null;
    }
}

function _appendLocalTrace(row) {
    if (!_resolveLocalTracePath()) return;
    try {
        _localTraceBuffer.push(`${JSON.stringify(row)}\n`);
        if (_localTraceBuffer.length >= _LOCAL_TRACE_FLUSH_LINES) {
            _flushLocalTrace();
        } else if (!_localTraceTimer) {
            _localTraceTimer = setTimeout(_flushLocalTrace, _LOCAL_TRACE_FLUSH_MS);
            _localTraceTimer.unref?.();
        }
    } catch (err) {
        warnBridgeOnce('bridge-trace:local-spool', `[bridge-trace] local spool failed (${err?.message})`);
    }
}

function _flushLocalTrace() {
    if (_localTraceTimer) {
        clearTimeout(_localTraceTimer);
        _localTraceTimer = null;
    }
    if (_localTraceBuffer.length === 0) return;
    const path = _resolveLocalTracePath();
    if (!path) return;
    const chunk = _localTraceBuffer.join('');
    _localTraceBuffer = [];
    try {
        _rotateLocalTraceIfNeeded(path);
        // mode only applies on file creation; existing files keep their mode.
        // Windows ignores POSIX bits — ACL governs there.
        appendFileSync(path, chunk, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
        warnBridgeOnce('bridge-trace:local-spool', `[bridge-trace] local spool failed (${err?.message})`);
    }
}

try {
    process.on('beforeExit', _flushLocalTrace);
    process.on('exit', _flushLocalTrace);
} catch {
    // Ignore lifecycle hook failures in embedded runtimes.
}

function _resolveServiceUrl() {
    if (_serviceUrl) return _serviceUrl;
    try {
        const runtimeRoot = process.env.MIXDOG_RUNTIME_ROOT
            ? join(process.env.MIXDOG_RUNTIME_ROOT)
            : join(os.tmpdir(), 'mixdog');
        const activeFile = join(runtimeRoot, 'active-instance.json');
        if (!existsSync(activeFile)) return null;
        const active = JSON.parse(readFileSync(activeFile, 'utf-8'));
        const port = Number(active && active.memory_port);
        if (!Number.isFinite(port) || port <= 0) return null;
        _serviceUrl = `http://127.0.0.1:${port}`;
        return _serviceUrl;
    } catch {
        return null;
    }
}

async function _flush() {
    _flushTimer = null;
    if (_buffer.length === 0) return;
    if (_flushInFlight) {
        if (!_flushTimer) _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS);
        return;
    }
    _flushInFlight = true;
    try {
        const url = _resolveServiceUrl();
        if (!url) {
            // Service not up yet — keep buffer, retry next timer tick
            if (!_flushTimer) _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS);
            return;
        }
        const batch = _buffer.splice(0, _FLUSH_BATCH_SIZE);
        try {
            const resp = await fetch(`${url}/admin/trace-record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: batch }),
                signal: AbortSignal.timeout(5000),
            });
            if (!resp.ok) {
                warnBridgeOnce('bridge-trace:flush-error', `[bridge-trace] /admin/trace-record returned ${resp.status} — dropping batch`);
            }
        } catch (err) {
            _serviceUrl = null;
            warnBridgeOnce('bridge-trace:flush-fetch', `[bridge-trace] flush fetch failed (${err?.message}) — dropping batch`);
        }
        if (_buffer.length >= _FLUSH_BATCH_SIZE) {
            // More pending — schedule another flush immediately
            setImmediate(_flush);
        }
    } finally {
        _flushInFlight = false;
    }
}

function _scheduleFlush(immediate = false) {
    if (immediate) {
        if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
        setImmediate(_flush);
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS);
    }
}

async function drainBridgeTrace() {
    if (!_resolveServiceUrl()) return;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    for (let i = 0; i < 10 && _buffer.length > 0; i++) {
        await _flush();
    }
}
process.on('exit', drainBridgeTrace);

function normalizeSessionId(sessionId) {
    return sessionId ? String(sessionId) : 'no-session';
}

function appendBridgeTrace(record = {}) {
    // Test isolation — when run-all-tests.mjs sets this env, skip entirely.
    if (process.env.MIXDOG_BRIDGE_TRACE_DISABLE === '1') return;
    try {
        // Coerce ts to epoch ms integer at enqueue time
        let ts = record.ts || Date.now();
        if (typeof ts === 'string') ts = Date.parse(ts);
        ts = Number(ts);
        if (!Number.isFinite(ts)) ts = Date.now();

        const row = {
            ...record,
            ts,
            session_id: record.session_id ?? normalizeSessionId(record.sessionId),
            payload: record.payload ?? {},
        };
        // Drop actor-facing alias to keep schema tidy
        delete row.sessionId;

        if (_buffer.length >= _BUFFER_MAX) {
            _buffer.shift(); // drop oldest
            warnBridgeOnce('bridge-trace:buffer-full', '[bridge-trace] buffer full (2000) — dropping oldest event');
        }
        _appendLocalTrace(row);
        _buffer.push(row);
        _scheduleFlush(_buffer.length >= _FLUSH_BATCH_SIZE);
    }
    catch {
        // Never break bridge execution for telemetry
    }
}

function estimateProviderPayloadBytes(messages, model, tools) {
    try {
        return Buffer.byteLength(JSON.stringify({ model, messages, tools: tools || [] }), 'utf8');
    }
    catch {
        return null;
    }
}

function extractCachedTokens(usage) {
    const candidates = [
        usage?.input_tokens_details?.cached_tokens,
        usage?.prompt_tokens_details?.cached_tokens,
        usage?.inputTokensDetails?.cachedTokens,
        usage?.promptTokensDetails?.cachedTokens,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

function warnBridgeOnce(key, message) {
    if (!key || WARNED_KEYS.has(key)) return;
    WARNED_KEYS.add(key);
    try {
        process.stderr.write(`${message}\n`);
    }
    catch {
        // Ignore logging failures.
    }
}

function traceBridgeLoop({ sessionId, iteration, sendMs, messageCount, bodyBytesEst }) {
    if (process.env.MIXDOG_BRIDGE_TRACE_VERBOSE !== '1') return;
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'loop',
        send_ms: sendMs,
        message_count: messageCount,
        body_bytes_est: bodyBytesEst,
    });
}

// Lightweight fingerprint of the conversation prefix. Hashes the first 4096
// characters of JSON.stringify(messages) — enough to detect prefix mutation
// across iterations (which invalidates the provider prompt cache) without
// hashing megabytes per turn. Truncated SHA1 keeps the trace row compact.
function messagePrefixHash(messages) {
    try {
        const json = JSON.stringify(messages || []);
        const slice = json.length > 4096 ? json.slice(0, 4096) : json;
        return createHash('sha1').update(slice).digest('hex').slice(0, 12);
    } catch {
        return null;
    }
}

function traceBridgeCompact({
    sessionId,
    iteration,
    stage,
    prune_count,
    compact_changed,
    input_prefix_hash,
    before_count,
    after_count,
    before_bytes,
    after_bytes,
    context_window,
    budget_tokens,
    reserve_tokens,
    message_tokens_est,
    provider,
    model,
    error,
    error_code,
}) {
    if (process.env.MIXDOG_BRIDGE_TRACE_VERBOSE !== '1') return;
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'compact_meta',
        stage: stage || null,
        prune_count: prune_count ?? 0,
        compact_changed: !!compact_changed,
        input_prefix_hash: input_prefix_hash || null,
        before_count: before_count ?? null,
        after_count: after_count ?? null,
        before_bytes: before_bytes ?? null,
        after_bytes: after_bytes ?? null,
        context_window: context_window ?? null,
        budget_tokens: budget_tokens ?? null,
        reserve_tokens: reserve_tokens ?? null,
        message_tokens_est: message_tokens_est ?? null,
        provider: provider || null,
        model: model || null,
        error: error || null,
        error_code: error_code || null,
    });
}

const TOOL_ARG_KEYS = {
    read: ['path', 'mode', 'n', 'offset', 'limit', 'full'],
    grep: ['pattern', 'path', 'glob', 'output_mode', 'head_limit', 'offset', 'type', '-i', '-n', '-A', '-B', '-C', 'context', 'multiline'],
    glob: ['pattern', 'path', 'head_limit', 'offset'],
    list: ['path', 'mode', 'depth', 'hidden', 'sort', 'type', 'head_limit', 'offset', 'name', 'min_size', 'max_size', 'modified_after', 'modified_before'],
    code_graph: ['mode', 'file', 'symbol', 'language', 'limit'],
    bash: ['command', 'cwd', 'timeout', 'run_in_background', 'persistent', 'session_id'],
    job_wait: ['job_id', 'timeout_ms', 'poll_ms'],
    edit: ['path', 'replace_all', 'edits'],
    edit_many: ['edits'],
    write: ['path', 'writes'],
    apply_patch: ['base_path', 'dry_run', 'reject_partial'],
};

const REDACT_KEY_RE = /token|secret|password|passwd|credential|authorization|api[_-]?key/i;
const BODY_KEY_RE = /content|old_string|new_string|patch|rewrite/i;
// Redact bash `command` values that look like they carry secrets. Covers
// assignment forms, Authorization headers, --password / -p flags, and
function _redactShellCommand(cmd) {
    if (typeof cmd !== 'string') return cmd;
    let out = cmd;
    // Assignment RHS: PASSWORD=, SECRET=, TOKEN=, API_KEY=/APIKEY=.
    out = out.replace(/((?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY)\s*=\s*)\S+/gi, '$1[redacted]');
    // Authorization: Bearer <token>.
    out = out.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[redacted]');
    // Long flags: --password <v> / --password=<v> (also --token, --secret, --api-key).
    out = out.replace(/(--(?:password|token|secret|api[-_]?key)(?:\s+|=))\S+/gi, '$1[redacted]');
    // Short -p <v> flag (mysql/psql/curl style).
    out = out.replace(/((?:^|\s)-p(?:\s+|=))\S+/g, '$1[redacted]');
    // URL userinfo: scheme://user:secret@host -> scheme://user:[redacted]@host.
    out = out.replace(/(:\/\/[^:\/\s@]+:)[^@\s]+(@)/g, '$1[redacted]$2');
    // URL query params carrying tokens/keys.
    out = out.replace(/([?&](?:token|api[-_]?key|access[-_]?token|auth|password|secret)=)[^&\s#]+/gi, '$1[redacted]');
    return out;
}

function compactTraceArgValue(value, key = '', depth = 0) {
    if (REDACT_KEY_RE.test(key)) return '[redacted]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        // Redact shell commands that embed secrets before length-truncating.
        if (key === 'command') {
            value = _redactShellCommand(value);
        }
        const limit = BODY_KEY_RE.test(key) ? 60 : 180;
        return value.length > limit ? `${value.slice(0, limit)}...` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        if (depth >= 2) return `[${value.length} items]`;
        return value.slice(0, 6).map((v) => compactTraceArgValue(v, key, depth + 1));
    }
    if (typeof value === 'object') {
        if (depth >= 2) return '{...}';
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 12)) {
            out[k] = compactTraceArgValue(v, k, depth + 1);
        }
        return out;
    }
    return String(value);
}

function summarizeToolArgs(toolName, args) {
    if (!args || typeof args !== 'object') return null;
    const keys = TOOL_ARG_KEYS[String(toolName || '')] || Object.keys(args).slice(0, 8);
    const out = {};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(args, key)) out[key] = compactTraceArgValue(args[key], key);
    }
    for (const countKey of ['edits', 'writes']) {
        if (Array.isArray(args[countKey])) out[`${countKey}_count`] = args[countKey].length;
    }
    if (toolName === 'read' && Array.isArray(args.path)) {
        out.path_count = args.path.length;
    }
    return Object.keys(out).length ? out : null;
}

function traceBridgeTool({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs, role, resultKind, model, resultText }) {
    const nextCallCount = countJsonNextCalls(resultText);
    // Flat shape — fields named exactly as the bridge_calls PG columns so
    // insertBridgeCalls can pick them up by direct property access without
    // a payload-unwrap step. result_kind has no column and rides as plain
    // sibling metadata for downstream consumers.
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool',
        role: role || null,
        model: model || null,
        tool_name: toolName,
        tool_kind: toolKind,
        tool_ms: toolMs,
        tool_args: summarizeToolArgs(toolName, toolArgs),
        result_kind: resultKind || null,
        result_has_next_call: nextCallCount > 0,
        result_next_call_count: nextCallCount,
        result_bytes_est: typeof resultText === 'string' ? Buffer.byteLength(resultText, 'utf8') : 0,
        result_lines_est: typeof resultText === 'string' && resultText.length > 0 ? resultText.split('\n').length : 0,
    });
}

// Compression layer trace (result-compression.mjs). One row per tool call
// where compression actually changed the byte count, so `gain` analytics
// can sum savings_pct over a window (mirrors RTK's `rtk gain` model
// without an external binary). No-op rows are dropped at the call site.
export function traceBridgeCompress({ sessionId, toolName, before, after }) {
    // bytes_before/after/savings_pct moved into payload because the
    // trace_events table only carries known top-level columns (id, ts,
    // session_id, kind, tool_name, payload, ...) — fields outside that
    // set are silently dropped at insert time. payload is jsonb so any
    // shape survives. Aggregation: SELECT (payload->>'bytes_before')::int.
    appendBridgeTrace({
        sessionId,
        kind: 'compress',
        tool_name: toolName,
        payload: {
            bytes_before: before,
            bytes_after: after,
            savings_pct: before > 0 ? Math.round((1 - after / before) * 100) : 0,
        },
    });
}

// Per-turn batch shape — one row per assistant turn with the number of
// tool calls observed. Lets a consumer compute Lead-side multi-tool
// adoption ratio (calls > 1 / total turns) directly from trace rows
// instead of re-parsing every assistant message body.
export function traceBridgeBatch({ sessionId, toolCallCount }) {
    appendBridgeTrace({
        sessionId,
        kind: 'batch',
        tool_call_count: toolCallCount,
    });
}

function _sanitizeSample(sample) {
    if (sample == null) return sample;
    if (typeof sample === 'string' || typeof sample === 'object') {
        return compactTraceArgValue(sample, '', 0);
    }
    return sample;
}

function traceStreamStalled({ sessionId, info }) {
    appendBridgeTrace({
        sessionId,
        kind: 'stream_stalled',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceStreamAborted({ sessionId, info }) {
    appendBridgeTrace({
        sessionId,
        kind: 'stream_aborted',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceBridgePreset({ sessionId, role, presetName, model, provider, parentSessionId }) {
    // Fires once per dispatch right after the preset has been resolved and
    // its runtime spec (provider/model) assembled. Useful for after-the-fact
    // routing analysis: "which role landed on which preset / provider / model
    // on this request?"
    appendBridgeTrace({
        sessionId,
        kind: 'preset_assign',
        role: role || null,
        preset_name: presetName || null,
        model: model || null,
        provider: provider || null,
        parent_session_id: parentSessionId || null,
    });
}

function traceBridgeFetch({ sessionId, headersMs, httpStatus, handshakeRetries, handshakeRetryClassifiers, provider, model, transport }) {
    const payload = {
        headers_ms: headersMs,
        http_status: httpStatus,
        provider: provider || null,
        model: model || null,
        transport: transport || null,
    };
    if (Number.isFinite(Number(handshakeRetries))) {
        payload.handshake_retries = Number(handshakeRetries);
    }
    if (Array.isArray(handshakeRetryClassifiers) && handshakeRetryClassifiers.length > 0) {
        payload.handshake_retry_classifiers = handshakeRetryClassifiers;
    }
    appendBridgeTrace({
        sessionId,
        kind: 'fetch',
        headers_ms: headersMs,
        http_status: httpStatus,
        provider: provider || null,
        model: model || null,
        transport: transport || null,
        handshake_retries: payload.handshake_retries,
        handshake_retry_classifiers: payload.handshake_retry_classifiers,
        payload,
    });
}

function traceBridgeSse({ sessionId, sseParseMs, ttftMs, provider, model, transport }) {
    appendBridgeTrace({
        sessionId,
        kind: 'sse',
        sse_parse_ms: sseParseMs,
        ttft_ms: ttftMs,
        provider: provider || null,
        model: model || null,
        transport: transport || null,
        payload: {
            sse_parse_ms: sseParseMs,
            ttft_ms: ttftMs,
            provider: provider || null,
            model: model || null,
            transport: transport || null,
        },
    });
}

function traceBridgeUsage({ sessionId, iteration, inputTokens, outputTokens, cachedTokens, cacheWriteTokens, promptTokens, model, modelDisplay, responseId, rawUsage, provider, serviceTier, requestKind }) {
    const inclusive = isInclusiveProvider(provider);
    const inTok = inputTokens || 0;
    const cacheRead = cachedTokens || 0;
    const cacheWrite = cacheWriteTokens || 0;
    const uncachedInputTokens = inclusive ? Math.max(inTok - cacheRead - cacheWrite, 0) : inTok;
    const promptTotal = typeof promptTokens === 'number'
        ? promptTokens
        : (inclusive
            ? Math.max(inTok, cacheRead + cacheWrite)
            : inTok + cacheRead + cacheWrite);
    const resolvedServiceTier = serviceTier || rawUsage?.service_tier || rawUsage?.serviceTier || null;
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'usage_raw',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheWrite,
        uncached_input_tokens: uncachedInputTokens,
        // Unified total-prompt field. Anthropic = input+cache_read+cache_write,
        // OpenAI/Gemini = input_tokens (cached is already a subset).
        prompt_tokens: promptTotal,
        model: model || null,
        model_display: modelDisplay || null,
        response_id: responseId || null,
        request_kind: typeof requestKind === 'string' && requestKind ? requestKind : null,
        service_tier: resolvedServiceTier,
        payload: {
            provider: provider || null,
            prompt_tokens: promptTotal,
            uncached_input_tokens: uncachedInputTokens,
            model_display: modelDisplay || null,
            response_id: responseId || null,
            service_tier: resolvedServiceTier,
            raw_usage: rawUsage || null,
        },
    });
}

export {
    appendBridgeTrace,
    drainBridgeTrace,
    estimateProviderPayloadBytes,
    extractCachedTokens,
    messagePrefixHash,
    traceBridgeFetch,
    traceBridgeLoop,
    traceBridgePreset,
    traceBridgeSse,
    traceBridgeTool,
    traceBridgeCompact,
    traceBridgeUsage,
    traceStreamAborted,
    traceStreamStalled,
    warnBridgeOnce,
};
