// manager/runtime-state.mjs
// The process-global runtime liveness map and its turn-activity reads.
// runtime-liveness.mjs owns every entry and mutation; this leaf has no
// imports, so a cold reader (the daemon's session catalog) can ask which turns
// are in flight without loading the session manager graph. Every session runs
// inline in the daemon, so this map is the whole answer to "is this session's
// turn running".

export const runtimeState = new Map();

// Stages that still own live provider/tool work: compaction, idle cleanup and
// runtime unload all stay away from an entry in one of them.
export const IN_FLIGHT_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'cancelling']);

/** Whether a runtime entry's turn (provider or tool work) is running now. */
export function isTurnInFlight(entry) {
  if (!entry || entry.closed === true) return false;
  if (entry.controller && !entry.controller.signal?.aborted) return true;
  return IN_FLIGHT_STAGES.has(entry.stage);
}

const cleanLower = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

/**
 * Turn activity of every session this process runs: `working` holds the ids
 * whose turn is in flight, `agentWorking` the root owner (Lead) ids of every
 * in-flight Agent session.
 */
export function inFlightSessionActivity() {
  const working = new Set();
  const agentWorking = new Set();
  for (const [id, entry] of runtimeState) {
    if (!isTurnInFlight(entry)) continue;
    working.add(id);
    const session = entry.session;
    const ownerSessionId = String(session?.ownerSessionId || session?.parentSessionId || '').trim();
    const agent = cleanLower(session?.agent);
    if (
      ownerSessionId &&
      ownerSessionId !== id &&
      (cleanLower(session?.owner) === 'agent' || (agent && agent !== 'lead'))
    ) {
      agentWorking.add(ownerSessionId);
    }
  }
  return { working, agentWorking };
}
