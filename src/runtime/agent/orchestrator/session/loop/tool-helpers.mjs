// Miscellaneous tool helpers extracted from loop.mjs: eager-dispatch check,
// message-array change detect, tool-kind classification, skills, hook overrides,
// native tool-search payload parsing, bash-session routing, and approval.
import { isMcpTool } from '../../mcp/client.mjs';
import { isBuiltinTool } from '../../tools/builtin.mjs';
import { isInternalTool } from '../../internal-tools.mjs';
import {
    collectSkillsCached,
    loadSkillResource,
    buildSkillToolEnvelope,
    filterSkillsExcludingDisabled,
    isSkillDisabled,
} from '../../context/collect.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';

// Eager-dispatch: tools with readOnlyHint:true in their declaration are safe
// to execute during SSE parsing so tool work overlaps with the rest of the
// stream. Writes, bash, MCP and skills stay serial after send() returns.
// Memoized: the read-only name Set is built once per distinct `tools` array
// (keyed by identity via a module-level WeakMap) so repeated per-call lookups
// are O(1) instead of O(N) tools.find scans.
const _eagerNameSetByTools = new WeakMap();
export function isEagerDispatchable(name, tools) {
    if (!Array.isArray(tools)) return false;
    let set = _eagerNameSetByTools.get(tools);
    if (set === undefined) {
        set = new Set();
        for (const t of tools) {
            if (t?.annotations?.readOnlyHint === true && typeof t.name === 'string') {
                set.add(t.name);
            }
        }
        _eagerNameSetByTools.set(tools, set);
    }
    return set.has(name);
}
export function messagesArrayChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return before !== after;
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) return true;
    }
    return false;
}

const SKILL_TOOL_NAMES = new Set(['Skill', 'skills_list', 'skill_view']);
const SPECIAL_TOOL_NAMES = new Set(['bash_session', 'apply_patch', 'code_graph']);
const BASH_SESSION_HEADER_RE = /\[session: ([^\]\r\n]+)\]/;

export function getToolKind(name) {
    if (SKILL_TOOL_NAMES.has(name)) return 'skill';
    if (SPECIAL_TOOL_NAMES.has(name)) return 'builtin';
    if (isMcpTool(name)) return 'mcp';
    if (isInternalTool(name)) return 'internal';
    if (isBuiltinTool(name)) return 'builtin';
    return 'builtin';
}
export function buildSkillsListResponse(cwd) {
    const skills = filterSkillsExcludingDisabled(collectSkillsCached(cwd));
    const entries = skills.map(s => ({ name: s.name, description: s.description || '' }));
    return JSON.stringify({ skills: entries });
}
export function viewSkill(cwd, name) {
    if (!name) return 'Error: skill name is required';
    if (isSkillDisabled(name)) return `Error: skill "${name}" is disabled`;
    const res = loadSkillResource(name, cwd);
    if (!res) return `Error: skill "${name}" not found`;
    // Return the general tool envelope: the model-visible tool_result is the
    // short stub (`Loaded skill: <name>`) and the full SKILL.md body is
    // delivered ONCE as a separate injected role:'user' message (newMessages).
    return buildSkillToolEnvelope(name, res.content, res.dir);
}

