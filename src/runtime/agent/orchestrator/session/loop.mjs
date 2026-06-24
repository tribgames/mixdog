import { classifyResultKind } from './result-classification.mjs';
import { executeMcpTool, isMcpTool, mcpToolHasField } from '../mcp/client.mjs';
import { canonicalizeBuiltinToolName, executeBuiltinTool, formatUnknownBuiltinToolMessage, isBuiltinTool } from '../tools/builtin.mjs';
import { executeBashSessionTool } from '../tools/bash-session.mjs';
import { executePatchTool } from '../tools/patch.mjs';
import { executeCodeGraphTool, isCodeGraphTool } from '../tools/code-graph.mjs';
import { executeInternalTool, isInternalTool } from '../internal-tools.mjs';
import { collectSkillsCached, loadSkillContent } from '../context/collect.mjs';
import { traceBridgeLoop, traceBridgeTool, traceBridgeCompact, estimateProviderPayloadBytes, messagePrefixHash } from '../bridge-trace.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError, getSessionAbortSignal } from './manager.mjs';
import { estimateMessagesTokens, estimateRequestReserveTokens } from './context-utils.mjs';
import {
    compactMessages,
    pruneToolOutputs,
    semanticCompactMessages,
    compactActiveTurn,
    SUMMARY_PREFIX,
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_KEEP_TOKENS,
} from './compact.mjs';
import { isContextOverflowError } from '../providers/retry-classifier.mjs';
import { classifyBashFileLookupCommand, stripSoftWarns } from '../tool-loop-guard.mjs';
import { maybeOffloadToolResult } from './tool-result-offload.mjs';
import { tryReadCached, setReadCached, invalidatePathForSession, markPostEdit, consumePostEditMark, clearReadDedupSession, extractTouchedPathsFromPatch, tryScopedToolCached, setScopedToolCached, clearScopedToolsForSession, clearScopedToolsForSessionPaths, invalidatePrefetchCache } from './read-dedup.mjs';
import { createScopedCacheOutcome } from './cache/scoped-cache-outcome.mjs';
import { createHash } from 'crypto';

// Tool-name classification for cross-turn read dedup.
// Strips the MCP prefix so direct calls and MCP-wrapped calls share the
// same cache.
function _stripMcpPrefix(name) {
    return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
        ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
function _isReadTool(name) {
    return _stripMcpPrefix(name) === 'read';
}
function _isScalarWriteEditTool(name) {
    const n = _stripMcpPrefix(name);
    return n === 'write' || n === 'edit';
}
function _isMutationTool(name) {
    const n = _stripMcpPrefix(name);
    return n === 'apply_patch' || n === 'write' || n === 'edit';
}
const SCOPED_CACHEABLE_TOOLS = new Set([
    'code_graph',
    'grep',
    'list',
    'glob',
]);
function _isScopedCacheableTool(name) {
    const n = _stripMcpPrefix(name);
    return SCOPED_CACHEABLE_TOOLS.has(n);
}
function _isBashTool(name) {
    const n = _stripMcpPrefix(name);
    return n === 'bash' || n === 'bash_session';
}

// classifyResultKind is imported from result-classification.mjs at the top of
// this file; import it from there directly rather than via this module.

// Canonical signature for intra-turn duplicate detection. Sorting keys
// produces a stable hash regardless of arg-object key order. Anything
// non-serializable falls back to String(args) — still deterministic for
// the model's typical structured-arg shape.
function _canonicalArgs(args) {
    if (args == null || typeof args !== 'object') {
        try { return JSON.stringify(args); } catch { return String(args); }
    }
    try {
        const keys = Object.keys(args).sort();
        const sorted = {};
        for (const k of keys) sorted[k] = args[k];
        return JSON.stringify(sorted);
    } catch { return String(args); }
}
function _intraTurnSig(name, args) {
    return createHash('sha256').update(`${name}:${_canonicalArgs(args)}`).digest('hex').slice(0, 16);
}

// Shared pre-dispatch deny — single source of truth for role/scope/permission
// rejects. Called by BOTH the eager dispatch path (startEagerTool) and the
// serial dispatch path (executeTool body). Returns null when the call is
// allowed to proceed; otherwise returns the Error string the serial path
// would emit. The eager caller ignores the message body and just treats
// non-null as "do not start eager".
//
// Predicates are kept in the same order as the legacy serial branch so a
// bridge-owned control-plane tool fails on _bridgeOwned+_controlPlaneTool
// FIRST (not on permission/wrapper checks) — matches the prior wording.
// Bridge workers are sandboxed to code/research tools. They must never reach
// owner/host control surfaces: session management, the ENTIRE channels module
// (Discord messaging, schedules, webhook/config, channel-bridge toggle,
// command injection), or host input injection. Explicit name list (no imports)
// keeps this hot-path gate dependency-free; add new owner/channel tools here.
const WORKER_DENIED_TOOLS = new Set([
    // session control-plane — unified into the single `bridge` tool
    // (type=spawn|send|close|list). Denying the one name blocks all worker
    // session control. Legacy names kept for defense-in-depth against any
    // stale catalog entry that still advertises them.
    'bridge', 'close_session', 'list_sessions', 'create_session',
    // channels module (owner/Discord-facing)
    'reply', 'react', 'edit_message', 'download_attachment', 'fetch',
    'schedule_status', 'trigger_schedule', 'schedule_control',
    'activate_channel_bridge', 'reload_config', 'inject_command',
    // host input injection
    'inject_input',
]);
function _preDispatchDeny(call, toolKind, sessionRef) {
    const name = call?.name;
    if (typeof name !== 'string' || !name) return null;
    const _bridgeOwned = sessionRef?.scope?.startsWith?.('bridge:') || sessionRef?.owner === 'bridge';
    const _controlPlaneTool = WORKER_DENIED_TOOLS.has(name);
    if (_bridgeOwned && _controlPlaneTool) {
        return `Error: control-plane tool "${name}" is Lead-only and not available to bridge workers.`;
    }
    const noToolRole = sessionRef?.role === 'cycle1-agent' || sessionRef?.role === 'cycle2-agent';
    if (noToolRole) {
        return `Error: tool "${name}" is not available in role "${sessionRef.role}". Re-emit the answer as pipe-separated text per the role's output format (first character a digit, NO tool_use blocks, NO JSON, NO prose, NO apology).`;
    }
    if (isBlockedHiddenWrapperCall(name, sessionRef)) {
        return `Error: tool "${name}" is the wrapper your role (${sessionRef?.role || 'hidden'}) backs. Calling it would spawn another hidden agent of the same kind — use direct read/grep/glob/code_graph instead.`;
    }
    const effectivePermission = effectiveToolPermission(sessionRef);
    const permissionBlocked = isBlockedByPermission(name, toolKind, effectivePermission);
    if (permissionBlocked && effectivePermission === 'mcp') {
        return `Error: tool "${name}" is not available on this session (permission=mcp). Use MCP/internal retrieval tools only.`;
    }
    if (permissionBlocked && effectivePermission === 'read') {
        return `Error: tool "${name}" is not available on this session (permission=read). Use Mixdog MCP read/grep/glob/recall/search/explore instead.`;
    }
    if (permissionBlocked && effectivePermission && typeof effectivePermission === 'object') {
        return `Error: tool "${name}" is not permitted on this session by the role's allow/deny permission policy.`;
    }
    return null;
}
/** Exported for smoke tests — same runtime deny as the agent loop. */
export function preDispatchDenyForSession(sessionRef, call, toolKind = 'builtin') {
    return _preDispatchDeny(call, toolKind, sessionRef);
}
import { compressToolResult, recordToolBatch } from '../tools/result-compression.mjs';


import { isHiddenRole } from '../internal-roles.mjs';
import { createRequire } from 'module';
import { readFileSync as _readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath, isAbsolute } from 'path';
// Load the CJS permission evaluator. The hooks/ directory lives two levels
// above src/agent/orchestrator/session/, so we walk up from __dirname.
const _require = createRequire(import.meta.url);
const _hooksLib = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../hooks/lib/permission-evaluator.cjs');
const { evaluatePermission: _evaluatePermission } = _require(_hooksLib);
const MCP_TOOL_PREFIX = 'mcp__plugin_mixdog_mixdog__';
const COMPACT_SAFETY_PERCENT = 1.00;
const COMPACT_BUFFER_MAX_WINDOW_FRACTION = 0.25;
// Stricter budget used for the one-shot retry after a provider rejects a send
// with a context-window-exceeded error. 0.60×contextWindow forces older
// non-system history into a tighter compact summary when the pre-send estimate
// under-counted provider-side bytes (tool schemas, framing,
// provider-internal token accounting). Used exactly once per send; see the
// retry block around provider.send below.
const OVERFLOW_RETRY_COMPACT_PERCENT = 0.60;

function estimateMessagesTokensSafe(messages) {
    try { return estimateMessagesTokens(messages); }
    catch { return null; }
}

class BridgeContextOverflowError extends Error {
    constructor({ stage, sessionId, provider, model, contextWindow, budgetTokens, reserveTokens, messageTokensEst }, cause) {
        const target = [provider, model].filter(Boolean).join('/') || 'target model';
        const causeMsg = cause && cause.message ? `: ${cause.message}` : '';
        super(
            `bridge context overflow (${target}, stage=${stage || 'compact'}): ` +
            `latest turn cannot fit target context budget=${budgetTokens ?? 'unknown'} ` +
            `reserve=${reserveTokens ?? 'unknown'} contextWindow=${contextWindow ?? 'unknown'} ` +
            `messageTokensEst=${messageTokensEst ?? 'unknown'}${causeMsg}`,
        );
        this.name = 'BridgeContextOverflowError';
        this.code = 'BRIDGE_CONTEXT_OVERFLOW';
        this.sessionId = sessionId || null;
        this.provider = provider || null;
        this.model = model || null;
        this.contextWindow = contextWindow ?? null;
        this.budgetTokens = budgetTokens ?? null;
        this.reserveTokens = reserveTokens ?? null;
        this.messageTokensEst = messageTokensEst ?? null;
        if (cause) this.cause = cause;
    }
}

function bridgeContextOverflowError({ stage, sessionId, sessionRef, model, budgetTokens, reserveTokens, messageTokensEst }, cause) {
    return new BridgeContextOverflowError({
        stage,
        sessionId,
        provider: sessionRef?.provider || null,
        model: sessionRef?.model || model || null,
        contextWindow: sessionRef?.contextWindow ?? null,
        budgetTokens,
        reserveTokens,
        messageTokensEst,
    }, cause);
}

// Cache-hit results always inline the cached body. The earlier size-gated
// `[cache-hit-ref]` branch confused bridge workers whose context did not
// contain the referenced prior tool_result, triggering shell-cat detours.
// Hard iteration ceiling for every agent loop. Reset to 0 whenever the
// transcript is compacted (see the trim block below): a long task that keeps
// compacting can proceed past this count, while a tight NON-compacting loop
// still stops here and returns the accumulated transcript.
const MAX_LOOP_ITERATIONS = 200;
// Consecutive identical-AND-failing tool calls (same name+args, error result)
// tolerated across iterations before the loop refuses to re-execute and steers
// the model to change approach. Distinct from the hard iteration cap above:
// this catches tight deterministic-failure loops (e.g. a command that errors
// the same way every time) far earlier than 100 iterations.
const REPEAT_FAIL_LIMIT = 3;
const _HIDDEN_ROLES_JSON = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../defaults/hidden-roles.json');
let _hiddenRolesCache = null;
function _getHiddenRoles() {
    if (_hiddenRolesCache) return _hiddenRolesCache;
    try {
        _hiddenRolesCache = JSON.parse(_readFileSync(_HIDDEN_ROLES_JSON, 'utf8'));
    } catch { _hiddenRolesCache = { roles: [] }; }
    return _hiddenRolesCache;
}
// Transcript pairing guard. Anthropic 400-rejects when an assistant message
// ends with tool_use blocks and the next message isn't tool results for
// those exact ids. abort/timeout/error race in the loop body can leave a
// dangling assistant tool_use at the tail (e.g. the structure_probe loop
// running 12 deep then aborting between push-assistant and push-tool).
// Strip any trailing assistant tool_use that has no matching tool result
// so provider.send sees a valid transcript instead of leaking the 400 to
// the user. Repair runs every iteration but is a no-op on healthy paths.
function _ensureTranscriptPairing(msgs, sessionId) {
    // Walk backwards to find the last assistant message that emitted
    // tool_use, then validate that every id has a matching tool result
    // inside the CONTIGUOUS tool-message block immediately following it.
    // Earlier guard splice'd the entire tail — which silently deleted any
    // user prompt appended after the dangling assistant by manager.mjs:
    // when the guard fired with shape
    //     [..., assistant{a,b}, tool{a}, user{new prompt}]
    // the splice removed user{new prompt} along with the orphan suffix.
    // Fix: remove only assistant + the contiguous tool block; preserve
    // anything past it (user / system / next assistant) untouched.
    let popped = 0;
    while (msgs.length > 0) {
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m?.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
                lastAssistantIdx = i;
                break;
            }
        }
        if (lastAssistantIdx === -1) break;
        // Collect the contiguous tool messages directly after this assistant.
        // Anything past that block is unrelated (next user prompt, system
        // marker, etc.) and must survive the repair.
        let toolBlockEnd = lastAssistantIdx + 1;
        while (toolBlockEnd < msgs.length && msgs[toolBlockEnd]?.role === 'tool') {
            toolBlockEnd += 1;
        }
        const toolBlock = msgs.slice(lastAssistantIdx + 1, toolBlockEnd);
        const ids = msgs[lastAssistantIdx].toolCalls.map(c => c.id);
        const matched = ids.every(id => toolBlock.some(m => m.toolCallId === id));
        if (matched) break;
        const removed = toolBlockEnd - lastAssistantIdx;
        msgs.splice(lastAssistantIdx, removed);
        popped += removed;
    }
    // Second sweep — catch dangling tool results that survived the
    // contiguous-block splice. Anthropic strict spec requires every
    // tool result to sit in a contiguous block right after the
    // assistant whose toolCalls produced it; a `[..., assistant{a,b},
    // tool{a}, user, tool{b}]` shape leaves tool{b} orphaned even
    // after assistant + tool{a} are repaired by the loop above.
    // Walk back from each tool message to the nearest non-tool
    // ancestor; if it is not an assistant whose toolCalls include
    // this id, drop the orphan.
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== 'tool') continue;
        if (!m.toolCallId) {
            msgs.splice(i, 1);
            popped += 1;
            continue;
        }
        let prevIdx = i - 1;
        while (prevIdx >= 0 && msgs[prevIdx]?.role === 'tool') prevIdx--;
        const anchor = prevIdx >= 0 ? msgs[prevIdx] : null;
        const anchorOk = anchor?.role === 'assistant'
            && Array.isArray(anchor.toolCalls)
            && anchor.toolCalls.some(c => c.id === m.toolCallId);
        if (!anchorOk) {
            msgs.splice(i, 1);
            popped += 1;
        }
    }
    if (popped > 0 && sessionId) {
        try { process.stderr.write(`[transcript-repair] sess=${sessionId} popped=${popped} dangling assistant tool_use\n`); } catch {}
    }
}

