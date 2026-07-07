import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs';
import { appendFile } from 'fs/promises';
import { dirname, join } from 'path';
import os from 'os';
import { getPluginData } from './config.mjs';
import { readServicePort, markServiceUnreachable, isConnRefuseError } from '../../shared/service-discovery.mjs';

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
// Port of the discovery advert `_serviceUrl` was resolved from (null when it
// came from legacy active-instance.json). Lets a flush connect-failure distrust
// a recycled-pid corpse advert so the next resolve falls back to legacy/buffer.
let _serviceAdvertPort = null;
let _flushInFlight = false;
let _localTracePath = null;
let _localTraceBuffer = [];
let _localTraceTimer = null;
let _localTraceFlushInFlight = false;
let _toolFailurePath = null;
let _toolFailureBuffer = [];
let _toolFailureTimer = null;
let _toolFailureFlushInFlight = false;
const _LOCAL_TRACE_FLUSH_LINES = 100;
const _LOCAL_TRACE_FLUSH_MS = 1000;
const _LOCAL_TRACE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — rotate to .1/.2/.3 above this.
// Rotation generations kept on disk (.1 newest … .N oldest). A single .1
// generation proved too short a window — bench rounds (session-bench /
// task-bench re-scoring) were losing their raw turn rows to a second rotation
// within hours. 3 generations ≈ 40 MB worst case per log. Env-overridable via
// MIXDOG_AGENT_TRACE_ROTATE_KEEP (positive integer).
const _LOCAL_TRACE_ROTATE_KEEP = (() => {
    const v = parseInt(process.env.MIXDOG_AGENT_TRACE_ROTATE_KEEP, 10);
    return Number.isFinite(v) && v > 0 ? v : 3;
})();
const _TOOL_FAILURE_FLUSH_LINES = 50;
const _TOOL_FAILURE_FLUSH_MS = 1000;
// Throttle interval for local rotation stat checks. statSync on every flush
// is unnecessary — rotation is a best-effort size guard. First flush always
// checks; subsequent checks wait at least this many ms. Tune via env
// MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS (default 60000 ms, positive integer).
const MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS = (() => {
    const v = parseInt(process.env.MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS, 10);
    return Number.isFinite(v) && v > 0 ? v : 60000;
})();
let _lastRotateCheckMs = 0;
let _lastToolFailureRotateCheckMs = 0;

function warnAgentOnce(key, message) {
    if (!key || WARNED_KEYS.has(key)) return;
    WARNED_KEYS.add(key);
    try {
        process.stderr.write(`${message}\n`);
    }
    catch {
        // Ignore logging failures.
    }
}

function normalizeSessionId(sessionId) {
    return sessionId ? String(sessionId) : 'no-session';
}

function _rotateLocalTraceIfNeeded(path) {
    try {
        const stat = statSync(path);
        if (stat && stat.size > _LOCAL_TRACE_MAX_BYTES) {
            try {
                // Shift generations oldest-first: .2 → .3, .1 → .2, live → .1.
                // The oldest (.KEEP) is overwritten by the rename below it.
                for (let gen = _LOCAL_TRACE_ROTATE_KEEP - 1; gen >= 1; gen -= 1) {
                    const src = `${path}.${gen}`;
                    if (existsSync(src)) renameSync(src, `${path}.${gen + 1}`);
                }
                renameSync(path, `${path}.1`);
            }
            catch (err) {
                warnAgentOnce('agent-trace:local-rotate', `[agent-trace] local rotate failed (${err?.message})`);
            }
        }
    } catch {
        // File missing or unstattable — nothing to rotate.
    }
}

function _resolveLocalTracePath() {
    if (process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE === '1') return null;
    if (_localTracePath) return _localTracePath;
    try {
        _localTracePath = process.env.MIXDOG_AGENT_TRACE_PATH
            || join(getPluginData(), 'history', 'agent-trace.jsonl');
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
        warnAgentOnce('agent-trace:local-spool', `[agent-trace] local spool failed (${err?.message})`);
    }
}

