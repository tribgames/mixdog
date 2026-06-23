import { performance } from 'perf_hooks';
import { classifyResultKind } from '../session/result-classification.mjs';
import {
    coerceShapeFlex,
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './builtin/path-utils.mjs';
import {
    SMART_BASH_HEAD_LINES,
    SMART_BASH_MAX_BYTES,
    SMART_BASH_MAX_LINES,
    SMART_BASH_TAIL_LINES,
    smartMiddleTruncate,
} from './builtin/shell-output.mjs';
import {
    executeBashTool,
    executeJobWaitTool,
} from './builtin/bash-tool.mjs';
import {
    executeFindFilesTool,
    executeListTool,
    executeTreeTool,
} from './builtin/list-tool.mjs';
import {
    executeHeadTool,
    executeSummaryTool,
    executeHexTool,
    executeTailTool,
    executeWcTool,
} from './builtin/read-mode-tool.mjs';
import { executeReadTool } from './builtin/read-tool.mjs';
import {
    executeGlobTool,
    executeGrepTool,
} from './builtin/search-tool.mjs';
import { executeEditTool } from './builtin/edit-tool.mjs';
import {
    runBatchEdit,
    runMultiEdit,
    runSingleEdit,
} from './builtin/edit-engine.mjs';
import { executeWriteTool } from './builtin/write-tool.mjs';
import { executeNotebookEditTool } from './builtin/notebook-edit-tool.mjs';
import { executeDiagnosticsTool } from './builtin/diagnostics-tool.mjs';
import { executeOpenConfigTool } from './builtin/open-config-tool.mjs';
import { executeRenameTool } from './builtin/rename-tool.mjs';
import {
    configureReadRangeIndexTelemetry,
    flushReadRangeIndexesSync,
} from './builtin/read-range-index.mjs';
import {
    extractIpynbText,
    extractPdfText,
} from './builtin/read-special-files.mjs';
import { computeUnifiedDiff } from './builtin/diff-utils.mjs';
import { formatToolStartProgress } from './progress-message.mjs';
import { BUILTIN_TOOLS } from './builtin/builtin-tools.mjs';
import { validateBuiltinArgs } from './builtin/arg-guard.mjs';
import {
    appendReadContextAdvisory,
    parseLineLimitArg,
    parseOffsetArg,
    renderReadLine,
    SMART_READ_HEAD_LINES,
    SMART_READ_MAX_BYTES,
    SMART_READ_MAX_LINES,
    SMART_READ_TAIL_LINES,
    smartReadTruncate,
} from './builtin/read-formatting.mjs';
import {
    findSimilarFile,
    normalizeErrorMessage,
} from './builtin/path-diagnostics.mjs';
import { isBinaryFile } from './builtin/binary-file.mjs';
import { normaliseReadLineWindowArgs } from './builtin/read-args.mjs';
import {
    READ_MAX_OUTPUT_BYTES,
    READ_MAX_SIZE_BYTES,
    READ_WHOLE_FILE_MAX_BYTES,
    READ_SMART_STREAM_MIN_BYTES,
    READ_STREAM_RANGE_MIN_BYTES,
} from './builtin/read-constants.mjs';
import { isBlockedDevicePath, isUncPath, isWindowsDevicePath, hasUnsafeWin32Component, isSpecialFileStat } from './builtin/device-paths.mjs';
import { mergeReadRanges as _mergeReadRanges } from './builtin/read-ranges.mjs';
import { hashText as _hashText } from './builtin/hash-utils.mjs';
import {
    rangeHashesForReadRanges as _rangeHashesForReadRanges,
    rangeHashesFromRenderedReadText as _rangeHashesFromRenderedReadText,
} from './builtin/snapshot-helpers.mjs';
import {
    cacheGetEntry as _cacheGetEntry,
    cacheSet as _cacheSet,
    invalidateBuiltinResultCache,
    rawContentCacheGet as _rawContentCacheGet,
    rawContentCacheSet as _rawContentCacheSet,
    seedRawContentCacheAfterWrite as _seedRawContentCacheAfterWrite,
} from './builtin/cache-layers.mjs';
import {
    deleteReadSnapshotPathEverywhere as _deleteReadSnapshotPathEverywhere,
} from './builtin/snapshot-store.mjs';
import { recordReadSnapshot as _recordReadSnapshot } from './builtin/read-snapshot-runtime.mjs';
import {
    coalesceObjectReadEntries,
    isFullModeReadEntry as _isFullModeReadEntry,
    readEntryLineWindow as _readEntryLineWindow,
    sliceReadBodyByLines,
} from './builtin/read-batch.mjs';
import {
    countLogicalLinesBytesSync as _countLogicalLinesBytesSyncImpl,
    renderTailWindowSync as _renderTailWindowSyncImpl,
    streamHeadWindow as _streamHeadWindowImpl,
    streamReadRange as _streamReadRangeImpl,
    streamSmartReadSummary as _streamSmartReadSummaryImpl,
} from './builtin/read-streaming.mjs';
export {
    coerceShapeFlex,
    normalizeInputPath,
    normalizeOutputPath,
    posixPathToWindowsPath,
    resolveAgainstCwd,
} from './builtin/path-utils.mjs';
export {
    buildGlobCacheKey,
    buildGrepCacheKey,
    buildGrepRgArgs,
    buildListCacheKey,
} from './builtin/search-builders.mjs';
export {
    analyzeShellCommandEffects,
    preflightShellLargeFileProbe,
} from './builtin/shell-analysis.mjs';
export { BUILTIN_TOOLS } from './builtin/builtin-tools.mjs';
export { withBuiltinPathLocks } from './builtin/path-locks.mjs';
export {
    getCachedReadOnlyStat,
    invalidateBuiltinResultCache,
} from './builtin/cache-layers.mjs';
export { atomicWrite } from './builtin/atomic-write.mjs';
// ---------------------------------------------------------------------------
// User-cwd persistence bridge: hook writes user-cwd.txt on SessionStart so
// the MCP server (spawned from cache dir) resolves the correct sandbox root.
// Helper extracted to src/shared/user-cwd.mjs so server-main.mjs can import
// the same primitive without circular-import risk.
// ---------------------------------------------------------------------------
import { pwd } from '../../../shared/user-cwd.mjs';

function _ioTraceEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_IO_TRACE || ''));
}