// Write-class tools that a permission=read session must not execute. The
// schema still advertises them to keep one unified shard; this runtime set
// is the fail-safe reject at call time.
const READ_BLOCKED_TOOLS = new Set([
    'bash', 'bash_session',
    'write',
    'edit',
    'apply_patch',
]);
const MCP_ONLY_ALLOWED_KINDS = new Set(['mcp', 'internal', 'skill']);
// Wrappers that hidden retrieval roles back. Hidden roles MUST NOT call
// these or they spawn another hidden agent of the same kind — nested chain
// + token burn. Block at call time; the role's rule prompt also says so.
const RETRIEVAL_WRAPPERS = new Set(['recall', 'search', 'explore']);
// Hidden roles that may call specific retrieval wrappers. Default policy
// blocks all hidden→wrapper calls; roles listed here have a documented
// need:
//   - scheduler-task / webhook-handler: state-changing agents whose
//     tasks routinely require both reach-back into past context
//     (`recall`) and fresh external info (`search`).
const HIDDEN_ROLE_WRAPPER_ALLOWLIST = {
    'scheduler-task': new Set(['recall', 'search']),
    'webhook-handler': new Set(['recall', 'search']),
};
// Eager-dispatch: tools with readOnlyHint:true in their declaration are safe
// to execute during SSE parsing so tool work overlaps with the rest of the
// stream. Writes, bash, MCP and skills stay serial after send() returns.
function isEagerDispatchable(name, tools) {
    if (!Array.isArray(tools)) return false;
    const def = tools.find(t => t?.name === name);
    return def?.annotations?.readOnlyHint === true;
}
// ── Bridge-worker permission enforcement ──────────────────────────────────────
// Mirrors the PreToolUse hook evaluation for tool calls that originate inside a
// bridge worker session. Worker dispatch previously bypassed the hook pipeline
// entirely; this guard closes that gap by running the same evaluator inline.
//
// `ask` is treated as deny here — forwarding `ask` decisions to the channel
// UI approval flow needs bidirectional prompt plumbing that does not exist.
function _checkWorkerPermission(toolName, toolInput, sessionRef) {
    const bareToolName = _stripMcpPrefix(toolName);
    if (sessionRef?.owner === 'bridge' && bareToolName === 'bash') {
        const cmdClass = classifyBashFileLookupCommand(toolInput?.command);
        if (cmdClass) {
            return `Error: bridge worker bash file lookup blocked (${cmdClass}). Use Mixdog MCP read/grep/glob/list directly; bash is only for build/test/run/git-style commands.`;
        }
    }
    // Even when no explicit permissionMode is propagated to the worker, run
    // the evaluator under the most restrictive baseline ('default') so the
    // bypass-proof hard-deny patterns (UNC paths, /etc, C:/Windows, etc.)
    // and the user's settings.json deny rules still apply. Previously a
    // missing permissionMode short-circuited to null and the worker
    // ran ungated — a model could dispatch a bridge to read or write
    // protected paths even when the same call would have been denied for
    // the parent. Callers that genuinely need bypassPermissions can still
    // forward it explicitly via session-builder; this only closes the
    // silent default-to-bypass path.
    const permissionMode = sessionRef?.permissionMode || 'default';
    // Prefix bare mixdog tool names so the evaluator path-logic handles them correctly.
    const fullName = toolName.startsWith(MCP_TOOL_PREFIX) || toolName.startsWith('mcp__')
        ? toolName
        : `${MCP_TOOL_PREFIX}${toolName}`;
    const projectDir = sessionRef?.cwd || undefined;
    const userCwd = sessionRef?.cwd || undefined;
    try {
        const { decision, reason } = _evaluatePermission({
            toolName: fullName,
            toolInput: toolInput || {},
            permissionMode,
            projectDir,
            userCwd,
        });
        if (decision === 'deny' || decision === 'ask') {
            return `Error: tool "${toolName}" blocked by permission evaluator (decision=${decision}): ${reason}`;
        }
    } catch (err) {
        // Evaluator errors must not crash the loop — log and allow.
        try { process.stderr.write(`[permission-evaluator] error: ${err?.message}\n`); } catch {}
    }
    return null;
}
function effectiveToolPermission(sessionRef) {
    return sessionRef?.toolPermission || sessionRef?.permission || null;
}
function isBlockedByPermission(toolName, toolKind, permission) {
    if (permission === 'mcp') return !MCP_ONLY_ALLOWED_KINDS.has(toolKind);
    if (permission === 'read') return READ_BLOCKED_TOOLS.has(toolName);
    // Object-form {allow,deny} permission (role template / profile). The
    // schema-level intersection in createSession only narrows the ADVERTISED
    // tool list; it is not a runtime execution boundary. Enforce the same
    // allow/deny here as the fail-safe so a tool call for a non-advertised
    // (denied / out-of-allow) tool is rejected at dispatch time, matching
    // the string-form ('read'/'mcp') guards. Names are compared bare +
    // lowercased to mirror createSession's allow/deny set construction.
    if (permission && typeof permission === 'object') {
        const name = String(_stripMcpPrefix(toolName) || '').toLowerCase();
        const deny = Array.isArray(permission.deny) && permission.deny.length > 0
            ? permission.deny.map(n => String(n).toLowerCase())
            : null;
        if (deny && deny.includes(name)) return true;
        const allow = Array.isArray(permission.allow) && permission.allow.length > 0
            ? permission.allow.map(n => String(n).toLowerCase())
            : null;
        if (allow && !allow.includes(name)) return true;
        return false;
    }
    return false;
}
function isBlockedHiddenWrapperCall(toolName, sessionRef) {
    if (!RETRIEVAL_WRAPPERS.has(toolName)) return false;
    if (sessionRef?.owner !== 'bridge') return false;
    if (!isHiddenRole(sessionRef?.role)) return false;
    const allow = HIDDEN_ROLE_WRAPPER_ALLOWLIST[sessionRef.role];
    if (allow && allow.has(toolName)) return false;
    return true;
}
function messagesArrayChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return before !== after;
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) return true;
    }
    return false;
}
function normalizeUsage(usage) {
    if (!usage) return null;
    const costUsd = Number(usage.costUsd);
    return {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cachedTokens: usage.cachedTokens || 0,
        cacheWriteTokens: usage.cacheWriteTokens || 0,
        promptTokens: usage.promptTokens || 0,
        ...(Number.isFinite(costUsd) ? { costUsd } : {}),
        raw: usage.raw,
    };
}
function addUsage(total, usage) {
    const delta = normalizeUsage(usage);
    if (!delta) return total;
    if (!total) return { ...delta };
    const next = {
        ...total,
        inputTokens: (total.inputTokens || 0) + delta.inputTokens,
        outputTokens: (total.outputTokens || 0) + delta.outputTokens,
        cachedTokens: (total.cachedTokens || 0) + delta.cachedTokens,
        cacheWriteTokens: (total.cacheWriteTokens || 0) + delta.cacheWriteTokens,
        promptTokens: (total.promptTokens || 0) + delta.promptTokens,
    };
    if (delta.costUsd != null || total.costUsd != null) {
        next.costUsd = (total.costUsd || 0) + (delta.costUsd || 0);
    }
    return next;
}
function splitMessagesForRemoteCompact(messages) {
    if (!Array.isArray(messages)) return null;
    const system = messages.filter(m => m?.role === 'system');
    const nonSystem = messages.filter(m => m?.role !== 'system');
    let turnStart = -1;
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
        if (nonSystem[i]?.role === 'user') {
            turnStart = i;
            break;
        }
    }
    if (turnStart <= 0) return null;
    const oldHistory = nonSystem.slice(0, turnStart);
    if (!oldHistory.length) return null;
    return [...system, ...oldHistory];
}
function markRemoteCompactFallback(messages, providerName) {
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (m?.role !== 'user' || typeof m.content !== 'string') continue;
        if (!m.content.startsWith(SUMMARY_PREFIX)) continue;
        m._mixdogRemoteCompactFallback = 'openai-codex';
        m._mixdogRemoteCompactProvider = providerName || 'openai-oauth';
        return true;
    }
    return false;
}
function providerRemoteCompactEnabled(provider, opts) {
    if (opts?.remoteCompact === false) return false;
    if (process.env.MIXDOG_REMOTE_COMPACT === '0') return false;
    return typeof provider?.remoteCompactMessages === 'function';
}
function positiveTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function envFlag(name, fallback = false) {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
}
function envTokenInt(name) {
    return positiveTokenInt(process.env[name]);
}
function resolveSemanticCompactSetting(sessionRef, cfg = {}) {
    const env = process.env.MIXDOG_BRIDGE_COMPACT_SEMANTIC;
    if (env !== undefined) return envFlag('MIXDOG_BRIDGE_COMPACT_SEMANTIC', true);
    if (cfg.semantic === false || cfg.semantic === 'false' || cfg.semantic === 'off') return false;
    if (cfg.semantic === true || cfg.semantic === 'true' || cfg.semantic === 'on') return true;
    // OpenCode keeps compaction as a session concern. For Mixdog, default the
    // semantic agent only on bridge-owned workers so direct user sessions and
    // narrow tests do not pay an extra provider call unless they opt in.
    return sessionRef?.owner === 'bridge';
}
function resolveCompactBufferTokens(boundaryTokens, cfg = {}) {
    const configured = positiveTokenInt(cfg.bufferTokens ?? cfg.buffer)
        || envTokenInt('MIXDOG_BRIDGE_COMPACT_BUFFER_TOKENS')
        || DEFAULT_COMPACTION_BUFFER_TOKENS;
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return configured;
    const windowCap = Math.max(0, Math.floor(boundary * COMPACT_BUFFER_MAX_WINDOW_FRACTION));
    return Math.max(0, Math.min(configured, windowCap));
}
function resolveCompactKeepTokens(cfg = {}) {
    return positiveTokenInt(cfg.keepTokens ?? cfg.keep?.tokens ?? cfg.preserveRecentTokens)
        || envTokenInt('MIXDOG_BRIDGE_COMPACT_KEEP_TOKENS')
        || DEFAULT_COMPACTION_KEEP_TOKENS;
}
function resolveWorkerCompactPolicy(sessionRef, tools) {
    if (!sessionRef) return null;
    const cfg = sessionRef.compaction || {};
    const auto = cfg.auto !== false && envFlag('MIXDOG_BRIDGE_COMPACT_AUTO', true);
    if (!auto) return { auto: false };
    const contextWindow = positiveTokenInt(sessionRef.contextWindow ?? cfg.contextWindow);
    const autoLimit = positiveTokenInt(
        sessionRef.compactBoundaryTokens
            ?? cfg.boundaryTokens
            ?? sessionRef.autoCompactTokenLimit
            ?? cfg.autoCompactTokenLimit,
    );
    const boundaryTokens = autoLimit && contextWindow
        ? Math.min(autoLimit, contextWindow)
        : (autoLimit || contextWindow);
    if (!boundaryTokens) return null;
    const compactBoundaryTokens = Math.max(1, Math.floor(boundaryTokens * COMPACT_SAFETY_PERCENT));
    const bufferTokens = resolveCompactBufferTokens(compactBoundaryTokens, cfg);
    const triggerTokens = Math.max(1, compactBoundaryTokens - bufferTokens);
    const configuredReserve = positiveTokenInt(cfg.reservedTokens)
        || envTokenInt('MIXDOG_BRIDGE_COMPACT_RESERVED_TOKENS')
        || 0;
    const requestReserve = estimateRequestReserveTokens(tools);
    const keepTokens = resolveCompactKeepTokens(cfg);
    return {
        auto: true,
        prune: cfg.prune === true || envFlag('MIXDOG_BRIDGE_COMPACT_PRUNE', false),
        // Narrow active-turn fallback (bridge/worker only). When system +
        // current turn alone overflow the budget, shrink older same-turn tool
        // outputs / drop older same-turn groups before declaring overflow,
        // preserving system + task user + the latest group(s) and tool
        // pairing. Defaults on for workers; disable via env to restore the
        // strict no-fallback behavior.
        activeTurnFallback: cfg.activeTurnFallback !== false
            && envFlag('MIXDOG_BRIDGE_COMPACT_ACTIVE_TURN_FALLBACK', true),
        boundaryTokens: compactBoundaryTokens,
        triggerTokens,
        bufferTokens,
        contextWindow,
        rawContextWindow: positiveTokenInt(sessionRef.rawContextWindow ?? cfg.rawContextWindow) || contextWindow,
        effectiveContextWindowPercent: Number.isFinite(Number(sessionRef.effectiveContextWindowPercent ?? cfg.effectiveContextWindowPercent))
            ? Number(sessionRef.effectiveContextWindowPercent ?? cfg.effectiveContextWindowPercent)
            : null,
        autoCompactTokenLimit: positiveTokenInt(sessionRef.autoCompactTokenLimit ?? cfg.autoCompactTokenLimit),
        semantic: resolveSemanticCompactSetting(sessionRef, cfg),
        semanticTimeoutMs: positiveTokenInt(cfg.timeoutMs) || envTokenInt('MIXDOG_BRIDGE_COMPACT_TIMEOUT_MS') || 30_000,
        tailTurns: positiveTokenInt(cfg.tailTurns) || envTokenInt('MIXDOG_BRIDGE_COMPACT_TAIL_TURNS') || 2,
        keepTokens,
        preserveRecentTokens: positiveTokenInt(cfg.preserveRecentTokens) || envTokenInt('MIXDOG_BRIDGE_COMPACT_PRESERVE_RECENT_TOKENS') || keepTokens,
        reserveTokens: requestReserve + configuredReserve,
        requestReserveTokens: requestReserve,
        configuredReserveTokens: configuredReserve,
    };
}
function shouldCompactForPolicy(messageTokensEst, policy) {
    if (!policy?.auto || !policy.boundaryTokens) return false;
    if (messageTokensEst === null) return true;
    return messageTokensEst + (policy.reserveTokens || 0) >= (policy.triggerTokens || policy.boundaryTokens);
}
function countPrunedToolOutputs(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return 0;
    let count = 0;
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i += 1) {
        if (before[i]?.role !== 'tool' || after[i]?.role !== 'tool') continue;
        if (before[i]?.content !== after[i]?.content && after[i]?.compactedKind === 'tool_output_prune') count += 1;
    }
    return count;
}
function rememberCompactTelemetry(sessionRef, policy, meta = {}) {
    if (!sessionRef || !policy) return;
    const prev = sessionRef.compaction && typeof sessionRef.compaction === 'object'
        ? sessionRef.compaction
        : {};
    const changed = meta.compactChanged === true || meta.pruneCount > 0;
    sessionRef.compaction = {
        ...prev,
        auto: policy.auto !== false,
        prune: policy.prune === true,
        reservedTokens: policy.configuredReserveTokens || prev.reservedTokens || null,
        requestReserveTokens: policy.requestReserveTokens || 0,
        reserveTokens: policy.reserveTokens || 0,
        boundaryTokens: policy.boundaryTokens || null,
        triggerTokens: policy.triggerTokens || null,
        bufferTokens: policy.bufferTokens || 0,
        contextWindow: policy.contextWindow || null,
        rawContextWindow: policy.rawContextWindow || null,
        effectiveContextWindowPercent: policy.effectiveContextWindowPercent ?? null,
        autoCompactTokenLimit: policy.autoCompactTokenLimit || null,
        semantic: policy.semantic === true ? 'auto' : false,
        semanticModel: policy.semanticModel || null,
        semanticTimeoutMs: policy.semanticTimeoutMs || null,
        tailTurns: policy.tailTurns || null,
        keepTokens: policy.keepTokens || null,
        preserveRecentTokens: policy.preserveRecentTokens || null,
        lastCheckedAt: Date.now(),
        lastBeforeTokens: meta.beforeTokens ?? null,
        lastAfterTokens: meta.afterTokens ?? null,
        lastStage: meta.stage || prev.lastStage || null,
        lastChanged: changed,
        lastRemote: meta.remoteCompact === true,
        lastSemantic: meta.semanticCompact === true,
        lastSemanticError: meta.semanticError || null,
        lastPruneCount: meta.pruneCount || 0,
        compactCount: (prev.compactCount || 0) + (changed ? 1 : 0),
    };
    sessionRef.contextWindow = policy.contextWindow || sessionRef.contextWindow;
    sessionRef.rawContextWindow = policy.rawContextWindow || sessionRef.rawContextWindow;
    sessionRef.autoCompactTokenLimit = policy.autoCompactTokenLimit || sessionRef.autoCompactTokenLimit || null;
    sessionRef.compactBoundaryTokens = policy.boundaryTokens || sessionRef.compactBoundaryTokens || null;
    if (policy.effectiveContextWindowPercent !== null) {
        sessionRef.effectiveContextWindowPercent = policy.effectiveContextWindowPercent;
    }
}
const SKILL_TOOL_NAMES = new Set(['skills_list', 'skill_view', 'skill_execute']);
const SPECIAL_TOOL_NAMES = new Set(['bash_session', 'apply_patch', 'code_graph']);
const BASH_SESSION_HEADER_RE = /\[session: ([^\]\r\n]+)\]/;
const STORED_TOOL_ARG_BODY_KEY_RE = /^(?:content|old_string|new_string|patch|rewrite)$/i;
const STORED_TOOL_ARG_LONG_KEY_RE = /^(?:command|script)$/i;
const STORED_TOOL_ARG_BODY_LIMIT = 2_000;
const STORED_TOOL_ARG_LONG_LIMIT = 8_000;
const STORED_TOOL_ARG_PREVIEW_HEAD = 360;
const STORED_TOOL_ARG_PREVIEW_TAIL = 160;

