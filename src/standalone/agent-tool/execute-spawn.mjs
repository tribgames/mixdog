import { clean, rowMatchesContext } from './helpers.mjs';

// Spawn request dispatch: deciding what an explicitly tagged spawn means before
// a job is started, and starting it.
//
// Inputs: `registry` (tag resolution, live sessions, tombstones),
// `terminalTrace`, `sendFlow` (reuse path), `spawnFlow`, and `spawnResult`
// (job -> rendered tool output). Output: { spawn }.
export function createSpawnDispatch({ registry, terminalTrace, sendFlow, spawnFlow, spawnResult }) {
  // Explicit-tag spawn priority (auto nextTag always creates a fresh session):
  //   1) live + busy -> queue the prompt (reuse)
  //   2) live + idle -> continue existing session (reuse)
  //   3) lingering terminal trace -> reap trace and fresh spawn under same tag
  //   4) genuinely new tag -> fresh deferred spawn
  async function resolveExplicitTagSpawn(explicitTag, args, { scopedContext, context, notifyContext }) {
    let liveSessionId = null;
    try {
      liveSessionId = registry.resolveTag(explicitTag, scopedContext, {
        scanSessions: registry.wantsSessionScan(args),
        excludeTerminalTraces: true,
      });
    } catch {
      // Ambiguous across terminals — the normal spawn path surfaces the same
      // error consistently.
      liveSessionId = null;
    }
    if (liveSessionId && registry.getLiveSession(liveSessionId)) {
      const prepared = await sendFlow.prepareSend({ ...args, tag: explicitTag }, scopedContext);
      return { reused: sendFlow.dispatchToExistingSession(prepared, notifyContext, { reused: true }) };
    }
    if (terminalTrace.hasTerminalTrace(explicitTag, scopedContext)) {
      terminalTrace.reapTerminalTraceForTag(explicitTag, scopedContext);
      return { spawnArgs: args, respawned: true };
    }
    // Tombstone inheritance never honors allTerminals/global scope.
    const tombstone = registry.tagTombstoneForTag(explicitTag, context);
    if (tombstone) {
      registry.consumeTagTombstone(tombstone);
      return {
        spawnArgs: {
          ...args,
          agent: clean(args.agent) || clean(tombstone.agent),
          ...(clean(args.cwd) || !clean(tombstone.cwd) ? {} : { cwd: tombstone.cwd }),
        },
        respawned: true,
      };
    }
    const foreignTombstone = registry
      .readAllTagTombstones()
      .find((row) => clean(row.tag) === explicitTag && !rowMatchesContext(row, context));
    if (foreignTombstone) throw new Error(`agent spawn: tag "${explicitTag}" belongs to another terminal`);
    return { spawnArgs: args, respawned: false };
  }

  async function spawn(args, request) {
    const explicitTag = clean(args.tag);
    let spawnArgs = args;
    let respawned = false;
    if (explicitTag) {
      const plan = await resolveExplicitTagSpawn(explicitTag, args, request);
      if (plan.reused) return plan.reused;
      spawnArgs = plan.spawnArgs;
      respawned = plan.respawned;
    }
    const job = spawnFlow.startDeferredSpawnJob(
      spawnArgs,
      request.callerCwd,
      request.context,
      request.notifyContext,
      respawned ? { respawned: true } : {}
    );
    return spawnResult(job);
  }

  return { spawn };
}
