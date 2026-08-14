import { createHash } from 'crypto';
import { countJsonNextCalls } from './tools/next-call-utils.mjs';
import { parseGrepContextHeader, splitGrepLinePrefix } from './tools/builtin/grep-formatting.mjs';
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
const RECOVERED_ERROR_MESSAGE_MAX_CHARS = 300;

function compactRecoveredErrorMessage(value) {
    if (value == null) return null;
    const message = String(value);
    return message.length > RECOVERED_ERROR_MESSAGE_MAX_CHARS
        ? `${message.slice(0, 299)}…`
        : message;
}

function traceAgentLoop({
    sessionId,
    iteration,
    sendMs,
    preSendMs,
    toolResumeMs,
    messageCount,
    bodyBytesEst,
    agent = null,
}) {
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
        pre_send_ms: preSendMs ?? null,
        tool_resume_ms: toolResumeMs ?? null,
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
    recovered_error,
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
        recovered_error: recovered_error && typeof recovered_error === 'object'
            ? {
                code: recovered_error.code ?? null,
                // Capture already strips ANSI/newlines; retain this writer-side
                // cap for any future compact-meta caller.
                message: compactRecoveredErrorMessage(recovered_error.message),
            }
            : null,
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
    code_graph: ['mode', 'file', 'files', 'symbol', 'symbols', 'body', 'language', 'limit', 'depth', 'page', 'cwd'],
    shell: ['command', 'timeout_ms'],
    task: ['action', 'task_id'],
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
    let rawSourceLinesRemaining = 0;
    const addLine = (path, lineNo) => {
        if (!path || !Number.isInteger(lineNo) || lineNo < 1 || out.length >= GREP_COVERAGE_MAX) return;
        const key = `${path}\0${lineNo}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ path: String(path).replace(/\\/g, '/'), line: lineNo });
    };
    for (const line of String(resultText ?? '').split(/\r?\n/)) {
        if (rawSourceLinesRemaining > 0) {
            rawSourceLinesRemaining--;
            continue;
        }
        const header = parseGrepContextHeader(line);
        if (header) {
            for (let lineNo = header.startLine; lineNo <= header.endLine && out.length < GREP_COVERAGE_MAX; lineNo++) {
                addLine(header.path, lineNo);
            }
            rawSourceLinesRemaining = header.sourceLineCount;
            continue;
        }
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
        addLine(path, lineNo);
        if (out.length >= GREP_COVERAGE_MAX) break;
    }
    return out.length ? out : null;
}

// Patch failures all arrive as "apply_patch … failed" prose, but
// a malformed envelope, a rejected hunk, a preflight veto and a size/lock
// guard need different operator responses. Returning null means "nothing
// patch-specific here" and lets the generic rules (path/enoent, schema/args,
// runtime/failure) finish the classification.
// Emitted by the sequence/wave reporters whenever section writes reached disk
// and were NOT rolled back cleanly (committed-by-design, partial mode, or a
// rollback that itself failed). Any of these means the working tree state is
// committed or uncertain, which outranks every other failure detail.
const PATCH_COMMITTED_WRITES_RE = /already applied to disk \(writes committed\)|applied to disk \(committed\) and left in place|applied \(committed to disk\)|rollback was incomplete|--- rollback incomplete ---|patch partially (?:applied|created|updated|written)/;

function classifyPatchFailure(text) {
    // Writes already committed outranks every other patch detail: the tree is
    // no longer in its pre-patch state and needs inspection before a retry.
    if (PATCH_COMMITTED_WRITES_RE.test(text)) return 'patch/partial-apply';
    // Resource guards (byte cap) are deliberate rejections, not tool defects.
    if (/patch too large|byte cap/.test(text)) return 'patch/limit';
    if (/parse failed|invalid patch|malformed patch|missing \*\*\* (?:begin|end) patch|patch body is empty|unsupported patch format/.test(text)
        // `patch contained no file sections` / `contains an empty file path`:
        // the envelope parsed but produced nothing applicable — a patch-text
        // defect, not a context miss.
        || /contained no file sections|contains an empty file path/.test(text)) return 'patch/parse';
    if (/hunk rejected|context not found|context mismatch|anchor not found|expected first old(?:\/context| line)/.test(text)) {
        // Stale context requires REAL evidence that the region exists but has
        // moved/changed (nearest line, divergent line, rejected hunk). The
        // `expected first old line: …` fragment is printed for every context
        // miss, so on its own it means only "the context is not there".
        return /nearest line|first divergent line|hunk rejected/.test(text)
            ? 'patch/stale-context'
            : 'patch/context';
    }
    // Missing/unreadable targets are path problems even when a preflight
    // wrapper reports them; fall through to the generic path rules.
    if (/enoent|no such file|target unreadable|source (?:missing or )?unreadable|destination unreadable|cannot find/.test(text)) return null;
    if (/preflight rejected|does not support|cannot be combined|only one v4a rename|missing parsed entry|internal js dispatch|rollback snapshot target/.test(text)) return 'patch/verification';
    return null;
}

function classifyToolFailure(resultText, toolName) {
    const raw = String(resultText ?? '');
    const text = raw.toLowerCase();
    if (isExpectedToolCancellation(raw)) return 'expected-cancellation';
    // Shell renderers put the machine-readable status on the leading line.
    // Only inspect that marker: command text and stderr frequently contain
    // words such as "timeout" or "aborted" and must not rewrite a real exit
    // code into a runtime failure category.
    const leading = raw.split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('⚠️ '))
        ?.replace(/^Error:\s*/i, '') || '';
    if (/^\[shell-tool-failed\](?:\s|$)/i.test(leading)) return 'tool-call/failure';
    if (/^\[shell-run-failed\](?:\s|$)/i.test(leading)) {
        if (/\[timeout:|cause:\s*(?:timeout|cancellation)\b/i.test(leading)) return 'timeout/abort';
        if (/cause:\s*(?:output-limit|output-capture-error|background-adoption-failed)\b/i.test(leading)) return 'runtime/failure';
        if (/\[signal:\s*[^\]]+/i.test(leading)) return 'process/signal';
        return 'command-exit';
    }
    if (/compacted-history placeholder/.test(text)) return 'expected-preflight';
    if (/\[tool-input-validation\]/.test(text)) return 'schema/args';
    // `shell` results quote git/patch output verbatim (e.g. `git apply`
    // rejects); only real patch surfaces may claim the patch taxonomy, so an
    // ordinary command exit is never rewritten into a patch failure.
    const patchSurface = String(toolName || '') === 'apply_patch'
        || (String(toolName || '') !== 'shell'
            && /apply_patch|native patch|v4a|\*\*\* begin patch|hunk rejected|context not found/.test(text));
    // Committed/uncertain on-disk state outranks the lock or permission detail
    // that triggered it: the operator must inspect the tree before retrying,
    // and a "denied"/"lock held" word further down must not hide that.
    if (patchSurface && PATCH_COMMITTED_WRITES_RE.test(text)) return 'patch/partial-apply';
    // Write-lock contention is a resource guard, not a timeout or a patch bug.
    if (/advisory lock (?:timeout|busy)|lock held by pid|\.mixdog-lock/.test(text)) return 'resource/lock';
    if (/eacces|eperm|permission|denied|forbidden|operation not permitted/.test(text)) return 'path/permission';
    if (patchSurface) {
        const patchCategory = classifyPatchFailure(text);
        if (patchCategory) return patchCategory;
    }
    if (/requires either|invalid arguments|unknown parameter|unknown memory action/.test(text)
        || /must be|schema|required|old_string is .*>?=/.test(text)) return 'schema/args';
    if (/not in allow-list|not allowed/.test(text)) return 'permission';
    if (String(toolName || '') === 'shell' || /^\s*\[exit code:\s*\d+\]/i.test(raw)) return 'command-exit';
    if (/enoent|cannot find|not found at this path|path does not exist|no such file|file not found in graph|unreadable/.test(text)) return 'path/enoent';
    if (/timed out|timeout|interrupted|aborted/.test(text)) return 'timeout/abort';
    if (/unknown tool|tool.*not.*available|missing.*tool/.test(text)) return 'tool-surface';
    return 'runtime/failure';
}

function isExpectedToolCancellation(resultText) {
    const leading = String(resultText ?? '').split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('⚠️ '))
        ?.replace(/^Error:\s*/i, '') || '';
    return /^Session\s+"[^"]+"\s+closed:\s*(?:aborted|closed)\s+during call\b/i.test(leading);
}

function traceAgentToolFailure({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs, agent, model, cwd, resultText, resultKind = 'error' }) {
    if (process.env.MIXDOG_AGENT_TRACE_DISABLE === '1') return;
    if (!_resolveToolFailurePath()) return;
    try {
        const cleanText = _redactLogText(String(resultText ?? ''));
        // A session close is deliberate orchestration, not a tool failure.
        // traceAgentTool still records the error/category on the normal trace.
        if (isExpectedToolCancellation(cleanText)) return;
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

function traceAgentTool({ sessionId, iteration, toolName, toolKind, toolMs, toolArgs, agent, resultKind, model, resultText, localSearchTelemetry = null, cwd }) {
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
        local_search: localSearchTelemetry && Object.keys(localSearchTelemetry).length > 0
            ? { ...localSearchTelemetry }
            : null,
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
                local_search: localSearchTelemetry && Object.keys(localSearchTelemetry).length > 0
                    ? { ...localSearchTelemetry }
                    : null,
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

export function buildShellOutputTelemetryPayload({
    toolCallId,
    telemetry,
    preOffloadBytes,
    postOffloadBytes,
    modelVisibleBytes,
    offloaded,
    resultKind,
}) {
    const commandOutputBytes = Number(telemetry?.commandOutputBytes);
    if (!Number.isFinite(commandOutputBytes) || commandOutputBytes < 0) return null;
    const visibleBytes = Math.max(0, Math.trunc(Number(modelVisibleBytes) || 0));
    const byteDelta = Math.trunc(commandOutputBytes) - visibleBytes;
    return {
        tool_call_id: toolCallId || null,
        result_kind: resultKind || null,
        command_output_bytes: Math.trunc(commandOutputBytes),
        captured_preview_bytes: Math.max(0, Math.trunc(Number(telemetry?.capturedPreviewBytes) || 0)),
        shell_result_bytes: Math.max(0, Math.trunc(Number(telemetry?.shellResultBytes) || 0)),
        tool_result_bytes: Math.max(0, Math.trunc(Number(telemetry?.toolResultBytes) || 0)),
        pre_offload_bytes: Math.max(0, Math.trunc(Number(preOffloadBytes) || 0)),
        post_offload_bytes: Math.max(0, Math.trunc(Number(postOffloadBytes) || 0)),
        model_visible_bytes: visibleBytes,
        byte_delta: byteDelta,
        reduction_pct: commandOutputBytes > 0
            ? Math.round((1 - visibleBytes / commandOutputBytes) * 100)
            : null,
        spilled: telemetry?.spilled === true,
        offloaded: offloaded === true,
    };
}

export function traceAgentShellOutput({
    sessionId,
    toolName,
    toolCallId,
    telemetry,
    preOffloadBytes,
    postOffloadBytes,
    modelVisibleBytes,
    offloaded,
    resultKind,
}) {
    const payload = buildShellOutputTelemetryPayload({
        toolCallId,
        telemetry,
        preOffloadBytes,
        postOffloadBytes,
        modelVisibleBytes,
        offloaded,
        resultKind,
    });
    if (!sessionId || !payload) return;
    appendAgentTrace({
        sessionId,
        kind: 'shell_output',
        tool_name: toolName || 'shell',
        payload,
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