function compactStoredToolArgString(value, key = '') {
    if (typeof value !== 'string') return value;
    const isBody = STORED_TOOL_ARG_BODY_KEY_RE.test(key);
    const isLong = isBody || STORED_TOOL_ARG_LONG_KEY_RE.test(key);
    const limit = isBody ? STORED_TOOL_ARG_BODY_LIMIT : (isLong ? STORED_TOOL_ARG_LONG_LIMIT : Infinity);
    if (value.length <= limit) return value;
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const head = value.slice(0, STORED_TOOL_ARG_PREVIEW_HEAD).replace(/\r\n/g, '\n');
    const tail = value.slice(-STORED_TOOL_ARG_PREVIEW_TAIL).replace(/\r\n/g, '\n');
    return `[mixdog compacted ${key || 'string'}: ${value.length} chars, sha256:${hash}]\n${head}\n... [middle omitted from stored tool-call args] ...\n${tail}`;
}

function compactStoredToolArgValue(value, key = '', depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return compactStoredToolArgString(value, key);
    if (typeof value !== 'object') return value;
    if (depth >= 6) return Array.isArray(value) ? `[${value.length} items]` : '{...}';
    if (Array.isArray(value)) {
        return value.map((item) => compactStoredToolArgValue(item, key, depth + 1));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = compactStoredToolArgValue(v, k, depth + 1);
    }
    return out;
}

function compactToolCallsForHistory(calls) {
    if (!Array.isArray(calls)) return calls;
    return calls.map((call) => {
        if (!call || typeof call !== 'object') return call;
        return {
            ...call,
            arguments: compactStoredToolArgValue(call.arguments),
        };
    });
}

// Restore the FULL body of ONE tool call inside a history assistant message
// whose toolCalls were compacted at push time. Used for a failed edit call so
// the model sees the original patch/old_string on retry instead of a
// `[mixdog compacted …]` placeholder it cannot act on. Must run BEFORE the
// message is first transmitted so it never mutates an already-cached prefix
// (the prompt cache is content-prefix matched).
//
// Only the compactable body/long keys (patch, old_string, new_string, content,
// rewrite, command, script) are restored, and at ANY depth — compaction is
// recursive (compactStoredToolArgValue), so batch shapes like edits[].old_string
// or writes[].content carry nested compacted bodies too. Every other field
// (e.g. `path`, which a tool may mutate in place during execution) is taken from
// the compacted snapshot captured at push time, before any mutation. The
// compacted args tree is built fresh by compactToolCallsForHistory and is not
// shared with originalCalls, so rebuilding it here is safe.
function restoreToolCallBodyForId(assistantMsg, originalCalls, callId) {
    if (!assistantMsg || !Array.isArray(assistantMsg.toolCalls) || !callId) return;
    if (!Array.isArray(originalCalls)) return;
    const tc = assistantMsg.toolCalls.find((t) => t && t.id === callId);
    const orig = originalCalls.find((c) => c && c.id === callId);
    if (!tc || !orig) return;
    if (!tc.arguments || typeof tc.arguments !== 'object'
        || !orig.arguments || typeof orig.arguments !== 'object') return;
    tc.arguments = _restoreCompactedBodies(tc.arguments, orig.arguments, '');
}

