// Deferred catalog call-through: inactive catalog tool_use → discovery bookkeeping
// then normal executeTool routing (runtime errors only; no pre-dispatch schema).
import { clean } from '../../../../../session-runtime/session-text.mjs';
import { deferredCatalogUnion, isReadonlySelectable, selectDeferredTools } from '../../../../../session-runtime/tool-catalog.mjs';

/** Skill-list plumbing only; mutation/MCP/builtins must use the catalog+mode gate. */
const INACTIVE_INFRA_BYPASS = new Set(['skills_list', 'skill_view']);

function isActiveSessionTool(session, name) {
    const key = clean(name);
    if (!key || !Array.isArray(session?.tools)) return false;
    return session.tools.some((tool) => clean(tool?.name) === key);
}

function lookupDeferredCatalogTool(session, name) {
    // Union of the boot-frozen catalog and the late-connected MCP catalog so a
    // direct call to a tool whose server connected after boot resolves and
    // auto-loads (selectDeferredTools promotes it onto session.tools).
    const catalog = deferredCatalogUnion(session);
    const key = clean(name);
    if (!key) return null;
    for (const tool of catalog) {
        const n = clean(tool?.name);
        if (n === key || n.toLowerCase() === key.toLowerCase()) return tool;
    }
    return null;
}

export function isOnDeferredToolSurface(session, name) {
    if (!session) return false;
    return isActiveSessionTool(session, name) || lookupDeferredCatalogTool(session, name) !== null;
}

export function toolExecutesWhenInactive(name) {
    return INACTIVE_INFRA_BYPASS.has(name);
}

function resolveDeferredSelectMode(session) {
    const spec = session?.toolSpec;
    if (spec == null || spec === '') return null;
    if (spec === 'readonly') return 'readonly';
    if (spec === 'full' || spec === 'mcp') return 'full';
    if (Array.isArray(spec)) {
        if (!spec.length) return null;
        if (spec.includes('full')) return 'full';
        if (spec.includes('tools:readonly')) return 'readonly';
        return 'full';
    }
    return null;
}

function denyDeferredCallThrough(message) {
    return { deny: message };
}

/**
 * Inactive deferred catalog hits: readonly/mode gate + promoteToActive, or deny.
 * Returns null when not applicable (not in catalog, already active, infra allowlist).
 */
export function prepareDeferredToolCallThrough(sessionRef, name, _args) {
    if (!sessionRef) return null;
    const tool = lookupDeferredCatalogTool(sessionRef, name);
    if (!tool) return null;
    if (isActiveSessionTool(sessionRef, name)) return null;
    if (toolExecutesWhenInactive(name)) return null;

    const toolLabel = clean(tool.name) || clean(name) || 'tool';
    const resolvedMode = resolveDeferredSelectMode(sessionRef);
    if (resolvedMode === null) {
        if (!isReadonlySelectable(tool)) {
            return denyDeferredCallThrough(
                `Error: tool "${toolLabel}" is deferred and cannot be auto-loaded without a resolved tool mode; load it with load_tool names:["${toolLabel}"].`,
            );
        }
    } else if (resolvedMode === 'readonly' && !isReadonlySelectable(tool)) {
        return denyDeferredCallThrough(`Error: tool "${toolLabel}" is not available in readonly mode`);
    }

    const selectMode = resolvedMode === null ? 'readonly' : resolvedMode;
    selectDeferredTools(sessionRef, [toolLabel], selectMode, { promoteToActive: true });
    return null;
}