/**
 * src/session-runtime/turn/agent-ops.mjs - surface-driven agent/task control,
 * runtime notifications, and the deferred tool surface (status + selection).
 */
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  toolRow,
  toolSearchMatches,
  sortedNamesByMeasuredUsage,
  selectDeferredTools,
} from '../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';

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

  // Stop one background shell job of THIS session through the task tool's
  // cancel path; the answer is structured so a surface never parses text.
  async function stopShellJob(taskId) {
    const session = getSession();
    const { stopBackgroundShellJob } = await import('../../runtime/agent/orchestrator/tools/builtin/task-tool.mjs');
    return stopBackgroundShellJob(taskId, {
      callerSessionId: session?.id || null,
      clientHostPid: session?.clientHostPid || process.pid,
    });
  }

  // Explicit user force-release ("Release anyway") of a shell job whose
  // termination is unconfirmed: drops its workspace hold. The surface has
  // already asked the user to confirm. The caller session's own holds, and
  // holds of a closed session whose workspace this session's folder sees.
  async function releaseShellJob(taskId) {
    const session = getSession();
    const { forceReleaseTerminationHold } = await import(
      '../../runtime/agent/orchestrator/tools/builtin/lib/shell-job-records.mjs'
    );
    return forceReleaseTerminationHold(taskId, {
      callerSessionId: session?.id || null,
      callerCwd: getCurrentCwd?.() || null,
    });
  }

  // This session's live shell jobs (the readout rows), each carrying
  // `terminationUnconfirmed` when it is held without confirmed termination,
  // plus held shells a closed session left in a workspace this session sees.
  async function listShellJobs() {
    const session = getSession();
    const { shellJobsStatusFresh, shellJobVisibleFrom } = await import(
      '../../runtime/shared/statusline/statusline-segments.mjs'
    );
    const status = await shellJobsStatusFresh({ clientHostPid: session?.clientHostPid || process.pid });
    const own = session?.id ? status?.sessions?.[session.id]?.jobs : status?.jobs;
    const jobs = Array.isArray(own) ? [...own] : [];
    const cwd = getCurrentCwd?.() || null;
    for (const job of status?.orphaned || []) {
      if (shellJobVisibleFrom(job, cwd) && !jobs.some((row) => row.taskId === job.taskId)) jobs.push(job);
    }
    return { jobs };
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

  return {
    agentControl,
    taskControl,
    stopShellJob,
    releaseShellJob,
    listShellJobs,
    onNotification,
    toolsStatus,
    selectTools,
  };
}