function _ioTraceStart() {
    return _ioTraceEnabled() ? performance.now() : 0;
}

function _ioTrace(event, fields = {}) {
    if (!_ioTraceEnabled()) return;
    try {
        process.stderr.write(`[io-trace] ${JSON.stringify({
            event,
            ts: Date.now(),
            ...fields,
        })}\n`);
    } catch {}
}

function _ioTraceDone(event, started, fields = {}) {
    if (!started || !_ioTraceEnabled()) return;
    _ioTrace(event, {
        ...fields,
        ms: Number((performance.now() - started).toFixed(3)),
    });
}

const _readStreamingHooks = {
    ioTraceStart: _ioTraceStart,
    ioTraceDone: _ioTraceDone,
    recordReadSnapshot: (...args) => _recordReadSnapshot(...args),
};

function streamReadRange(fullPath, offset, limit, stHint = null, hooks = {}) {
    return _streamReadRangeImpl(fullPath, offset, limit, stHint, { ..._readStreamingHooks, ...hooks });
}

function renderTailWindowSync(fullPath, st, n, readStateScope, options = {}) {
    return _renderTailWindowSyncImpl(fullPath, st, n, readStateScope, options, _readStreamingHooks);
}

function countLogicalLinesBytesSync(fullPath, size, stHint = null) {
    return _countLogicalLinesBytesSyncImpl(fullPath, size, stHint, _readStreamingHooks);
}

function streamHeadWindow(fullPath, st, n, readStateScope, source = 'read_head_stream') {
    return _streamHeadWindowImpl(fullPath, st, n, readStateScope, source, _readStreamingHooks);
}

function streamSmartReadSummary(fullPath, st, source = 'read_smart_stream') {
    return _streamSmartReadSummaryImpl(fullPath, st, source, _readStreamingHooks);
}

