import { createHash } from 'crypto';
import { countJsonNextCalls } from './tools/next-call-utils.mjs';
import { splitGrepLinePrefix } from './tools/builtin/grep-formatting.mjs';
import {
    appendAgentTrace,
    normalizeSessionId,
    warnAgentOnce,
    _resolveToolFailurePath,
    _appendToolFailureRow,
} from './agent-trace-io.mjs';

const MIXDOG_SLOW_TOOL_TRACE_MS = (() => {
    const v = parseInt(process.env.MIXDOG_SLOW_TOOL_TRACE_MS, 10);
    return Number.isFinite(v) && v > 0 ? v : 3000;
})();
const MIXDOG_SLOW_TOOL_TRACE_NAMES_RAW = String(process.env.MIXDOG_SLOW_TOOL_TRACE_NAMES || 'recall,grep,code_graph');
const MIXDOG_SLOW_TOOL_TRACE_ALL = MIXDOG_SLOW_TOOL_TRACE_NAMES_RAW.trim() === '*';
const MIXDOG_SLOW_TOOL_TRACE_NAMES = new Set(
    MIXDOG_SLOW_TOOL_TRACE_NAMES_RAW
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
);

function traceAgentLoop({ sessionId, iteration, sendMs, messageCount, bodyBytesEst, agent = null }) {
    // Two emit modes, no behavior change either way:
    //   VERBOSE=1 → full loop row incl. body_bytes_est (payload serialized).
    //   TIMING=1  → lightweight send-latency attribution for high-fanout
    //               benches; bodyBytesEst is skipped upstream so measuring
    //               the send does not perturb it (body_bytes_est → null).
    if (process.env.MIXDOG_AGENT_TRACE_VERBOSE !== '1'
        && process.env.MIXDOG_AGENT_TRACE_TIMING !== '1') return;
    appendAgentTrace({
        sessionId,
        iteration,
        kind: 'loop',
        agent: agent || null,
        send_ms: sendMs,
        message_count: messageCount,
        body_bytes_est: bodyBytesEst ?? null,
    });
}

function traceAgentCompact({
    sessionId,
    iteration,
    stage,
    trigger,
    compact_type,
    prune_count,
    compact_changed,
    input_prefix_hash,
    before_count,
    after_count,
    before_bytes,
    after_bytes,
    context_window,
    budget_tokens,
    boundary_tokens,
    target_budget_tokens,
    reserve_tokens,
    pressure_tokens,
    trigger_tokens,
    message_tokens_est,
    duration_ms,
    provider,
    model,
    error,
    error_code,
    details,
}) {
    appendAgentTrace({
        sessionId,
        iteration,
        kind: 'compact_meta',
        stage: stage || null,
        trigger: trigger || null,
        compact_type: compact_type || null,
        prune_count: prune_count ?? 0,
        compact_changed: !!compact_changed,
        input_prefix_hash: input_prefix_hash || null,
        before_count: before_count ?? null,
        after_count: after_count ?? null,
        before_bytes: before_bytes ?? null,
        after_bytes: after_bytes ?? null,
        context_window: context_window ?? null,
        budget_tokens: budget_tokens ?? null,
        boundary_tokens: boundary_tokens ?? null,
        target_budget_tokens: target_budget_tokens ?? null,
        reserve_tokens: reserve_tokens ?? null,
        pressure_tokens: pressure_tokens ?? null,
        trigger_tokens: trigger_tokens ?? null,
        message_tokens_est: message_tokens_est ?? null,
        duration_ms: duration_ms ?? null,
        provider: provider || null,
        model: model || null,
        error: error || null,
        error_code: error_code || null,
        details: details && typeof details === 'object' ? details : null,
    });
}

const TOOL_ARG_KEYS = {
    read: ['path', 'offset', 'limit', 'line', 'context', 'symbol'],
    grep: ['pattern', 'path', 'glob', 'output_mode', 'head_limit', 'offset'],
    glob: ['pattern', 'path', 'head_limit', 'offset', 'sort'],
    find: ['query', 'path', 'head_limit'],
    list: ['path', 'head_limit', 'offset'],
    recall: ['query', 'limit', 'session_id', 'cwd'],
    search: ['query', 'limit', 'cwd'],
    explore: ['query', 'queries', 'limit', 'cwd'],
    code_graph: ['mode', 'file', 'files', 'symbol', 'symbols', 'body', 'language', 'limit', 'depth', 'page', 'cwd'],
    shell: ['command', 'cwd', 'timeout', 'mode', 'run_in_background', 'persistent', 'session_id'],
    task: ['task_id', 'action', 'timeout_ms', 'poll_ms'],
    edit: ['path', 'replace_all', 'edits'],
    edit_many: ['edits'],
    write: ['path'],
    apply_patch: ['base_path', 'dry_run'],
};

const REDACT_KEY_RE = /token|secret|password|passwd|credential|authorization|api[_-]?key/i;
const BODY_KEY_RE = /content|old_string|new_string|patch|rewrite/i;
// Redact shell `command` values that look like they carry secrets. Covers
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

