import { createTagResume } from './execute-resume.mjs';
import { clean, rowMatchesContext } from './helpers.mjs';
import { resolveRequestedModel } from './model-select.mjs';

// What an explicit (already resolved) spawn asks a reused session to change:
// the model, the tuning, or both — only what it names, or null when it names
// nothing. It is a partial request: the session's route write completes it
// against the latest selected route (and drops it when nothing differs), so
// no descriptor snapshot decides what the other tuning becomes.
function requestedRoute(args) {
  const model = clean(args.model);
  const effort = clean(args.effort);
  const route = {
    ...(model ? { provider: clean(args.provider), model } : {}),
    ...(effort ? { effort } : {}),
    ...(args.fast === undefined ? {} : { fast: args.fast === true }),
    ...(args.autoEffort === undefined ? {} : { autoEffort: args.autoEffort !== false }),
  };
  return Object.keys(route).length ? route : null;
}

// Spawn request dispatch: deciding what an explicitly tagged spawn means before
// a job is started, and starting it.
//
// Inputs: `registry` (tag resolution, live sessions, tombstones, session
// records), `terminalTrace`, `sendFlow` (reuse path), `spawnFlow`,
// `spawnResult` (job -> rendered tool output), `defaultCwd` and `tagResume`
// (shared with send). Output: { spawn }.
export function createSpawnDispatch({
  registry,
  terminalTrace,
  sendFlow,
  spawnFlow,
  spawnResult,
  listProviderModels = null,
  defaultCwd = process.cwd(),
  tagResume = createTagResume({ registry, sendFlow, defaultCwd }),
}) {
  const { resumeTag } = tagResume;

  // Explicit-tag spawn priority (auto nextTag always creates a fresh session):
  //   1) live + busy -> queue the prompt (reuse)
  //   2) live + idle -> continue existing session (reuse)
  //   3) lingering terminal trace -> reap trace and fresh spawn under same tag
  //   4) reaped tag (tombstone, or past it this owner's last session record)
  //      whose saved session can continue -> resume it; a tombstone whose
  //      session cannot -> fresh spawn inheriting agent/cwd (`respawned`)
  //   5) genuinely new tag -> fresh deferred spawn
  async function resolveExplicitTagSpawn(explicitTag, args, { scopedContext, context, notifyContext, callerCwd }) {
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
      await sendFlow.adoptCaller(prepared, notifyContext);
      const route = requestedRoute(args);
      return {
        reused: sendFlow.dispatchToExistingSession(route ? { ...prepared, route } : prepared, notifyContext, {
          reused: true,
        }),
      };
    }
    if (terminalTrace.hasTerminalTrace(explicitTag, scopedContext)) {
      terminalTrace.reapTerminalTraceForTag(explicitTag, scopedContext);
      return { spawnArgs: args, respawned: true };
    }
    // Tombstone inheritance and resume never honor allTerminals/global scope.
    const resumeOptions = { operation: 'spawn', args, callerCwd, context, notifyContext, route: requestedRoute(args) };
    const tombstone = registry.tagTombstoneForTag(explicitTag, context);
    if (tombstone) {
      const resumed = await resumeTag(explicitTag, tombstone.sessionId, { ...resumeOptions, tombstone });
      if (resumed) return { reused: resumed };
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
    const record = registry.lastTagSession(explicitTag, context);
    if (record) {
      const resumed = await resumeTag(explicitTag, record.id, resumeOptions);
      if (resumed) return { reused: resumed };
    }
    return { spawnArgs: args, respawned: false };
  }

  async function spawn(requestArgs, request) {
    // Resolve a user-pinned model before deferring, so a miss or an ambiguous
    // name answers this call instead of failing the background job.
    const args = await resolveRequestedModel(requestArgs, listProviderModels);
    const explicitTag = clean(args.tag);
    let spawnArgs = args;
    let respawned = false;
    if (explicitTag) {
      // One decision at a time per owner's tag: a spawn queued behind a send
      // or spawn that resumed this tag reuses it instead of resuming it again.
      const plan = await tagResume.serialized(explicitTag, request.context, () =>
        resolveExplicitTagSpawn(explicitTag, args, request)
      );
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