/** Normalize PostToolUse hook override values (legacy MCP text envelopes only). */
export function normalizeHookUpdatedToolOutput(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'object' && Array.isArray(value.content)) {
        const hasNonText = value.content.some((c) => c && typeof c === 'object' && c.type && c.type !== 'text');
        if (hasNonText) return value;
        return value.content
            .map((c) => (c?.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
    }
    return value;
}

export function resolveToolResultAfterHook(originalResult, hookResult) {
    if (!hookResult || typeof hookResult !== 'object' || hookResult.updatedToolOutput === undefined) {
        return originalResult;
    }
    const updated = normalizeHookUpdatedToolOutput(hookResult.updatedToolOutput);
    return updated === undefined ? originalResult : updated;
}

export function parseNativeToolSearchPayload(toolName, result) {
    if ((toolName !== 'load_tool' && toolName !== 'tool_search') || typeof result !== 'string') return null;
    try {
        const parsed = JSON.parse(result);
        const native = parsed?.nativeToolSearch;
        if (!native || typeof native !== 'object') return null;
        const rawToolReferences = Array.isArray(native.toolReferences) ? native.toolReferences : [];
        const toolReferences = rawToolReferences
            .filter((name) => typeof name === 'string')
            .map((name) => name.trim())
            .filter(Boolean);
        const rawOpenaiTools = Array.isArray(native.openaiTools) ? native.openaiTools : [];
        const openaiTools = rawOpenaiTools.filter((tool) => (
            tool
            && typeof tool === 'object'
            && !Array.isArray(tool)
            && typeof tool.name === 'string'
            && tool.name.trim()
            && (tool.type === undefined || typeof tool.type === 'string')
        ));
        if (!toolReferences.length && !openaiTools.length) return null;
        const baseSummary = typeof native.summary === 'string' && native.summary
            ? native.summary
            : `Loaded deferred tools: ${toolReferences.join(', ') || openaiTools.map((tool) => tool.name).filter(Boolean).join(', ')}`;
        const selectedTools = parsed?.selected?.tools;
        const missing = Array.isArray(selectedTools?.missing)
            ? selectedTools.missing.map((name) => String(name || '').trim()).filter(Boolean)
            : [];
        const blocked = Array.isArray(selectedTools?.blocked)
            ? selectedTools.blocked
                .map((entry) => {
                    if (entry && typeof entry === 'object') {
                        const name = String(entry.name || '').trim();
                        if (!name) return '';
                        const reason = String(entry.reason || '').trim();
                        return reason ? `${name} (${reason})` : name;
                    }
                    return String(entry || '').trim();
                })
                .filter(Boolean)
            : [];
        const extraLines = [];
        if (missing.length) extraLines.push(`missing: ${missing.join(', ')}`);
        if (blocked.length) extraLines.push(`blocked: ${blocked.join(', ')}`);
        const summary = extraLines.length ? `${baseSummary}\n${extraLines.join('; ')}` : baseSummary;
        return {
            toolReferences,
            openaiTools,
            summary,
        };
    } catch {
        return null;
    }
}
export function extractBashSessionId(result) {
    if (typeof result !== 'string') return null;
    const match = BASH_SESSION_HEADER_RE.exec(result);
    return match ? match[1] : null;
}

export function buildAgentBashSessionArgs(args, sessionRef) {
    if (!isAgentOwner(sessionRef)) return null;
    // run_in_background is a detached one-shot job, incompatible with the
    // persistent bash session. Fall through to the background-job path
    // (executeBuiltinTool -> startBackgroundShellJob) so the worker gets a
    // task_id that task control can resolve — otherwise the persistent
    // session returns a [session: ...] header and task control reports "task not found".
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

export function formatMissingToolApprovalUiDenial(toolName, askReason) {
    const reason = String(askReason || 'approval requested by hook').trim();
    const name = String(toolName || 'tool');
    return `Error: tool "${name}" denied by hook: approval required but no approval UI is available${reason ? ` (${reason})` : ''}`;
}

/**
 * Resolve PreToolUse `{ action: 'ask' }` against an optional approval callback.
 * Returns `{ denial }` when the tool must not run; otherwise `{ approval }`.
 */
export async function resolvePreToolAskApproval({
    toolName,
    args,
    cwd,
    sessionId,
    toolCallId,
    askReason,
    toolApprovalHook,
}) {
    const name = String(toolName || 'tool');
    const reason = String(askReason || 'approval requested by hook').trim();
    if (typeof toolApprovalHook !== 'function') {
        return { denial: formatMissingToolApprovalUiDenial(name, reason) };
    }
    let approval;
    try {
        approval = await toolApprovalHook({
            name,
            args,
            cwd,
            sessionId,
            toolCallId: toolCallId || null,
            reason,
        });
    } catch (error) {
        const detail = error?.message || String(error || 'approval failed');
        return { denial: `Error: tool "${name}" denied by hook: ${detail}` };
    }
    if (!approvalGranted(approval)) {
        const detail = approvalReason(approval, reason || 'not approved');
        return { denial: `Error: tool "${name}" denied by hook: ${detail}` };
    }
    return { approval };
}

export function approvalGranted(value) {
    if (value === true) return true;
    if (!value || typeof value !== 'object') return false;
    if (value.approved === true || value.allow === true || value.allowed === true) return true;
    const decision = String(value.decision || value.action || value.result || '').trim().toLowerCase();
    return decision === 'approve' || decision === 'approved' || decision === 'allow' || decision === 'yes';
}

export function approvalReason(value, fallback = '') {
    if (value && typeof value === 'object') {
        const reason = String(value.reason || value.message || '').trim();
        if (reason) return reason;
    }
    return fallback;
}