function stableTraceStringify(value) {
    if (value === null || value === undefined) return JSON.stringify(value);
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableTraceStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableTraceStringify(value[k])}`).join(',') + '}';
}

function hashTraceValue(value) {
    try {
        return createHash('sha256').update(stableTraceStringify(value)).digest('hex').slice(0, 16);
    } catch {
        return null;
    }
}

function _firstNonEmptyLine(text) {
    return String(text ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}

function _redactLogText(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    out = out.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[redacted]');
    out = out.replace(/([?&](?:token|api[-_]?key|access[-_]?token|auth|password|secret)=)[^&\s#]+/gi, '$1[redacted]');
    out = out.replace(/((?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY)\s*=\s*)\S+/gi, '$1[redacted]');
    return out;
}

const GREP_COVERAGE_MAX = 512;
export function parseGrepCoverage(resultText, toolName, toolArgs, resultKind) {
    if (toolName !== 'grep' || resultKind === 'error' || (toolArgs?.output_mode && toolArgs.output_mode !== 'content_with_context')) return null;
    const out = [];
    const seen = new Set();
    let sectionPath = null;
    for (const line of String(resultText ?? '').split(/\r?\n/)) {
        const section = line.match(/^# grep (.+)$/);
        if (section) {
            if (!section[1].startsWith('pattern:')) sectionPath = section[1];
            continue;
        }
        const split = splitGrepLinePrefix(line);
        const omitted = !split && typeof toolArgs?.path === 'string'
            ? String(line).match(/^(\d+)(?::|-)/)
            : null;
        const sectionOmitted = !split && sectionPath
            ? String(line).match(/^(\d+)(?::|-)/)
            : null;
        const path = split?.path || (omitted ? toolArgs.path : null) || (sectionOmitted ? sectionPath : null);
        const lineNo = split?.lineNo || (omitted ? Number(omitted[1]) : null)
            || (sectionOmitted ? Number(sectionOmitted[1]) : null);
        if (!path || !Number.isInteger(lineNo) || lineNo < 1) continue;
        const key = `${path}\0${lineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: String(path).replace(/\\/g, '/'), line: lineNo });
        if (out.length >= GREP_COVERAGE_MAX) break;
    }
    return out.length ? out : null;
}

function classifyToolFailure(resultText, toolName) {
    const text = String(resultText ?? '').toLowerCase();
    if (/\[shell-tool-failed\]/i.test(String(resultText ?? ''))) return 'tool-call/failure';
    if (/\[shell-run-failed\]/i.test(String(resultText ?? ''))) {
        if (/timeout|timed out|aborted|interrupted/.test(text)) return 'timeout/abort';
        return 'command-exit';
    }
    if (/requires either|invalid arguments|unknown parameter|must be|schema|expected|required|old_string is .*>=/.test(text)) return 'schema/args';
    if (/not in allow-list|not allowed/.test(text)) return 'permission';
    if (String(toolName || '') === 'shell' || /^\s*\[exit code:\s*\d+\]/i.test(String(resultText ?? ''))) return 'command-exit';
    if (/enoent|cannot find|not found at this path|path does not exist|no such file|file not found in graph|unreadable/.test(text)) return 'path/enoent';
    if (/timed out|timeout|interrupted|aborted/.test(text)) return 'timeout/abort';
    if (/hunk rejected|patch failed|context mismatch|expected first old\/context|context not found/.test(text)) return 'patch/context';
    if (/permission|denied|forbidden/.test(text)) return 'permission';
    if (/unknown tool|tool.*not.*available|missing.*tool/.test(text)) return 'tool-surface';
    return 'runtime/failure';
}

function traceAgentToolFailure({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs, agent, model, cwd, resultText, resultKind = 'error' }) {
    if (process.env.MIXDOG_AGENT_TRACE_DISABLE === '1') return;
    if (!_resolveToolFailurePath()) return;
    try {
        const cleanText = _redactLogText(String(resultText ?? ''));
        const row = {
            ts: Date.now(),
            session_id: normalizeSessionId(sessionId),
            iteration: iteration ?? null,
            tool_name: toolName || null,
            tool_kind: toolKind || null,
            result_kind: resultKind || 'error',
            category: classifyToolFailure(cleanText, toolName),
            agent: agent || null,
            model: model || null,
            cwd: cwd || null,
            tool_ms: Number.isFinite(Number(toolMs)) ? Number(toolMs) : null,
            tool_args: summarizeToolArgs(toolName, toolArgs),
            error_first_line: _firstNonEmptyLine(cleanText).slice(0, 300),
            error_preview: cleanText.slice(0, 1200),
            result_bytes_est: Buffer.byteLength(cleanText, 'utf8'),
            result_lines_est: cleanText.length > 0 ? cleanText.split('\n').length : 0,
        };
        _appendToolFailureRow(row);
    } catch (err) {
        warnAgentOnce('tool-failure-log:append', `[tool-failure-log] append failed (${err?.message})`);
    }
}