const _readModeHelpers = {
    streamHeadWindow,
    renderTailWindowSync,
    countLogicalLinesBytesSync,
    recordReadSnapshot: (...args) => _recordReadSnapshot(...args),
};

const _readToolHelpers = {
    appendReadContextAdvisory,
    classifyResultKind,
    coalesceObjectReadEntries,
    coerceShapeFlex,
    extractIpynbText,
    extractPdfText,
    findSimilarFile,
    isBinaryFile,
    isBlockedDevicePath,
    isUncPath,
    isWindowsDevicePath,
    hasUnsafeWin32Component,
    isSpecialFileStat,
    normalizeErrorMessage,
    normalizeInputPath,
    normalizeOutputPath,
    normaliseReadLineWindowArgs,
    parseLineLimitArg,
    parseOffsetArg,
    renderReadLine,
    resolveAgainstCwd,
    smartReadTruncate,
    streamReadRange,
    streamSmartReadSummary,
    sliceReadBodyByLines,
    READ_MAX_OUTPUT_BYTES,
    READ_MAX_SIZE_BYTES,
    READ_WHOLE_FILE_MAX_BYTES,
    READ_SMART_STREAM_MIN_BYTES,
    READ_STREAM_RANGE_MIN_BYTES,
    _cacheGetEntry,
    _cacheSet,
    _hashText,
    _isFullModeReadEntry,
    _mergeReadRanges,
    _rangeHashesForReadRanges,
    _rangeHashesFromRenderedReadText,
    _rawContentCacheGet,
    _rawContentCacheSet,
    _readEntryLineWindow,
    _recordReadSnapshot,
};

// Tool definitions live in ./builtin/builtin-tools.mjs; keep builtin.mjs focused on execution.

const BUILTIN_TOOL_ALIASES = new Map([
    ['grop', 'grep'],
    ['grpe', 'grep'],
    ['greap', 'grep'],
    ['gerp', 'grep'],
    ['glbo', 'glob'],
    ['gloob', 'glob'],
    ['golb', 'glob'],
]);

export function canonicalizeBuiltinToolName(name) {
    if (typeof name !== 'string') return name;
    return BUILTIN_TOOL_ALIASES.get(name) || name;
}

function editDistance(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return Infinity;
    const aa = a.toLowerCase();
    const bb = b.toLowerCase();
    if (aa === bb) return 0;
    const prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
    const curr = new Array(bb.length + 1);
    for (let i = 1; i <= aa.length; i += 1) {
        curr[0] = i;
        for (let j = 1; j <= bb.length; j += 1) {
            const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                curr[j - 1] + 1,
                prev[j] + 1,
                prev[j - 1] + cost,
            );
        }
        for (let j = 0; j <= bb.length; j += 1) prev[j] = curr[j];
    }
    return prev[bb.length];
}

export function suggestBuiltinToolName(name) {
    if (typeof name !== 'string' || !name) return null;
    const canonical = canonicalizeBuiltinToolName(name);
    if (canonical !== name) return canonical;
    let best = null;
    for (const tool of BUILTIN_TOOLS) {
        const d = editDistance(name, tool.name);
        if (d <= 2 && (!best || d < best.distance || (d === best.distance && tool.name < best.name))) {
            best = { name: tool.name, distance: d };
        }
    }
    return best?.name || null;
}

export function formatUnknownBuiltinToolMessage(name, _args = {}, noun = 'builtin tool') {
    const suggestion = suggestBuiltinToolName(name);
    if (!suggestion) return `Error: unknown ${noun} "${name}"`;
    return `Error: unknown ${noun} "${name}". Did you mean "${suggestion}"?`;
}

// --- Mixdog scoped read snapshot tracking ---
//
process.on('exit', flushReadRangeIndexesSync);
// SIGINT/SIGTERM go through the same path — Node's exit event fires
// after the default handler in those cases too, so a single hook is
// enough for both graceful and abrupt shutdowns of the mcp child.

configureReadRangeIndexTelemetry({ trace: _ioTrace, hashText: _hashText });

