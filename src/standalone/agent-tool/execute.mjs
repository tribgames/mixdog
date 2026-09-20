import { errorLine } from '../../runtime/shared/err-text.mjs';
import { agentScope, clean, resolvePrompt, rowMatchesContext } from './helpers.mjs';
import { renderResult } from './render.mjs';

// The agent tool's request dispatch: list/status/read/cleanup/cancel/close/
// send/spawn, including the dead-tag send fallback and explicit-tag spawn
// resolution.
export function createAgentExecute({
  mgr,
  defaultCwd,
  awaitKeychainPrewarm,
  registry,
  views,
  spawnFlow,
  sendFlow,
  closeFlow,
  terminalTrace,
}) {
  const spawnResult = (job) => renderResult(views.renderJob(job, false));

  async function readJob(args, scopedContext) {
    const job = views.getJobOrWorker(args, scopedContext);
    if (job?.taskId == null && typeof mgr.readSessionHandoff === 'function') {
      const handoff = await mgr.readSessionHandoff(job.meta?.sessionId);
      if (handoff) job.result = handoff;
    }
    return renderResult(views.renderJob(job, true));
  }

  // A retained row or reap tombstone proves that this terminal owned the tag.
  // Unknown tags stay errors even when the caller supplies an agent/cwd: typo
  // absorption requires persisted same-tag evidence. Absorption identity is
  // always terminal-local, even when live resolution was explicitly requested
  // across all terminals; a local proof wins even if another terminal also
  // owns this tag.
  function inheritedTagIdentity(fallbackTag, ownershipContext, args, callerCwd) {
    let row = null;
    try {
      row = registry.readWorkerRows(ownershipContext).find((entry) => clean(entry.tag) === fallbackTag) || null;
    } catch {
      row = null;
    }
    const tombstone = registry.tagTombstoneForTag(fallbackTag, ownershipContext);
    if (!row && !tombstone) return null;
    const agent = clean(args.agent) || clean(row?.agent) || clean(tombstone?.agent);
    const cwd = clean(args.cwd) || clean(row?.cwd) || clean(tombstone?.cwd) || clean(callerCwd);
    if (!agent || !cwd) return null;
    return { row, tombstone, sessionId: clean(row?.sessionId), agent, cwd };
  }

  // Drop this terminal's in-memory trace and remove ONLY the persisted row
  // matching the inherited sessionId. A tag-wide removal would delete peer
  // terminals' same-tag rows; the map deletes are guarded on the tag pointing
  // at OUR sessionId so a peer cache entry is left intact (it rebuilds from
  // rows).
  function consumeInheritedTag(fallbackTag, inherited) {
    if (registry.tags.get(fallbackTag) === inherited.sessionId) {
      try {
        registry.tags.delete(fallbackTag);
        registry.tagAgents.delete(fallbackTag);
        registry.tagCwds.delete(fallbackTag);
      } catch {}
    }
    if (inherited.sessionId) {
      try {
        registry.removeWorkerRow({ sessionId: inherited.sessionId });
      } catch {}
    }
    if (inherited.tombstone) registry.consumeTagTombstone(inherited.tombstone);
  }

  // Reaped/dead-tag fallback: with the 5m terminal-reap window a same-scope
  // follow-up often lands after the session is gone. Instead of bouncing an
  // error back to Lead (who would just re-issue the same content as a spawn),
  // respawn a FRESH session under the same tag with the message as its brief.
  // `respawned: true` in the result tells Lead the worker has no prior session
  // context. Only tag-addressed sends fall back; explicit sessionId sends keep
  // erroring (the caller pinned a specific session on purpose).
  async function respawnDeadTagSend(err, args, { callerCwd, context, notifyContext }) {
    const fallbackTag = clean(args.tag);
    const isDeadTarget = /not found|is closed/i.test(String(err?.message || ''));
    if (!fallbackTag || fallbackTag.startsWith('sess_') || !isDeadTarget) throw err;
    const prompt = await resolvePrompt(args, callerCwd || defaultCwd);
    const inherited = inheritedTagIdentity(fallbackTag, context, args, callerCwd);
    if (!inherited) throw err;
    consumeInheritedTag(fallbackTag, inherited);
    const spawnArgs = {
      ...args,
      type: 'spawn',
      tag: fallbackTag,
      prompt,
      message: undefined,
      agent: inherited.agent,
      cwd: inherited.cwd,
    };
    return spawnResult(
      spawnFlow.startDeferredSpawnJob(spawnArgs, callerCwd, context, notifyContext, { respawned: true })
    );
  }

  async function send(args, { scopedContext, callerCwd, context, notifyContext }) {
    try {
      const prepared = await sendFlow.prepareSend(args, scopedContext);
      return sendFlow.dispatchToExistingSession(prepared, notifyContext);
    } catch (err) {
      return await respawnDeadTagSend(err, args, { callerCwd, context, notifyContext });
    }
  }

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

  return async function execute(args = {}, context = {}) {
    try {
      await awaitKeychainPrewarm();
      const type = clean(args.type) || 'spawn';
      const request = {
        callerCwd: clean(context.cwd || context.callerCwd),
        scopedContext: agentScope(args, context),
        context,
        notifyContext: context,
      };
      const { scopedContext } = request;
      if (typeof mgr.rehydrateAgentSessions === 'function') {
        await mgr.rehydrateAgentSessions();
        // Rebuild tag ownership from canonical records even if a daemon crash
        // happened before the auxiliary worker row was flushed.
        registry.refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
      }
      switch (type) {
        case 'status':
          if (clean(args.task_id) || clean(args.tag) || clean(args.sessionId)) {
            return renderResult(views.renderJob(views.getJobOrWorker(args, scopedContext), false), {
              includeDiagnostics: true,
            });
          }
        // Targetless status is the same compact overview as list.
        case 'list':
          return renderResult({
            workers: views.list({ scanSessions: registry.wantsSessionScan(args), context: scopedContext }),
            jobs: views.listJobs(scopedContext),
          });
        case 'read':
          return await readJob(args, scopedContext);
        case 'cleanup':
          return renderResult(closeFlow.cleanup(args, scopedContext));
        case 'cancel':
        case 'close':
          return renderResult(await closeFlow.close(args, scopedContext));
        case 'send':
          return await send(args, request);
        case 'spawn':
          return await spawn(args, request);
        default:
          throw new Error(`agent: unknown type "${type}"`);
      }
    } catch (err) {
      return errorLine(err, { surface: 'agent' });
    }
  };
}