function _flushLocalTrace() {
    if (_localTraceTimer) {
        clearTimeout(_localTraceTimer);
        _localTraceTimer = null;
    }
    if (_localTraceBuffer.length === 0) return;
    if (_localTraceFlushInFlight) {
        _localTraceTimer = setTimeout(_flushLocalTrace, 25);
        _localTraceTimer.unref?.();
        return;
    }
    const path = _resolveLocalTracePath();
    if (!path) return;
    const chunk = _localTraceBuffer.join('');
    _localTraceBuffer = [];
    try {
        // Throttle rotation stat checks to avoid unnecessary statSync calls
        // on every flush. First flush (_lastRotateCheckMs === 0) always checks.
        const now = Date.now();
        if (_lastRotateCheckMs === 0 || now - _lastRotateCheckMs >= MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS) {
            _rotateLocalTraceIfNeeded(path);
            _lastRotateCheckMs = now;
        }
    } catch (err) {
        warnAgentOnce('agent-trace:local-spool', `[agent-trace] local spool failed (${err?.message})`);
        return;
    }
    // mode only applies on file creation; existing files keep their mode.
    // Windows ignores POSIX bits — ACL governs there.
    _localTraceFlushInFlight = true;
    appendFile(path, chunk, { encoding: 'utf8', mode: 0o600 })
        .catch((err) => {
            warnAgentOnce('agent-trace:local-spool', `[agent-trace] local spool failed (${err?.message})`);
        })
        .finally(() => {
            _localTraceFlushInFlight = false;
            if (_localTraceBuffer.length > 0) {
                _localTraceTimer = setTimeout(_flushLocalTrace, 0);
                _localTraceTimer.unref?.();
            }
        });
}

function _flushLocalTraceSync() {
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
        const now = Date.now();
        if (_lastRotateCheckMs === 0 || now - _lastRotateCheckMs >= MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS) {
            _rotateLocalTraceIfNeeded(path);
            _lastRotateCheckMs = now;
        }
        appendFileSync(path, chunk, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
        warnAgentOnce('agent-trace:local-spool', `[agent-trace] local spool failed (${err?.message})`);
    }
}

try {
    process.on('beforeExit', () => {
        _flushLocalTraceSync();
        _flushToolFailuresSync();
    });
    process.on('exit', () => {
        _flushLocalTraceSync();
        _flushToolFailuresSync();
    });
} catch {
    // Ignore lifecycle hook failures in embedded runtimes.
}

function _resolveServiceUrl() {
    if (_serviceUrl) return _serviceUrl;
    try {
        // Prefer the single-writer discovery advert (discovery/memory.json),
        // pid-validated; fall back to legacy active-instance.json memory_port.
        const advertPort = readServicePort('memory', { requirePid: false });
        if (advertPort) { _serviceAdvertPort = advertPort; _serviceUrl = `http://127.0.0.1:${advertPort}`; return _serviceUrl; }
        _serviceAdvertPort = null;
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
        if (!_flushTimer) { _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS); _flushTimer.unref?.(); }
        return;
    }
    _flushInFlight = true;
    try {
        const url = _resolveServiceUrl();
        if (!url) {
            // Service not up yet — keep buffer, retry next timer tick
            if (!_flushTimer) { _flushTimer = setTimeout(_flush, _FLUSH_INTERVAL_MS); _flushTimer.unref?.(); }
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
            // Always drain the body. An undrained response body keeps the
            // underlying keep-alive socket referenced, which can hold the event
            // loop open and make a short-lived process (smoke scripts / one-shot
            // agent tasks) appear to hang for seconds after its work is done.
            try { await resp.arrayBuffer(); } catch { /* body already gone */ }
            if (!resp.ok) {
                warnAgentOnce('agent-trace:flush-error', `[agent-trace] /admin/trace-record returned ${resp.status} — dropping batch`);
            }
        } catch (err) {
            _serviceUrl = null;
            // Discovery-first consumer with no health probe: a connect failure
            // means the pid-validated advert points at a dead (recycled-pid)
            // port. Distrust it (connection-level errors ONLY — a timeout is a
            // slow-but-alive daemon, not a corpse) so the next resolve falls back
            // to legacy/buffer instead of re-trusting the same advert.
            if (_serviceAdvertPort && isConnRefuseError(err)) markServiceUnreachable('memory', _serviceAdvertPort);
            _serviceAdvertPort = null;
            warnAgentOnce('agent-trace:flush-fetch', `[agent-trace] flush fetch failed (${err?.message}) — dropping batch`);
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
        // Never let the periodic trace flush keep the event loop alive: a
        // ref'd 5s timer prevented short-lived processes (smoke scripts, agent
        // tasks) from exiting naturally after their work was done — they hung
        // until an external timeout/kill. exit/beforeExit drains still flush
        // the buffer, so unref loses no data.
        _flushTimer.unref?.();
    }
}