// Uniform tool-output cap (Codex `tool_output_token_limit` analogue): a SINGLE
// optional knob that bounds EVERY builtin string result before it enters the
// lead context, on top of each tool's own caps. Default 0 = OFF (per-tool caps
// only, no behaviour change). Set MIXDOG_TOOL_OUTPUT_MAX_BYTES (or pass
// options.toolOutputMaxBytes) to globally tighten lead-context cost.
const _ENV_TOOL_OUTPUT_MAX_BYTES = (() => {
    const v = Number(process.env.MIXDOG_TOOL_OUTPUT_MAX_BYTES);
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
})();

function _sliceToBytesFromStart(s, maxBytes) {
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo);
}
function _sliceToBytesFromEnd(s, maxBytes) {
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(s.slice(s.length - mid), 'utf8') <= maxBytes) lo = mid; else hi = mid - 1;
    }
    return s.slice(s.length - lo);
}
function capToolOutput(result, options = {}) {
    const cap = Number(options?.toolOutputMaxBytes) > 0
        ? Math.trunc(Number(options.toolOutputMaxBytes))
        : _ENV_TOOL_OUTPUT_MAX_BYTES;
    if (cap <= 0 || typeof result !== 'string') return result; // off, or media/structured → pass through
    const bytes = Buffer.byteLength(result, 'utf8');
    if (bytes <= cap) return result;
    // Middle-truncate: keep head + tail (byte-accurate), drop the middle. Mirrors
    // Codex middle truncation so the model still sees both ends of a runaway.
    const half = Math.max(1, Math.floor(cap / 2) - 64);
    const head = _sliceToBytesFromStart(result, half);
    const tail = _sliceToBytesFromEnd(result, half);
    return `${head}\n... [tool-output truncated: ${Math.round(bytes / 1024)} KB -> ${Math.round(cap / 1024)} KB cap (tool_output_token_limit)] ...\n${tail}`;
}

export async function executeBuiltinTool(name, args, cwd, options = {}) {
    if (options.abortSignal && !options.signal) {
        options = { ...options, signal: options.abortSignal };
    }
    const toolName = canonicalizeBuiltinToolName(name);
    const argError = validateBuiltinArgs(toolName, args);
    if (argError) return argError;
    // Fallback live-progress emit for direct callers (in-process toolExecutor
    // path). The MCP dispatch path already fired the central start message and
    // sets progressStarted:true, so guard against a double-emit there. No-op
    // when onProgress is absent (no progressToken) — stays byte-identical.
    if (typeof options.onProgress === 'function' && options.progressStarted !== true) {
        try { options.onProgress(formatToolStartProgress(toolName, args)); } catch { /* best-effort */ }
        // Mark progress as started so child-builtin recursions (read batch→read,
        // read mode head/tail/count/summary/hex→child, grep glob-only→glob) that
        // spread these options below don't re-emit a second start message.
        options = { ...options, progressStarted: true };
    }
    const workDir = cwd || pwd();
    const readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
    const executeChildBuiltinTool = (childName, childArgs, childCwd = workDir, childOptions = null) =>
        executeBuiltinTool(childName, childArgs, childCwd, childOptions ? { ...options, ...childOptions } : options);
    // Path policy: Claude Code's settings.json permissions (mcp__* allow) are the
    // sole arbiter for workspace-boundary decisions.
    const _toolResult = await (async () => {
    switch (toolName) {
        case 'bash':
            return executeBashTool(args, workDir, options);
        case 'job_wait':
            return executeJobWaitTool(args);
        case 'read':
            return executeReadTool(args, workDir, readStateScope, executeChildBuiltinTool, options, _readToolHelpers);
        case 'write':
            return executeWriteTool(args, workDir, readStateScope, options);
        case 'diagnostics':
            return executeDiagnosticsTool(args, workDir, options);
        case 'open_config':
            return executeOpenConfigTool();
        case 'edit': {
            const op = args?.operation;
            if (op === 'notebook')
                return executeNotebookEditTool(args, workDir, readStateScope, options);
            if (op === 'rename')
                return executeRenameTool(args, workDir, options?.abortSignal || null);
            return executeEditTool(args, workDir, readStateScope, executeChildBuiltinTool, options, {
                runMultiEdit,
                runBatchEdit,
                runSingleEdit,
            });
        }
        case 'grep':
            return executeGrepTool(args, workDir, executeChildBuiltinTool, readStateScope, options);
        case 'glob':
            return executeGlobTool(args, workDir, options);
        case 'list':
            return executeListTool(args, workDir, options);
        case 'tree':
            return executeTreeTool(args, workDir, options);
        case 'find_files':
            return executeFindFilesTool(args, workDir, options);
        case 'head':
            return executeHeadTool(args, workDir, readStateScope, _readModeHelpers);
        case 'tail':
            return executeTailTool(args, workDir, readStateScope, _readModeHelpers);
        case 'wc':
            return executeWcTool(args, workDir, _readModeHelpers);
        case 'summary':
            return executeSummaryTool(args, workDir, readStateScope, _readModeHelpers);
        case 'hex':
            return executeHexTool(args, workDir, readStateScope, _readModeHelpers);
        default:
            return formatUnknownBuiltinToolMessage(name, args);
    }
    })();
    return capToolOutput(_toolResult, options);
}
/**
 * Check if a tool name is a builtin tool.
 */