function traceAgentTool({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs, agent, resultKind, model, resultText, cwd }) {
    const nextCallCount = countJsonNextCalls(resultText);
    const resultBytesEst = typeof resultText === 'string' ? Buffer.byteLength(resultText, 'utf8') : 0;
    const resultLinesEst = typeof resultText === 'string' && resultText.length > 0 ? resultText.split('\n').length : 0;
    const numericToolMs = Number(toolMs);
    const summarizedArgs = summarizeToolArgs(toolName, toolArgs);
    const grepCoverage = parseGrepCoverage(resultText, toolName, toolArgs, resultKind);
    // Hash the FULL args, not the summary: summaries drop payload fields
    // (e.g. apply_patch keeps only base_path), which made every patch in a
    // session collide to one hash and broke duplicate/retry detection.
    const toolArgsHash = toolArgs && typeof toolArgs === 'object'
        ? hashTraceValue(toolArgs)
        : (summarizedArgs ? hashTraceValue(summarizedArgs) : null);
    // Keep a short redacted error preview on the tool row itself so trace
    // analysis can see WHY a call failed without joining the failure log.
    const errorFirstLine = resultKind === 'error'
        ? _firstNonEmptyLine(_redactLogText(String(resultText ?? ''))).slice(0, 200) || null
        : null;
    // Failure taxonomy on the tool row itself (mirrors the failure log's
    // `category`) so trace-level aggregation can exclude expected command
    // exits (`command-exit`) without joining tool-failures.jsonl.
    const errorCategory = resultKind === 'error'
        ? classifyToolFailure(String(resultText ?? ''), toolName)
        : null;
    // Flat shape — fields named exactly as the agent_calls PG columns so
    // insertAgentCalls can pick them up by direct property access without
    // a payload-unwrap step. result_kind has no column and rides as plain
    // sibling metadata for downstream consumers.
    appendAgentTrace({
        sessionId,
        iteration,
        kind: 'tool',
        agent: agent || null,
        model: model || null,
        tool_name: toolName,
        tool_kind: toolKind,
        tool_ms: toolMs,
        tool_args: summarizedArgs,
        tool_args_hash: toolArgsHash,
        tool_args_summary: summarizedArgs,
        result_kind: resultKind || null,
        result_error_first_line: errorFirstLine,
        result_error_category: errorCategory,
        result_has_next_call: nextCallCount > 0,
        result_next_call_count: nextCallCount,
        result_bytes_est: resultBytesEst,
        result_lines_est: resultLinesEst,
        grep_coverage: grepCoverage,
        cwd: cwd || null,
    });
    if (
        Number.isFinite(numericToolMs)
        && numericToolMs >= MIXDOG_SLOW_TOOL_TRACE_MS
        && (MIXDOG_SLOW_TOOL_TRACE_ALL || MIXDOG_SLOW_TOOL_TRACE_NAMES.size === 0 || MIXDOG_SLOW_TOOL_TRACE_NAMES.has(String(toolName || '')))
    ) {
        appendAgentTrace({
            sessionId,
            iteration,
            kind: 'tool_slow',
            agent: agent || null,
            model: model || null,
            tool_name: toolName,
            tool_kind: toolKind,
            tool_ms: numericToolMs,
            payload: {
                threshold_ms: MIXDOG_SLOW_TOOL_TRACE_MS,
                result_kind: resultKind || null,
                tool_args: summarizedArgs,
                tool_args_hash: toolArgsHash,
                tool_args_summary: summarizedArgs,
                result_has_next_call: nextCallCount > 0,
                result_next_call_count: nextCallCount,
                result_bytes_est: resultBytesEst,
                result_lines_est: resultLinesEst,
                cwd: cwd || null,
            },
        });
    }
    if (resultKind === 'error') {
        traceAgentToolFailure({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs, agent, model, cwd, resultText, resultKind });
    }
}

// Compression layer trace (result-compression.mjs). One row per tool call
// where compression actually changed the byte count, so `gain` analytics
// can sum savings_pct over a window (mirrors RTK's `rtk gain` model
// without an external binary). No-op rows are dropped at the call site.
export function traceAgentCompress({ sessionId, toolName, before, after }) {
    // bytes_before/after/savings_pct moved into payload because the
    // trace_events table only carries known top-level columns (id, ts,
    // session_id, kind, tool_name, payload, ...) — fields outside that
    // set are silently dropped at insert time. payload is jsonb so any
    // shape survives. Aggregation: SELECT (payload->>'bytes_before')::int.
    appendAgentTrace({
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
export function traceAgentBatch({ sessionId, toolCallCount }) {
    appendAgentTrace({
        sessionId,
        kind: 'batch',
        // trace_events has no tool_call_count column — top-level unknown
        // fields are dropped at insert time, so carry it in payload (jsonb).
        payload: { tool_call_count: toolCallCount },
    });
}

export {
    traceAgentLoop,
    traceAgentCompact,
    traceAgentTool,
    traceAgentToolFailure,
    summarizeToolArgs,
    classifyToolFailure,
};
