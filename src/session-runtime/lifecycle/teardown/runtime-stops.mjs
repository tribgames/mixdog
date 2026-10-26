/**
 * runtime-stops.mjs — the process-wide services a teardown stops (MCP, WS
 * pool, patch runtime, memory, goals, shell jobs, native transports,
 * Computer Use) and how their stops are awaited: bounded for a detached
 * close, all-settled for a full one.
 */
import { releaseComputerSession } from '../../../runtime/computer-bridge/client.mjs';
import {
  pendingSummaryIndexIds,
  settleSummaryIndexWrites,
} from '../../../runtime/agent/orchestrator/session/store-summary-index.mjs';
import { settleGatewayUsageWrites } from '../../../runtime/agent/orchestrator/providers/statusline-route-meta.mjs';
import { closeSessionSearch } from '../../../runtime/session-search/session-search-ingest.mjs';

// How long a close waits for a stop that owns files (memory, goals, and the
// close's own persistence): briefly for a detached close, longer for a full one.
const DETACHED_FILE_STOP_MS = 1500;
const FULL_FILE_STOP_MS = 5500;

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
    [stops.memoryStop, DETACHED_FILE_STOP_MS],
    [stops.goalStop, DETACHED_FILE_STOP_MS],
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

/**
 * The close's deferred data-dir writes, under the file-stop deadline: this
 * session's summary-index ops (every queued op when no session is closing),
 * the buffered gateway usage events with their compaction, and this session's
 * session-search writes (cancelled, PostgreSQL install included). Past the
 * deadline the close stops waiting and reports what is still pending; those
 * writes stay queued and land later.
 */
export async function settlePersistence(withTeardownDeadline, { detach, closingSessionId }) {
  const ids = closingSessionId ? [closingSessionId] : null;
  const giveUp = new AbortController();
  const pending = new Set(['summary index', 'gateway usage', 'session search']);
  const track = (name, work) =>
    Promise.resolve(work).then((settled) => {
      if (settled !== false) pending.delete(name);
    });
  const settled = await withTeardownDeadline(
    Promise.all([
      track('summary index', settleSummaryIndexWrites({ ids, signal: giveUp.signal })),
      track('gateway usage', settleGatewayUsageWrites()),
      track('session search', closingSessionId ? closeSessionSearch(closingSessionId) : null),
    ]).then(() => true),
    detach ? DETACHED_FILE_STOP_MS : FULL_FILE_STOP_MS,
    false
  );
  if (settled) return;
  giveUp.abort();
  const detail = [...pending].map((name) =>
    name === 'summary index' && ids ? `summary index (sessions: ${pendingSummaryIndexIds(ids).join(', ')})` : name
  );
  process.emitWarning(`close persistence incomplete; still pending: ${detail.join('; ')}`, {
    code: 'TEARDOWN_PERSISTENCE_PENDING',
  });
}

export async function settleAll(withTeardownDeadline, stops) {
  await Promise.allSettled([
    withTeardownDeadline(stops.channelStop, 5500, false),
    withTeardownDeadline(stops.mcpStop, 1500, false),
    withTeardownDeadline(stops.openaiWsStop, 1500, false),
    withTeardownDeadline(stops.patchStop, 1500, false),
    withTeardownDeadline(stops.memoryStop, FULL_FILE_STOP_MS, false),
    withTeardownDeadline(stops.goalStop, FULL_FILE_STOP_MS, false),
    withTeardownDeadline(stops.shellJobsStop, 1500, false),
    withTeardownDeadline(stops.nativeToolStop, 1500, false),
    withTeardownDeadline(stops.computerStop, 1500, false),
  ]);
}