// Recursively rebuild a compacted args tree: replace ONLY compactable body/long
// string fields (matched by key at any depth) with their full originals, and
// keep every other field from the compacted snapshot. tcVal and origVal share
// the same structure (compaction only shortens body strings), so the walk
// descends them in parallel; a missing or non-object origVal falls back to the
// compacted value rather than throwing.
function _restoreCompactedBodies(tcVal, origVal, key) {
    if ((STORED_TOOL_ARG_BODY_KEY_RE.test(key) || STORED_TOOL_ARG_LONG_KEY_RE.test(key))
        && typeof origVal === 'string') {
        return origVal;
    }
    if (Array.isArray(tcVal) && Array.isArray(origVal)) {
        return tcVal.map((item, i) => _restoreCompactedBodies(item, origVal[i], key));
    }
    if (tcVal && typeof tcVal === 'object' && origVal && typeof origVal === 'object') {
        const out = {};
        for (const k of Object.keys(tcVal)) {
            out[k] = (k in origVal) ? _restoreCompactedBodies(tcVal[k], origVal[k], k) : tcVal[k];
        }
        return out;
    }
    return tcVal;
}
/**
 * Execute a single tool call — routes to MCP or builtin.
 */
function getToolKind(name) {
    if (SKILL_TOOL_NAMES.has(name)) return 'skill';
    if (SPECIAL_TOOL_NAMES.has(name)) return 'builtin';
    if (isMcpTool(name)) return 'mcp';
    if (isInternalTool(name)) return 'internal';
    if (isBuiltinTool(name)) return 'builtin';
    return 'builtin';
}
function buildSkillsListResponse(cwd) {
    const skills = collectSkillsCached(cwd);
    const entries = skills.map(s => ({ name: s.name, description: s.description || '' }));
    return JSON.stringify({ skills: entries });
}
function viewSkill(cwd, name) {
    if (!name) return 'Error: skill name is required';
    const content = loadSkillContent(name, cwd);
    return content || `Error: skill "${name}" not found`;
}
function executeSkill(cwd, name, _args) {
    if (!name) return 'Error: skill name is required';
    const content = loadSkillContent(name, cwd);
    return content || `Error: skill "${name}" not found`;
}
function extractBashSessionId(result) {
    if (typeof result !== 'string') return null;
    const match = BASH_SESSION_HEADER_RE.exec(result);
    return match ? match[1] : null;
}

export function buildBridgeBashSessionArgs(args, sessionRef) {
    if (sessionRef?.owner !== 'bridge') return null;
    // run_in_background is a detached one-shot job, incompatible with the
    // persistent bash session. Fall through to the background-job path
    // (executeBuiltinTool -> startBackgroundShellJob) so the worker gets a
    // [job: ...] id that job_wait can resolve — otherwise the persistent
    // session returns a [session: ...] header and job_wait reports "job not found".
    if (args?.run_in_background === true) return null;
    const routedArgs = { ...(args || {}) };
    const explicitSessionId = typeof routedArgs.session_id === 'string' && routedArgs.session_id.trim()
        ? routedArgs.session_id.trim()
        : null;
    const wantsPersistent = routedArgs.persistent === true || !!explicitSessionId;
    if (!wantsPersistent) return null;
    if (!explicitSessionId && sessionRef?.implicitBashSessionId) {
        routedArgs.session_id = sessionRef.implicitBashSessionId;
    } else if (explicitSessionId) {
        routedArgs.session_id = explicitSessionId;
    }
    delete routedArgs.persistent;
    return routedArgs;
}

function _scopedCacheOutcomeForCall(sessionRef, toolCallId, toolName, callerSessionId, executeOpts = {}) {
    if (executeOpts.scopedCacheOutcome) {
        if (sessionRef && toolCallId) {
            if (!sessionRef._scopedCacheOutcomeByCallId) sessionRef._scopedCacheOutcomeByCallId = new Map();
            sessionRef._scopedCacheOutcomeByCallId.set(toolCallId, executeOpts.scopedCacheOutcome);
        }
        return executeOpts.scopedCacheOutcome;
    }
    if (!callerSessionId || !toolCallId || !_isScopedCacheableTool(toolName)) return null;
    const outcome = createScopedCacheOutcome();
    if (sessionRef) {
        if (!sessionRef._scopedCacheOutcomeByCallId) sessionRef._scopedCacheOutcomeByCallId = new Map();
        sessionRef._scopedCacheOutcomeByCallId.set(toolCallId, outcome);
    }
    return outcome;
}