export function isBuiltinTool(name) {
    const toolName = canonicalizeBuiltinToolName(name);
    return BUILTIN_TOOLS.some(t => t.name === toolName);
}

// Test-only exports for smart truncation helpers (see
// scripts/test-smart-truncation.mjs). Runtime callers inside this module
// use the local bindings unchanged; these named exports just make the
// same functions + constants reachable from the test harness.
export {
    computeUnifiedDiff,
    smartMiddleTruncate,
    smartReadTruncate,
    SMART_READ_MAX_BYTES,
    SMART_READ_MAX_LINES,
    SMART_READ_HEAD_LINES,
    SMART_READ_TAIL_LINES,
    SMART_BASH_MAX_LINES,
    SMART_BASH_MAX_BYTES,
    SMART_BASH_HEAD_LINES,
    SMART_BASH_TAIL_LINES,
};

// Public path-keyed wrappers around the read-snapshot machinery. patch.mjs
// uses these after a multi-file diff lands so subsequent reads see the new
// content instead of the pre-edit cached body. Both are best-effort: the
// failure mode is a stale snapshot, not a corrupt write.
export function recordReadSnapshotForPath(fullPath, scope, meta = {}) {
  try {
    const { stat, st, ...snapshotMeta } = meta || {};
    _recordReadSnapshot(fullPath, st || stat, scope || null, snapshotMeta);
  } catch {}
}
export function clearReadSnapshotForPath(fullPath, _scope) {
  // Drop the cached result entries that may carry stale snapshot meta for
  // this path. The internal map is keyed on opaque hashes, so a targeted
  // delete is not possible — full invalidate-by-path is the contract.
  try { invalidateBuiltinResultCache([fullPath]); } catch {}
  try { _deleteReadSnapshotPathEverywhere(fullPath); } catch {}
}

// Re-export from the side-effect-free code-graph definition source so callers that already import other
// helpers from builtin.mjs (result-compression.mjs) can pick up the tool
// def list from the same module without a parallel path.
export { CODE_GRAPH_TOOL_DEFS } from './code-graph-tool-defs.mjs';

// Render an absolute path relative to `cwd` for display. Falls back to the
// absolute path when `cwd` is missing or does not prefix the input. Used by
// code-graph for tool-result formatting; declared here to keep path-display
// invariants colocated with the other normalize* helpers above.
export function toDisplayPath(absPath, cwd) {
  if (!absPath) return '';
  if (cwd) {
    const a = String(absPath).replace(/\\/g, '/');
    const c = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    if (a.toLowerCase().startsWith(c.toLowerCase() + '/')) {
      return a.slice(c.length + 1);
    }
    if (a.toLowerCase() === c.toLowerCase()) return '';
  }
  return absPath;
}
