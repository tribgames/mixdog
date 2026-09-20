/**
 * runtime-stops.mjs — the process-wide services a teardown stops (MCP, WS
 * pool, patch runtime, memory, goals, shell jobs, native transports,
 * Computer Use) and how their stops are awaited: bounded for a detached
 * close, all-settled for a full one.
 */
import { releaseComputerSession } from '../../../runtime/computer-bridge/client.mjs';

export function startRuntimeStops(deps, reason, { detach, isProcessExit }) {
  const { mcpClient, getMcpScopeId, closePatchRuntimeIfLoaded, getMemoryModPromise, setMemoryModPromise } = deps;
  let mcpStop = null;
  try {
    mcpStop = mcpClient.disconnectAll?.({ scopeId: getMcpScopeId?.() });
  } catch {}
  const openaiWsStop =
    isProcessExit && globalThis.__mixdogOpenaiWsRuntimeLoaded === true
      ? import('../../../runtime/agent/orchestrator/providers/openai-oauth-ws.mjs')
          .then((mod) => mod?.drainOpenaiWsPool?.(reason))
          .catch(() => {})
      : null;
  const patchStop = closePatchRuntimeIfLoaded(detach ? { waitForExit: false } : undefined);
  const memoryModPromise = getMemoryModPromise();
  const stopMemoryMod = (mod) => (typeof mod?.stop === 'function' ? mod.stop() : null);
  const memoryStop = memoryModPromise
    ? memoryModPromise
        .then(stopMemoryMod)
        .catch(() => {})
        .finally(() => {
          setMemoryModPromise(null);
        })
    : null;
  return { mcpStop, openaiWsStop, patchStop, memoryStop };
}

export function startWorkStops(deps, reason, { isProcessExit, scopedTeardown, teardownReapsWork, closingSessionId }) {
  const { goalRuntime, closeNativeToolTransports } = deps;
  let goalStop = null;
  try {
    goalStop = goalRuntime?.close?.();
  } catch {}
  const shellJobsScope = scopedTeardown ? { scope: { ownerSessionId: closingSessionId } } : {};
  const shellJobsStop =
    teardownReapsWork && globalThis.__mixdogShellJobsRuntimeLoaded === true
      ? import('../../../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs')
          .then((mod) => mod?.shutdownShellJobs?.(reason, { ...shellJobsScope }))
          .catch(() => {})
      : null;
  const nativeToolStop = isProcessExit
    ? Promise.resolve(shellJobsStop)
        .then(() => closeNativeToolTransports?.(reason))
        .catch(() => {})
    : null;
  // Computer Use pins a host-side worker plus window claims for the closing
  // session, and the runtime's deferred release timer is unref'd. A real
  // teardown releases them here; a keepBackgroundWork eviction leaves the
  // lease to that timer so a re-materialized session keeps its refs.
  const computerStop =
    teardownReapsWork && closingSessionId
      ? Promise.resolve(releaseComputerSession(closingSessionId)).catch(() => false)
      : null;
  return { goalStop, shellJobsStop, nativeToolStop, computerStop };
}

/** Detached close: wait briefly for the stops that own files, let the rest drain unobserved. */
export async function settleDetached(withTeardownDeadline, stops) {
  const bounded = [
    [stops.channelStop, 300],
    [stops.shellJobsStop, 300],
    [stops.memoryStop, 1500],
    [stops.goalStop, 1500],
  ];
  for (const [stop, deadlineMs] of bounded) {
    try {
      await withTeardownDeadline(stop, deadlineMs, false);
    } catch {}
  }
  for (const stop of [stops.mcpStop, stops.openaiWsStop, stops.patchStop, stops.nativeToolStop, stops.computerStop]) {
    Promise.resolve(stop).catch(() => {});
  }
}

export async function settleAll(withTeardownDeadline, stops) {
  await Promise.allSettled([
    withTeardownDeadline(stops.channelStop, 5500, false),
    withTeardownDeadline(stops.mcpStop, 1500, false),
    withTeardownDeadline(stops.openaiWsStop, 1500, false),
    withTeardownDeadline(stops.patchStop, 1500, false),
    withTeardownDeadline(stops.memoryStop, 5500, false),
    withTeardownDeadline(stops.goalStop, 5500, false),
    withTeardownDeadline(stops.shellJobsStop, 1500, false),
    withTeardownDeadline(stops.nativeToolStop, 1500, false),
    withTeardownDeadline(stops.computerStop, 1500, false),
  ]);
}