async function executeTool(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
    const scopedCacheOutcome = _scopedCacheOutcomeForCall(
        sessionRef,
        executeOpts.toolCallId,
        name,
        callerSessionId,
        executeOpts,
    );
    const toolOpts = scopedCacheOutcome
        ? { ...executeOpts, scopedCacheOutcome }
        : executeOpts;
    const beforeToolHook = typeof executeOpts.beforeToolHook === 'function'
        ? executeOpts.beforeToolHook
        : sessionRef?.beforeToolHook;
    if (beforeToolHook) {
        try {
            const decision = await beforeToolHook({
                name,
                args,
                cwd,
                sessionId: callerSessionId,
                toolCallId: executeOpts.toolCallId || null,
            });
            const action = String(decision?.action || decision?.decision || '').toLowerCase();
            if (action === 'deny' || action === 'block') {
                const reason = decision?.reason ? `: ${decision.reason}` : '';
                return `Error: tool "${name}" denied by hook${reason}`;
            }
            if ((action === 'modify' || action === 'rewrite') && decision?.args && typeof decision.args === 'object' && !Array.isArray(decision.args)) {
                args = decision.args;
            }
        } catch {
            // Hooks are policy extensions. A broken hook must not wedge the agent loop.
        }
    }
    if (name === 'skills_list') {
        return buildSkillsListResponse(cwd);
    }
    if (name === 'skill_view') {
        return viewSkill(cwd, args?.name);
    }
    if (name === 'skill_execute') {
        return executeSkill(cwd, args?.name, args?.args);
    }
    if (isMcpTool(name)) {
        // 24h trace data shows ~24% of external MCP calls are cwd-sensitive
        // (bash / grep / read / list / glob etc.) but the worker session's
        // cwd was previously dropped here. Inject cwd only when the tool's
        // inputSchema declares the field — schemas without it would reject
        // an unknown argument.
        const needsCwdInjection = cwd
            && mcpToolHasField(name, 'cwd')
            && (args == null || args.cwd == null);
        const finalArgs = needsCwdInjection ? { ...(args || {}), cwd } : args;
        return executeMcpTool(name, finalArgs);
    }
    if (isCodeGraphTool(name)) {
        // cwd chain: args.cwd (caller-explicit) → session cwd → undefined (handler throws)
        const graphCwd = (typeof args?.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
        return executeCodeGraphTool(name, args, graphCwd, null, toolOpts);
    }
    if (isInternalTool(name)) {
        // callerSessionId propagates into server.mjs dispatchTool so that
        // dispatchAiWrapped can detect and reject recursive calls from a
        // hidden-role session (recall/search/explore → self).
        return executeInternalTool(name, args, { callerSessionId, callerCwd: cwd });
    }
    if (name === 'bash') {
        const routedArgs = buildBridgeBashSessionArgs(args, sessionRef);
        if (!routedArgs) {
            // clientHostPid scopes background shell-jobs to the dispatching
            // terminal's claude.exe pid (bridge sessions store it on sessionRef);
            // without it resolveJobOwnerHostPid falls back to the daemon-global env.
            return executeBuiltinTool(name, args, cwd, { sessionId: callerSessionId, clientHostPid: sessionRef?.clientHostPid, ...toolOpts });
        }
        // Thread the session's AbortSignal so bridge type=close can interrupt the
        // persistent child process. getSessionAbortSignal is imported at top of
        // loop.mjs from manager.mjs; callerSessionId identifies the controller.
        let _bashAbortSignal = null;
        try { _bashAbortSignal = getSessionAbortSignal(callerSessionId); } catch { /* ignore */ }
        const result = await executeBashSessionTool('bash_session', routedArgs, cwd, {
            sessionId: callerSessionId,
            abortSignal: _bashAbortSignal,
        });
        const bashSid = extractBashSessionId(result);
        if (bashSid) {
            sessionRef.implicitBashSessionId = bashSid;
            // Track all persistent bash sessions for bulk teardown on close.
            if (sessionRef.allBashSessionIds) {
                if (!sessionRef.allBashSessionIds.includes(bashSid)) {
                    sessionRef.allBashSessionIds.push(bashSid);
                }
            } else {
                sessionRef.allBashSessionIds = [bashSid];
            }
        }
        return result;
    }
    if (name === 'apply_patch') {
        return executePatchTool(name, args, cwd, { sessionId: callerSessionId });
    }
    if (isBuiltinTool(name)) {
        // clientHostPid threaded for the same per-terminal job-scope reason as
        // the bash branch above (see resolveJobOwnerHostPid).
        return executeBuiltinTool(name, args, cwd, { sessionId: callerSessionId, clientHostPid: sessionRef?.clientHostPid, signal: executeOpts.signal, ...toolOpts });
    }
    return formatUnknownBuiltinToolMessage(name, args, 'tool');
}
/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 * sendOpts may include:
 *   - `effort` (provider-specific)
 *   - `fast` (boolean)
 *   - `sessionId` — enables runtime liveness markers (optional)
 *   - `signal` — AbortSignal; checked at each iteration boundary and after each
 *                tool. When aborted, throws SessionClosedError so the ask
 *                wrapper can propagate a clean cancellation.
 *   - `onStageChange(stage)` / `onStreamDelta()` — forwarded to provider.send for heartbeats
 */
// Source of truth: defaults/hidden-roles.json (loaded via _getHiddenRoles
// above). Build the name Set eagerly at module load so HIDDEN_ROLE_NAMES
// stays in sync with the declarative registry — no hardcoded duplicate.
const HIDDEN_ROLE_NAMES = new Set(
    (_getHiddenRoles().roles || []).map((r) => r && r.name).filter((n) => typeof n === 'string' && n.length > 0)
);

// Stop reasons that signal the turn was cut short mid-synthesis (token cap,
// provider pause). Empty content + one of these reasons means the worker
// was not done — re-prompt instead of accepting empty as final.
// Covers Anthropic (pause_turn, max_tokens), OpenAI (length), Gemini
// (MAX_TOKENS, OTHER), and case variants.
const INCOMPLETE_STOP_REASONS = new Set([
    'pause_turn', 'max_tokens', 'length', 'MAX_TOKENS', 'OTHER',
]);

export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let firstTurnUsage;
    let response;
    let contractNudges = 0;
    const opts = sendOpts || {};
    const sessionId = opts.sessionId || null;
    const signal = opts.signal || null;
    const sessionRole = opts.session?.role;
    const forcedFirstTool = opts.forcedFirstTool ?? null;
    const forcedFirstToolDef = forcedFirstTool
        ? tools.find(tool => tool?.name === forcedFirstTool)
        : null;
    // Opaque providerState passthrough. The loop never inspects provider-native
    // payloads; the originating provider owns them. OpenAI Codex uses this for
    // native remote compaction prefixes, and stateful Responses providers may
    // use it for continuation anchors.
    let providerState = opts.providerState ?? undefined;
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const reason = signal.reason instanceof Error ? signal.reason : null;
            // Preserve any structured abort reason (SessionClosedError,
            // StreamStalledAbortError, etc.). Fallback to SessionClosedError
            // when the reason is not an Error instance.
            if (reason) throw reason;
            throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
        }
    };
    const sessionRef = opts.session || null;
    const maxLoopIterations = Number.isFinite(sessionRef?.maxLoopIterations)
        ? sessionRef.maxLoopIterations
        : MAX_LOOP_ITERATIONS;
    // Tool execution must use the session cwd even when the caller omitted the
    // legacy positional cwd argument. Bridge workers always carry their cwd on
    // sessionRef; falling through to pwd()/process.cwd() resolves relatives
    // against the host/plugin root instead of the worker workspace.
    cwd = cwd || sessionRef?.cwd || undefined;
    while (true) {
        throwIfAborted();
        if (iterations >= maxLoopIterations) {
            process.stderr.write(`[loop] hard iteration cap ${maxLoopIterations} reached (sess=${sessionId || 'unknown'}); stopping loop.\n`);
            break;
        }
        const compactPolicy = resolveWorkerCompactPolicy(sessionRef, tools);
        if (compactPolicy?.auto) {
            // Snapshot pre-compact shape so compact_meta can record the actual
            // mutation (or no-op) for prefix-mutation forensics. Bytes are
            // a best-effort JSON.stringify length — close enough to the
            // payload we hand the provider for prefix-cache analysis.
            const beforeCount = messages.length;
            let beforeBytes = null;
            try { beforeBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { beforeBytes = null; }
            const messageTokensEst = estimateMessagesTokensSafe(messages);
            const shouldCompact = shouldCompactForPolicy(messageTokensEst, compactPolicy);
            if (!shouldCompact) {
                rememberCompactTelemetry(sessionRef, compactPolicy, {
                    stage: 'pre_send_check',
                    beforeTokens: messageTokensEst,
                    afterTokens: messageTokensEst,
                });
            } else {
                let compacted;
                let remoteCompactResult = null;
                let pruneCount = 0;
                let summaryChanged = false;
                let semanticCompactResult = null;
                let semanticCompactError = null;
                try {
                    let compactInputMessages = messages;
                    if (compactPolicy.prune) {
                        const pruned = pruneToolOutputs(messages, compactPolicy.boundaryTokens, {
                            reserveTokens: compactPolicy.reserveTokens,
                        });
                        pruneCount = countPrunedToolOutputs(messages, pruned);
                        compactInputMessages = pruned;
                    }
                    // Pre-send compaction replaces destructive drop: older
                    // non-system history is condensed into one summary message.
                    // The current turn and tool pairing stay intact; if those
                    // mandatory parts cannot fit, compactMessages throws instead
                    // of silently discarding user-visible context.
                    if (compactPolicy.semantic) {
                        try {
                            semanticCompactResult = await semanticCompactMessages(
                                provider,
                                compactInputMessages,
                                model,
                                compactPolicy.boundaryTokens,
                                {
                                    reserveTokens: compactPolicy.reserveTokens,
                                    providerName: sessionRef.provider || provider?.name || null,
                                    sessionId,
                                    signal,
                                    sendOpts: opts,
                                    promptCacheKey: opts.promptCacheKey || null,
                                    providerCacheKey: opts.providerCacheKey || null,
                                    timeoutMs: compactPolicy.semanticTimeoutMs,
                                    tailTurns: compactPolicy.tailTurns,
                                    keepTokens: compactPolicy.keepTokens,
                                    preserveRecentTokens: compactPolicy.preserveRecentTokens,
                                },
                            );
                            compacted = semanticCompactResult.messages;
                            if (semanticCompactResult?.usage) {
                                lastUsage = addUsage(lastUsage, semanticCompactResult.usage);
                                if (!firstTurnUsage) firstTurnUsage = normalizeUsage(semanticCompactResult.usage);
                                if (sessionId && opts.onUsageDelta) {
                                    try {
                                        opts.onUsageDelta({
                                            sessionId,
                                            iterationIndex: iterations + 1,
                                            deltaInput: semanticCompactResult.usage.inputTokens || 0,
                                            deltaOutput: semanticCompactResult.usage.outputTokens || 0,
                                            deltaCachedRead: semanticCompactResult.usage.cachedTokens || 0,
                                            deltaCacheWrite: semanticCompactResult.usage.cacheWriteTokens || 0,
                                            source: 'semantic_compact',
                                            ts: Date.now(),
                                        });
                                    } catch { /* best-effort */ }
                                }
                            }
                        } catch (semanticErr) {
                            semanticCompactError = semanticErr;
                            try {
                                process.stderr.write(
                                    `[loop] semantic compact failed (sess=${sessionId || 'unknown'}): ` +
                                    `${semanticErr?.message || semanticErr}; falling back to deterministic compact\n`,
                                );
                            } catch { /* best-effort */ }
                        }
                    }
                    if (!compacted) {
                        try {
                            compacted = compactMessages(compactInputMessages, compactPolicy.boundaryTokens, {
                                reserveTokens: compactPolicy.reserveTokens,
                            });
                        } catch (deterministicErr) {
                            // Deterministic (and any prior semantic) compaction
                            // failed because system + the entire current turn is
                            // mandatory and overflows the budget. For bridge
                            // workers, fall back to the narrow active-turn
                            // compactor, which shrinks older same-turn tool
                            // outputs / drops older same-turn groups while
                            // preserving system + task user + the latest
                            // group(s) and tool pairing. It still throws (and we
                            // surface overflow below) when even that floor cannot
                            // fit, so overflow/cancellation behavior is preserved.
                            if (!compactPolicy.activeTurnFallback) throw deterministicErr;
                            compacted = compactActiveTurn(compactInputMessages, compactPolicy.boundaryTokens, {
                                reserveTokens: compactPolicy.reserveTokens,
                            });
                            try {
                                process.stderr.write(
                                    `[loop] active-turn fallback compaction (sess=${sessionId || 'unknown'}): ` +
                                    `${deterministicErr?.message || deterministicErr}\n`,
                                );
                            } catch { /* best-effort */ }
                        }
                    }
                    summaryChanged = messagesArrayChanged(compactInputMessages, compacted);
                    if (summaryChanged && providerRemoteCompactEnabled(provider, opts)) {
                        const compactInput = splitMessagesForRemoteCompact(messages);
                        if (compactInput) {
                            try {
                                remoteCompactResult = await provider.remoteCompactMessages(
                                    compactInput,
                                    model,
                                    tools,
                                    {
                                        ...opts,
                                        thinkingBudgetTokens: undefined,
                                        xaiReasoningEffort: undefined,
                                        reasoningEffort: undefined,
                                        effort: 'low',
                                        providerState,
                                        iteration: iterations + 1,
                                        remoteCompact: true,
                                        onToolCall: undefined,
                                        onStreamDelta: undefined,
                                    },
                                );
                                if (remoteCompactResult?.providerState !== undefined) {
                                    markRemoteCompactFallback(compacted, provider?.name);
                                }
                                if (remoteCompactResult?.usage) {
                                    lastUsage = addUsage(lastUsage, remoteCompactResult.usage);
                                    if (!firstTurnUsage) firstTurnUsage = normalizeUsage(remoteCompactResult.usage);
                                    if (sessionId && opts.onUsageDelta) {
                                        try {
                                            opts.onUsageDelta({
                                                sessionId,
                                                iterationIndex: iterations + 1,
                                                deltaInput: remoteCompactResult.usage.inputTokens || 0,
                                                deltaOutput: remoteCompactResult.usage.outputTokens || 0,
                                                deltaCachedRead: remoteCompactResult.usage.cachedTokens || 0,
                                                deltaCacheWrite: remoteCompactResult.usage.cacheWriteTokens || 0,
                                                source: 'remote_compact',
                                                ts: Date.now(),
                                            });
                                        } catch { /* best-effort */ }
                                    }
                                }
                            } catch (remoteErr) {
                                try {
                                    process.stderr.write(
                                        `[loop] remote compact failed (sess=${sessionId || 'unknown'}): ` +
                                        `${remoteErr?.message || remoteErr}; falling back to local summary\n`,
                                    );
                                } catch { /* best-effort */ }
                                traceBridgeCompact({
                                    sessionId,
                                    iteration: iterations + 1,
                                    stage: 'remote_compact',
                                    prune_count: pruneCount,
                                    compact_changed: false,
                                    input_prefix_hash: messagePrefixHash(messages),
                                    before_count: beforeCount,
                                    after_count: beforeCount,
                                    before_bytes: beforeBytes,
                                    after_bytes: beforeBytes,
                                    context_window: compactPolicy.contextWindow,
                                    budget_tokens: compactPolicy.boundaryTokens,
                                    reserve_tokens: compactPolicy.reserveTokens,
                                    message_tokens_est: messageTokensEst,
                                    provider: sessionRef.provider,
                                    model: sessionRef.model || model,
                                    error: remoteErr && remoteErr.message ? remoteErr.message : String(remoteErr),
                                    error_code: 'REMOTE_COMPACT_FAILED',
                                });
                            }
                        }
                    }
                } catch (compactErr) {
                    traceBridgeCompact({
                        sessionId,
                        iteration: iterations + 1,
                        stage: 'pre_send',
                        prune_count: pruneCount,
                        compact_changed: false,
                        input_prefix_hash: messagePrefixHash(messages),
                        before_count: beforeCount,
                        after_count: messages.length,
                        before_bytes: beforeBytes,
                        after_bytes: beforeBytes,
                        context_window: compactPolicy.contextWindow,
                        budget_tokens: compactPolicy.boundaryTokens,
                        reserve_tokens: compactPolicy.reserveTokens,
                        message_tokens_est: messageTokensEst,
                        provider: sessionRef.provider,
                        model: sessionRef.model || model,
                        error: compactErr && compactErr.message ? compactErr.message : String(compactErr),
                        error_code: 'BRIDGE_CONTEXT_OVERFLOW',
                    });
                    throw bridgeContextOverflowError({
                        stage: 'pre_send',
                        sessionId,
                        sessionRef,
                        model,
                        budgetTokens: compactPolicy.boundaryTokens,
                        reserveTokens: compactPolicy.reserveTokens,
                        messageTokensEst,
                    }, compactErr);
                }
                const compactChanged = messagesArrayChanged(messages, compacted);
                if (compactChanged) {
                    messages.length = 0;
                    messages.push(...compacted);
                    if (remoteCompactResult?.providerState !== undefined) {
                        providerState = remoteCompactResult.providerState;
                    } else {
                        // Compacting/pruning the transcript invalidates the
                        // server-side conversation anchor (xAI Responses /
                        // Codex WS rely on previous_response_id which points
                        // at a now-mutated prefix). Drop providerState so the
                        // next send starts a fresh chain instead of triggering
                        // silent cache miss or hard mismatch.
                        providerState = undefined;
                    }
                    // Compaction shrank the transcript, so prior turns no
                    // longer pressure the window — reset the iteration counter
                    // so a steadily-compacting long task isn't killed by the
                    // cap, while a non-compacting tight loop still hits it.
                    iterations = 0;
                }
                const afterTokens = estimateMessagesTokensSafe(messages);
                rememberCompactTelemetry(sessionRef, compactPolicy, {
                    stage: 'pre_send',
                    beforeTokens: messageTokensEst,
                    afterTokens,
                    compactChanged,
                    remoteCompact: remoteCompactResult?.providerState !== undefined,
                    semanticCompact: semanticCompactResult?.semantic === true,
                    semanticError: semanticCompactError?.message || null,
                    pruneCount,
                });
                let afterBytes = null;
                try { afterBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { afterBytes = null; }
                traceBridgeCompact({
                    sessionId,
                    iteration: iterations + 1,
                    stage: 'pre_send',
                    prune_count: pruneCount,
                    compact_changed: compactChanged || summaryChanged,
                    input_prefix_hash: messagePrefixHash(messages),
                    before_count: beforeCount,
                    after_count: messages.length,
                    before_bytes: beforeBytes,
                    after_bytes: afterBytes,
                    context_window: compactPolicy.contextWindow,
                    budget_tokens: compactPolicy.boundaryTokens,
                    reserve_tokens: compactPolicy.reserveTokens,
                    message_tokens_est: messageTokensEst,
                    provider: sessionRef.provider,
                    model: sessionRef.model || model,
                });
            }
        }
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        if (forcedFirstTool && toolCallsTotal === 0) {
            opts.toolChoice = 'required';
        } else {
            delete opts.toolChoice;
        }
        const sendTools = forcedFirstToolDef && toolCallsTotal === 0 ? [forcedFirstToolDef] : tools;
        // Eager-dispatch queue: when the provider streams a tool-call event,
        // start read-only tools immediately so execution overlaps with the
        // remaining SSE parse. Writes and unknown tools wait until send()
        // returns and run serially in the call-order loop below.
        const pending = new Map();
        // Streaming-time intra-turn dedup. When the LLM emits two
        // tool_use blocks with identical (name, args) signatures in
        // sequence, the provider's onToolCall fires for both BEFORE
        // the iter for-body runs, so the batch-level pre-pass would be
        // too late to prevent the eager dispatch of the second one.
        // Track signatures of in-flight eager calls and skip starting a
        // second one for the same sig. The duplicate's executeTool is
        // never invoked; the for-body's pre-pass marks it as a duplicate
        // and emits a stub tool_result. The sig is NOT cleared when the
        // eager promise settles (see finally below): a streaming onToolCall
        // can deliver a same-turn identical call AFTER the first promise
        // settles but BEFORE the deferred cache set (:1256), and the static
        // pre-pass (:909) only runs after send() returns — so clearing the
        // sig on settle would let that second streaming eager call
        // re-execute. A fresh Map() is created per turn, so the sig set
        // resets at the turn boundary without leaking across iterations.
        const _eagerInFlightSigs = new Map();
        let _mutationEpoch = 0;
        const startEagerTool = (call) => {
            if (!call?.id || pending.has(call.id) || !isEagerDispatchable(call.name, tools)) return null;
            const _sig = _intraTurnSig(call.name, call.arguments);
            if (_eagerInFlightSigs.has(_sig)) return null;
            // Repeat-failure guard also gates eager dispatch (reviewer-flagged):
            // streaming onToolCall / startEagerRun would otherwise re-run an
            // identical read-only call that already failed REPEAT_FAIL_LIMIT
            // times before the serial for-body guard runs. Returning null here
            // lets the serial body push the [repeat-failure-guard] stub.
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _sig && _rfg.count >= REPEAT_FAIL_LIMIT) return null;
            }
            const toolKind = getToolKind(call.name);
            // Shared pre-dispatch deny: identical predicate runs in the
            // serial path below. If any role/permission guard would reject
            // this call there, never start it eagerly here.
            if (_preDispatchDeny(call, toolKind, sessionRef) !== null) return null;
            const entry = { startedAt: Date.now(), endedAt: null, mutationEpoch: _mutationEpoch };
            _eagerInFlightSigs.set(_sig, call.id);
            entry.promise = (async () => {
                try {
                    const permBlocked = _checkWorkerPermission(call.name, call.arguments, sessionRef);
                    if (permBlocked !== null) return { ok: true, value: permBlocked };
                    return { ok: true, value: await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal }) };
                } catch (error) {
                    return { ok: false, error };
                }
            })()
                .finally(() => {
                    entry.endedAt = Date.now();
                    // Intentionally do NOT delete _sig here — see the block
                    // comment above. The sig must outlive promise settlement
                    // so a later same-turn streaming duplicate stays blocked
                    // at the _eagerInFlightSigs.has(_sig) guard until the turn
                    // boundary recreates the Map.
                });
            pending.set(call.id, entry);
            return entry;
        };
        const startEagerRun = (calls, startIndex, dupSet) => {
            for (let j = startIndex; j < calls.length; j += 1) {
                const call = calls[j];
                if (!call?.id || !isEagerDispatchable(call.name, tools)) break;
                if (dupSet && dupSet.has(call.id)) continue;
                if (!startEagerTool(call) && !pending.has(call.id)) break;
            }
        };
        let _streamEagerBlocked = false;
        opts.onToolCall = (call) => {
            if (!isEagerDispatchable(call?.name, tools)) {
                _streamEagerBlocked = true;
                return;
            }
            if (_streamEagerBlocked) return;
            startEagerTool(call);
        };
        // Repair any dangling assistant tool_use left over from a prior
        // abort/error path before the provider sees the transcript. No-op
        // on the healthy iteration cycle (every assistant tool_use is
        // followed by tool results in the same loop body below).
        _ensureTranscriptPairing(messages, sessionId);
        // Strip soft-warn markers from prior tool results before the next
        // send. Marker bytes (Tool-budget(xN), Same-file reads(xN), etc.)
        // mutate every turn with dynamic counters, so leaving them in the
        // transcript breaks server-side prefix cache lookup on later turns.
        // The current turn's marker (if any) is appended AFTER this strip,
        // so the model still sees the self-correct hint on its own iteration.
        for (let _i = 0; _i < messages.length; _i++) {
            const _m = messages[_i];
            if (_m && _m.role === 'tool' && typeof _m.content === 'string' && _m.content.includes('⚠')) {
                const _stripped = stripSoftWarns(_m.content);
                if (_stripped !== _m.content) _m.content = _stripped;
            }
        }
        const sendStartedAt = Date.now();
        try {
            response = await provider.send(messages, model, sendTools.length ? sendTools : undefined, opts);
        } catch (sendErr) {
            // Context-window-exceeded is a deterministic refusal: the request is
            // simply too large. Retry ONCE with a stricter budget using the
            // same summary-based compaction path. It never falls back to
            // destructive trim/drop: if system + current turn + compact marker
            // cannot fit, surface overflow. Unrelated errors (network, stall,
            // auth, etc.) re-throw untouched — they are handled by the
            // provider/bridge retry layers.
            if (
                !isContextOverflowError(sendErr)
                || !(sessionRef && typeof sessionRef.contextWindow === 'number')
            ) {
                throw sendErr;
            }
            const overflowPolicy = resolveWorkerCompactPolicy(sessionRef, sendTools.length ? sendTools : tools);
            const overflowBase = overflowPolicy?.boundaryTokens || sessionRef.contextWindow;
            const overflowBudget = Math.max(1, Math.min(
                overflowBase,
                overflowPolicy?.triggerTokens || Math.floor(overflowBase * OVERFLOW_RETRY_COMPACT_PERCENT),
            ));
            const overflowReserve = overflowPolicy?.reserveTokens || estimateRequestReserveTokens(sendTools.length ? sendTools : tools);
            const beforeCount = messages.length;
            let beforeBytes = null;
            try { beforeBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { beforeBytes = null; }
            const messageTokensEst = estimateMessagesTokensSafe(messages);
            let recompacted;
            try {
                recompacted = compactMessages(messages, overflowBudget, { reserveTokens: overflowReserve });
            } catch (compactErr) {
                // Same narrow active-turn fallback as the pre-send path: when
                // system + the whole current turn overflow even the stricter
                // overflow-retry budget, shrink older same-turn tool outputs /
                // drop older same-turn groups before surfacing overflow. Throws
                // (caught below) when even the floor cannot fit, preserving the
                // overflow error behavior.
                if (overflowPolicy?.activeTurnFallback) {
                    try {
                        recompacted = compactActiveTurn(messages, overflowBudget, { reserveTokens: overflowReserve });
                        try {
                            process.stderr.write(
                                `[loop] active-turn fallback compaction on overflow retry ` +
                                `(sess=${sessionId || 'unknown'} iter=${nextIteration}): ` +
                                `${compactErr?.message || compactErr}\n`,
                            );
                        } catch { /* best-effort */ }
                    } catch { recompacted = undefined; }
                }
                if (!recompacted) {
                traceBridgeCompact({
                    sessionId,
                    iteration: nextIteration,
                    stage: 'overflow_retry',
                    prune_count: 0,
                    compact_changed: false,
                    input_prefix_hash: messagePrefixHash(messages),
                    before_count: beforeCount,
                    after_count: messages.length,
                    before_bytes: beforeBytes,
                    after_bytes: beforeBytes,
                    context_window: overflowPolicy?.contextWindow || sessionRef.contextWindow,
                    budget_tokens: overflowBudget,
                    reserve_tokens: overflowReserve,
                    message_tokens_est: messageTokensEst,
                    provider: sessionRef.provider,
                    model: sessionRef.model || model,
                    error: compactErr && compactErr.message ? compactErr.message : String(compactErr),
                    error_code: 'BRIDGE_CONTEXT_OVERFLOW',
                });
                throw bridgeContextOverflowError({
                    stage: 'overflow_retry',
                    sessionId,
                    sessionRef,
                    model,
                    budgetTokens: overflowBudget,
                    reserveTokens: overflowReserve,
                    messageTokensEst,
                }, compactErr);
                }
            }
            const compactChanged = messagesArrayChanged(messages, recompacted);
            const pruneCount = Math.max(beforeCount - recompacted.length, 0);
            messages.length = 0;
            messages.push(...recompacted);
            let afterBytes = null;
            try { afterBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { afterBytes = null; }
            traceBridgeCompact({
                sessionId,
                iteration: nextIteration,
                stage: 'overflow_retry',
                prune_count: pruneCount,
                compact_changed: compactChanged,
                input_prefix_hash: messagePrefixHash(messages),
                before_count: beforeCount,
                after_count: messages.length,
                before_bytes: beforeBytes,
                after_bytes: afterBytes,
                context_window: overflowPolicy?.contextWindow || sessionRef.contextWindow,
                budget_tokens: overflowBudget,
                reserve_tokens: overflowReserve,
                message_tokens_est: messageTokensEst,
                provider: sessionRef.provider,
                model: sessionRef.model || model,
            });
            rememberCompactTelemetry(sessionRef, overflowPolicy, {
                stage: 'overflow_retry',
                beforeTokens: messageTokensEst,
                afterTokens: estimateMessagesTokensSafe(messages),
                compactChanged,
                pruneCount,
            });
            // The transcript prefix changed; the server-side conversation anchor
            // (previous_response_id / WS continuation) is now invalid. Drop
            // providerState so the retry starts a fresh chain instead of
            // tripping a silent cache miss or hard mismatch.
            providerState = undefined;
            opts.providerState = undefined;
            // Drop eager-dispatch state before the retry send. A tool_use
            // streamed by the failed first send could otherwise orphan its
            // eager result or be double-dispatched; force the retry's tools
            // through the serial post-send path with a clean matching slate.
            opts.onToolCall = undefined;
            pending.clear();
            _eagerInFlightSigs.clear();
            try {
                process.stderr.write(
                    `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                    `retrying once at budget=${overflowBudget} reserve=${overflowReserve} ` +
                    `messages=${messages.length}\n`,
                );
            } catch { /* best-effort */ }
            response = await provider.send(messages, model, sendTools.length ? sendTools : undefined, opts);
        }
        opts.onToolCall = undefined;
        // Capture opaque state for the next turn (may be undefined — that's
        // the stateless contract for providers that don't use continuation).
        providerState = response?.providerState ?? undefined;
        iterations = nextIteration;
        traceBridgeLoop({
            sessionId,
            iteration: iterations,
            sendMs: Date.now() - sendStartedAt,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            bodyBytesEst: estimateProviderPayloadBytes(messages, model, sendTools),
        });
        // Accumulate usage across iterations — every billable slot, not just
        // input/output. Anthropic cache_read/cache_write typically stay 0 on
        // the first iteration and surge on later ones (warm prefix reuse),
        // so aggregating only the head would silently drop most of the
        // cache-side tokens.
        if (response.usage) {
            const hadUsage = !!lastUsage;
            lastUsage = addUsage(lastUsage, response.usage);
            if (!hadUsage) {
                // Snapshot the first turn separately so callers can show
                // iter1 vs final cache-hit ratios — first iter is the
                // warm-prefix signal, final iter is the steady-state
                // efficiency signal after tool-result accumulation.
                firstTurnUsage = { ...lastUsage };
            }
        }
        // Provider may have returned despite an abort (SDKs that don't honour
        // signal) — bail before processing any of its output.
        throwIfAborted();
        // Incremental metric persistence (fix A): push per-iteration token delta
        // immediately so watchdog / bridge type=list sees live totals mid-turn.
        if (sessionId && opts.onUsageDelta && response.usage) {
            try {
                opts.onUsageDelta({
                    sessionId,
                    iterationIndex: iterations,
                    deltaInput: response.usage.inputTokens || 0,
                    deltaOutput: response.usage.outputTokens || 0,
                    deltaPrompt: response.usage.promptTokens || 0,
                    // Cache delta carried alongside input/output so live metrics
                    // reflect the same token classes the terminal aggregate adds;
                    // additive — callers that ignore these fields keep working.
                    deltaCachedRead: response.usage.cachedTokens || 0,
                    deltaCacheWrite: response.usage.cacheWriteTokens || 0,
                    ts: Date.now(),
                });
            } catch { /* best-effort — never break the loop */ }
        }
        // No tool calls. For PUBLIC bridge workers, the bridge contract
        // (rules/bridge/00-common.md) requires either a tool call or a
        // `<final-answer>` wrapped reply.
        // A text-only turn without those tags violates the contract (e.g.
        // Opus 4.6 emits 'Now I'll polish…' preamble before its first tool
        // call) and used to leave the session idle until the idle sweep
        // collected it. Re-prompt the worker with a contract reminder; cap
        // at 2 nudges so a model that never complies still terminates the
        // loop. Hidden roles (cycle1-agent / cycle2-agent / explorer /
        // scheduler-task / webhook-handler) are exempt:
        // their own role rules define a different output contract (pipe-
        // separated chunker output, structured pipe-format, etc.) and a
        // text-only terminal turn is the correct shape — nudging them
        // produces a contradictory user message that traps the model in a
        // tool-call-blocked vs contract-required oscillation.
        if (!response.toolCalls?.length) {
            // No tool calls. Decide between final-answer accept vs nudge.
            //   - has content + non-hidden role → valid final, break.
            //   - empty content + hidden role → contract allows text-only
            //     terminal turn, break.
            //   - empty content + non-hidden role → one soft nudge. Repeated
            //     reminders waste turns and fragment the working context, so
            //     the second empty turn is accepted as terminal.
            const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
            const isHidden = HIDDEN_ROLE_NAMES.has(sessionRole);
            const stopReason = response.stopReason ?? response.stop_reason ?? null;
            const isIncompleteStop = stopReason && INCOMPLETE_STOP_REASONS.has(stopReason);
            if (!hasContent && !isHidden) {
                if (contractNudges >= 1) break;
                contractNudges += 1;
                let nudgeMsg;
                if (isIncompleteStop) {
                    nudgeMsg = `[mixdog-runtime] Previous turn ended mid-synthesis (stopReason=${stopReason}) with empty content. Continue — emit <final-answer>...</final-answer> with your synthesis so far, or call more tools to finish.`;
                } else {
                    nudgeMsg = '[mixdog-runtime] Your previous response was empty (no <final-answer> tag and no tool call). Either emit your final answer wrapped in <final-answer>...</final-answer> tags, or continue with tool calls. Do not return an empty turn.';
                }
                messages.push({ role: 'user', content: nudgeMsg });
                continue;
            }
            break;
        }
        const calls = response.toolCalls;
        toolCallsTotal += calls.length;
        // Per-turn batch shape — one row per assistant turn so trace
        // consumers can derive multi-tool adoption ratio without scanning
        // every assistant message body.
        recordToolBatch(sessionId, calls.length);
        onToolCall?.(iterations, calls);
        // Append assistant message with tool calls. reasoningItems is the
        // OpenAI Responses API replay payload (encrypted_content blobs);
        // providers that ignore it just see an extra field and drop it,
        // openai-oauth.convertMessagesToResponsesInput emits matching
        // type:'reasoning' input items on the next turn to keep the Codex
        // server-side cache prefix stable.
        const _assistantTurnMsg = {
            role: 'assistant',
            content: response.content || '',
            toolCalls: compactToolCallsForHistory(calls),
            ...(Array.isArray(response.reasoningItems) && response.reasoningItems.length
                ? { reasoningItems: response.reasoningItems }
                : {}),
            ...(typeof response.reasoningContent === 'string' && response.reasoningContent
                ? { reasoningContent: response.reasoningContent }
                : {}),
        };
        messages.push(_assistantTurnMsg);
        // Execute each tool and append results.
        //
        // Intra-turn duplicate suppression: when an LLM emits two tool_use
        // blocks with identical (name, args) inside the SAME assistant turn,
        // re-executing wastes tokens. Restricted to tools with
        // `readOnlyHint:true` (= isEagerDispatchable) — bash/write/edit/
        // apply_patch may be intentional repeats with distinct side effects.
        // Pre-pass identifies duplicates BEFORE startEagerRun so eager
        // dispatch also skips them, not just the for-body.
        const _duplicateCallIds = new Set();
        const _dupFirstId = new Map();
        {
            const _firstIdBySig = new Map();
            for (const c of calls) {
                if (!c?.id) continue;
                if (!isEagerDispatchable(c.name, tools)) {
                    _firstIdBySig.clear();
                    continue;
                }
                const sig = _intraTurnSig(c.name, c.arguments);
                const first = _firstIdBySig.get(sig);
                if (first === undefined) {
                    _firstIdBySig.set(sig, c.id);
                } else {
                    _duplicateCallIds.add(c.id);
                    _dupFirstId.set(c.id, first);
                }
            }
        }
        // R15: per-turn scalar read-count Map. Lifetime = this turn's tool-call batch.
        // Declared between the duplicate-detection block and the for-loop so it resets
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            if (isBuiltinTool(call.name)) {
                call.name = canonicalizeBuiltinToolName(call.name);
            }
            if (_duplicateCallIds.has(call.id)) {
                const _firstId = _dupFirstId.get(call.id);
                const _stub = `[intra-turn-dedup] identical read-only \`${call.name}\` call was already executed in this same assistant turn as tool_use_id=${_firstId}. The first call's tool_result is in context immediately above; skipping re-execution to save tokens. If you needed a different slice of the file, narrow the next call (different path / offset / limit / pattern) so it has a distinct signature.`;
                messages.push({
                    role: 'tool',
                    content: _stub,
                    toolCallId: call.id,
                });
                continue;
            }
            // Cross-iteration repeat-failure guard. Distinct from the
            // intra-turn dedup above (which spans ONE assistant turn and
            // resets every turn): when the model re-issues an IDENTICAL
            // (name,args) call that has already failed REPEAT_FAIL_LIMIT times
            // in a row across iterations, stop re-executing — the result will
            // not change, and each retry burns a full (often slow) LLM
            // round-trip until the hard iteration cap. Steer it to change
            // approach instead.
            const _repeatFailSig = _intraTurnSig(call.name, call.arguments);
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _repeatFailSig && _rfg.count >= REPEAT_FAIL_LIMIT) {
                    messages.push({
                        role: 'tool',
                        content: `[repeat-failure-guard] This exact \`${call.name}\` call (identical arguments) has already failed ${_rfg.count} times in a row; not re-executing because the result will not change. Change approach: use different arguments, a different tool, or skip this step.`,
                        toolCallId: call.id,
                    });
                    continue;
                }
            }
            if (sessionId) markSessionToolCall(sessionId, call.name);
            let result;
            let toolStartedAt;
            let toolEndedAt;
            const toolKind = getToolKind(call.name);
            // Cross-turn read dedup. Mirrors Anthropic Claude Code's
            // fileReadCache.ts: if the path's stat tuple (mtime/size/ino/dev)
            // is unchanged since a prior read in THIS session, return the cached
            // body instead of executing. Both scalar and array/object-array path
            // forms are cached — keyed by (abs, offset, limit, mode, n) per entry.
            //
            // Scoped-tool cache (grep/glob/list + graph lookups): same idea
            // but keyed by (toolName, canonical args) without per-file stat.
            // These tools scan many files so a single stat tuple cannot cover
            // them. The scoped cache registers dependency roots and write-class
            // tools evict entries whose root contains the touched path.
            let _readCacheHit = null;
            let _scopedCacheHit = null;
            let _executeOk = false;
            let _resultKind = 'normal';
            if (sessionId && _isReadTool(call.name)) {
                _readCacheHit = tryReadCached({ sessionId, args: call.arguments, cwd });
            } else if (sessionId && _isScopedCacheableTool(call.name)) {
                _scopedCacheHit = tryScopedToolCached({ sessionId, toolName: _stripMcpPrefix(call.name), args: call.arguments, cwd });
            }
            try {
                if (_readCacheHit !== null) {
                    toolStartedAt = Date.now();
                    toolEndedAt = toolStartedAt;
                    const _body = _readCacheHit.content;
                    // Return the cached body byte-for-byte instead of a
                    // human-readable cache marker. The marker made public
                    // bridge workers treat a successful cached read as a
                    // meta instruction and repeat the same read loop.
                    result = _body;
                    _resultKind = 'cache-hit';
                    _executeOk = true;
                } else if (_scopedCacheHit !== null) {
                    toolStartedAt = Date.now();
                    toolEndedAt = toolStartedAt;
                    const _body = _scopedCacheHit.content;
                    result = _body;
                    _resultKind = 'scoped-cache-hit';
                    _executeOk = true;
                } else {
                // Fallback for providers that don't stream tool calls early:
                // execute a contiguous read-only run in parallel, but never
                // cross a write/bash/MCP boundary that may change state.
                if (isEagerDispatchable(call.name, tools)) {
                    startEagerRun(calls, callIndex, _duplicateCallIds);
                }
                let eager = pending.get(call.id);
                if (eager !== undefined && eager.mutationEpoch < _mutationEpoch) {
                    pending.delete(call.id);
                    eager = undefined;
                }
                if (eager !== undefined) {
                    toolStartedAt = eager.startedAt;
                    const settled = await eager.promise;
                    if (!settled.ok) throw settled.error;
                    result = settled.value;
                    toolEndedAt = eager.endedAt ?? Date.now();
                    const _eagerKind = classifyResultKind(result);
                    if (_eagerKind === 'error') {
                        _resultKind = 'error';
                        _executeOk = false;
                    } else {
                        _executeOk = true;
                    }
                } else {
                    toolStartedAt = Date.now();
                    // Runtime permission guard. Schema profiles may hide
                    // tools for routing efficiency, but this remains the
                    // safety boundary for any tool_use that still reaches
                    // the loop. _preDispatchDeny is the SHARED helper used
                    // by both the eager dispatch path (startEagerTool) and
                    // this serial path — keeps the bridge-owned control-
                    // plane reject, role guards, wrapper guards, and
                    // permission guards consistent across both paths.
                    const _denyMsg = _preDispatchDeny(call, toolKind, sessionRef);
                    if (_denyMsg !== null) {
                        result = _denyMsg;
                        toolEndedAt = Date.now();
                        _resultKind = 'error';
                    } else {
                        const permBlocked = _checkWorkerPermission(call.name, call.arguments, sessionRef);
                        if (permBlocked !== null) {
                            result = permBlocked;
                            toolEndedAt = Date.now();
                            _resultKind = 'error';
                        } else {
                            result = await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal });
                            toolEndedAt = Date.now();
                            // Boundary: tool-return string convention → structural kind.
                            // The only prefix check in this codebase; downstream layers
                            // operate on _resultKind.
                            if (classifyResultKind(result) === 'error') {
                                _resultKind = 'error';
                                _executeOk = false;
                            } else {
                                _executeOk = true;
                            }
                            // _resultKind stays 'normal' when tool returned a non-error string.
                        }
                    }
                }
                } // close: else branch of _readCacheHit check
            }
            catch (err) {
                if (toolStartedAt === undefined) toolStartedAt = Date.now();
                toolEndedAt = Date.now();
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                _resultKind = 'error';
            }
            // Update the cross-iteration repeat-failure guard with this call's
            // outcome: bump the consecutive-failure count for an identical
            // signature, or clear it the moment the same call succeeds.
            if (sessionRef) {
                const _failed = !_executeOk || _resultKind === 'error';
                if (_failed) {
                    sessionRef._repeatFailGuard = (sessionRef._repeatFailGuard?.sig === _repeatFailSig)
                        ? { sig: _repeatFailSig, count: sessionRef._repeatFailGuard.count + 1 }
                        : { sig: _repeatFailSig, count: 1 };
                } else if (sessionRef._repeatFailGuard?.sig === _repeatFailSig) {
                    sessionRef._repeatFailGuard = null;
                }
            }
            // A failed executed call keeps its FULL argument body in history so the
            // model can retry against the original (a large apply_patch `patch` /
            // edit `old_string` would otherwise be hidden behind a
            // `[mixdog compacted …]` placeholder). Restored IMMEDIATELY — not at end
            // of loop — so an abort or post-processing throw after this point cannot
            // leave a failed edit compacted. Cache-safe: _assistantTurnMsg is not
            // transmitted until the next provider.send. Early-continue paths (dedup /
            // repeat-failure-guard) never reach here and stay compacted.
            if ((!_executeOk || _resultKind === 'error') && call?.id) {
                restoreToolCallBodyForId(_assistantTurnMsg, calls, call.id);
            }
            // Cross-turn cache maintenance — gate on both _executeOk and _resultKind==='normal'.
            // _executeOk=false catches permission-blocked / catch-path / partial-fail results.
            // _resultKind==='normal' ensures cache-hit refs are never re-stored (structural,
            // no prefix sniffing).
            // NOTE: setReadCached / setScopedToolCached are deferred below (after
            // compressToolResult) so the cache holds the same content as conversation
            // history. Cache-hit refs point to a tool_use_id whose message body matches
            // exactly what's stored — no phantom full body.
            if (sessionId && _executeOk && _resultKind === 'normal') {
                const _toolBare = _stripMcpPrefix(call.name);
                if (_readCacheHit === null && _isReadTool(call.name)) {
                    // Post-edit advisory: handle BOTH scalar and array forms
                    // of args.path. The array form (path:[a,b,c] or
                    // path:[{path:a},{path:b}]) was a coverage gap in R1 —
                    // an LLM that edits X then reads [X,Y] should still see
                    // the advisory for X.
                    const _argsPath = call.arguments?.path;
                    const _pathList = [];
                    if (typeof _argsPath === 'string') {
                        _pathList.push(_argsPath);
                    } else if (typeof call.arguments?.file_path === 'string') {
                        _pathList.push(call.arguments.file_path);
                    } else if (Array.isArray(_argsPath)) {
                        for (const _item of _argsPath) {
                            if (typeof _item === 'string') _pathList.push(_item);
                            else if (_item && typeof _item === 'object') {
                                const _itemPath = typeof _item.path === 'string' ? _item.path : _item.file_path;
                                if (typeof _itemPath === 'string') _pathList.push(_itemPath);
                            }
                        }
                    }
                    const _marks = [];
                    for (const _p of _pathList) {
                        const _m = consumePostEditMark({ sessionId, path: _p, cwd });
                        if (_m) _marks.push({ path: _p, mark: _m });
                    }
                } else if (_toolBare === 'apply_patch') {
                    // apply_patch's args are a unified-diff text in `patch`
                    // (resolved against `base_path` or cwd). Parse the diff
                    // headers (`--- a/path` / `+++ b/path`) to extract the
                    // touched paths and invalidate / mark each one. Falls
                    // back to a full session clear only when no paths could
                    // be parsed (malformed diff or unknown format).
                    const _argsBase = call.arguments?.base_path;
                    const _patchBase = (typeof _argsBase === 'string' && _argsBase.length > 0)
                        ? (isAbsolute(_argsBase) ? _argsBase : resolvePath(cwd || process.cwd(), _argsBase))
                        : (cwd || process.cwd());
                    const _touched = extractTouchedPathsFromPatch(call.arguments?.patch);
                    if (_touched.length > 0) {
                        for (const _p of _touched) {
                            invalidatePathForSession(sessionId, _p, _patchBase);
                            markPostEdit({ sessionId, path: _p, cwd: _patchBase, toolName: 'apply_patch' });
                            // R20: cross-dispatch prefetch cache invalidation.
                            invalidatePrefetchCache(_p, _patchBase);
                        }
                    } else {
                        clearReadDedupSession(sessionId);
                        // R20: path unknown — can't target; no-op on prefetch cache
                        // (stat-validation at lookup time will naturally reject stale entries).
                    }
                    // Targeted scoped-cache invalidation: only evict entries whose
                    // dep paths intersect the touched set. Full wipe is the fallback
                    // when no paths were extracted (D).
                    if (_touched.length > 0) {
                        clearScopedToolsForSessionPaths(sessionId, _touched, _patchBase);
                    } else {
                        clearScopedToolsForSession(sessionId);
                    }
                } else if (_isScalarWriteEditTool(call.name)) {
                    // Scalar `args.path` only: precise invalidate + advisory mark.
                    // Array-form (`edits[]`/`writes[]`): the tool may have partial-
                    // failed across paths and the result string aggregates;
                    // full-clear instead of falsely marking every path.
                    const _scalarPath = call.arguments?.path || call.arguments?.file_path;
                    const _hasArrayForm = Array.isArray(call.arguments?.edits)
                        || Array.isArray(call.arguments?.writes);
                    if (_hasArrayForm) {
                        clearReadDedupSession(sessionId);
                        clearScopedToolsForSession(sessionId);
                        // R20: array-form — walk each entry, extract its path,
                        // and invalidate the prefetch cache + mark post-edit for
                        // every distinct touched path. Falls back to the top-
                        // level `path` (or `file_path`) when an entry omits its
                        // own path. This covers both edit edits[] and write
                        // writes[] forms; entries without a resolvable path are
                        // silently skipped (their stat-validation safety net at
                        // next lookup still applies).
                        const _topPath = call.arguments?.path || call.arguments?.file_path;
                        const _entries = call.arguments?.edits || call.arguments?.writes || [];
                        const _seenPaths = new Set();
                        for (const _e of _entries) {
                            const _ep = _e?.path || _e?.file_path || _topPath;
                            if (typeof _ep === 'string' && _ep && !_seenPaths.has(_ep)) {
                                _seenPaths.add(_ep);
                                invalidatePathForSession(sessionId, _ep, cwd);
                                markPostEdit({ sessionId, path: _ep, cwd, toolName: _toolBare });
                                invalidatePrefetchCache(_ep, cwd);
                            }
                        }
                        if (_seenPaths.size > 0) {
                            clearScopedToolsForSessionPaths(sessionId, [..._seenPaths], cwd);
                        }
                    } else if (typeof _scalarPath === 'string') {
                        invalidatePathForSession(sessionId, _scalarPath, cwd);
                        markPostEdit({ sessionId, path: _scalarPath, cwd, toolName: _toolBare });
                        // R20: cross-dispatch prefetch cache invalidation.
                        invalidatePrefetchCache(_scalarPath, cwd);
                        // Targeted scoped-cache invalidation for the single touched path (D).
                        clearScopedToolsForSessionPaths(sessionId, [_scalarPath], cwd);
                    } else {
                        // No path extractable — full wipe fallback.
                        clearScopedToolsForSession(sessionId);
                    }
                }
            } // end _executeOk+_resultKind gate (scoped tool cache set)
            // E: mutation tools (apply_patch / write / edit) must invalidate caches
            // even on returned-error/partial-fail — the file state is unknown after
            // an error exit, and some tools report failure as an Error: result string
            // rather than throwing.
            // This block runs unconditionally (not gated on _executeOk or _resultKind).
            if (sessionId && (!_executeOk || _resultKind === 'error') && (_stripMcpPrefix(call.name) === 'apply_patch' || _isScalarWriteEditTool(call.name))) {
                clearReadDedupSession(sessionId);
            }
            if (_isMutationTool(call.name)) {
                _mutationEpoch += 1;
            }
            // Bash always clears scoped cache UNCONDITIONALLY — a mutating bash
            // that throws or fails partway can still leave stale find_symbol / grep entries.
            // Must not be gated on _executeOk or _resultKind.
            if (sessionId && _isBashTool(call.name)) {
                clearScopedToolsForSession(sessionId);
            }
            // R17 compression pipeline — correct ordering (compress → cache → push):
            //   1. compressToolResult: lossless ANSI/dedup/separator passes.
            //   2. setReadCached / setScopedToolCached: cache stores the SAME result that
            //      goes into conversation history. Cache-hit refs point to the tool_use_id
            //      whose message body matches — no phantom full body.
            //   3. offload → hint → message push.
            // Offload FIRST — before compress. Large RAW output goes to a disk sidecar
            // + ~2K preview before any in-place shrink (lossless compress) can reduce
            // it below the offload threshold and pre-empt the sidecar. When offload
            // fires it replaces `result` with a short preview stub (<2K) referencing
            // the on-disk path; the later compress is a no-op on that stub. compress
            // then only touches output that stayed inline (<= threshold).
            // Per-tool post-processing backstop. The executeTool try/catch
            // above terminates BEFORE offload/compress/trim/hint/cache writes/
            // trace/messages.push, so a maybeOffloadToolResult rejection (or
            // any downstream throw) would otherwise leave the assistant
            // tool_use message with no matching tool result. Wrap the whole
            // post-processing window through messages.push() in a catch; on
            // failure push a synthetic Error: tool result for this call.id
            // and skip the cache writes for it.
            let _postProcessOk = true;
            try {
                // Offload thresholds are keyed by BARE tool name
                // (INLINE_THRESHOLD_BY_TOOL: grep=20k, bash=30k, read=Infinity, ...),
                // so strip the MCP prefix exactly as the cache write below does.
                // Otherwise an mcp__..__grep name misses its 20k grep cap and
                // silently falls back to the 50k default — per-tool limits ignored.
                const _toolBare = _stripMcpPrefix(call.name);
                result = await maybeOffloadToolResult(sessionId, call.id, _toolBare, result);
                result = compressToolResult(call.name, call.arguments, result, { sessionId, toolKind });
                traceBridgeTool({
                    sessionId,
                    iteration: iterations,
                    toolName: call.name,
                    toolKind,
                    toolMs: toolEndedAt - toolStartedAt,
                    toolArgs: call.arguments,
                    role: sessionRef?.role || null,
                    model: sessionRef?.model || null,
                    resultKind: _resultKind,
                    resultText: result,
                });
                // Cache stores run AFTER compress+trim+offload+hint AND after all other
                // post-processing (trace) so stored content == history content. Placing
                // the cache writes immediately before messages.push ensures ANY throw
                // earlier in post-processing skips the cache entirely — no stale or
                // partial result is ever cached. Cache-hit refs pointing to an offloaded
                // tool_use will show the offload stub; LLM can still recover the full
                // body via the disk path in that stub.
                if (sessionId && _executeOk && _resultKind === 'normal') {
                    if (_scopedCacheHit === null && _isScopedCacheableTool(call.name)) {
                        const _outcome = sessionRef?._scopedCacheOutcomeByCallId?.get(call.id);
                        setScopedToolCached({
                            sessionId,
                            toolName: _toolBare,
                            args: call.arguments,
                            cwd,
                            content: result,
                            toolUseId: call.id,
                            complete: _outcome ? _outcome.complete : true,
                        });
                        sessionRef?._scopedCacheOutcomeByCallId?.delete(call.id);
                    }
                    if (_readCacheHit === null && _isReadTool(call.name)) {
                        // Pass tool_use id so future cache-hits can reference the body's location in history.
                        setReadCached({ sessionId, args: call.arguments, cwd, content: result, toolUseId: call.id });
                    }
                }
                messages.push({
                    role: 'tool',
                    content: result,
                    toolCallId: call.id,
                    toolKind: _resultKind,
                });
            } catch (postErr) {
                _postProcessOk = false;
                // Post-processing failed AFTER a successful exec: the result is
                // replaced with an error below, so preserve this call's full body
                // too for a clean retry (mirrors the failed-exec path above).
                if (call?.id) restoreToolCallBodyForId(_assistantTurnMsg, calls, call.id);
                const _postMsg = `Error: tool result post-processing failed for "${call.name}": ${postErr instanceof Error ? postErr.message : String(postErr)}`;
                // Always emit a matching tool result so the assistant
                // tool_use isn't orphaned. Cache writes are placed at the
                // end of the try block (immediately before messages.push),
                // so ANY throw in post-processing reaches this catch before
                // the cache is written — stale/partial results are never
                // cached. The next read on the same path/scope re-executes
                // naturally.
                messages.push({
                    role: 'tool',
                    content: _postMsg,
                    toolCallId: call.id,
                    toolKind: 'error',
                });
            }
            // Soft-cancel after each tool: if close landed during execution,
            // discard the rest of the batch and skip the next provider.send.
            throwIfAborted();
        }
        // About to re-send with tool results — transition back to connecting for the next turn.
        if (sessionId) updateSessionStage(sessionId, 'connecting');
    }
    return {
        ...response,
        usage: lastUsage || response.usage,
        lastTurnUsage: response.usage,
        firstTurnUsage: firstTurnUsage || response.usage,
        iterations,
        toolCallsTotal,
        providerState,
    };
}