async function drainAgentTrace() {
    if (!_resolveServiceUrl()) return;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    for (let i = 0; i < 10 && _buffer.length > 0; i++) {
        await _flush();
    }
}
process.on('exit', drainAgentTrace);

function appendAgentTrace(record = {}) {
    // Test isolation — when run-all-tests.mjs sets this env, skip entirely.
    if (process.env.MIXDOG_AGENT_TRACE_DISABLE === '1') return;
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
            warnAgentOnce('agent-trace:buffer-full', '[agent-trace] buffer full (2000) — dropping oldest event');
        }
        _appendLocalTrace(row);
        _buffer.push(row);
        _scheduleFlush(_buffer.length >= _FLUSH_BATCH_SIZE);
    }
    catch {
        // Never break agent execution for telemetry
    }
}

function _resolveToolFailurePath() {
    if (process.env.MIXDOG_TOOL_FAILURE_LOG_DISABLE === '1') return null;
    if (_toolFailurePath) return _toolFailurePath;
    try {
        _toolFailurePath = process.env.MIXDOG_TOOL_FAILURE_LOG_PATH
            || join(getPluginData(), 'history', 'tool-failures.jsonl');
        mkdirSync(dirname(_toolFailurePath), { recursive: true, mode: 0o700 });
        return _toolFailurePath;
    } catch {
        return null;
    }
}

function _scheduleToolFailureFlush(delayMs = _TOOL_FAILURE_FLUSH_MS) {
    if (_toolFailureTimer) return;
    _toolFailureTimer = setTimeout(_flushToolFailures, delayMs);
    _toolFailureTimer.unref?.();
}

function _maybeRotateToolFailureLog(path) {
    const now = Date.now();
    if (_lastToolFailureRotateCheckMs !== 0 && now - _lastToolFailureRotateCheckMs < MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS) return;
    _rotateLocalTraceIfNeeded(path);
    _lastToolFailureRotateCheckMs = now;
}

function _appendToolFailureRow(row) {
    if (!_resolveToolFailurePath()) return;
    try {
        _toolFailureBuffer.push(`${JSON.stringify(row)}\n`);
        if (_toolFailureBuffer.length >= _TOOL_FAILURE_FLUSH_LINES) {
            _flushToolFailures();
        } else {
            _scheduleToolFailureFlush();
        }
    } catch (err) {
        warnAgentOnce('tool-failure-log:append', `[tool-failure-log] append failed (${err?.message})`);
    }
}

function _flushToolFailures() {
    if (_toolFailureTimer) {
        clearTimeout(_toolFailureTimer);
        _toolFailureTimer = null;
    }
    if (_toolFailureBuffer.length === 0) return;
    if (_toolFailureFlushInFlight) {
        _scheduleToolFailureFlush(25);
        return;
    }
    const path = _resolveToolFailurePath();
    if (!path) return;
    const chunk = _toolFailureBuffer.join('');
    _toolFailureBuffer = [];
    try {
        _maybeRotateToolFailureLog(path);
    } catch (err) {
        warnAgentOnce('tool-failure-log:rotate', `[tool-failure-log] rotate check failed (${err?.message})`);
    }
    _toolFailureFlushInFlight = true;
    appendFile(path, chunk, { encoding: 'utf8', mode: 0o600 })
        .catch((err) => {
            warnAgentOnce('tool-failure-log:append', `[tool-failure-log] append failed (${err?.message})`);
        })
        .finally(() => {
            _toolFailureFlushInFlight = false;
            if (_toolFailureBuffer.length > 0) _scheduleToolFailureFlush(0);
        });
}

function _flushToolFailuresSync() {
    if (_toolFailureTimer) {
        clearTimeout(_toolFailureTimer);
        _toolFailureTimer = null;
    }
    if (_toolFailureBuffer.length === 0) return;
    const path = _resolveToolFailurePath();
    if (!path) return;
    const chunk = _toolFailureBuffer.join('');
    _toolFailureBuffer = [];
    try {
        _maybeRotateToolFailureLog(path);
        appendFileSync(path, chunk, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
        warnAgentOnce('tool-failure-log:append', `[tool-failure-log] append failed (${err?.message})`);
    }
}

export {
    appendAgentTrace,
    drainAgentTrace,
    normalizeSessionId,
    warnAgentOnce,
    _resolveToolFailurePath,
    _appendToolFailureRow,
};
