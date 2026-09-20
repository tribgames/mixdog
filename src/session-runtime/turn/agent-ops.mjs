/**
 * src/session-runtime/turn/agent-ops.mjs - surface-driven agent/task control,
 * runtime notifications, and the deferred tool surface (status + selection).
 */
import { clean } from '../session-text.mjs';
import { toolRow, toolSearchMatches, sortedNamesByMeasuredUsage, selectDeferredTools } from '../tool-catalog.mjs';

function splitToolStatusCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const regular = list.filter((row) => row?.kind !== 'mcp' && row?.kind !== 'skill');
  const mcp = list.filter((row) => row?.kind === 'mcp');
  return {
    count: regular.length,
    activeCount: regular.filter((row) => row.active).length,
    mcpToolCount: mcp.length,
    activeMcpToolCount: mcp.filter((row) => row.active).length,
  };
}

export function createAgentOps(deps) {
  const {
    getSession,
    getCurrentCwd,
    getMode,
    notifyFnForSession,
    subscribeRuntimeNotification,
    agentTool,
    activeToolSurface,
    notificationListeners,
    getReservedSessionId,
  } = deps;

  function agentControl(args = {}) {
    const session = getSession();
    const callerSessionId = session?.id || null;
    return agentTool.execute(args, {
      callerCwd: getCurrentCwd(),
      invocationSource: 'user-command',
      callerSessionId,
      clientHostPid: session?.clientHostPid || process.pid,
      notifyFn: notifyFnForSession(callerSessionId),
    });
  }

  // Background-task control (list/read/monitor/cancel) for a SURFACE that
  // already shows the running job — the same path the `task` tool takes, so
  // a shell cancel is one authority, not a second kill route. Ownership
  // scoping rides the caller session, exactly like agentControl. Loaded on
  // demand: the shell-job registry stays out of the boot path.
  async function taskControl(args = {}) {
    const session = getSession();
    const { executeTaskTool } = await import('../../runtime/agent/orchestrator/tools/builtin/task-tool.mjs');
    return executeTaskTool(args || {}, {
      callerSessionId: session?.id || null,
      clientHostPid: session?.clientHostPid || process.pid,
    });
  }

  function onNotification(listener) {
    if (typeof listener !== 'function') return () => {};
    const sessionId = getSession()?.id || getReservedSessionId?.() || '';
    if (typeof subscribeRuntimeNotification === 'function') {
      return subscribeRuntimeNotification(sessionId, listener);
    }
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function toolsStatus(query = '') {
    const surface = activeToolSurface();
    let catalog = [];
    if (Array.isArray(surface?.deferredToolCatalog)) catalog = surface.deferredToolCatalog;
    else if (Array.isArray(surface?.tools)) catalog = surface.tools;
    const activeNames = new Set([
      ...(surface?.tools || []).map((tool) => tool?.name).filter(Boolean),
      ...(surface?.deferredCallableTools || []),
    ]);
    const needle = clean(query).toLowerCase();
    const rows = catalog.map((tool) => toolRow(tool, activeNames)).filter((row) => row.name);
    const counts = splitToolStatusCounts(rows);
    const tools = needle ? rows.filter((row) => toolSearchMatches(row, needle)) : rows;
    return {
      mode: getMode(),
      ...counts,
      tools,
      activeTools: sortedNamesByMeasuredUsage(activeNames),
      discoveredTools: sortedNamesByMeasuredUsage(surface?.deferredDiscoveredTools || []),
    };
  }

  function selectTools(names) {
    const list = Array.isArray(names) ? names : String(names || '').split(/[,\s]+/);
    const result = selectDeferredTools(activeToolSurface(), list, getMode());
    return { ...result, status: toolsStatus() };
  }

  return { agentControl, taskControl, onNotification, toolsStatus, selectTools };
}
